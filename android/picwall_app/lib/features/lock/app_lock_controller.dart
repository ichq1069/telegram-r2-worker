import 'package:flutter/foundation.dart';

/// 应用锁运行态：标记当前会话是否已通过验证解锁。
/// 冷启动/回到前台/切后台都会复位，未解锁时 RootGate 与锁屏路由保持拦截。
class AppLockController extends ChangeNotifier {
  bool _unlocked = false;

  bool get unlocked => _unlocked;

  void unlock() {
    if (_unlocked) return;
    _unlocked = true;
    notifyListeners();
  }

  void lock() {
    if (!_unlocked) return;
    _unlocked = false;
    notifyListeners();
  }
}
