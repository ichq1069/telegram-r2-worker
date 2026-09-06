import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:photo_manager/photo_manager.dart';

import '../../data/local/local_db.dart';
import '../../data/models/album_sync_state.dart';
import '../../data/models/sync_filter.dart';
import '../../services/providers.dart';
import 'album_grid_picker.dart';
import 'sync_background.dart';
import 'sync_filter_sheet.dart';

/// 相册自动同步设置页：选相册（网格预览）→ 筛选规则 → 手动/自动后台同步。
///
/// 同步本体由前台服务（状态栏通知进度）执行；本页展示开关、规则与实时进度。
class SyncPage extends ConsumerStatefulWidget {
  const SyncPage({super.key});

  @override
  ConsumerState<SyncPage> createState() => _SyncPageState();
}

class _SyncPageState extends ConsumerState<SyncPage> {
  LocalDb? _db;
  AlbumSyncState? _enabled;
  SyncFilter _filter = const SyncFilter();
  bool _ready = false;
  bool _auto = false;
  bool _running = false;
  bool _busy = false;
  QueueSnapshot? _snap;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _boot());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _boot() async {
    try {
      final db = await ref.read(localDbProvider.future);
      final enabled = await db.getEnabledAlbum();
      final filter = await db.loadSyncFilter();
      final auto = await db.syncMeta(kMetaAutoSync);
      if (!mounted) return;
      setState(() {
        _db = db;
        _enabled = enabled;
        _filter = filter;
        _auto = auto == '1';
        _ready = true;
      });
      await _refreshRunning();
      _poll = Timer.periodic(const Duration(seconds: 1), (_) => _pollTick());
    } catch (_) {
      if (mounted) setState(() => _ready = true);
    }
  }

  Future<void> _pollTick() async {
    final db = _db;
    if (db == null) return;
    await _refreshRunning();
  }

  Future<void> _refreshRunning() async {
    final db = _db;
    if (db == null) return;
    final running = await db.isSyncRunning();
    final snap = await db.queueSnapshot();
    final enabled = await db.getEnabledAlbum();
    if (!mounted) return;
    setState(() {
      _running = running;
      _snap = snap;
      if (enabled != null) _enabled = enabled;
    });
  }

  Future<void> _pickAlbum() async {
    final db = _db;
    if (db == null) return;
    try {
      final state = await PhotoManager.requestPermissionExtend();
      if (!mounted) return;
      if (!state.hasAccess) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('请在系统设置中允许“照片与视频”访问')),
        );
        return;
      }
      final albums =
          await PhotoManager.getAssetPathList(type: RequestType.common);
      if (!mounted) return;
      if (albums.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('没有可同步的相册')),
        );
        return;
      }
      final chosen = await showAlbumGridPicker(context, albums: albums);
      if (chosen == null || !mounted) return;
      await db.setEnabledAlbum(chosen.id, chosen.name);
      await _refreshRunning();
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('读取相册失败，请稍后重试')),
        );
      }
    }
  }

  Future<void> _disableAlbum() async {
    final db = _db;
    if (db == null || _running) return;
    await db.disableAllSyncAlbums();
    if (!mounted) return;
    setState(() => _enabled = null);
  }

  Future<void> _editFilter() async {
    final db = _db;
    if (db == null) return;
    final next = await SyncFilterSheet.show(context, initial: _filter);
    if (next == null) return;
    await db.saveSyncFilter(next);
    if (mounted) setState(() => _filter = next);
  }

  Future<void> _toggleAuto(bool value) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      if (value) {
        await SyncService.enableAuto();
      } else {
        await SyncService.disableAuto();
        if (_running) await SyncService.stopPass();
      }
      if (mounted) setState(() => _auto = value);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _startNow() async {
    if (_busy || _running) return;
    setState(() => _busy = true);
    final ok = await SyncService.startPass();
    if (mounted) {
      setState(() => _busy = false);
      if (!ok) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('同步已在运行或相册未配置')),
        );
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('已开始后台同步，进度见状态栏通知')),
        );
      }
    }
    await _refreshRunning();
  }

  Future<void> _stopNow() async {
    await SyncService.stopPass();
    await _refreshRunning();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final secondary = theme.colorScheme.onSurfaceVariant;
    return Scaffold(
      appBar: AppBar(title: const Text('相册同步')),
      body: !_ready
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(12),
              children: [
                Card(
                  child: SwitchListTile(
                    secondary: const Icon(Icons.sync),
                    title: const Text('自动同步'),
                    subtitle: Text(
                      _auto ? '每约 15 分钟在后台检查并同步新照片' : '开启后允许后台自动检查',
                    ),
                    value: _auto,
                    onChanged: _busy ? null : _toggleAuto,
                  ),
                ),
                const SizedBox(height: 12),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('同步相册',
                            style: TextStyle(
                                fontWeight: FontWeight.w700,
                                color: secondary,
                                fontSize: 13)),
                        const SizedBox(height: 8),
                        if (_enabled == null)
                          OutlinedButton.icon(
                            onPressed: _running ? null : _pickAlbum,
                            icon: const Icon(Icons.add_photo_alternate_outlined,
                                size: 18),
                            label: const Text('选择要同步的相册'),
                          )
                        else
                          Row(
                            children: [
                              const Icon(Icons.photo_library_outlined),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  _enabled!.albumName,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style:
                                      const TextStyle(fontWeight: FontWeight.w600),
                                ),
                              ),
                              TextButton(
                                onPressed: _running ? null : _pickAlbum,
                                child: const Text('更换'),
                              ),
                              TextButton(
                                onPressed: _running ? null : _disableAlbum,
                                child: Text('停用',
                                    style:
                                        TextStyle(color: theme.colorScheme.error)),
                              ),
                            ],
                          ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.filter_alt_outlined),
                    title: const Text('同步筛选'),
                    subtitle: Text(
                      _filterSummary(),
                      style: TextStyle(fontSize: 12, color: secondary),
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: _running ? null : _editFilter,
                  ),
                ),
                const SizedBox(height: 12),
                if (_enabled != null) ...[
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Icon(_running
                                  ? Icons.sync
                                  : Icons.cloud_done_outlined,
                                  size: 20,
                                  color: theme.colorScheme.primary),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  _running ? '后台同步进行中…' : '未在同步',
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w700, fontSize: 15),
                                ),
                              ),
                              if (_running)
                                TextButton(
                                  onPressed: _stopNow,
                                  child: Text('停止',
                                      style: TextStyle(
                                          color: theme.colorScheme.error)),
                                ),
                            ],
                          ),
                          const SizedBox(height: 10),
                          if (_running)
                            const LinearProgressIndicator(minHeight: 4)
                          else
                            const SizedBox(height: 4),
                          const SizedBox(height: 10),
                          _statusLines(theme),
                          const SizedBox(height: 12),
                          SizedBox(
                            width: double.infinity,
                            child: FilledButton.icon(
                              onPressed: _busy || _running ? null : _startNow,
                              icon: _busy
                                  ? const SizedBox(
                                      width: 16,
                                      height: 16,
                                      child: CircularProgressIndicator(
                                          strokeWidth: 2))
                                  : const Icon(Icons.play_arrow),
                              label: Text(
                                  _running ? '同步运行中' : '立即后台同步一次'),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                ],
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
                          '· 同步在前台服务中执行，进度显示在系统状态栏通知。\n'
                          '· 重复照片不会上传；筛选不满足的文件直接跳过。\n'
                          '· 自动同步需要“通知”权限，请勿在系统设置中关闭。',
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

  Widget _statusLines(ThemeData theme) {
    final secondary = theme.colorScheme.onSurfaceVariant;
    final snap = _snap;
    final en = _enabled;
    final last = en?.lastSync;
    final lines = <String>[
      '上次同步：${_fmtTime(last)}',
      if (snap != null)
        '上传队列：待传 ${snap.queued} · 上传中 ${snap.uploading}'
            ' · 完成 ${snap.done} · 失败 ${snap.failed}',
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final l in lines)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(l, style: TextStyle(fontSize: 12, color: secondary)),
          ),
      ],
    );
  }

  String _filterSummary() {
    final parts = <String>[_filter.kind.label];
    if (_filter.minBytes > 0 || _filter.maxBytes > 0) {
      final min = _filter.minBytes / (1024 * 1024);
      final max = _filter.maxBytes / (1024 * 1024);
      if (_filter.minBytes > 0 && _filter.maxBytes > 0) {
        parts.add('${min.toStringAsFixed(min % 1 == 0 ? 0 : 1)}–${max.toStringAsFixed(max % 1 == 0 ? 0 : 1)}MB');
      } else if (_filter.minBytes > 0) {
        parts.add('≥${min.toStringAsFixed(min % 1 == 0 ? 0 : 1)}MB');
      } else {
        parts.add('≤${max.toStringAsFixed(max % 1 == 0 ? 0 : 1)}MB');
      }
    }
    if (_filter.exts.isNotEmpty) {
      parts.add('仅 ${_filter.exts.join('/')}');
    }
    if (parts.length == 1) return '不限制（${parts.first}）';
    return parts.join(' · ');
  }

  static String _fmtTime(DateTime? t) {
    if (t == null) return '从未';
    String two(int v) => v.toString().padLeft(2, '0');
    return '${t.year}-${two(t.month)}-${two(t.day)} '
        '${two(t.hour)}:${two(t.minute)}';
  }
}
