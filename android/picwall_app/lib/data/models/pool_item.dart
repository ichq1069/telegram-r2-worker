/// 管理端共享库/私密库条目模型（对齐 random_pool 表）。
library;

class PoolItem {
  const PoolItem({
    required this.id,
    required this.url,
    this.thumbUrl = '',
    this.title = '',
    this.tags = '',
    this.fileType = 'photo',
    this.width,
    this.height,
    this.fileSize,
    this.source = 'manual',
    this.tgFileId,
    this.enabled = 1,
    this.createdAt = '',
    this.level = 'pt',
    this.isPrivate = 0,
    this.folderId,
  });

  final int id;
  final String url;
  final String thumbUrl;
  final String title;
  final String tags;
  final String fileType;
  final int? width;
  final int? height;
  final int? fileSize;
  final String source;
  final int? tgFileId;
  final int enabled;
  final String createdAt;
  final String level;
  final int isPrivate;
  final int? folderId;

  String get displayUrl => thumbUrl.isNotEmpty ? thumbUrl : url;
  bool get isImage => fileType == 'photo' || fileType == 'image';

  static PoolItem fromJson(Map<String, dynamic> r) => PoolItem(
        id: r['id'] is num ? (r['id'] as num).toInt() : 0,
        url: (r['url'] ?? '').toString(),
        thumbUrl: (r['thumb_url'] ?? '').toString(),
        title: (r['title'] ?? '').toString(),
        tags: (r['tags'] ?? '').toString(),
        fileType: (r['file_type'] ?? 'photo').toString(),
        width: r['width'] is num ? (r['width'] as num).toInt() : null,
        height: r['height'] is num ? (r['height'] as num).toInt() : null,
        fileSize: r['file_size'] is num ? (r['file_size'] as num).toInt() : null,
        source: (r['source'] ?? 'manual').toString(),
        tgFileId: r['tg_file_id'] is num ? (r['tg_file_id'] as num).toInt() : null,
        enabled: r['enabled'] is num ? (r['enabled'] as num).toInt() : 1,
        createdAt: (r['created_at'] ?? '').toString(),
        level: (r['level'] ?? 'pt').toString(),
        isPrivate: r['is_private'] is num ? (r['is_private'] as num).toInt() : 0,
        folderId: r['folder_id'] is num ? (r['folder_id'] as num).toInt() : null,
      );
}
