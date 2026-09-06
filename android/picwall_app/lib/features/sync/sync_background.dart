import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:workmanager/workmanager.dart';

import '../../data/local/local_db.dart';
import '../../data/repositories/gallery_repository.dart';
import '../../services/api_client.dart';
import '../../services/debug_service.dart';
import '../../services/secure_store.dart';
import '../upload/upload_engine.dart';
import 'album_sync_scanner.dart';

/// 相册同步后台运行：
/// - 前台服务（flutter_foreground_task）承载真正的扫描+上传，通知栏常驻并实时更新进度；
/// - WorkManager 周期任务（≥15 分钟）在应用被杀后唤醒并按需拉起前台服务；
/// - sqflite `sync_meta` 上的 `sync_running` 锁保证同一时刻只有一端在上传，
///   主进程的 UploadEngine 在锁有效时挂起。

const String kSyncChannelId = 'picwall_sync';
const String kSyncChannelName = 'PicWall 相册同步';
const String kSyncPeriodicTask = 'picwall_sync_periodic';
const String kMetaAutoSync = 'auto_sync';

@pragma('vm:entry-point')
void syncTaskCallback() {
  FlutterForegroundTask.setTaskHandler(SyncTaskHandler());
}

class SyncTaskHandler extends TaskHandler {
  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) =>
      SyncService.runPass();

  @override
  void onRepeatEvent(DateTime timestamp) {}

  @override
  Future<void> onDestroy(DateTime timestamp) async {}
}

/// 后台同步门面：供 UI 与 WorkManager 调用。
class SyncService {
  SyncService._();

  static bool _inited = false;

  /// 在 main() 中调用：建立前后台 isolate 通信 + 通知渠道 + 注册 WorkManager。
  static Future<void> init() async {
    FlutterForegroundTask.initCommunicationPort();
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: kSyncChannelId,
        channelName: kSyncChannelName,
        channelDescription: '相册自动同步的运行状态与进度',
        channelImportance: NotificationChannelImportance.HIGH,
        priority: NotificationPriority.HIGH,
        onlyAlertOnce: false,
        showWhen: true,
      ),
      iosNotificationOptions: const IOSNotificationOptions(),
      foregroundTaskOptions: ForegroundTaskOptions(
        eventAction: ForegroundTaskEventAction.repeat(30000),
      ),
    );
    if (_inited) return;
    _inited = true;
    await Workmanager().initialize(syncWorkDispatcher);
  }

  /// 读取当前用户配置并起一个前台同步服务实例（幂等：已有锁则跳过）。
  static Future<bool> startPass() async {
    final db = await LocalDb.open();
    if (await db.isSyncRunning()) return false;
    final enabled = await db.getEnabledAlbum();
    if (enabled == null) return false;
    await db.setSyncRunning(true);
    final res = await FlutterForegroundTask.startService(
      notificationTitle: 'PicWall 相册同步',
      notificationText: '正在准备同步「${enabled.albumName}」…',
      callback: syncTaskCallback,
    );
    if (res is ServiceRequestFailure) {
      await db.setSyncRunning(false);
      return false;
    }
    return true;
  }

  static Future<void> stopPass() async {
    final db = await LocalDb.open();
    await db.setSyncRunning(false);
    await FlutterForegroundTask.stopService();
  }

  static Future<bool> autoEnabled() async {
    final db = await LocalDb.open();
    final v = await db.syncMeta(kMetaAutoSync);
    return v == '1';
  }

  /// 开启自动同步：持久化 + 注册周期任务；应用已在前台时立即起一轮。
  static Future<void> enableAuto() async {
    final db = await LocalDb.open();
    await db.setSyncMeta(kMetaAutoSync, '1');
    await Workmanager().registerPeriodicTask(
      kSyncPeriodicTask,
      kSyncPeriodicTask,
      frequency: const Duration(minutes: 15),
    );
  }

  static Future<void> disableAuto() async {
    final db = await LocalDb.open();
    await db.delSyncMeta(kMetaAutoSync);
    await Workmanager().cancelByUniqueName(kSyncPeriodicTask);
  }

  /// WorkManager 后台回调入口（独立 isolate）：自动同步开启且未在运行时，
  /// 拉起前台服务执行真正的一轮同步。
  static Future<void> runAutoFromBackground() async {
    final db = await LocalDb.open();
    final auto = await db.syncMeta(kMetaAutoSync);
    if (auto != '1') return;
    await startPass();
  }

  /// 前台服务 isolate 内实际执行一轮：扫描（增量）→ 上传 → 停止服务。
  static Future<void> runPass() async {
    final db = await LocalDb.open();
    try {
      final enabled = await db.getEnabledAlbum();
      if (enabled == null) return;

      final settings = await SecureStore().readSettings();
      final base =
          (settings['apiBase']?.isNotEmpty ?? false) ? settings['apiBase']! : '';
      if (base.isEmpty) return;
      final apiKey = settings['apiKey'] ?? '';
      final wifiOnly = settings['wifiOnlyUpload'] == '1';

      await _notify('PicWall 相册同步', '开始扫描「${enabled.albumName}」…');

      final repo = GalleryRepository(ApiClient(baseUrl: base, apiKey: apiKey));
      final engine = UploadEngine(repository: repo, db: db, wifiOnly: wifiOnly);
      await engine.loadFromDb();

      final filter = await db.loadSyncFilter();
      final albums = await PhotoManager.getAssetPathList(type: RequestType.common);
      AssetPathEntity? album;
      for (final a in albums) {
        if (a.id == enabled.albumId) {
          album = a;
          break;
        }
      }
      if (album == null) {
        await _notify('PicWall 相册同步', '同步相册已被移除，请在应用内重新选择');
        return;
      }

      final scanner = AlbumSyncScanner(db: db, engine: engine);
      var lastCount = 0;
      final added = await scanner.syncAlbum(
        album,
        filter: filter,
        onProgress: (n, s) {
          if (n != lastCount && (s % 25 == 0 || n % 10 == 0)) {
            lastCount = n;
            _notify('PicWall 相册同步', '扫描中：已发现新增 $n 张（已查 $s）…');
          }
        },
      );
      _notify('PicWall 相册同步',
          added > 0 ? '发现 $added 张新照片，开始上传…' : '没有新增内容');

      var totalScanned = 0;
      engine.addListener(() {
        final queued = engine.queuedCount;
        final uploading = engine.uploadingCount;
        final done = engine.doneCount;
        final failed = engine.failedCount;
        totalScanned = done + failed + queued + uploading;
        if (totalScanned > 0 && (uploading > 0 || queued > 0)) {
          final pct = totalScanned > 0 ? ((done / totalScanned) * 100).round() : 0;
          _notify(
            'PicWall 相册同步',
            '上传中 $pct%：剩余 $queued · 成功 $done · 失败 $failed',
          );
        }
      });
      await engine.start();

      if (engine.networkPaused) {
        await _notify('PicWall 相册同步', '已挂起：当前非 Wi-Fi 网络，任务保留待连接 Wi-Fi');
      } else if (engine.failedCount > 0) {
        await _notify('PicWall 相册同步',
            '本轮结束：成功 ${engine.doneCount} · 失败 ${engine.failedCount}，可手动重试');
      } else {
        await _notify('PicWall 相册同步', '本轮同步完成，共上传 ${engine.doneCount} 张');
      }
    } catch (e, st) {
      DebugService.instance.recordError('SyncService.runPass', e, st);
      await _notify('PicWall 相册同步', '同步出错：$e');
    } finally {
      await db.setSyncRunning(false);
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
}

@pragma('vm:entry-point')
void syncWorkDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    try {
      await SyncService.runAutoFromBackground();
    } catch (_) {}
    return true;
  });
}
