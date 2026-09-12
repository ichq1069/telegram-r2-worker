/// 分享文本链接提取：小红书/微博等分享出来的文案通常是
/// 「标题描述 + 短链 + 推广语」，用户直接整段粘贴会带上无关文字。
/// 这里统一从任意文本中取出可用的 http(s) 链接。
library;

final RegExp _urlPattern = RegExp(
  r"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+",
  caseSensitive: false,
);

final RegExp _trailingPunct = RegExp(r'''[.,;:!?)\]}"']+$''');

final RegExp _directImg = RegExp(
  r'\.(?:jpe?g|png|gif|webp|avif|bmp|ico|svg|tiff?)(?:\?|#|$)',
  caseSensitive: false,
);

String _cleanUrl(String raw) => raw.replaceFirst(_trailingPunct, '');

/// 提取文本中第一个 http(s) 链接，并去掉链接末尾误入的英文标点；
/// 找不到链接返回空串。纯链接输入原样返回。
String extractFirstUrl(String text) {
  final all = extractAllUrls(text);
  return all.isEmpty ? '' : all.first;
}

/// 提取文本中全部互不相同的 http(s) 链接（保留出现顺序）。
List<String> extractAllUrls(String text) {
  if (text.isEmpty) return const [];
  final out = <String>[];
  final seen = <String>{};
  for (final m in _urlPattern.allMatches(text)) {
    final u = _cleanUrl(m.group(0)!);
    if (u.isEmpty) continue;
    final key = u.toLowerCase();
    if (seen.add(key)) out.add(u);
  }
  return out;
}

/// 路径或 query 带常见图片扩展名，视为图片直链。
bool isDirectImageUrl(String url) => _directImg.hasMatch(url);
