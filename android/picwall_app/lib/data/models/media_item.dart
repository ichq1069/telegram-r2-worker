import '../../core/constants.dart';

/// 内容条目模型（对齐后端 poolFileJson / user_uploads 返回结构）。
class MediaItem {
  const MediaItem({
    required this.id,
    required this.url,
    this.thumbUrl,
    this.title = '',
    this.tags = const [],
    this.level = UserLevel.pt,
    this.isPrivate = false,
    this.fileType = 'photo',
    this.width,
    this.height,
    this.fileSize,
    this.source = '',
    this.createdAt = '',
    this.extra = const {},
  });

  final String id;
  final String url;
  final String? thumbUrl;
  final String title;
  final List<String> tags;
  final UserLevel level;
  final bool isPrivate;
  final String fileType; // photo / video / document / audio
  final int? width;
  final int? height;
  final int? fileSize;
  final String source;
  final String createdAt;
  final Map<String, dynamic> extra;

  /// 缩略图直链（优先 thumbUrl；部分来源只有 url）。
  String get displayThumb => thumbUrl != null && thumbUrl!.isNotEmpty ? thumbUrl! : url;

  static const _imageExts = {
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif'
  };

  /// thumbUrl 是否是可直接当图片渲染的直链。
  ///
  /// 视频条目很多来源没有独立封面，服务端会把 thumb_url 兜底成视频地址；直接
  /// 拿它当图片加载会白下载整段视频，故按扩展名过滤。
  bool get hasImageThumb {
    final t = thumbUrl;
    if (t == null || t.isEmpty) return false;
    final path = Uri.tryParse(t)?.path ?? t;
    final dot = path.lastIndexOf('.');
    if (dot < 0 || dot == path.length - 1) return false;
    return _imageExts.contains(path.substring(dot + 1).toLowerCase());
  }

  /// 安全的封面直链：视频缺真实图片封面时返回空串，由 UI 显示占位，
  /// 避免把视频地址当图片拉取；图片条目保持原 displayThumb 行为。
  String get posterUrl => (isVideo && !hasImageThumb) ? '' : displayThumb;

  /// 唯一去重键：以条目 id（或 url）为锚，避免本地收藏/历史重复。
  String get dedupeKey => id.isNotEmpty ? '$fileType:$id' : url;

  String get fileTypeLabel {
    switch (fileType) {
      case 'video':
        return '视频';
      case 'document':
        return '文档';
      case 'audio':
        return '音频';
      default:
        return '图片';
    }
  }

  bool get isVideo => fileType == 'video';
  bool get isPhoto => fileType == 'photo' || fileType == 'image';

  /// 解析随机池 / gallery / show 系列的条目。
  factory MediaItem.fromPoolJson(Map<String, dynamic> j) {
    return MediaItem(
      id: _str(j['id']),
      url: _str(j['url']),
      thumbUrl: j['thumb_url'] is String ? j['thumb_url'] as String : null,
      title: _str(j['title']),
      tags: _tags(j['tags']),
      level: levelFromWire(j['level'] is String ? j['level'] as String : null),
      isPrivate: _bool(j['is_private']),
      fileType: _str(j['file_type'], fallback: 'photo'),
      width: j['width'] is num ? (j['width'] as num).toInt() : null,
      height: j['height'] is num ? (j['height'] as num).toInt() : null,
      fileSize: j['file_size'] is num ? (j['file_size'] as num).toInt() : null,
      source: _str(j['source']),
      createdAt: _str(j['created_at']),
      extra: j,
    );
  }

  /// 解析 user_uploads / files 系列的条目。
  factory MediaItem.fromFilesJson(Map<String, dynamic> j) {
    return MediaItem(
      id: _str(j['id']),
      url: _str(j['url'], fallback: j['proxy_url']),
      thumbUrl: j['thumb_url'] is String ? j['thumb_url'] as String : null,
      title: _str(j['title'], fallback: j['file_name']),
      tags: _tags(j['tags']),
      level: levelFromWire(j['level'] is String ? j['level'] as String : null),
      isPrivate: _bool(j['is_private']),
      fileType: _str(j['file_type'], fallback: 'photo'),
      width: j['width'] is num ? (j['width'] as num).toInt() : null,
      height: j['height'] is num ? (j['height'] as num).toInt() : null,
      fileSize: j['file_size'] is num ? (j['file_size'] as num).toInt() : null,
      source: _str(j['source']),
      createdAt: _str(j['created_at']),
      extra: j,
    );
  }

  /// 本地库（收藏/历史）持久化用归一化 JSON。
  Map<String, dynamic> toJson() => {
        'id': id,
        'url': url,
        'thumbUrl': thumbUrl,
        'title': title,
        'tags': tags,
        'level': level.wire,
        'isPrivate': isPrivate,
        'fileType': fileType,
        'width': width,
        'height': height,
        'fileSize': fileSize,
        'source': source,
        'createdAt': createdAt,
      };

  /// 从 toJson 结果还原；缺字段有兜底。
  factory MediaItem.fromLocalJson(Map<String, dynamic> j) {
    return MediaItem(
      id: _str(j['id']),
      url: _str(j['url']),
      thumbUrl: j['thumbUrl'] is String ? j['thumbUrl'] as String : null,
      title: _str(j['title']),
      tags: _tags(j['tags']),
      level: levelFromWire(j['level']?.toString()),
      isPrivate: _bool(j['isPrivate']),
      fileType: _str(j['fileType'], fallback: 'photo'),
      width: j['width'] is num ? (j['width'] as num).toInt() : null,
      height: j['height'] is num ? (j['height'] as num).toInt() : null,
      fileSize: j['fileSize'] is num ? (j['fileSize'] as num).toInt() : null,
      source: _str(j['source']),
      createdAt: _str(j['createdAt']),
    );
  }

  static String _str(dynamic v, {String fallback = ''}) {
    if (v == null) return fallback;
    return v.toString();
  }

  static bool _bool(dynamic v) => v == 1 || v == true || v == '1' || v == 'true';

  static List<String> _tags(dynamic v) {
    if (v is List) {
      return v.map((e) => e.toString()).where((s) => s.isNotEmpty).toList();
    }
    if (v is String && v.isNotEmpty) {
      return v.split(',').where((s) => s.trim().isNotEmpty).map((s) => s.trim()).toList();
    }
    return const [];
  }
}

/// gallery/data 分页响应。
class GalleryPage {
  const GalleryPage({
    required this.total,
    required this.limit,
    required this.offset,
    required this.level,
    required this.items,
  });

  final int total;
  final int limit;
  final int offset;
  final String level;
  final List<MediaItem> items;

  bool get hasMore => offset + items.length < total;

  factory GalleryPage.fromJson(Map<String, dynamic> j) {
    final rawItems = j['items'] is List ? j['items'] as List : <dynamic>[];
    return GalleryPage(
      total: j['total'] is num ? (j['total'] as num).toInt() : 0,
      limit: j['limit'] is num ? (j['limit'] as num).toInt() : 0,
      offset: j['offset'] is num ? (j['offset'] as num).toInt() : 0,
      level: j['level'] is String ? j['level'] as String : 'pt',
      items: rawItems
          .whereType<Map>()
          .map((e) => MediaItem.fromPoolJson(Map<String, dynamic>.from(e)))
          .toList(),
    );
  }
}
