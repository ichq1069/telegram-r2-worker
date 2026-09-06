/// 展示格式化小工具（管理端多处复用）。
String fmtBytes(int bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(2)} GB';
  }
  if (bytes >= 1024 * 1024) {
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
  if (bytes >= 1024) {
    return '${(bytes / 1024).toStringAsFixed(0)} KB';
  }
  return '$bytes B';
}

/// 千分位。
String fmtCount(int n) {
  final s = n.toString();
  final buf = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    final fromEnd = s.length - i;
    buf.write(s[i]);
    if (fromEnd > 1 && (fromEnd - 1) % 3 == 0) buf.write(',');
  }
  return buf.toString();
}

/// ISO 时间戳转北京时间 `yyyy-MM-dd HH:mm`。
String fmtIso(String s) {
  if (s.isEmpty) return '-';
  final dt = DateTime.tryParse(s);
  if (dt == null) return s;
  final bjt = dt.toUtc().add(const Duration(hours: 8));
  final y = bjt.year;
  final m = bjt.month.toString().padLeft(2, '0');
  final d = bjt.day.toString().padLeft(2, '0');
  final h = bjt.hour.toString().padLeft(2, '0');
  final min = bjt.minute.toString().padLeft(2, '0');
  return '$y-$m-$d $h:$min';
}
