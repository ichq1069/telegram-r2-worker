import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../data/models/admin_file.dart';
import '../../services/providers.dart';
import 'files_search_panel.dart';

enum _Pane { objects, files }

/// R2 仓储：对象浏览 + 孤儿清理 + files 全量库文件检索。
/// - 前缀过滤 + cursor 分页浏览（/admin/api/r2/list）；
/// - 仅孤儿对象可勾选删除（服务端 state=orphan 强校验），D1 引用对象/备份只读；
/// - 不做全量 cleanup（服务端会把未引用的 backups/ 一并删除，风险高）。
class StorageTab extends ConsumerStatefulWidget {
  const StorageTab({super.key, required this.adminKey});

  final String adminKey;

  @override
  ConsumerState<StorageTab> createState() => _StorageTabState();
}

class _StorageTabState extends ConsumerState<StorageTab> {
  final _prefixCtrl = TextEditingController();
  final List<R2Object> _objects = [];
  bool _loading = false;
  bool _loadingMore = false;
  String? _error;
  String? _nextCursor;
  int _refs = 0;
  final Set<String> _sel = {};
  bool _acting = false;
  bool _gridMode = false;
  _Pane _pane = _Pane.objects;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _prefixCtrl.dispose();
    super.dispose();
  }

  String get _prefix => _prefixCtrl.text.trim();

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await ref
          .read(galleryRepositoryProvider)
          .adminR2List(widget.adminKey, prefix: _prefix);
      if (!mounted) return;
      setState(() {
        _objects
          ..clear()
          ..addAll(page.objects);
        _nextCursor = page.cursor;
        _refs = page.refsCount;
        _sel.clear();
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadMore() async {
    final cursor = _nextCursor;
    if (cursor == null || _loadingMore || _loading) return;
    setState(() => _loadingMore = true);
    try {
      final page = await ref
          .read(galleryRepositoryProvider)
          .adminR2List(widget.adminKey, prefix: _prefix, cursor: cursor);
      if (!mounted) return;
      setState(() {
        _objects.addAll(page.objects);
        _nextCursor = page.cursor;
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  void _toggle(String key) {
    setState(() {
      if (!_sel.remove(key)) _sel.add(key);
    });
  }

  Future<void> _deleteSel() async {
    final keys = _sel.toList();
    if (keys.isEmpty) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('删除 ${keys.length} 个孤儿对象'),
        content: const Text('将从 R2 永久删除这些无引用的对象，确定？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _acting = true);
    try {
      final r = await ref
          .read(galleryRepositoryProvider)
          .adminR2Delete(widget.adminKey, keys: keys);
      if (!mounted) return;
      final msg = StringBuffer('已删除 ${r.deleted} 个');
      if (r.refused.isNotEmpty) {
        msg.write('；拒绝 ${r.refused.length} 个（${r.refused.take(2).join('，')}）');
      }
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg.toString())));
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
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: SizedBox(
            width: double.infinity,
            child: SegmentedButton<_Pane>(
              showSelectedIcon: false,
              segments: const [
                ButtonSegment(
                    value: _Pane.objects,
                    label: Text('R2 对象'),
                    icon: Icon(Icons.storage_outlined, size: 18)),
                ButtonSegment(
                    value: _Pane.files,
                    label: Text('文件检索'),
                    icon: Icon(Icons.manage_search, size: 18)),
              ],
              selected: {_pane},
              onSelectionChanged: (s) => setState(() => _pane = s.first),
            ),
          ),
        ),
        Expanded(
          child: _pane == _Pane.objects
              ? _buildObjects()
              : FilesSearchPanel(adminKey: widget.adminKey),
        ),
      ],
    );
  }

  Widget _buildObjects() {
    final theme = Theme.of(context);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _prefixCtrl,
                  decoration: const InputDecoration(
                    labelText: '前缀过滤（如 thumbs/）',
                    isDense: true,
                    border: OutlineInputBorder(),
                  ),
                  onSubmitted: (_) => _load(),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filledTonal(
                tooltip: '刷新',
                onPressed: _loading ? null : _load,
                icon: const Icon(Icons.refresh),
              ),
              const SizedBox(width: 4),
              IconButton(
                tooltip: _gridMode ? '切换列表视图' : '切换网格视图',
                onPressed: () => setState(() => _gridMode = !_gridMode),
                icon: Icon(
                  _gridMode ? Icons.view_list_outlined : Icons.grid_view_outlined,
                  size: 20,
                ),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  _loading
                      ? '加载中…'
                      : '已显示 ${fmtCount(_objects.length)} 个 · D1 引用 ${fmtCount(_refs)}',
                  style: theme.textTheme.bodySmall,
                ),
              ),
              if (_nextCursor != null)
                TextButton(
                  onPressed: _loadingMore ? null : _loadMore,
                  child: _loadingMore
                      ? const SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('加载更多'),
                ),
            ],
          ),
        ),
        Expanded(child: _buildBody(theme)),
        if (_sel.isNotEmpty)
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _acting ? null : _deleteSel,
                  icon: const Icon(Icons.delete_forever_outlined),
                  label: Text('删除选中孤儿对象(${_sel.length})'),
                ),
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildBody(ThemeData theme) {
    if (_loading && _objects.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_objects.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            _error ?? (_prefix.isEmpty ? 'R2 桶是空的' : '没有匹配「$_prefix」的对象'),
            textAlign: TextAlign.center,
            style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: _gridMode ? _buildGrid() : _buildList(),
    );
  }

  Widget _buildList() {
    return ListView.separated(
      padding: const EdgeInsets.only(bottom: 8),
      physics: const AlwaysScrollableScrollPhysics(),
      itemCount: _objects.length,
      separatorBuilder: (_, __) => const Divider(height: 1, indent: 16),
      itemBuilder: (context, i) {
        final o = _objects[i];
        final lastSegment = _nameOf(o.key);
        return ListTile(
          dense: true,
          leading: o.isOrphan
              ? Checkbox(
                  value: _sel.contains(o.key),
                  onChanged: (_) => _toggle(o.key),
                )
              : Icon(_stateIcon(o.state),
                  color: _stateColor(o.state, Theme.of(context))),
          title: Text(lastSegment,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 13)),
          subtitle: Text(
            '${fmtBytes(o.size)} · ${fmtIso(o.uploaded)}',
            style: const TextStyle(fontSize: 11),
          ),
          trailing: _StateBadge(state: o.state),
          onTap: o.isOrphan ? () => _toggle(o.key) : null,
        );
      },
    );
  }

  /// 网格视图：优先展示对象直链缩略图（图片类），非图片/加载失败回退占位图标。
  Widget _buildGrid() {
    return LayoutBuilder(
      builder: (context, constraints) {
        final cross = ((constraints.maxWidth - 8) / 132).floor().clamp(2, 6);
        return GridView.builder(
          padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
          physics: const AlwaysScrollableScrollPhysics(),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: cross,
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
            childAspectRatio: 0.82,
          ),
          itemCount: _objects.length,
          itemBuilder: (context, i) {
            final o = _objects[i];
            return _ObjectTile(
              object: o,
              selected: _sel.contains(o.key),
              onTap: o.isOrphan ? () => _toggle(o.key) : null,
            );
          },
        );
      },
    );
  }

  static String _nameOf(String key) {
    final i = key.lastIndexOf('/');
    return i >= 0 ? key.substring(i + 1) : key;
  }

  static IconData _stateIcon(String state) {
    switch (state) {
      case 'used':
        return Icons.link;
      case 'backup':
        return Icons.archive_outlined;
      case 'page':
        return Icons.public;
      default:
        return Icons.help_outline;
    }
  }

  static Color _stateColor(String state, ThemeData theme) {
    switch (state) {
      case 'used':
        return Colors.lightGreen;
      case 'backup':
        return Colors.lightBlue;
      case 'page':
        return theme.colorScheme.outline;
      default:
        return theme.colorScheme.error;
    }
  }
}

class _ObjectTile extends StatelessWidget {
  const _ObjectTile({
    required this.object,
    required this.selected,
    this.onTap,
  });

  final R2Object object;
  final bool selected;
  final VoidCallback? onTap;

  static const Set<String> _imgExts = {
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic',
  };

  String get _name {
    final i = object.key.lastIndexOf('/');
    return i >= 0 ? object.key.substring(i + 1) : object.key;
  }

  String get _ext {
    final dot = _name.lastIndexOf('.');
    if (dot < 0) return '';
    return _name.substring(dot + 1).toLowerCase();
  }

  bool get _isImage => _imgExts.contains(_ext);

  (String, Color) get _state {
    switch (object.state) {
      case 'used':
        return ('引用', Colors.lightGreen);
      case 'backup':
        return ('备份', Colors.lightBlue);
      case 'page':
        return ('页面', Colors.grey);
      default:
        return ('孤儿', Colors.redAccent);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (stateLabel, stateColor) = _state;
    return Material(
      color: theme.colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(10),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  if (_isImage && object.publicUrl.isNotEmpty)
                    Image.network(
                      object.publicUrl,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => _placeholder(theme),
                      loadingBuilder: (_, child, progress) =>
                          progress == null ? child : _placeholder(theme),
                    )
                  else
                    _placeholder(theme),
                  Positioned(
                    left: 6,
                    top: 6,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                      decoration: BoxDecoration(
                        color: stateColor.withValues(alpha: 0.22),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(stateLabel,
                          style: TextStyle(
                              color: stateColor,
                              fontSize: 10,
                              fontWeight: FontWeight.w700)),
                    ),
                  ),
                  if (object.isOrphan)
                    Positioned(
                      right: 2,
                      top: 2,
                      child: Checkbox(
                        value: selected,
                        visualDensity: VisualDensity.compact,
                        onChanged: (_) => onTap?.call(),
                      ),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 5, 8, 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11)),
                  const SizedBox(height: 2),
                  Text(
                    '${fmtBytes(object.size)} · ${fmtIso(object.uploaded)}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 10, color: theme.colorScheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _placeholder(ThemeData theme) {
    return Container(
      color: theme.colorScheme.surfaceContainerHighest,
      alignment: Alignment.center,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            _isImage ? Icons.broken_image_outlined : Icons.insert_drive_file_outlined,
            color: theme.colorScheme.outline,
            size: 30,
          ),
          const SizedBox(height: 4),
          if (_ext.isNotEmpty)
            Text('.$_ext',
                style: TextStyle(color: theme.colorScheme.outline, fontSize: 10)),
        ],
      ),
    );
  }
}

class _StateBadge extends StatelessWidget {
  const _StateBadge({required this.state});

  final String state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (label, color) = switch (state) {
      'used' => ('引用', Colors.lightGreen),
      'backup' => ('备份', Colors.lightBlue),
      'page' => ('页面', theme.colorScheme.outline),
      _ => ('孤儿', theme.colorScheme.error),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(label,
          style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w700)),
    );
  }
}
