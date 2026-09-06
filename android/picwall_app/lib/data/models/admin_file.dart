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
