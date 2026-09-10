import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import '../data/local/local_db.dart';

/// 采集入库“前台服务锁”帮助类。
///
/// 与相册同步共用同一个 flutter_foreground_task 前台服务，`sync_meta.scrape_running`
/// 是跨 isolate 的互斥标志：采集服务运行期间置位。进程被杀导致锁残留时，这里用
/// 真实服务存活状态 + 是否仍有待入库项判定并自愈，避免界面永远显示“入库中”。
class ScrapeLock {
  ScrapeLock._();

  static Future<bool> serviceActive() async {
    try {
      return await FlutterForegroundTask.isRunningService;
    } catch (_) {
      return false;
    }
  }

  /// 锁与真实状态一致化：
  /// - 无锁 → false；
  /// - 有锁、任务仍在运行且服务存活 → true；
  /// - 否则视为陈旧锁，清除并返回 false。
  static Future<bool> activeOrHeal(LocalDb db) async {
    if (!await db.isScrapeRunning()) return false;
    if (await db.hasActiveScrapeJob() && await serviceActive()) return true;
    try {
      await db.setScrapeRunning(false);
    } catch (_) {}
    return false;
  }
}
