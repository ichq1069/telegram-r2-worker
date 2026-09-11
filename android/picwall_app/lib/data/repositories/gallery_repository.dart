import 'package:dio/dio.dart';
import 'package:http_parser/http_parser.dart';

import '../../services/api_client.dart';
import '../models/admin_file.dart';
import '../models/media_item.dart';
import '../models/pool_item.dart';
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

  /// 共享库 /gallery/data?api_key&tags&type&level&sort&limit&offset
  /// [level] 内容等级过滤（'' 不限，服务端默认返回密钥可见全部级别）；
  /// [oldestFirst] true=按时间正序(最旧在前)，false=倒序(最新在前)。
  Future<PagedMedia> galleryData({
    String tags = '',
    String type = '',
    String level = '',
    bool oldestFirst = false,
    int limit = 60,
    int offset = 0,
  }) async {
    final data = await _api.getData(
      '/gallery/data',
      query: {
        'tags': tags,
        'type': type,
        if (level.isNotEmpty) 'level': level,
        'sort': oldestFirst ? 'asc' : 'desc',
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

  /// 拉取当前账号已上传文件的“云端签名”（文件名|大小，小写归一）。
  ///
  /// 相册同步每轮前先比对这份清单，文件已存在则跳过入队，避免换机/重装
  /// 后本地去重记录丢失导致的重复上传。page_size 用服务端上限 100，
  /// 最多翻 [maxPages] 页（默认 200 页 ≈ 2 万文件）作为安全阀。
  Future<Set<String>> fetchCloudUploadSignatures({int maxPages = 200}) async {
    const pageSize = 100;
    final sigs = <String>{};
    var page = 1;
    while (page <= maxPages) {
      final d = await _api.getRaw(
        '/api/v1/user/files',
        query: {'page': page, 'page_size': pageSize},
      );
      if (d['ok'] != true) break;
      final raw = d['data'];
      if (raw is! List || raw.isEmpty) break;
      var matched = 0;
      for (final e in raw) {
        if (e is! Map) continue;
        matched++;
        final name = (e['file_name'] ?? e['title'] ?? '')
            .toString()
            .trim()
            .toLowerCase();
        if (name.isEmpty) continue;
        final size =
            e['file_size'] is num ? (e['file_size'] as num).toInt() : 0;
        sigs.add('$name|$size');
      }
      final total = d['total'] is num ? (d['total'] as num).toInt() : 0;
      final fetched = (page - 1) * pageSize + matched;
      if (fetched >= total || matched < pageSize) break;
      page++;
    }
    return sigs;
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

  /// 逐张上传单个本地文件。
  /// 上传成功返回 true；失败（含后端 results 里的 error 条目）抛 ApiException。
  Future<void> uploadLocalFile({
    required String filePath,
    required String fileName,
    String tags = '',
  }) async {
    final ext = fileName.contains('.')
        ? fileName.split('.').last.toLowerCase()
        : '';
    final MediaType? mt = switch (ext) {
      'jpg' || 'jpeg' => MediaType('image', 'jpeg'),
      'png' => MediaType('image', 'png'),
      'webp' => MediaType('image', 'webp'),
      'gif' => MediaType('image', 'gif'),
      'heic' || 'heif' => MediaType('image', 'heic'),
      'mp4' => MediaType('video', 'mp4'),
      'mov' => MediaType('video', 'quicktime'),
      'webm' => MediaType('video', 'webm'),
      _ => null,
    };
    final mp = await MultipartFile.fromFile(
      filePath,
      filename: fileName,
      contentType: mt,
    );
    final query = tags.trim().isEmpty ? null : {'tags': tags.trim()};
    final resp = await _api.postMultipart(
      '/api/v1/user/upload',
      files: [mp],
      query: query,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '上传失败').toString());
    }
    final data = resp['data'];
    if (data is Map) {
      final results = data['results'];
      if (results is List && results.isNotEmpty) {
        final first = results.first;
        if (first is Map && (first['error'] as String?)?.isNotEmpty == true) {
          throw ApiException((first['error'] as String).toString());
        }
        if (first is Map && first['id'] != null) return;
      }
    }
    throw ApiException('上传失败：服务器未返回文件结果');
  }

  /// 管理员总览统计。密钥校验规则见 worker.js：
  /// `api_key`（query 或 X-API-Key header）=== env.API_KEY 才可访问 /admin/api/*。
  Future<Map<String, dynamic>> adminStats(String adminKey) async {
    final body = await _api.getRaw(
      '/admin/api/stats',
      query: {'api_key': adminKey},
      noKey: true,
    );
    if (body['ok'] != true) {
      throw ApiException(
        (body['error'] ?? '管理员密钥无效').toString(),
        hint: body['hint']?.toString(),
      );
    }
    final d = body['data'];
    if (d is Map) return Map<String, dynamic>.from(d);
    return const {};
  }

  Map<String, dynamic> _adminQuery(String adminKey) => {'api_key': adminKey};

  /// 回收站列表（GET /admin/api/trash）。
  Future<AdminListPage<AdminFile>> adminTrash(
    String adminKey, {
    int page = 1,
    int pageSize = 20,
  }) async {
    final resp = await _api.getRaw(
      '/admin/api/trash',
      query: {..._adminQuery(adminKey), 'page': page, 'page_size': pageSize},
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '获取回收站失败').toString());
    }
    return _adminPage(resp, AdminFile.fromJson);
  }

  /// 回收站恢复（POST /admin/api/trash/restore，ids 空数组 = 恢复全部）。
  Future<int> adminTrashRestore(
    String adminKey, {
    List<String> ids = const [],
  }) async {
    final resp = await _api.postRaw(
      '/admin/api/trash/restore',
      body: {'ids': ids},
      query: _adminQuery(adminKey),
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '恢复失败').toString());
    }
    return resp['restored'] is num ? (resp['restored'] as num).toInt() : 0;
  }

  /// 彻底删除回收站文件（DELETE /admin/api/files?...&purge=1）。
  /// [all]=true 时 purge=1&all=1 清空整个回收站。
  Future<int> adminTrashPurge(
    String adminKey, {
    List<String> ids = const [],
    bool all = false,
  }) async {
    final resp = await _api.deleteRaw(
      '/admin/api/files',
      query: {
        ..._adminQuery(adminKey),
        if (all) ...{'purge': '1', 'all': '1'},
        if (!all && ids.isNotEmpty) ...{'ids': ids.join(',')},
      },
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '删除失败').toString());
    }
    return resp['deleted'] is num ? (resp['deleted'] as num).toInt() : 0;
  }

  /// 未入库列表（GET /admin/api/unsaved，processing_state != completed）。
  Future<AdminListPage<AdminFile>> adminUnsaved(
    String adminKey, {
    int page = 1,
    int pageSize = 20,
  }) async {
    final resp = await _api.getRaw(
      '/admin/api/unsaved',
      query: {..._adminQuery(adminKey), 'page': page, 'page_size': pageSize},
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '获取未入库列表失败').toString());
    }
    return _adminPage(resp, AdminFile.fromJson);
  }

  /// 未入库重试（POST /admin/api/unsaved/retry）。
  /// [ids] 非空重试指定记录；为空数组则服务端按默认批量兜底（8 条），
  /// 如需全部重试传 [all]=true（服务端最多 50 条）。
  Future<({int started, int total})> adminUnsavedRetry(
    String adminKey, {
    List<String> ids = const [],
    bool all = false,
  }) async {
    final resp = await _api.postRaw(
      '/admin/api/unsaved/retry',
      body: all ? {'all': true} : {'ids': ids},
      query: _adminQuery(adminKey),
      noKey: true,
      long: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '重试失败').toString());
    }
    return (
      started: resp['started'] is num ? (resp['started'] as num).toInt() : 0,
      total: resp['total'] is num ? (resp['total'] as num).toInt() : 0,
    );
  }

  AdminListPage<T> _adminPage<T>(
    Map<String, dynamic> resp,
    T Function(Map<String, dynamic>) parse,
  ) {
    final d = resp['data'];
    if (d is Map) return AdminListPage.fromJson(Map<String, dynamic>.from(d), parse);
    return AdminListPage<T>(
      items: const [],
      total: 0,
      page: 1,
      totalPages: 1,
      pageSize: 0,
    );
  }

  /// R2 对象列表（GET /admin/api/r2/list?limit&prefix&cursor）。
  Future<R2ListPage> adminR2List(
    String adminKey, {
    int limit = 200,
    String prefix = '',
    String? cursor,
  }) async {
    final resp = await _api.getRaw(
      '/admin/api/r2/list',
      query: {
        ..._adminQuery(adminKey),
        'limit': limit,
        if (prefix.isNotEmpty) 'prefix': prefix,
        if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
      },
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '获取 R2 列表失败').toString());
    }
    final d = resp['data'];
    if (d is Map) return R2ListPage.fromJson(Map<String, dynamic>.from(d));
    throw ApiException('服务器返回结构异常');
  }

  /// 删除孤儿对象（POST /admin/api/r2/delete，仅允许 state=orphan）。
  Future<({int deleted, List<String> refused})> adminR2Delete(
    String adminKey, {
    required List<String> keys,
  }) async {
    final resp = await _api.postRaw(
      '/admin/api/r2/delete',
      body: {'keys': keys},
      query: _adminQuery(adminKey),
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '删除失败').toString());
    }
    final data = resp['data'];
    if (data is! Map) throw ApiException('服务器返回结构异常');
    final deletedRaw = data['deleted'];
    final refusedRaw = data['refused'];
    final refusedDesc = <String>[];
    if (refusedRaw is List) {
      for (final e in refusedRaw) {
        if (e is Map) {
          final key = (e['key'] ?? '').toString();
          final reason = (e['error'] ?? e['state'] ?? '').toString();
          refusedDesc.add(reason.isEmpty ? key : '$key($reason)');
        }
      }
    }
    return (
      deleted: deletedRaw is List ? deletedRaw.length : 0,
      refused: refusedDesc,
    );
  }

  /// 解析采集页（POST /admin/api/scrape/analyze）。
  /// 返回 {url,title,count,total,filtered,images:[...]}。
  Future<Map<String, dynamic>> adminScrapeAnalyze(
    String adminKey, {
    required String url,
    String cookie = '',
    String ignoreKw = '',
    String ignoreExt = '',
    String must = '',
  }) async {
    final resp = await _api.postRaw(
      '/admin/api/scrape/analyze',
      body: {
        'url': url,
        'cookie': cookie,
        'ignore_kw': ignoreKw,
        'ignore_ext': ignoreExt,
        'must': must,
      },
      query: _adminQuery(adminKey),
      noKey: true,
      long: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '解析失败').toString());
    }
    final d = resp['data'];
    if (d is Map) return Map<String, dynamic>.from(d);
    throw ApiException('服务器返回结构异常');
  }

  /// 单张抓取入库（POST /admin/api/scrape/grab_one）。
  /// status: added/exists/ignored/failed；reason 为补充说明。
  Future<({String status, String reason})> adminScrapeGrabOne(
    String adminKey, {
    required String url,
    required String title,
    String tags = '',
    String level = 'pt',
    String ref = '',
    String ignoreKw = '',
    String ignoreExt = '',
    String must = '',
    int? maxMb,
    String cookie = '',
    int seq = 0,
  }) async {
    final body = <String, dynamic>{
      'url': url,
      'title': title,
      'tags': tags,
      'level': level,
      'ref': ref,
      'ignore_kw': ignoreKw,
      'ignore_ext': ignoreExt,
      'must': must,
      'cookie': cookie,
      'seq': seq,
    };
    if (maxMb != null && maxMb > 0) body['max_mb'] = maxMb;
    final resp = await _api.postRaw(
      '/admin/api/scrape/grab_one',
      body: body,
      query: _adminQuery(adminKey),
      noKey: true,
      long: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '抓取失败').toString());
    }
    final d = resp['data'];
    if (d is Map) {
      return (
        status: (d['status'] ?? 'failed').toString(),
        reason: (d['reason'] ?? '').toString(),
      );
    }
    throw ApiException('服务器返回结构异常');
  }

  /// 读取采集域名规则组（GET /admin/api/scrape/rule-groups）。
  Future<List<RuleGroup>> adminRuleGroups(String adminKey) async {
    final resp = await _api.getRaw(
      '/admin/api/scrape/rule-groups',
      query: _adminQuery(adminKey),
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '读取规则组失败').toString());
    }
    return _groupsOf(resp['data']);
  }

  /// 全量覆盖保存采集规则组（POST /admin/api/scrape/rule-groups）。
  Future<List<RuleGroup>> adminRuleGroupsSave(
    String adminKey,
    List<RuleGroup> groups,
  ) async {
    final resp = await _api.postRaw(
      '/admin/api/scrape/rule-groups',
      body: {'groups': [for (final g in groups) g.toJson()]},
      query: _adminQuery(adminKey),
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '保存规则组失败').toString());
    }
    return _groupsOf(resp['data']);
  }

  List<RuleGroup> _groupsOf(dynamic d) {
    final groups = <RuleGroup>[];
    if (d is Map) {
      final raw = d['groups'];
      if (raw is List) {
        for (final e in raw) {
          if (e is Map) {
            groups.add(RuleGroup.fromJson(Map<String, dynamic>.from(e)));
          }
        }
      }
    }
    return groups;
  }

  /// files 全量库检索（GET /admin/api/files，支持 type/keyword/state 过滤）。
  Future<(int total, List<AdminFileRecord> items)> adminFilesSearch(
    String adminKey, {
    int page = 1,
    int pageSize = 40,
    String keyword = '',
    String type = '',
    String state = '',
  }) async {
    final resp = await _api.getRaw(
      '/admin/api/files',
      query: {
        ..._adminQuery(adminKey),
        'page': page,
        'page_size': pageSize,
        if (keyword.trim().isNotEmpty) 'keyword': keyword.trim(),
        if (type.isNotEmpty) 'type': type,
        if (state.isNotEmpty) 'state': state,
      },
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '检索失败').toString());
    }
    final d = resp['data'];
    final items = <AdminFileRecord>[];
    if (d is Map) {
      final raw = d['items'];
      if (raw is List) {
        for (final e in raw) {
          if (e is Map) {
            items.add(AdminFileRecord.fromJson(Map<String, dynamic>.from(e)));
          }
        }
      }
    }
    return (
      d is Map && d['total'] is num ? (d['total'] as num).toInt() : items.length,
      items,
    );
  }

  // ─── 共享库 / 私密库管理 ────────────────────────────────────────────

  /// 共享库/私密库列表（GET /admin/api/pool）。
  Future<(int total, List<PoolItem> items)> adminPoolList(
    String adminKey, {
    int isPrivate = 0,
    String keyword = '',
    String tags = '',
    String level = '',
    String orderBy = 'created_at',
    String order = 'desc',
    int limit = 50,
    int offset = 0,
  }) async {
    final resp = await _api.getRaw(
      '/admin/api/pool',
      query: {
        ..._adminQuery(adminKey),
        'is_private': isPrivate,
        if (keyword.trim().isNotEmpty) 'keyword': keyword.trim(),
        if (tags.isNotEmpty) 'tags': tags,
        if (level.isNotEmpty) 'level': level,
        'order_by': orderBy,
        'order': order,
        'limit': limit,
        'offset': offset,
      },
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '获取列表失败').toString());
    }
    final d = resp['data'];
    final items = <PoolItem>[];
    if (d is List) {
      for (final e in d) {
        if (e is Map) items.add(PoolItem.fromJson(Map<String, dynamic>.from(e)));
      }
    }
    return (resp['total'] is num ? (resp['total'] as num).toInt() : items.length, items);
  }

  /// 私密库列表（GET /admin/api/private-pool）。
  Future<(int total, List<PoolItem> items)> adminPrivatePoolList(
    String adminKey, {
    String keyword = '',
    String tags = '',
    String orderBy = 'created_at',
    String order = 'desc',
    int limit = 50,
    int offset = 0,
  }) async {
    final resp = await _api.getRaw(
      '/admin/api/private-pool',
      query: {
        ..._adminQuery(adminKey),
        if (keyword.trim().isNotEmpty) 'keyword': keyword.trim(),
        if (tags.isNotEmpty) 'tags': tags,
        'order_by': orderBy,
        'order': order,
        'limit': limit,
        'offset': offset,
      },
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '获取私密库失败').toString());
    }
    final d = resp['data'];
    final items = <PoolItem>[];
    if (d is List) {
      for (final e in d) {
        if (e is Map) items.add(PoolItem.fromJson(Map<String, dynamic>.from(e)));
      }
    }
    return (resp['total'] is num ? (resp['total'] as num).toInt() : items.length, items);
  }

  /// 批量更新 pool 条目（POST /admin/api/pool/batch）。
  Future<void> adminPoolBatch(
    String adminKey, {
    required List<int> ids,
    String? level,
    int? enabled,
    int? isPrivate,
  }) async {
    final body = <String, dynamic>{'ids': ids};
    if (level != null) body['level'] = level;
    if (enabled != null) body['enabled'] = enabled;
    if (isPrivate != null) body['is_private'] = isPrivate;
    final resp = await _api.postRaw(
      '/admin/api/pool/batch',
      body: body,
      query: _adminQuery(adminKey),
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '批量更新失败').toString());
    }
  }

  /// 批量设置 pool 标签（POST /admin/api/pool/tags）。
  Future<void> adminPoolTags(
    String adminKey, {
    required List<int> ids,
    required List<String> tags,
    String mode = 'set',
  }) async {
    final resp = await _api.postRaw(
      '/admin/api/pool/tags',
      body: {'ids': ids, 'tags': tags, 'mode': mode},
      query: _adminQuery(adminKey),
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '打标失败').toString());
    }
  }

  /// 批量删除 pool 条目（POST /admin/api/pool/batch-delete）。
  Future<void> adminPoolBatchDelete(
    String adminKey, {
    required List<int> ids,
  }) async {
    final resp = await _api.postRaw(
      '/admin/api/pool/batch-delete',
      body: {'ids': ids},
      query: _adminQuery(adminKey),
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '删除失败').toString());
    }
  }

  /// TG → 共享库（POST /admin/api/pool/from-tg）。
  Future<({int added, int skipped, int duplicated})> adminPoolFromTg(
    String adminKey, {
    required List<int> ids,
    List<String>? tags,
    String? level,
  }) async {
    final body = <String, dynamic>{'ids': ids};
    if (tags != null) body['tags'] = tags;
    if (level != null) body['level'] = level;
    final resp = await _api.postRaw(
      '/admin/api/pool/from-tg',
      body: body,
      query: _adminQuery(adminKey),
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '入库失败').toString());
    }
    final d = resp['data'];
    return (
      added: d is Map && d['added'] is num ? (d['added'] as num).toInt() : 0,
      skipped: d is Map && d['skipped'] is num ? (d['skipped'] as num).toInt() : 0,
      duplicated: d is Map && d['duplicated'] is num ? (d['duplicated'] as num).toInt() : 0,
    );
  }

  /// TG → 私密库（POST /admin/api/private-pool/from-tg）。
  Future<({int added, int skipped, int duplicated})> adminPrivatePoolFromTg(
    String adminKey, {
    required List<int> ids,
    List<String>? tags,
  }) async {
    final body = <String, dynamic>{'ids': ids};
    if (tags != null) body['tags'] = tags;
    final resp = await _api.postRaw(
      '/admin/api/private-pool/from-tg',
      body: body,
      query: _adminQuery(adminKey),
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '入库私密库失败').toString());
    }
    final d = resp['data'];
    return (
      added: d is Map && d['added'] is num ? (d['added'] as num).toInt() : 0,
      skipped: d is Map && d['skipped'] is num ? (d['skipped'] as num).toInt() : 0,
      duplicated: d is Map && d['duplicated'] is num ? (d['duplicated'] as num).toInt() : 0,
    );
  }

  /// 预设标签库（GET /admin/api/tags）。
  Future<List<({String tag, int count})>> adminTagsList(String adminKey) async {
    final resp = await _api.getRaw(
      '/admin/api/tags',
      query: _adminQuery(adminKey),
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '获取标签库失败').toString());
    }
    final raw = resp['data'];
    final items = <({String tag, int count})>[];
    if (raw is List) {
      for (final e in raw) {
        if (e is Map) {
          items.add((
            tag: (e['tag'] ?? '').toString(),
            count: e['count'] is num ? (e['count'] as num).toInt() : 0,
          ));
        }
      }
    }
    return items;
  }

  /// 批量设置文件标签（POST /admin/api/files/tags）。
  Future<void> adminFilesTags(
    String adminKey, {
    required List<int> ids,
    required List<String> tags,
    String mode = 'set',
  }) async {
    final resp = await _api.postRaw(
      '/admin/api/files/tags',
      body: {'ids': ids, 'tags': tags, 'mode': mode},
      query: _adminQuery(adminKey),
      noKey: true,
    );
    if (resp['ok'] != true) {
      throw ApiException((resp['error'] ?? '打标失败').toString());
    }
  }
}
