/// 三库通用网格/列表视图组件：支持 PoolItem 和 AdminFileRecord 两种数据源。
library;

import 'package:flutter/material.dart';

import '../../data/models/admin_file.dart';
import '../../data/models/pool_item.dart';

const _levelColors = {
  'pt': Color(0xFF9CA3AF),
  'vip': Color(0xFF3B82F6),
  'svip': Color(0xFF8B5CF6),
  'vvip': Color(0xFFD97706),
};

/// 统一的展示条目，兼容 PoolItem 与 AdminFileRecord。
class LibraryEntry {
  const LibraryEntry({
    required this.key,
    required this.id,
    required this.displayUrl,
    this.title = '',
    this.tags = '',
    this.level = 'pt',
    this.source = '',
    this.createdAt = '',
    this.poolItem,
    this.fileRecord,
  });

  final String key;
  final int id;
  final String displayUrl;
  final String title;
  final String tags;
  final String level;
  final String source;
  final String createdAt;
  final PoolItem? poolItem;
  final AdminFileRecord? fileRecord;

  String get poolState => fileRecord?.poolState ?? '';
  bool get imported => poolState == 'imported';

  factory LibraryEntry.fromPool(PoolItem p) => LibraryEntry(
        key: 'pool_${p.id}',
        id: p.id,
        displayUrl: p.displayUrl,
        title: p.title,
        tags: p.tags,
        level: p.level,
        source: p.source,
        createdAt: p.createdAt,
        poolItem: p,
      );

  factory LibraryEntry.fromFile(AdminFileRecord f) => LibraryEntry(
        key: 'file_${f.id}',
        id: f.id,
        displayUrl: f.url,
        title: f.fileName,
        tags: f.tags,
        level: f.level,
        source: 'tg',
        createdAt: f.createdAt,
        fileRecord: f,
      );
}

class LibraryGridView extends StatefulWidget {
  const LibraryGridView({
    super.key,
    required this.entries,
    required this.selected,
    this.selectedOrder = const [],
    required this.gridMode,
    this.loading = false,
    this.onTap,
    this.onLongPress,
    this.onSelect,
    this.scrollController,
  });

  final List<LibraryEntry> entries;
  final Set<String> selected;
  final List<String> selectedOrder;
  final bool gridMode;
  final bool loading;
  final void Function(LibraryEntry)? onTap;
  final void Function(LibraryEntry)? onLongPress;
  final void Function(String key, bool selected)? onSelect;
  final ScrollController? scrollController;

  @override
  State<LibraryGridView> createState() => _LibraryGridViewState();
}

class _LibraryGridViewState extends State<LibraryGridView> {
  static const _pad = 8.0;
  static const _spacing = 8.0;
  static const _maxExtent = 160.0;

  bool _paintAdd = true;
  int? _lastPainted;

  int? _hitIndex(Offset local) {
    final box = context.findRenderObject() as RenderBox?;
    if (box == null || !widget.gridMode) return null;
    final w = box.size.width - _pad * 2;
    if (w <= 0) return null;
    var cols = ((w + _spacing) / (_maxExtent + _spacing)).floor();
    if (cols < 1) cols = 1;
    final usable = w - _spacing * (cols - 1);
    final cell = usable / cols;
    final stride = cell + _spacing;
    if (stride <= 0) return null;
    final scroll = widget.scrollController?.hasClients == true
        ? widget.scrollController!.offset
        : 0.0;
    final x = local.dx - _pad;
    final y = local.dy - _pad + scroll;
    if (x < 0 || y < 0) return null;
    final col = (x / stride).floor();
    final row = (y / stride).floor();
    if (col < 0 || col >= cols) return null;
    final i = row * cols + col;
    if (i < 0 || i >= widget.entries.length) return null;
    return i;
  }

  void _paintAt(int i) {
    if (_lastPainted == i) return;
    _lastPainted = i;
    widget.onSelect?.call(widget.entries[i].key, _paintAdd);
  }

  void _onLongPressStart(LongPressStartDetails d, LibraryEntry e, int i) {
    _paintAdd = !widget.selected.contains(e.key);
    _lastPainted = i;
    widget.onLongPress?.call(e);
  }

  void _onLongPressMove(LongPressMoveUpdateDetails d) {
    final box = context.findRenderObject() as RenderBox?;
    if (box == null) return;
    final i = _hitIndex(box.globalToLocal(d.globalPosition));
    if (i != null) _paintAt(i);
  }

  @override
  Widget build(BuildContext context) {
    if (widget.entries.isEmpty) {
      if (widget.loading) {
        return const Center(child: CircularProgressIndicator());
      }
      return const Center(child: Text('暂无内容'));
    }
    if (widget.gridMode) {
      return _buildGrid(context);
    }
    return _buildList(context);
  }

  Widget _buildGrid(BuildContext context) {
    final theme = Theme.of(context);
    final selecting = widget.selected.isNotEmpty;
    return GridView.builder(
      controller: widget.scrollController,
      padding: const EdgeInsets.all(_pad),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: _maxExtent,
        mainAxisSpacing: _spacing,
        crossAxisSpacing: _spacing,
      ),
      itemCount: widget.entries.length + (widget.loading ? 1 : 0),
      itemBuilder: (context, i) {
        if (i >= widget.entries.length) {
          return const Center(child: CircularProgressIndicator(strokeWidth: 2));
        }
        final e = widget.entries[i];
        final sel = widget.selected.contains(e.key);
        final selIdx = sel ? widget.selectedOrder.indexOf(e.key) + 1 : 0;
        return GestureDetector(
          onTap: () => widget.onTap?.call(e),
          onLongPressStart: (d) => _onLongPressStart(d, e, i),
          onLongPressMoveUpdate: _onLongPressMove,
          onLongPressEnd: (_) => _lastPainted = null,
          child: Stack(
            fit: StackFit.expand,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Opacity(
                  opacity: e.imported ? 0.72 : 1,
                  child: Image.network(
                    e.displayUrl,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => ColoredBox(
                      color: theme.colorScheme.surfaceContainerHighest,
                      child: const Icon(Icons.broken_image_outlined),
                    ),
                  ),
                ),
              ),
              if (sel)
                DecoratedBox(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: theme.colorScheme.primary, width: 3),
                    color: theme.colorScheme.primary.withValues(alpha: 0.18),
                  ),
                ),
              if (selecting)
                Positioned(
                  right: 4,
                  top: 4,
                  child: IgnorePointer(
                    child: sel
                        ? Container(
                            width: 22,
                            height: 22,
                            decoration: BoxDecoration(
                              color: theme.colorScheme.primary,
                              shape: BoxShape.circle,
                            ),
                            alignment: Alignment.center,
                            child: Text(
                              '$selIdx',
                              style: const TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                                color: Colors.white,
                              ),
                            ),
                          )
                        : const Icon(
                            Icons.circle_outlined,
                            size: 22,
                            color: Colors.white70,
                          ),
                  ),
                ),
              if (e.level != 'pt')
                Positioned(
                  left: 4,
                  top: 4,
                  child: _LevelBadge(level: e.level),
                ),
              Positioned(
                left: 4,
                bottom: 4,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: Colors.black54,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text('${i + 1}',
                      style: const TextStyle(fontSize: 11, color: Colors.white)),
                ),
              ),
              if (e.poolState.isNotEmpty)
                Positioned(
                  right: 4,
                  bottom: 4,
                  child: _PoolBadge(state: e.poolState),
                ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildList(BuildContext context) {
    final theme = Theme.of(context);
    final selecting = widget.selected.isNotEmpty;
    return ListView.separated(
      controller: widget.scrollController,
      padding: const EdgeInsets.all(8),
      itemCount: widget.entries.length + (widget.loading ? 1 : 0),
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, i) {
        if (i >= widget.entries.length) {
          return const Center(
            child: Padding(
              padding: EdgeInsets.all(12),
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          );
        }
        final e = widget.entries[i];
        final sel = widget.selected.contains(e.key);
        final selIdx = sel ? widget.selectedOrder.indexOf(e.key) + 1 : 0;
        return ListTile(
          leading: selecting
              ? IgnorePointer(
                  child: sel
                      ? Container(
                          width: 28,
                          height: 28,
                          decoration: BoxDecoration(
                            color: theme.colorScheme.primary,
                            shape: BoxShape.circle,
                          ),
                          alignment: Alignment.center,
                          child: Text(
                            '$selIdx',
                            style: const TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                              color: Colors.white,
                            ),
                          ),
                        )
                      : Icon(
                          Icons.circle_outlined,
                          color: theme.colorScheme.outline,
                        ),
                )
              : SizedBox(
                  width: 40,
                  height: 40,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(4),
                    child: Image.network(e.displayUrl, fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => ColoredBox(
                              color: theme.colorScheme.surfaceContainerHighest,
                              child: const Icon(Icons.broken_image_outlined, size: 16),
                            )),
                  ),
                ),
          title: Text(e.title.isNotEmpty ? e.title : e.displayUrl,
              maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
          subtitle: e.tags.isNotEmpty
              ? Text(e.tags, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11))
              : null,
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (e.poolState.isNotEmpty) ...[
                _PoolBadge(state: e.poolState),
                const SizedBox(width: 6),
              ],
              _LevelBadge(level: e.level),
            ],
          ),
          selected: sel,
          onTap: () => widget.onTap?.call(e),
          onLongPress: () => widget.onLongPress?.call(e),
        );
      },
    );
  }
}

class _LevelBadge extends StatelessWidget {
  const _LevelBadge({required this.level});
  final String level;

  @override
  Widget build(BuildContext context) {
    final color = _levelColors[level] ?? _levelColors['pt']!;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(level.toUpperCase(),
          style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.w700)),
    );
  }
}

class _PoolBadge extends StatelessWidget {
  const _PoolBadge({required this.state});
  final String state;

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (state) {
      'imported' => ('已入库', const Color(0xFF22C55E)),
      'ignored' => ('已忽略', const Color(0xFFEF4444)),
      'pending' => ('未入库', const Color(0xFF94A3B8)),
      _ => (state, const Color(0xFF94A3B8)),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: Colors.black54,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(label,
          style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.w700)),
    );
  }
}
