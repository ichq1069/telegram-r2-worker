import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/local/local_db.dart';
import '../../services/providers.dart';
import '../detail/detail_page.dart';
import '../gallery/media_thumb.dart';
import '../video/feed_video_autoplay.dart';

/// 本地条目列表页（收藏 / 浏览历史），长按可移除单条。
class LocalGridPage extends ConsumerStatefulWidget {
  const LocalGridPage({
    super.key,
    required this.title,
    required this.kind,
    this.emptyText = '还没有内容',
  });

  final String title;
  final LocalKind kind;
  final String emptyText;

  @override
  ConsumerState<LocalGridPage> createState() => _LocalGridPageState();
}

enum LocalKind { favorite, history }

class _LocalGridPageState extends ConsumerState<LocalGridPage> {
  final ScrollController _scroll = ScrollController();
  final FeedVideoAutoplay _feed = FeedVideoAutoplay();
  List<LocalEntry> _entries = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_feed.onScroll);
    _load();
  }

  @override
  void dispose() {
    _scroll.removeListener(_feed.onScroll);
    _scroll.dispose();
    _feed.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final db = await ref.read(localDbProvider.future);
      final entries = widget.kind == LocalKind.favorite
          ? await db.listFavorites()
          : await db.listHistory();
      if (!mounted) return;
      setState(() {
        _entries = entries;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _removeAt(int index) async {
    final entry = _entries[index];
    final db = await ref.read(localDbProvider.future);
    if (widget.kind == LocalKind.favorite) {
      await db.unfavorite(entry.key);
    } else {
      await db.clearHistoryKey(entry.key);
    }
    if (!mounted) return;
    setState(() => _entries = List.of(_entries)..removeAt(index));
  }

  Future<void> _removeWithConfirm(int index) async {
    final label = widget.kind == LocalKind.favorite ? '移除收藏' : '删除该历史';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('确认'),
        content: Text('$label？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('移除'),
          ),
        ],
      ),
    );
    if (ok == true) _removeAt(index);
  }

  void _openDetail(int index) {
    final items = _entries.map((e) => e.item).toList();
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DetailPage(items: items, initialIndex: index),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        actions: [
          if (widget.kind == LocalKind.history && _entries.isNotEmpty)
            IconButton(
              tooltip: '清空历史',
              icon: const Icon(Icons.delete_sweep_outlined),
              onPressed: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (ctx) => AlertDialog(
                    title: const Text('清空浏览历史？'),
                    actions: [
                      TextButton(
                        onPressed: () => Navigator.of(ctx).pop(false),
                        child: const Text('取消'),
                      ),
                      FilledButton(
                        onPressed: () => Navigator.of(ctx).pop(true),
                        child: const Text('清空'),
                      ),
                    ],
                  ),
                );
                if (ok == true) {
                  final db = await ref.read(localDbProvider.future);
                  await db.clearHistory();
                  if (mounted) setState(() => _entries = const []);
                }
              },
            ),
        ],
      ),
      body: _body(),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, color: Colors.white24, size: 48),
            const SizedBox(height: 12),
            const Text('本地库不可用', style: TextStyle(color: Colors.white54)),
            const SizedBox(height: 16),
            FilledButton(onPressed: _load, child: const Text('重试')),
          ],
        ),
      );
    }
    if (_entries.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              widget.kind == LocalKind.favorite
                  ? Icons.favorite_border
                  : Icons.history,
              size: 52,
              color: Colors.white24,
            ),
            const SizedBox(height: 12),
            Text(widget.emptyText, style: const TextStyle(color: Colors.white54)),
          ],
        ),
      );
    }
    return FeedGate(
      feed: _feed,
      child: RefreshIndicator(
        onRefresh: _load,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final cellW = (constraints.maxWidth - 30) / 2;
            final base = ref.read(settingsControllerProvider).settings.apiBase;
            return SingleChildScrollView(
              controller: _scroll,
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(10),
              child: Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [
                  for (var i = 0; i < _entries.length; i++)
                    SizedBox(
                      width: cellW,
                      child: GestureDetector(
                        onLongPress: () => _removeWithConfirm(i),
                        child: MediaThumb(
                          item: _entries[i].item,
                          onTap: () => _openDetail(i),
                          autoplay: _feed,
                          autoplayIndex: i,
                          baseUrl: base,
                        ),
                      ),
                    ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}
