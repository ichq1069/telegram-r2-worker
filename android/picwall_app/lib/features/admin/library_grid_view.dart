/// 三库通用网格/列表视图组件：支持 PoolItem 和 AdminFileRecord 两种数据源。
library;

import 'package:flutter/material.dart';

import '../../core/format.dart';
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

class LibraryGridView extends StatelessWidget {
  const LibraryGridView({
    super.key,
    required this.entries,
    required this.selected,
    required this.gridMode,
    this.loading = false,
    this.onTap,
    this.onLongPress,
    this.onSelect,
    this.scrollController,
  });

  final List<LibraryEntry> entries;
  final Set<String> selected;
  final bool gridMode;
  final bool loading;
  final void Function(LibraryEntry)? onTap;
  final void Function(LibraryEntry)? onLongPress;
  final void Function(String key, bool selected)? onSelect;
  final ScrollController? scrollController;

  @override
  Widget build(BuildContext context) {
    if (entries.isEmpty && !loading) {
      return const Center(child: Text('暂无内容'));
    }
    if (gridMode) {
      return _buildGrid(context);
    }
    return _buildList(context);
  }

  Widget _buildGrid(BuildContext context) {
    final theme = Theme.of(context);
    return GridView.builder(
      controller: scrollController,
      padding: const EdgeInsets.all(8),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 160,
        mainAxisSpacing: 8,
        crossAxisSpacing: 8,
      ),
      itemCount: entries.length + (loading ? 1 : 0),
      itemBuilder: (context, i) {
        if (i >= entries.length) {
          return const Center(child: CircularProgressIndicator(strokeWidth: 2));
        }
        final e = entries[i];
        final sel = selected.contains(e.key);
        return GestureDetector(
          onTap: () => onTap?.call(e),
          onLongPress: () => onLongPress?.call(e),
          child: Stack(
            fit: StackFit.expand,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.network(
                  e.displayUrl,
                  fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => ColoredBox(
                    color: theme.colorScheme.surfaceContainerHighest,
                    child: const Icon(Icons.broken_image_outlined),
                  ),
                ),
              ),
              if (selected.isNotEmpty)
                Positioned(
                  right: 4,
                  top: 4,
                  child: Checkbox(
                    value: sel,
                    onChanged: (_) => onSelect?.call(e.key, !sel),
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
            ],
          ),
        );
      },
    );
  }

  Widget _buildList(BuildContext context) {
    final theme = Theme.of(context);
    return ListView.separated(
      controller: scrollController,
      padding: const EdgeInsets.all(8),
      itemCount: entries.length + (loading ? 1 : 0),
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, i) {
        if (i >= entries.length) {
          return const Center(
            child: Padding(
              padding: EdgeInsets.all(12),
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          );
        }
        final e = entries[i];
        final sel = selected.contains(e.key);
        return ListTile(
          leading: selected.isNotEmpty
              ? Checkbox(
                  value: sel,
                  onChanged: (_) => onSelect?.call(e.key, !sel),
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
          trailing: _LevelBadge(level: e.level),
          onTap: () => onTap?.call(e),
          onLongPress: () => onLongPress?.call(e),
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
