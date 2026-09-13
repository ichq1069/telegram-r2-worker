/// 采集入库后台运行：
/// - 前台服务（flutter_foreground_task）承载逐条 `grab_one` 入库，通知栏常驻并
///   实时更新进度，离开采集页 / 切后台 / 锁屏都不中断；
/// - WorkManager 一次性任务在进程被杀后唤醒并拉起前台服务续跑未完成项；
/// - 与相册同步共用同一前台服务，靠 `sync_meta.scrape_running` 与 `sync_running`
///   互相让路，同一时刻只允许一端占用服务。
library;

import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:workmanager/workmanager.dart';

import '../../data/local/local_db.dart';
import '../../data/models/scrape_job.dart';
import '../../data/repositories/gallery_repository.dart';
import '../../services/api_client.dart';
import '../../services/debug_service.dart';
import '../../services/scrape_lock.dart';
import '../../services/secure_store.dart';
import '../../services/sync_lock.dart';

/// 进程被杀后续跑的 WorkManager 任务唯一名（由 sync_background 的调度器路由）。
const String kScrapeResumeTask = 'picwall_scrape_resume';

@pragma('vm:entry-point')
void scrapeTaskCallback() {
  FlutterForegroundTask.setTaskHandler(ScrapeTaskHandler());
}

class ScrapeTaskHandler extends TaskHandler {
  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) =>
      ScrapeService.runPass();

  @override
  void onRepeatEvent(DateTime timestamp) {}

  @override
  Future<void> onDestroy(DateTime timestamp) async {}
}

/// 采集入库后台门面：供采集页与 WorkManager 调用。
class ScrapeService {
  ScrapeService._();

  static const String _title = 'PicWall 采集入库';

  static const int _maxAttempts = 3;

  /// 发起一次新的后台入库任务。返回错误信息；成功返回 null。
  static Future<String?> startJob({
    required String title,
    required List<String> urls,
    String tags = '',
    String level = 'pt',
    String ref = '',
    String ignoreKw = '',
    String ignoreExt = '',
    String must = '',
    int? maxMb,
    String cookie = '',
  }) async {
    if (urls.isEmpty) return '没有可入库的图片';
    final db = await LocalDb.open();
    if (await ScrapeLock.activeOrHeal(db)) return '已有采集入库任务正在进行';
    if (await SyncLock.activeOrHeal(db)) return '相册同步正在进行，请稍后再试';
    final job = ScrapeJob(
      createdAtMs: DateTime.now().millisecondsSinceEpoch,
      title: title,
      tags: tags,
      level: level,
      ref: ref,
      ignoreKw: ignoreKw,
      ignoreExt: ignoreExt,
      must: must,
      maxMb: maxMb,
      cookie: cookie,
      state: 'running',
    );
    final jobId = await db.createScrapeJob(job, urls);
    await db.clearScrapeStop();
    await db.setScrapeRunning(true);
    final ok = await _startService('准备入库 ${urls.length} 张…');
    if (!ok) {
      await db.setScrapeRunning(false);
      await db.setScrapeJobState(jobId, 'stopped');
      return '启动后台入库服务失败';
    }
    await _scheduleResume();
    return null;
  }

  /// 继续/重试当前任务：失败项重置为待入库，已停止的任务恢复为运行中。
  /// 返回错误信息；成功返回 null。
  static Future<String?> resumeJob() async {
    final db = await LocalDb.open();
    if (await ScrapeLock.activeOrHeal(db)) return '已有采集入库任务正在进行';
    if (await SyncLock.activeOrHeal(db)) return '相册同步正在进行，请稍后再试';
    await db.resetFailedScrapeItems();
    final snap = await db.loadScrapeJob();
    final id = snap?.job.id;
    if (snap == null || id == null) return '没有可继续的任务';
    if (snap.job.state != 'running') await db.setScrapeJobState(id, 'running');
    await db.clearScrapeStop();
    if (!await db.hasPendingScrapeJob()) return '没有待入库项';
    await db.setScrapeRunning(true);
    final ok = await _startService('恢复未完成的入库任务…');
    if (!ok) {
      await db.setScrapeRunning(false);
      return '启动后台入库服务失败';
    }
    await _scheduleResume();
    return null;
  }

  /// 请求停止：置停止标志，正在跑的循环会在当前张完成后退出并落终态。
  static Future<void> stopJob() async {
    final db = await LocalDb.open();
    await db.requestScrapeStop();
    await _cancelResume();
    await _notify(_title, '正在停止…');
  }

  /// WorkManager 唤醒入口（独立 isolate）：仍有未完成项且未在运行时，拉起前台服务续跑。
  static Future<void> resumeIfNeeded() async {
    final db = await LocalDb.open();
    if (!await db.hasPendingScrapeJob()) {
      await _cancelResume();
      return;
    }
    if (await ScrapeLock.activeOrHeal(db)) {
      await _scheduleResume();
      return;
    }
    if (await SyncLock.activeOrHeal(db)) {
      await _scheduleResume();
      return;
    }
    await db.setScrapeRunning(true);
    final ok = await _startService('恢复未完成的入库任务…');
    if (!ok) {
      await db.setScrapeRunning(false);
      await _scheduleResume();
      return;
    }
    await _scheduleResume();
  }

  /// 前台服务 isolate 内实际执行：读取任务参数与待入库项，逐条 grab_one 并落库。
  static Future<void> runPass() async {
    final db = await LocalDb.open();
    try {
      final snap = await db.loadScrapeJob();
      final jobId = snap?.job.id;
      if (snap == null || jobId == null) return;
      if (snap.job.state != 'running') return;

      final settings = await SecureStore().readSettings();
      final base =
          (settings['apiBase']?.isNotEmpty ?? false) ? settings['apiBase']! : '';
      final adminKey = settings['adminKey'] ?? '';
      if (base.isEmpty || adminKey.isEmpty) {
        await db.setScrapeJobState(jobId, 'stopped');
        await _notify(_title, '缺少服务端地址或管理 Key，已停止');
        return;
      }
      final repo = GalleryRepository(
        ApiClient(baseUrl: base, apiKey: settings['apiKey'] ?? ''),
      );

      final pending = [
        for (final it in snap.items)
          if (it.status == 'pending' && it.id != null) it,
      ];
      final total = snap.items.length;
      var done = total - pending.length;
      var added = snap.items.where((i) => i.status == 'added').length;
      await _notify(_title, '待入库 ${pending.length} 张，共 $total 张');

      for (final it in pending) {
        if (await db.scrapeStopRequested()) break;
        var ok = false;
        Object? lastErr;
        StackTrace? lastSt;
        for (var attempt = 1; attempt <= _maxAttempts; attempt++) {
          try {
            final r = await repo.adminScrapeGrabOne(
              adminKey,
              url: it.url,
              title: snap.job.title,
              tags: snap.job.tags,
              level: snap.job.level,
              ref: snap.job.ref,
              ignoreKw: snap.job.ignoreKw,
              ignoreExt: snap.job.ignoreExt,
              must: snap.job.must,
              maxMb: snap.job.maxMb,
              cookie: snap.job.cookie,
              seq: it.seq,
            );
            await db.updateScrapeItemStatus(it.id!, r.status, r.reason);
            if (r.status == 'added') added++;
            ok = true;
            break;
          } catch (e, st) {
            lastErr = e;
            lastSt = st;
            final transient = e is! ApiException;
            if (!transient) break;
            if (attempt < _maxAttempts && !await db.scrapeStopRequested()) {
              await _notify(_title,
                  '第 ${it.seq} 张网络异常，重试 $attempt/${_maxAttempts - 1}…');
              await Future<void>.delayed(Duration(seconds: attempt * 2));
            }
          }
        }
        if (!ok) {
          if (await db.scrapeStopRequested()) break;
          DebugService.instance.recordError(
              'ScrapeService.grabOne', lastErr ?? Exception('抓取失败'), lastSt);
          await db.updateScrapeItemStatus(
              it.id!, 'failed', lastErr?.toString() ?? '抓取失败');
        }
        done++;
        await _notify(_title, '入库中 $done/$total · 成功 $added');
      }

      final stopped = await db.scrapeStopRequested();
      await db.setScrapeJobState(jobId, stopped ? 'stopped' : 'done');
      final finalSnap = await db.loadScrapeJob();
      final failed = finalSnap?.failed ?? 0;
      await _notify(
        _title,
        stopped
            ? '已停止：成功 $added / 共 $total'
            : '完成：成功 $added / 共 $total${failed > 0 ? ' · 失败 $failed' : ''}',
      );
    } catch (e, st) {
      DebugService.instance.recordError('ScrapeService.runPass', e, st);
      await _notify(_title, '入库出错：$e');
    } finally {
      await db.setScrapeRunning(false);
      await db.clearScrapeStop();
      if (!await db.hasPendingScrapeJob()) await _cancelResume();
      await FlutterForegroundTask.stopService();
    }
  }

  static Future<void> _notify(String title, String text) async {
    try {
      await FlutterForegroundTask.updateService(
        notificationTitle: title,
        notificationText: text,
      );
    } catch (_) {}
  }

  /// 确保前台服务所需权限已授予；未授予则向系统申请。
  static Future<bool> _ensurePermissions() async {
    try {
      final notif = await FlutterForegroundTask.checkNotificationPermission();
      if (notif != NotificationPermission.granted) {
        final result = await FlutterForegroundTask.requestNotificationPermission();
        if (result != NotificationPermission.granted) return false;
      }
    } catch (_) {}
    try {
      if (!await FlutterForegroundTask.isIgnoringBatteryOptimizations) {
        await FlutterForegroundTask.requestIgnoreBatteryOptimization();
      }
    } catch (_) {}
    return true;
  }

  /// 启动前台服务；并发重复启动抛出的异常按失败处理，避免中断调用方流程。
  static Future<bool> _startService(String text) async {
    if (!await _ensurePermissions()) return false;
    try {
      final res = await FlutterForegroundTask.startService(
        notificationTitle: _title,
        notificationText: text,
        callback: scrapeTaskCallback,
      );
      return res is! ServiceRequestFailure;
    } catch (e) {
      DebugService.instance.recordError('ScrapeService.startService', e);
      return false;
    }
  }

  /// 安排一次续跑：先取消旧的同名任务，避免重复触发。
  static Future<void> _scheduleResume() async {
    try {
      await Workmanager().cancelByUniqueName(kScrapeResumeTask);
      await Workmanager().registerOneOffTask(
        kScrapeResumeTask,
        kScrapeResumeTask,
        initialDelay: const Duration(minutes: 3),
      );
    } catch (e) {
      DebugService.instance.recordError('ScrapeService.scheduleResume', e);
    }
  }

  static Future<void> _cancelResume() async {
    try {
      await Workmanager().cancelByUniqueName(kScrapeResumeTask);
    } catch (_) {}
  }
}
