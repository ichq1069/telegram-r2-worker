import 'package:intl/intl.dart';

/// 北京时间（UTC+8）格式化工具。
class BJT {
  BJT._();

  static final _dtFmt = DateFormat('yyyy-MM-dd HH:mm');
  static final _dateFmt = DateFormat('yyyy-MM-dd');
  static final _timeFmt = DateFormat('HH:mm');

  /// 完整日期时间：2026-09-07 14:30
  static String formatDateTime(String? iso) {
    if (iso == null || iso.isEmpty) return '-';
    final dt = DateTime.tryParse(iso);
    if (dt == null) return iso;
    return _dtFmt.format(dt.toUtc().add(const Duration(hours: 8)));
  }

  /// 仅日期：2026-09-07
  static String formatDate(String? iso) {
    if (iso == null || iso.isEmpty) return '-';
    final dt = DateTime.tryParse(iso);
    if (dt == null) return iso;
    return _dateFmt.format(dt.toUtc().add(const Duration(hours: 8)));
  }

  /// 仅时间：14:30
  static String formatTime(String? iso) {
    if (iso == null || iso.isEmpty) return '-';
    final dt = DateTime.tryParse(iso);
    if (dt == null) return iso;
    return _timeFmt.format(dt.toUtc().add(const Duration(hours: 8)));
  }

  /// 友好相对时间：刚刚 / N分钟前 / N小时前 / 昨天 / 日期
  static String relative(String? iso) {
    if (iso == null || iso.isEmpty) return '-';
    final dt = DateTime.tryParse(iso);
    if (dt == null) return iso;
    final bjt = dt.toUtc().add(const Duration(hours: 8));
    final now = DateTime.now();
    final diff = now.difference(bjt);
    if (diff.isNegative) return formatDateTime(iso);
    if (diff.inSeconds < 60) return '刚刚';
    if (diff.inMinutes < 60) return '${diff.inMinutes}分钟前';
    if (diff.inHours < 24) return '${diff.inHours}小时前';
    if (diff.inHours < 48) return '昨天 ${_timeFmt.format(bjt)}';
    return _dtFmt.format(bjt);
  }
}
