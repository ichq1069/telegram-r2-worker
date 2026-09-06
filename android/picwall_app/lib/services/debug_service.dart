import 'dart:async';

/// 调试模式服务：捕获全应用错误并在 UI 上展示。
class DebugService {
  DebugService._();
  static final DebugService instance = DebugService._();

  bool _enabled = false;
  final List<DebugError> _errors = [];
  final _controller = StreamController<DebugError>.broadcast();

  bool get enabled => _enabled;
  List<DebugError> get errors => List.unmodifiable(_errors);
  Stream<DebugError> get errorStream => _controller.stream;

  void setEnabled(bool value) {
    _enabled = value;
    if (!value) _errors.clear();
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
    _controller.add(entry);
  }

  void clear() {
    _errors.clear();
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
    final h = time.hour.toString().padLeft(2, '0');
    final m = time.minute.toString().padLeft(2, '0');
    final s = time.second.toString().padLeft(2, '0');
    return '$h:$m:$s';
  }
}
