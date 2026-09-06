import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:photo_manager/photo_manager.dart';

import '../../data/local/local_db.dart';
import '../../data/models/album_sync_state.dart';
import '../../services/providers.dart';
import '../upload/upload_engine.dart';
import 'album_sync_scanner.dart';

/// 相册自动同步设置页：选择相册 → 立即同步 → 进入共享上传队列。
///
/// 与“上传”页共用 [uploadEngineProvider] 同一实例，避免双队列重复上传。
class SyncPage extends ConsumerStatefulWidget {
  const SyncPage({super.key});

  @override
  ConsumerState<SyncPage> createState() => _SyncPageState();
}

class _SyncPageState extends ConsumerState<SyncPage> {
  LocalDb? _db;
  UploadEngine? _engine;
  AlbumSyncScanner? _scanner;

  AlbumSyncState? _enabled;
  bool _ready = false;
  bool _hasPermission = false;
  bool _syncing = false;
  int _scanned = 0;
  int _newFound = 0;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _boot());
  }

  Future<void> _boot() async {
    try {
      final engine = await ref.read(uploadEngineProvider.future);
      final db = await ref.read(localDbProvider.future);
      if (!mounted) return;
      setState(() {
        _engine = engine;
        _db = db;
        _scanner = AlbumSyncScanner(db: db, engine: engine);
      });
      _engine!.addListener(_onEngine);
      final enabled = await db.getEnabledAlbum();
      if (!mounted) return;
      setState(() {
        _enabled = enabled;
        _ready = true;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _ready = true);
    }
  }

  void _onEngine() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _engine?.removeListener(_onEngine);
    super.dispose();
  }

  Future<void> _pickAlbum() async {
    final scanner = _scanner;
    if (scanner == null) return;
    final ok = await scanner.ensurePermission();
    if (!mounted) return;
    setState(() => _hasPermission = ok);
    if (!ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('请在系统设置中允许“照片与视频”访问')),
      );
      return;
    }
    final albums = await scanner.fetchAlbums();
    if (!mounted) return;
    if (albums.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('没有可同步的相册')),
      );
      return;
    }
    final chosen = await showModalBottomSheet<AssetPathEntity>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('选择要同步的相册',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
            ),
            for (final a in albums)
              ListTile(
                leading: const Icon(Icons.photo_library_outlined),
                title: Text(a.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                onTap: () => Navigator.pop(ctx, a),
              ),
          ],
        ),
      ),
    );
    if (chosen == null || !mounted) return;
    final db = _db;
    if (db == null) return;
    await db.setEnabledAlbum(chosen.id, chosen.name);
    if (!mounted) return;
    final enabled = await db.getEnabledAlbum();
    if (!mounted) return;
    setState(() {
      _enabled = enabled;
      _newFound = 0;
      _scanned = 0;
      _error = null;
    });
  }

  Future<void> _disableSync() async {
    final db = _db;
    if (db == null) return;
    await db.disableAllSyncAlbums();
    if (!mounted) return;
    setState(() {
      _enabled = null;
      _scanned = 0;
      _newFound = 0;
    });
  }

  Future<void> _runSync() async {
    final scanner = _scanner;
    final db = _db;
    final engine = _engine;
    final enabled = _enabled;
    if (scanner == null ||
        db == null ||
        engine == null ||
        enabled == null ||
        _syncing) {
      return;
    }
    setState(() {
      _syncing = true;
      _error = null;
      _scanned = 0;
      _newFound = 0;
    });
    try {
      final albums = await scanner.fetchAlbums();
      AssetPathEntity? target;
      for (final a in albums) {
        if (a.id == enabled.albumId) {
          target = a;
          break;
        }
      }
      if (target == null) {
        throw StateError('相册「${enabled.albumName}」已删除或不可访问');
      }
      final added = await scanner.syncAlbum(
        target,
        onProgress: (n, s) {
          if (mounted && (s % 25 == 0 || n % 10 == 0)) {
            setState(() {
              _newFound = n;
              _scanned = s;
            });
          }
        },
      );
      if (!mounted) return;
      setState(() => _newFound = added);
      final refreshed = await db.getEnabledAlbum();
      if (mounted && refreshed != null) setState(() => _enabled = refreshed);
      await engine.start();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(added > 0 ? '已同步 $added 张新照片' : '相册已是最新')),
        );
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('相册同步')),
      body: !_ready
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(12),
              children: [
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Row(
                          children: [
                            Icon(Icons.sync, size: 20),
                            SizedBox(width: 8),
                            Text('自动相册同步',
                                style: TextStyle(
                                    fontWeight: FontWeight.w700, fontSize: 16)),
                          ],
                        ),
                        const SizedBox(height: 8),
                        const Text(
                          '把相册中的新照片/视频自动加入上传队列，'
                          '增量去重、断点续传，也受“仅 Wi-Fi 上传”约束。',
                          style: TextStyle(fontSize: 13),
                        ),
                        const SizedBox(height: 12),
                        _AlbumRow(
                          enabled: _enabled,
                          hasPermission: _hasPermission,
                          syncing: _syncing,
                          onPick: _pickAlbum,
                          onDisable: _disableSync,
                        ),
                        if (_enabled != null) ...[
                          const SizedBox(height: 12),
                          _statusLine(context),
                          const SizedBox(height: 12),
                          SizedBox(
                            width: double.infinity,
                            child: FilledButton.icon(
                              onPressed: _syncing ? null : _runSync,
                              icon: _syncing
                                  ? const SizedBox(
                                      width: 16,
                                      height: 16,
                                      child: CircularProgressIndicator(
                                          strokeWidth: 2))
                                  : const Icon(Icons.play_arrow),
                              label: Text(_syncing ? '同步中…' : '立即同步'),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                const Card(
                  child: Padding(
                    padding: EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('说明',
                            style: TextStyle(
                                fontWeight: FontWeight.w700, fontSize: 14)),
                        SizedBox(height: 6),
                        Text(
                          '· 重复的照片不会再次上传（同一设备内以资产 ID 去重）。\n'
                          '· 上传队列与“上传”页共用，可随时查看进度。\n'
                          '· 建议开启“仅 Wi-Fi 上传”，大文件在移动网络下自动挂起。',
                          style: TextStyle(fontSize: 13),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
    );
  }

  Widget _statusLine(BuildContext context) {
    final en = _enabled;
    if (en == null) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final secondary = theme.colorScheme.onSurfaceVariant;
    final lastSync = en.lastSync;
    final busy = _syncing;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (busy)
          Text(
            '扫描中… 本次已扫 $_scanned 张 / 新增 $_newFound 张',
            style: TextStyle(fontSize: 13, color: secondary),
          )
        else if (_error != null)
          Text(
            _error!,
            style: TextStyle(fontSize: 13, color: theme.colorScheme.error),
          )
        else
          Text(
            '上次同步：${_fmtTime(lastSync)} · 累计入队 ${en.syncedCount} 张',
            style: TextStyle(fontSize: 13, color: secondary),
          ),
        if (_engine != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              '上传队列：待传 ${_engine!.queuedCount} · 上传中 ${_engine!.uploadingCount}'
              ' · 完成 ${_engine!.doneCount} · 失败 ${_engine!.failedCount}',
              style: TextStyle(fontSize: 12, color: secondary),
            ),
          ),
      ],
    );
  }

  static String _fmtTime(DateTime? t) {
    if (t == null) return '从未';
    String two(int v) => v.toString().padLeft(2, '0');
    return '${t.year}-${two(t.month)}-${two(t.day)} '
        '${two(t.hour)}:${two(t.minute)}';
  }
}

class _AlbumRow extends StatelessWidget {
  const _AlbumRow({
    required this.enabled,
    required this.hasPermission,
    required this.syncing,
    required this.onPick,
    required this.onDisable,
  });

  final AlbumSyncState? enabled;
  final bool hasPermission;
  final bool syncing;
  final VoidCallback onPick;
  final VoidCallback onDisable;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final en = enabled;
    if (en == null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            hasPermission ? '尚未启用，请选择要同步的相册。' : '首次使用需授权访问相册。',
            style: TextStyle(fontSize: 13, color: theme.colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: syncing ? null : onPick,
            icon: const Icon(Icons.add_photo_alternate_outlined, size: 18),
            label: const Text('选择相册'),
          ),
        ],
      );
    }
    return Row(
      children: [
        const Icon(Icons.photo_library_outlined, size: 20),
        const SizedBox(width: 8),
        Expanded(
          child: Text(en.albumName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w600)),
        ),
        TextButton(
          onPressed: syncing ? null : onPick,
          child: const Text('更换'),
        ),
        TextButton(
          onPressed: syncing ? null : onDisable,
          child: Text('停用', style: TextStyle(color: theme.colorScheme.error)),
        ),
      ],
    );
  }
}
