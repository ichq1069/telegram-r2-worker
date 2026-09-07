import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import '../data/local/local_db.dart';

/// 相册同步“前台服务锁”帮助类。
///
/// `sync_meta.sync_running` 是跨 isolate 的互斥锁：同步前台服务运行期间置位，
/// 主进程的 [UploadEngine] 与 WorkManager 靠它避免并发上传。若进程被系统/用户
/// 杀掉（或前台服务异常退出）而锁未被 finally 清理，会出现“陈旧锁”：界面上
/// 永远显示同步中、筛选弹层/重新同步都无法触发。这里用真实服务存活状态判定，
/// 服务已死时自动清锁，让后续操作恢复可用。
class SyncLock {
  SyncLock._();

  /// 前台同步服务此刻是否真实存活。
  static Future<bool> serviceActive() async {
    try {
      return await FlutterForegroundTask.isRunningService;
    } catch (_) {
      return false;
    }
  }

  /// 锁与真实服务状态一致化：
  /// - 无锁 → false（未在同步）；
  /// - 有锁且服务存活 → true（正在同步）；
  /// - 有锁但服务已死 → 清除陈旧锁并返回 false。
  static Future<bool> activeOrHeal(LocalDb db) async {
    if (!await db.isSyncRunning()) return false;
    if (await serviceActive()) return true;
    try {
      await db.setSyncRunning(false);
    } catch (_) {}
    return false;
  }
}
