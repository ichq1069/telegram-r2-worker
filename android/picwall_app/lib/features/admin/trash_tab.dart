import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../data/models/admin_file.dart';
import '../../services/providers.dart';

/// 回收站 / 未入库 双列表运维页：
/// - 回收站（软删，deleted_at 非空）：勾选/全部恢复；
/// - 未入库（processing_state != completed）：勾选/全部重试转存。
class TrashTab extends ConsumerStatefulWidget {
  const TrashTab({super.key, required this.adminKey});

  final String adminKey;

  @override
  ConsumerState<TrashTab> createState() => _TrashTabState();
}

class _TrashTabState extends ConsumerState<TrashTab> {
  static const _titles = ['回收站', '未入库'];

  int _kind = 0;
  final List<AdminFile> _rows = [];
  bool _loading = false;
  String? _error;
  int _page = 1;
  int _totalPages = 1;
  int _total = 0;
  final Set<String> _sel = {};
  bool _acting = false;
  final ScrollController _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  bool get _hasMore => _page < _totalPages;

  Future<void> _load() => _fetch(1, replace: true);

  Future<void> _loadMore() {
    if (_loading || !_hasMore) return Future.value();
    return _fetch(_page + 1, replace: false);
  }

  Future<void> _fetch(int page, {required bool replace}) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final repo = ref.read(galleryRepositoryProvider);
      final result = _kind == 0
          ? await repo.adminTrash(widget.adminKey, page: page, pageSize: 20)
          : await repo.adminUnsaved(widget.adminKey, page: page, pageSize: 20);
      if (!mounted) return;
      setState(() {
        if (replace) {
          _rows
            ..clear()
            ..addAll(result.items);
        } else {
          _rows.addAll(result.items);
        }
        _page = result.page;
        _totalPages = result.totalPages;
        _total = result.total;
        _sel.clear();
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _switchKind(int kind) {
    if (kind == _kind) return;
    setState(() {
      _kind = kind;
      _rows.clear();
      _sel.clear();
      _page = 1;
      _totalPages = 1;
      _total = 0;
      _error = null;
    });
    _load();
  }

  bool get _isTrash => _kind == 0;

  void _toggle(String id) {
    setState(() {
      if (!_sel.remove(id)) _sel.add(id);
    });
  }

  void _togglePage() {
    final ids = _rows.map((r) => r.id).toList();
    final allOn = ids.isNotEmpty && ids.every(_sel.contains);
    setState(() {
      if (allOn) {
        _sel.removeAll(ids);
      } else {
        _sel.addAll(ids);
      }
    });
  }

  Future<void> _restoreSel() async {
    final ids = _sel.toList();
    if (ids.isEmpty) return;
    await _act(
      () => ref
          .read(galleryRepositoryProvider)
          .adminTrashRestore(widget.adminKey, ids: ids),
      '已恢复',
    );
  }

  Future<void> _restoreAll() async {
    final ok = await _confirm('恢复全部回收站', '将清除所有文件的删除标记并重新可见，确定？');
    if (!ok) return;
    await _act(
      () => ref
          .read(galleryRepositoryProvider)
          .adminTrashRestore(widget.adminKey, ids: const []),
      '已恢复',
    );
  }

  Future<void> _retrySel() async {
    final ids = _sel.toList();
    if (ids.isEmpty) return;
    await _act(
      () async => (await ref
              .read(galleryRepositoryProvider)
              .adminUnsavedRetry(widget.adminKey, ids: ids))
          .started,
      '已提交重试',
    );
  }

  Future<void> _retryAll() async {
    final ok = await _confirm('全部重试未入库', '将把待处理/失败/下载中的记录重新入队转存，确定？');
    if (!ok) return;
    await _act(
      () async => (await ref
              .read(galleryRepositoryProvider)
              .adminUnsavedRetry(widget.adminKey, all: true))
          .started,
      '已提交重试',
    );
  }

  Future<void> _purgeSel() async {
    final ids = _sel.toList();
    if (ids.isEmpty) return;
    final ok = await _confirm('彻底删除 ${ids.length} 条',
        '将从 D1 删除记录并回收对应 R2 对象（不可恢复），确定？');
    if (!ok) return;
    await _act(
      () => ref
          .read(galleryRepositoryProvider)
          .adminTrashPurge(widget.adminKey, ids: ids),
      '已彻底删除',
    );
  }

  Future<void> _purgeAll() async {
    final ok = await _confirm('清空回收站',
        '将彻底删除回收站内全部文件与对应 R2 对象，此操作不可恢复，确定？');
    if (!ok) return;
    await _act(
      () => ref
          .read(galleryRepositoryProvider)
          .adminTrashPurge(widget.adminKey, all: true),
      '已彻底删除',
    );
  }

  void _onBulk(String value) {
    switch (value) {
      case 'restoreAll':
        _restoreAll();
        break;
      case 'purgeAll':
        _purgeAll();
        break;
      case 'retryAll':
        _retryAll();
        break;
    }
  }

  Future<bool> _confirm(String title, String content) async {
    final r = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(content),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('确定'),
          ),
        ],
      ),
    );
    return r ?? false;
  }

  Future<void> _act(Future<int> Function() run, String doneText) async {
    setState(() => _acting = true);
    try {
      final n = await run();
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('$doneText：$n 条')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
          child: SegmentedButton<int>(
            segments: const [
              ButtonSegment(value: 0, label: Text('回收站')),
              ButtonSegment(value: 1, label: Text('未入库')),
            ],
            selected: {_kind},
            onSelectionChanged: (s) => _switchKind(s.first),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  _loading ? '加载中…' : '共 ${fmtCount(_total)} 条',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
              if (_rows.isNotEmpty)
                TextButton(
                  onPressed: _togglePage,
                  child: const Text('全选本页'),
                ),
              if (_rows.isNotEmpty)
                PopupMenuButton<String>(
                  tooltip: '批量操作',
                  onSelected: _onBulk,
                  itemBuilder: (_) => [
                    if (_isTrash) ...[
                      const PopupMenuItem(value: 'restoreAll', child: Text('恢复全部')),
                      const PopupMenuItem(value: 'purgeAll', child: Text('清空回收站')),
                    ] else
                      const PopupMenuItem(value: 'retryAll', child: Text('全部重试')),
                  ],
                ),
            ],
          ),
        ),
        Expanded(
          child: _buildBody(),
        ),
        if (_rows.isNotEmpty) _buildActionBar(context),
      ],
    );
  }

  Widget _buildBody() {
    final theme = Theme.of(context);
    if (_loading && _rows.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_rows.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            _error ?? (_isTrash ? '回收站是空的' : '没有待处理的文件'),
            style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        controller: _scroll,
        padding: const EdgeInsets.only(bottom: 8),
        itemCount: _rows.length,
        itemBuilder: (context, i) {
          final f = _rows[i];
          return CheckboxListTile(
            value: _sel.contains(f.id),
            onChanged: (_) => _toggle(f.id),
            controlAffinity: ListTileControlAffinity.leading,
            secondary: _leading(f, theme),
            title: Text(
              f.fileName.isEmpty ? '#${f.id}' : f.fileName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 14),
            ),
            subtitle: _subtitle(f),
            isThreeLine: false,
          );
        },
      ),
    );
  }

  Widget _leading(AdminFile f, ThemeData theme) {
    final icon = f.isImage
        ? Icons.image_outlined
        : f.fileType == 'video'
            ? Icons.movie_outlined
            : Icons.insert_drive_file_outlined;
    return CircleAvatar(
      radius: 18,
      backgroundColor: theme.colorScheme.surfaceContainerHighest,
      child: Icon(icon, size: 20),
    );
  }

  Widget _subtitle(AdminFile f) {
    final sb = StringBuffer();
    if (_isTrash) {
      sb.write('删除 ${fmtIso(f.deletedAt)}');
    } else {
      sb.write('${_stateLabel(f.processingState)} · ${fmtIso(f.createdAt)}');
    }
    sb.write(' · ${fmtBytes(f.fileSize)}');
    if (f.chatTitle.isNotEmpty) sb.write(' · ${f.chatTitle}');
    return Text(sb.toString(),
        maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12));
  }

  static String _stateLabel(String state) {
    const map = {
      'pending': '等待',
      'failed': '失败',
      'downloading': '下载中',
      'hashing': '校验中',
      'uploading': '上传中',
      'saving': '入库中',
      'completed': '已完成',
    };
    return map[state] ?? (state.isEmpty ? '未知' : state);
  }

  Widget _buildActionBar(BuildContext context) {
    final theme = Theme.of(context);
    final selected = _sel.isNotEmpty && !_acting;
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          border: Border(
            top: BorderSide(color: theme.colorScheme.outlineVariant, width: 0.5),
          ),
        ),
        child: Row(
          children: [
            if (_isTrash) ...[
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: selected ? _purgeSel : null,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: theme.colorScheme.error,
                    side: BorderSide(color: theme.colorScheme.error),
                  ),
                  icon: const Icon(Icons.delete_forever_outlined, size: 18),
                  label: Text('彻底删除(${_sel.length})'),
                ),
              ),
              const SizedBox(width: 10),
            ] else ...[
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _acting ? null : _retryAll,
                  icon: const Icon(Icons.restart_alt),
                  label: const Text('全部重试'),
                ),
              ),
              const SizedBox(width: 10),
            ],
            Expanded(
              child: FilledButton.icon(
                onPressed: selected
                    ? _isTrash
                        ? _restoreSel
                        : _retrySel
                    : null,
                icon: _acting
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.check),
                label: Text(_isTrash ? '恢复选中(${_sel.length})' : '重试选中(${_sel.length})'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
