import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../data/models/admin_file.dart';
import '../../services/providers.dart';

const _typeOptions = [
  ('', '全类型'),
  ('photo', '图片'),
  ('video', '视频'),
  ('document', '文档'),
  ('audio', '音频'),
];

/// 仓储-文件检索：files 全量库按关键词/类型分页检索（GET /admin/api/files）。
class FilesSearchPanel extends ConsumerStatefulWidget {
  const FilesSearchPanel({super.key, required this.adminKey});

  final String adminKey;

  @override
  ConsumerState<FilesSearchPanel> createState() => _FilesSearchPanelState();
}

class _FilesSearchPanelState extends ConsumerState<FilesSearchPanel> {
  final _kwCtrl = TextEditingController();
  String _type = '';
  final List<AdminFileRecord> _items = [];
  int _total = 0;
  int _page = 1;
  bool _loading = false;
  bool _loadingMore = false;
  String? _error;
  bool _hasMore = false;
  bool _searched = false;

  @override
  void dispose() {
    _kwCtrl.dispose();
    super.dispose();
  }

  Future<void> _search({bool more = false}) async {
    final next = more ? _page + 1 : 1;
    if (_loading || _loadingMore) return;
    if (more && !_hasMore) return;
    setState(() {
      if (more) {
        _loadingMore = true;
      } else {
        _loading = true;
        _error = null;
        _searched = true;
      }
    });
    try {
      final (total, items) = await ref
          .read(galleryRepositoryProvider)
          .adminFilesSearch(widget.adminKey,
              page: next, keyword: _kwCtrl.text.trim(), type: _type);
      if (!mounted) return;
      setState(() {
        if (more) {
          _items.addAll(items);
        } else {
          _items
            ..clear()
            ..addAll(items);
        }
        _total = total;
        _page = next;
        _hasMore = items.isNotEmpty && _items.length < total;
      });
    } catch (e) {
      if (!mounted) return;
      if (more) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
      } else {
        setState(() => _error = e.toString());
      }
    } finally {
      if (mounted) setState(() {
        _loading = false;
        _loadingMore = false;
      });
    }
  }

  Future<void> _preview(AdminFileRecord f) async {
    await showDialog<void>(
      context: context,
      builder: (ctx) {
        final theme = Theme.of(ctx);
        return Dialog(
          insetPadding: const EdgeInsets.all(16),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 460),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 8, 0),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          f.fileName.isEmpty
                              ? '${_typeLabel(f.fileType)} #${f.id}'
                              : f.fileName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                      ),
                      IconButton(
                        tooltip: '复制链接',
                        onPressed: () async {
                          await Clipboard.setData(ClipboardData(text: f.url));
                          if (ctx.mounted) {
                            ScaffoldMessenger.of(ctx).showSnackBar(
                              const SnackBar(content: Text('链接已复制'), duration: Duration(seconds: 1)),
                            );
                          }
                        },
                        icon: const Icon(Icons.copy, size: 20),
                      ),
                      IconButton(
                        tooltip: '关闭',
                        onPressed: () => Navigator.of(ctx).pop(),
                        icon: const Icon(Icons.close, size: 20),
                      ),
                    ],
                  ),
                ),
                if (f.url.isNotEmpty)
                  Flexible(
                    child: InteractiveViewer(
                      maxScale: 5,
                      child: Image.network(
                        f.url,
                        fit: BoxFit.contain,
                        errorBuilder: (_, __, ___) => Container(
                          height: 200,
                          alignment: Alignment.center,
                          color: theme.colorScheme.surfaceContainerHighest,
                          child: const Icon(Icons.broken_image_outlined, size: 48),
                        ),
                      ),
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(
                    '${_typeLabel(f.fileType)} · ${f.level.toUpperCase()}'
                    '${f.isPrivate ? ' · 私密' : ''}'
                    ' · ${fmtBytes(f.fileSize ?? 0)}'
                    '${f.tags.isEmpty ? '' : ' · ${f.tags}'}\n'
                    '${f.createdAt.isEmpty ? '' : fmtIso(f.createdAt)}',
                    style: theme.textTheme.bodySmall,
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _kwCtrl,
                  textInputAction: TextInputAction.search,
                  decoration: const InputDecoration(
                    labelText: '关键词（文件名/说明/群组）',
                    isDense: true,
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.search, size: 20),
                  ),
                  onSubmitted: (_) => _search(),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filledTonal(
                tooltip: '搜索',
                onPressed: _loading ? null : _search,
                icon: const Icon(Icons.search),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SegmentedButton<String>(
              showSelectedIcon: false,
              segments: [
                for (final t in _typeOptions)
                  ButtonSegment(value: t.$1, label: Text(t.$2)),
              ],
              selected: {_type},
              onSelectionChanged: (s) {
                setState(() => _type = s.first);
                _search();
              },
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  !_searched
                      ? 'files 全量库检索（库内全部记录）'
                      : '命中 ${fmtCount(_total)} 条 · 已显示 ${fmtCount(_items.length)}',
                  style: theme.textTheme.bodySmall,
                ),
              ),
            ],
          ),
        ),
        Expanded(child: _buildBody(theme)),
      ],
    );
  }

  Widget _buildBody(ThemeData theme) {
    if (_loading && _items.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_items.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            _error ??
                (!_searched
                    ? '输入关键词或选类型后搜索'
                    : '没有匹配的记录'),
            textAlign: TextAlign.center,
            style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: () => _search(),
      child: ListView.separated(
        padding: const EdgeInsets.only(bottom: 8),
        itemCount: _items.length + (_hasMore ? 1 : 0),
        separatorBuilder: (_, __) => const Divider(height: 1, indent: 16),
        itemBuilder: (context, i) {
          if (i == _items.length) {
            return Center(
              child: TextButton(
                onPressed: _loadingMore ? null : () => _search(more: true),
                child: _loadingMore
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('加载更多'),
              ),
            );
          }
          return _FileTile(record: _items[i], onTap: () => _preview(_items[i]));
        },
      ),
    );
  }

  static String _typeLabel(String type) {
    for (final t in _typeOptions) {
      if (t.$1 == type) return t.$2;
    }
    return type.isEmpty ? '未知' : type;
  }
}

class _FileTile extends StatelessWidget {
  const _FileTile({required this.record, required this.onTap});

  final AdminFileRecord record;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final f = record;
    final title = f.caption.trim().isNotEmpty
        ? f.caption.trim()
        : (f.fileName.isNotEmpty ? f.fileName : '#${f.id}');
    final meta = <String>[
      if (f.level.isNotEmpty) f.level.toUpperCase(),
      if (f.isPrivate) '私密',
      if (f.chatTitle.isNotEmpty) f.chatTitle,
      if (f.fileSize != null) fmtBytes(f.fileSize!),
    ];
    return ListTile(
      dense: true,
      leading: _Thumb(record: f),
      title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
      subtitle: Text(
        '${meta.join(' · ')}${meta.isEmpty ? '' : '\n'}${fmtIso(f.createdAt)}',
        style: const TextStyle(fontSize: 11),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
      isThreeLine: meta.isNotEmpty,
      trailing: _poolBadge(f.poolState, theme),
      onTap: onTap,
    );
  }

  static Widget _poolBadge(String poolState, ThemeData theme) {
    if (poolState.isEmpty) return const SizedBox.shrink();
    final (label, color) = switch (poolState) {
      'imported' => ('已入库', Colors.lightGreen),
      'pending' => ('待入库', theme.colorScheme.outline),
      'ignored' => ('已忽略', theme.colorScheme.error),
      _ => (poolState, theme.colorScheme.outline),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(label, style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.w700)),
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.record});

  final AdminFileRecord record;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final f = record;
    final isImage = f.fileType == 'photo' || f.mimeType.startsWith('image/');
    final isVideo = f.fileType == 'video' || f.mimeType.startsWith('video/');
    if (!isImage) {
      return Container(
        width: 44,
        height: 44,
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Icon(isVideo ? Icons.movie_outlined : Icons.insert_drive_file_outlined,
            size: 22, color: theme.colorScheme.onSurfaceVariant),
      );
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(6),
      child: Image.network(
        f.url,
        width: 44,
        height: 44,
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => Container(
          width: 44,
          height: 44,
          color: theme.colorScheme.surfaceContainerHighest,
          child: Icon(Icons.broken_image_outlined,
              size: 20, color: theme.colorScheme.onSurfaceVariant),
        ),
      ),
    );
  }
}
