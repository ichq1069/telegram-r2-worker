import 'package:flutter/foundation.dart';

/// 调试模式服务：捕获全应用错误并在 UI 上展示。
/// 继承 [ChangeNotifier]，开关状态/错误列表变化时通知浮层刷新。
class DebugService extends ChangeNotifier {
  DebugService._();
  static final DebugService instance = DebugService._();

  bool _enabled = false;
  final List<DebugError> _errors = [];

  bool get enabled => _enabled;
  List<DebugError> get errors => List.unmodifiable(_errors);

  void setEnabled(bool value) {
    if (_enabled == value) return;
    _enabled = value;
    if (!value) _errors.clear();
    notifyListeners();
  }

  void recordError(String source, Object error, [StackTrace? stack]) {
    if (!_enabled) return;
    final entry = DebugError(
      source: source,
      message: error.toString(),
      stack: stack?.toString().split('\n').take(8).join('\n'),
      time: DateTime.now(),
    );
    _errors.insert(0, entry);
    if (_errors.length > 50) _errors.removeLast();
    notifyListeners();
  }

  void clear() {
    if (_errors.isEmpty) return;
    _errors.clear();
    notifyListeners();
  }
}

class DebugError {
  const DebugError({
    required this.source,
    required this.message,
    this.stack,
    required this.time,
  });

  final String source;
  final String message;
  final String? stack;
  final DateTime time;

  String get timeStr {
    final bjt = time.toUtc().add(const Duration(hours: 8));
    final h = bjt.hour.toString().padLeft(2, '0');
    final m = bjt.minute.toString().padLeft(2, '0');
    final s = bjt.second.toString().padLeft(2, '0');
    return '$h:$m:$s';
  }
}
