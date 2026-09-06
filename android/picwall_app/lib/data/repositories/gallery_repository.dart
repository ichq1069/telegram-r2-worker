import '../../services/api_client.dart';
import '../models/media_item.dart';
import '../models/user.dart';
/// 分页结果封装（兼容 gallery/data 的 data.items 与 user/files 的顶层 total）。
class PagedMedia {
  const PagedMedia({
    required this.items,
    required this.total,
    required this.offset,
    this.hasMore = false,
  });

  final List<MediaItem> items;
  final int total;
  final int offset;
  final bool hasMore;

  PagedMedia copyWith({List<MediaItem>? items, int? total, int? offset, bool? hasMore}) {
    return PagedMedia(
      items: items ?? this.items,
      total: total ?? this.total,
      offset: offset ?? this.offset,
      hasMore: hasMore ?? this.hasMore,
    );
  }
}

/// 图库 / 用户文件仓库。
class GalleryRepository {
  GalleryRepository(this._api);

  final ApiClient _api;

  /// 共享库 /gallery/data?api_key&tags&type&limit&offset
  Future<PagedMedia> galleryData({
    String tags = '',
    String type = '',
    int limit = 60,
    int offset = 0,
  }) async {
    final data = await _api.getData(
      '/gallery/data',
      query: {
        'tags': tags,
        'type': type,
        'limit': limit,
        'offset': offset,
      },
    ) as Map<String, dynamic>;

    final page = GalleryPage.fromJson(data);
    return PagedMedia(
      items: page.items,
      total: page.total,
      offset: page.offset,
      hasMore: page.hasMore,
    );
  }

  /// 我的图片 /api/v1/user/files?page&page_size&keyword&tags&type
  /// 返回结构与 files 全量接口一致：{ok,data:items,total,page,pageSize}
  Future<PagedMedia> myFiles({
    int page = 1,
    int pageSize = 20,
    String keyword = '',
    String tags = '',
    String type = '',
  }) async {
    final d = await _api.getRaw(
      '/api/v1/user/files',
      query: {
        'page': page,
        'page_size': pageSize,
        'keyword': keyword,
        'tags': tags,
        'type': type,
      },
    );
    if (d['ok'] != true) {
      throw ApiException((d['error'] ?? '请求失败').toString());
    }
    final rawItems = d['data'] is List ? d['data'] as List : <dynamic>[];
    final items = rawItems
        .whereType<Map>()
        .map((e) => MediaItem.fromFilesJson(Map<String, dynamic>.from(e)))
        .toList();
    final total = d['total'] is num ? (d['total'] as num).toInt() : items.length;
    final pageSizeOut = d['pageSize'] is num ? (d['pageSize'] as num).toInt() : pageSize;
    return PagedMedia(
      items: items,
      total: total,
      offset: (page - 1) * pageSizeOut,
      hasMore: items.length >= pageSizeOut && (page - 1) * pageSizeOut + items.length < total,
    );
  }

  /// 删除我的图片（DELETE /api/v1/user/files/:id）。
  Future<void> deleteMyFile(String id) async {
    final clean = id.replaceAll(RegExp(r'[^0-9]'), '');
    await _api.deleteRaw('/api/v1/user/files/$clean');
  }

  /// 打标（POST /api/v1/user/files/:id/tags，body {tags:[...]}）。
  Future<void> updateFileTags(String id, List<String> tags) async {
    final clean = id.replaceAll(RegExp(r'[^0-9]'), '');
    final resp = await _api.postRaw(
      '/api/v1/user/files/$clean/tags',
      body: {'tags': tags},
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '打标失败').toString());
    }
  }

  /// 随机抽取共享库（/api/v1/random?count&type&tags，最多 10 张/次）。
  Future<List<MediaItem>> randomPool({
    int count = 10,
    String type = '',
    String tags = '',
  }) async {
    final data = await _api.getData(
      '/api/v1/random',
      query: {'count': count, 'type': type, 'tags': tags},
    ) as Map<String, dynamic>;
    final raw = data['items'] is List ? data['items'] as List : <dynamic>[];
    return raw
        .whereType<Map>()
        .map((e) => MediaItem.fromPoolJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  /// 配额。
  Future<QuotaInfo> quota() async {
    final d = await _api.getData('/api/v1/user/quota') as Map<String, dynamic>;
    return QuotaInfo.fromJson(d);
  }
}
