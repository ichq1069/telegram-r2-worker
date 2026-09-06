/// 相册同步状态（每个相册一行，仅一行 enabled=1 为当前启用相册）。
class AlbumSyncState {
  const AlbumSyncState({
    required this.albumId,
    required this.albumName,
    this.enabled = false,
    this.cursorAssetId,
    this.lastSync,
    this.syncedCount = 0,
  });

  final String albumId;
  final String albumName;
  final bool enabled;

  /// 游标：最近一次扫描到达的 asset id（断点/进度记录，去重另靠 synced_assets）。
  final String? cursorAssetId;
  final DateTime? lastSync;
  final int syncedCount;

  AlbumSyncState copyWith({
    bool? enabled,
    String? cursorAssetId,
    DateTime? lastSync,
    int? syncedCount,
  }) {
    return AlbumSyncState(
      albumId: albumId,
      albumName: albumName,
      enabled: enabled ?? this.enabled,
      cursorAssetId: cursorAssetId ?? this.cursorAssetId,
      lastSync: lastSync ?? this.lastSync,
      syncedCount: syncedCount ?? this.syncedCount,
    );
  }

  Map<String, Object?> toDb() => {
        'album_id': albumId,
        'album_name': albumName,
        'enabled': enabled ? 1 : 0,
        'cursor': cursorAssetId,
        'last_sync': lastSync?.millisecondsSinceEpoch,
        'synced_count': syncedCount,
      };

  factory AlbumSyncState.fromDb(Map<String, Object?> r) {
    final ts = (r['last_sync'] as num?)?.toInt() ?? 0;
    return AlbumSyncState(
      albumId: (r['album_id'] as String?) ?? '',
      albumName: (r['album_name'] as String?) ?? '',
      enabled: ((r['enabled'] as num?) ?? 0) == 1,
      cursorAssetId: r['cursor'] as String?,
      lastSync: ts > 0 ? DateTime.fromMillisecondsSinceEpoch(ts) : null,
      syncedCount: ((r['synced_count'] as num?) ?? 0).toInt(),
    );
  }
}
