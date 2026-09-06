/// 管理端通用数据模型：回收站 / 未入库列表行与分页封装。
class AdminFile {
  const AdminFile({
    required this.id,
    required this.fileName,
    required this.fileType,
    required this.fileSize,
    required this.chatTitle,
    required this.createdAt,
    this.deletedAt = '',
    this.processingState = '',
    this.proxyUrl = '',
    this.displayUrl = '',
  });

  final String id;
  final String fileName;
  final String fileType;
  final int fileSize;
  final String chatTitle;
  final String createdAt;
  final String deletedAt;
  final String processingState;
  final String proxyUrl;
  final String displayUrl;

  factory AdminFile.fromJson(Map<String, dynamic> j) {
    String s(Object? v) => v?.toString() ?? '';
    return AdminFile(
      id: s(j['id']),
      fileName: s(j['file_name']),
      fileType: s(j['file_type']),
      fileSize: j['file_size'] is num
          ? (j['file_size'] as num).toInt()
          : (int.tryParse(s(j['file_size'])) ?? 0),
      chatTitle: s(j['chat_title']),
      createdAt: s(j['created_at']),
      deletedAt: s(j['deleted_at']),
      processingState: s(j['processing_state']),
      proxyUrl: s(j['proxy_url']),
      displayUrl: s(j['display_url']),
    );
  }

  bool get isImage => fileType == 'image';
}

/// 通用分页结果：兼容 /admin/api/trash 与 /admin/api/unsaved 的
/// {total,page,page_size,total_pages,items} 结构。
class AdminListPage<T> {
  const AdminListPage({
    required this.items,
    required this.total,
    required this.page,
    required this.totalPages,
    required this.pageSize,
  });

  final List<T> items;
  final int total;
  final int page;
  final int totalPages;
  final int pageSize;

  bool get hasMore => page < totalPages;

  factory AdminListPage.fromJson(
    Map<String, dynamic> data,
    T Function(Map<String, dynamic>) parse,
  ) {
    int n(Object? v) => v is num ? v.toInt() : (int.tryParse(v?.toString() ?? '') ?? 0);
    final items = <T>[];
    final raw = data['items'];
    if (raw is List) {
      for (final e in raw) {
        if (e is Map) {
          items.add(parse(Map<String, dynamic>.from(e)));
        }
      }
    }
    return AdminListPage<T>(
      items: items,
      total: n(data['total']),
      page: n(data['page']) == 0 ? 1 : n(data['page']),
      totalPages: n(data['total_pages']),
      pageSize: n(data['page_size']) == 0 ? items.length : n(data['page_size']),
    );
  }
}

/// R2 对象（/admin/api/r2/list 单条）。
class R2Object {
  const R2Object({
    required this.key,
    required this.size,
    required this.uploaded,
    required this.state,
    required this.publicUrl,
  });

  final String key;
  final int size;
  final String uploaded;
  final String state;
  final String publicUrl;

  /// state：page(站点静态页) / backup(备份) / used(D1 有引用) / orphan(孤儿)。
  bool get isOrphan => state == 'orphan';

  factory R2Object.fromJson(Map<String, dynamic> j) {
    return R2Object(
      key: (j['key'] ?? '').toString(),
      size: j['size'] is num ? (j['size'] as num).toInt() : 0,
      uploaded: (j['uploaded'] ?? '').toString(),
      state: (j['state'] ?? '').toString(),
      publicUrl: (j['public_url'] ?? '').toString(),
    );
  }
}

/// R2 列表页（cursor 分页）。
class R2ListPage {
  const R2ListPage({
    required this.objects,
    required this.objectsCount,
    required this.refsCount,
    required this.truncated,
    required this.publicBase,
    this.cursor,
  });

  final List<R2Object> objects;
  final int objectsCount;
  final int refsCount;
  final bool truncated;
  final String publicBase;
  final String? cursor;

  bool get hasMore => truncated && cursor != null;

  factory R2ListPage.fromJson(Map<String, dynamic> d) {
    final objects = <R2Object>[];
    final raw = d['objects'];
    if (raw is List) {
      for (final e in raw) {
        if (e is Map) objects.add(R2Object.fromJson(Map<String, dynamic>.from(e)));
      }
    }
    return R2ListPage(
      objects: objects,
      objectsCount: d['objects_count'] is num ? (d['objects_count'] as num).toInt() : objects.length,
      refsCount: d['refs_count'] is num ? (d['refs_count'] as num).toInt() : 0,
      truncated: d['truncated'] == true,
      publicBase: (d['public_base'] ?? '').toString(),
      cursor: d['cursor']?.toString(),
    );
  }
}

/// 采集域名规则组（key 为域名或 `*` 默认组）。
class RuleGroup {
  const RuleGroup({
    required this.key,
    this.name = '',
    this.kw = '',
    this.ext = '',
    this.mb = 10,
    this.must = '',
  });

  final String key;
  final String name;
  final String kw;
  final String ext;
  final int mb;
  final String must;

  factory RuleGroup.fromJson(Map<String, dynamic> j) {
    return RuleGroup(
      key: (j['key'] ?? '').toString(),
      name: (j['name'] ?? '').toString(),
      kw: (j['kw'] ?? '').toString(),
      ext: (j['ext'] ?? '').toString(),
      mb: j['mb'] is num ? (j['mb'] as num).toInt() : 10,
      must: (j['must'] ?? '').toString(),
    );
  }

  Map<String, dynamic> toJson() => {
        'key': key,
        'name': name,
        'kw': kw,
        'ext': ext,
        'mb': mb,
        'must': must,
      };
}

/// 管理端 files 全量库检索项（对齐服务端 /admin/api/files items）。
class AdminFileRecord {
  const AdminFileRecord({
    required this.id,
    required this.url,
    this.fileName = '',
    this.fileType = '',
    this.mimeType = '',
    this.fileSize,
    this.width,
    this.height,
    this.caption = '',
    this.tags = '',
    this.level = 'pt',
    this.isPrivate = false,
    this.chatTitle = '',
    this.createdAt = '',
    this.poolState = '',
  });

  final int id;
  final String url;
  final String fileName;
  final String fileType;
  final String mimeType;
  final int? fileSize;
  final int? width;
  final int? height;
  final String caption;
  final String tags;
  final String level;
  final bool isPrivate;
  final String chatTitle;
  final String createdAt;
  final String poolState;

  factory AdminFileRecord.fromJson(Map<String, dynamic> j) {
    String pick(Iterable<String> keys, {String def = ''}) {
      for (final k in keys) {
        final v = j[k];
        if (v != null && v.toString().isNotEmpty) return v.toString();
      }
      return def;
    }

    final fileSize = j['file_size'];
    return AdminFileRecord(
      id: j['id'] is num ? (j['id'] as num).toInt() : 0,
      url: pick(['display_url', 'r2_url', 'proxy_url']),
      fileName: (j['file_name'] ?? '').toString(),
      fileType: (j['file_type'] ?? '').toString(),
      mimeType: (j['mime_type'] ?? '').toString(),
      fileSize: fileSize is num ? fileSize.toInt() : null,
      width: j['width'] is num ? (j['width'] as num).toInt() : null,
      height: j['height'] is num ? (j['height'] as num).toInt() : null,
      caption: (j['caption'] ?? '').toString(),
      tags: (j['tags'] ?? '').toString(),
      level: (j['level'] ?? 'pt').toString(),
      isPrivate: j['is_private'] == 1,
      chatTitle: (j['chat_title'] ?? '').toString(),
      createdAt: (j['created_at'] ?? '').toString(),
      poolState: (j['pool_state'] ?? '').toString(),
    );
  }
}
