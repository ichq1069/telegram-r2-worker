/// 分享文本链接提取：小红书/微博等分享出来的文案通常是
/// 「标题描述 + 短链 + 推广语」，用户直接整段粘贴会带上无关文字。
/// 这里统一从任意文本中取出可用的 http(s) 链接。

final RegExp _urlPattern = RegExp(
  r"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+",
  caseSensitive: false,
);

final RegExp _trailingPunct = RegExp(r'''[.,;:!?)\]}"']+$''');

/// 提取文本中第一个 http(s) 链接，并去掉链接末尾误入的英文标点；
/// 找不到链接返回空串。纯链接输入原样返回。
String extractFirstUrl(String text) {
  if (text.isEmpty) return '';
  final m = _urlPattern.firstMatch(text);
  if (m == null) return '';
  return m.group(0)!.replaceFirst(_trailingPunct, '');
}
