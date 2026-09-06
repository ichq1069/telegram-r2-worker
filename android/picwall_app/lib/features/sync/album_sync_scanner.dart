import 'package:photo_manager/photo_manager.dart';

import '../../data/local/local_db.dart';
import '../../data/models/sync_filter.dart';
import '../../data/models/upload_task.dart';
import '../upload/upload_engine.dart';

/// 相册自动同步扫描器：把相册中的图片/视频增量送入上传队列。
///
/// 幂等策略：
/// - [LocalDb.synced_assets] 记录已入队的 asset id，跨进程/跨重启去重；
/// - [AlbumSyncState.cursor] 记录本轮扫描到达的最新 asset id（进度展示）；
/// - 逐页拉取并按创建时间倒序，连续命中已同步项即提前收敛，避免整库重扫。
///
/// 扫描范围受 [SyncFilter] 约束（类型 / 大小 / 扩展名白名单）。
class AlbumSyncScanner {
  AlbumSyncScanner({required LocalDb db, required UploadEngine engine})
      : _db = db,
        _engine = engine;

  final LocalDb _db;
  final UploadEngine _engine;

  static const int _pageSize = 300;

  /// 请求相册权限；返回是否有可用访问（authorized / limited）。
  Future<bool> ensurePermission() async {
    try {
      final state = await PhotoManager.requestPermissionExtend();
      return state.hasAccess;
    } catch (_) {
      return false;
    }
  }

  /// 列出可选相册（含图片与视频）。
  Future<List<AssetPathEntity>> fetchAlbums() async {
    final paths = await PhotoManager.getAssetPathList(type: RequestType.common);
    return paths;
  }

  /// 同步指定相册。返回本轮新入队的文件数。
  Future<int> syncAlbum(
    AssetPathEntity album, {
    SyncFilter? filter,
    void Function(int newCount, int scanned)? onProgress,
  }) async {
    final f = filter ?? const SyncFilter();
    var synced = await _db.loadAllSyncedAssetIds();
    final total = await album.assetCountAsync;
    if (total <= 0) return 0;

    var newCount = 0;
    var scanned = 0;
    var consecutive = 0;
    var page = 0;
    var lastId = '';
    var done = false;

    while (!done) {
      final List<AssetEntity> assets;
      try {
        assets = await album.getAssetListPaged(page: page, size: _pageSize);
      } catch (_) {
        break; // 相册并发变更导致的整页失败，忽略本次差异
      }
      if (assets.isEmpty) break;

      final sorted = List<AssetEntity>.of(assets)
        ..sort((a, b) {
          final d = b.createDateTime.compareTo(a.createDateTime);
          return d != 0 ? d : a.id.compareTo(b.id);
        });

      for (final asset in sorted) {
        lastId = asset.id;
        if (synced.contains(asset.id)) {
          consecutive++;
          if (consecutive >= 40) {
            done = true; // 更早的项大概率已全部同步，提前收敛
            break;
          }
          continue;
        }
        consecutive = 0;
        if (!_matches(asset, f)) continue;
        scanned++;
        if (await _tryEnqueue(asset, f)) {
          synced.add(asset.id);
          await _db.markAssetSynced(asset.id);
          newCount++;
          onProgress?.call(newCount, scanned);
        }
      }

      if (!done && assets.length < _pageSize) {
        done = true;
      }
      page++;

      // 每页落一次游标（进程被杀后可从此续扫；重复项由 synced 去重兜底）
      await _db.updateAlbumSyncProgress(
        album.id,
        cursorAssetId: lastId,
      );
    }

    await _db.updateAlbumSyncProgress(
      album.id,
      cursorAssetId: lastId,
      syncedCount: newCount,
      updateLastSync: true,
    );
    return newCount;
  }

  /// 类型与扩展名白名单前置判断（不触发文件下载）。
  bool _matches(AssetEntity asset, SyncFilter f) {
    switch (f.kind) {
      case SyncMediaKind.image:
        if (asset.type != AssetType.image) return false;
      case SyncMediaKind.video:
        if (asset.type != AssetType.video) return false;
      case SyncMediaKind.both:
        break;
    }
    if (f.exts.isEmpty) return true;
    final ext = _extOf(asset.title).toLowerCase();
    return ext.isNotEmpty && f.exts.contains(ext);
  }

  /// 判断大小是否落在过滤区间内（需先取到文件字节数）。
  bool _sizeOk(int bytes, SyncFilter f) {
    if (f.minBytes > 0 && bytes < f.minBytes) return false;
    if (f.maxBytes > 0 && bytes > f.maxBytes) return false;
    return true;
  }

  Future<bool> _tryEnqueue(AssetEntity asset, SyncFilter f) async {
    try {
      final file = await asset.file;
      if (file == null || !await file.exists()) return false;

      final length = await file.length();
      if (f.sizeLimited && !_sizeOk(length, f)) return false;

      // 白名单最后校验：优先用原始标题扩展名，缺省时回退文件路径
      if (f.exts.isNotEmpty) {
        var ext = _extOf(asset.title).toLowerCase();
        if (ext.isEmpty) ext = _extOf(file.path).toLowerCase();
        if (ext.isEmpty || !f.exts.contains(ext)) return false;
      }

      final added = await _engine.enqueueFiles(
        paths: [file.path],
        source: UploadSource.gallery,
        tags: '',
        nameOf: (p) => p.split('/').last,
      );
      return added.isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  static String _extOf(String? name) {
    if (name == null || name.isEmpty) return '';
    final dot = name.lastIndexOf('.');
    if (dot < 0 || dot == name.length - 1) return '';
    final ext = name.substring(dot + 1);
    return ext.contains('/') ? '' : ext;
  }
}
