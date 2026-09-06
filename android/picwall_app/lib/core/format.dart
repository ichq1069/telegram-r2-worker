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

/// ISO 时间戳截短为 `yyyy-MM-dd HH:mm`。
String fmtIso(String s) {
  if (s.length < 19) return s;
  final v = s.replaceAll('T', ' ');
  return v.substring(0, 16);
}
