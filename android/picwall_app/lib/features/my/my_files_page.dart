import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/media_item.dart';
import '../../data/repositories/gallery_repository.dart';
import '../../services/api_client.dart';
import '../../services/providers.dart';
import '../detail/detail_page.dart';
import '../gallery/masonry_virtual_grid.dart';
import '../gallery/media_thumb.dart';
import '../video/feed_video_autoplay.dart';

/// 我的图片：分页网格 + 关键词搜索 + 类型筛选 + 长按打标/删除。
class MyFilesPage extends ConsumerStatefulWidget {
  const MyFilesPage({super.key});

  @override
  ConsumerState<MyFilesPage> createState() => _MyFilesPageState();
}

class _MyFilesPageState extends ConsumerState<MyFilesPage> {
  final ScrollController _scroll = ScrollController();
  final TextEditingController _kw = TextEditingController();
  final FeedVideoAutoplay _feed = FeedVideoAutoplay();
  final List<MediaItem> _items = [];
  String _type = '';
  int _page = 1;
  int _total = 0;
  bool _loading = false;
  bool _loadingMore = false;
  bool _hasError = false;
  String _errorText = '';

  String get _base =>
      ref.read(settingsControllerProvider).settings.apiBase;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _scroll.addListener(_feed.onScroll);
    _load();
  }

  @override
  void dispose() {
    _scroll.removeListener(_feed.onScroll);
    _scroll.dispose();
    _kw.dispose();
    _feed.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scroll.position.pixels >= _scroll.position.maxScrollExtent - 400) {
      _loadMore();
    }
  }

  GalleryRepository get _repo => ref.read(galleryRepositoryProvider);

  void _setFilter({String? kw, String? type}) {
    if (kw != null) _kw.text = kw;
    if (type != null && type == _type) return;
    _type = type ?? _type;
    setState(() {
      _items.clear();
      _total = 0;
      _page = 1;
    });
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _hasError = false;
    });
    try {
      final res = await _repo.myFiles(
        page: 1,
        pageSize: 30,
        keyword: _kw.text.trim(),
        type: _type,
      );
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(res.items);
        _total = res.total;
        _page = 1;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _hasError = true;
        _errorText = normalizeError(e).message;
      });
    }
  }

  Future<void> _loadMore() async {
    if (_loading || _loadingMore) return;
    if (_items.isNotEmpty && _items.length >= _total) return;
    final next = _page + 1;
    setState(() => _loadingMore = true);
    try {
      final res = await _repo.myFiles(
        page: next,
        pageSize: 30,
        keyword: _kw.text.trim(),
        type: _type,
      );
      if (!mounted) return;
      setState(() {
        _items.addAll(res.items);
        _total = res.total;
        _page = next;
        _loadingMore = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loadingMore = false);
    }
  }

  Future<void> _onItemLongPress(MediaItem item) async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.sell_outlined),
              title: const Text('编辑标签'),
              onTap: () => Navigator.of(ctx).pop('tags'),
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline, color: Color(0xFFE53935)),
              title: const Text('删除', style: TextStyle(color: Color(0xFFE53935))),
              onTap: () => Navigator.of(ctx).pop('delete'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || choice == null) return;
    if (choice == 'delete') {
      await _delete(item);
    } else {
      await _editTags(item);
    }
  }

  Future<void> _delete(MediaItem item) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除文件？'),
        content: const Text('删除后不可恢复（含云端与共享库引用）。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFFE53935)),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _repo.deleteMyFile(item.id);
      if (!mounted) return;
      setState(() {
        _items.removeWhere((e) => e.id == item.id);
        _total = _total > 0 ? _total - 1 : 0;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已删除')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('删除失败：${normalizeError(e).message}')),
      );
    }
  }

  Future<void> _editTags(MediaItem item) async {
    final ctl = TextEditingController(text: item.tags.join(','));
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('编辑标签'),
        content: TextField(
          controller: ctl,
          autofocus: true,
          maxLines: 3,
          decoration: const InputDecoration(
            hintText: '逗号分隔，如：风景,美女',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(ctl.text),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    ctl.dispose();
    if (result == null || !mounted) return;
    final tags = result
        .split(',')
        .map((e) => e.trim())
        .where((e) => e.isNotEmpty)
        .toList();
    try {
      await _repo.updateFileTags(item.id, tags);
      if (!mounted) return;
      setState(() {
        final idx = _items.indexWhere((e) => e.id == item.id);
        if (idx >= 0) {
          final old = _items[idx];
          _items[idx] = MediaItem(
            id: old.id,
            url: old.url,
            thumbUrl: old.thumbUrl,
            title: old.title,
            tags: tags,
            level: old.level,
            isPrivate: old.isPrivate,
            fileType: old.fileType,
            width: old.width,
            height: old.height,
            fileSize: old.fileSize,
            source: old.source,
            createdAt: old.createdAt,
            extra: old.extra,
          );
        }
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('标签已更新')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('保存失败：${normalizeError(e).message}')),
      );
    }
  }

  void _openDetail(int index) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DetailPage(items: List.of(_items), initialIndex: index),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('我的图片')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
            child: TextField(
              controller: _kw,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _setFilter(kw: _kw.text),
              decoration: InputDecoration(
                hintText: '按文件名或标签搜索',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () => _setFilter(kw: ''),
                ),
                isDense: true,
              ),
            ),
          ),
          SizedBox(
            height: 48,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              children: [
                for (final (value, label) in const [('', '全部'), ('photo', '图片'), ('video', '视频')])
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(
                      label: Text(label),
                      selected: _type == value,
                      onSelected: (_) => _setFilter(type: value),
                    ),
                  ),
              ],
            ),
          ),
          Expanded(child: _grid(context)),
        ],
      ),
    );
  }

  Widget _grid(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_hasError) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.cloud_off, size: 48, color: Colors.white24),
            const SizedBox(height: 12),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Text(
                _errorText,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white54),
              ),
            ),
            const SizedBox(height: 18),
            FilledButton(onPressed: _load, child: const Text('重试')),
          ],
        ),
      );
    }
    if (_items.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.photo_outlined, size: 52, color: Colors.white24),
            const SizedBox(height: 12),
            const Text('还没有内容', style: TextStyle(color: Colors.white54)),
            if (_kw.text.trim().isNotEmpty || _type.isNotEmpty) ...[
              const SizedBox(height: 16),
              FilledButton(
                onPressed: () => _setFilter(kw: ''),
                child: const Text('清除筛选'),
              ),
            ],
          ],
        ),
      );
    }
    return FeedGate(
      feed: _feed,
      child: RefreshIndicator(
        onRefresh: _load,
        child: MasonryVirtualGrid(
          controller: _scroll,
          itemCount: _items.length,
          itemAspect: (i) => mediaItemAspectRatio(_items[i]),
          footer: _loadingMore
              ? const Padding(
                  padding: EdgeInsets.all(16),
                  child: Center(
                    child: SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
                )
              : null,
          buildCell: (context, i, cellW) => MediaThumb(
              item: _items[i],
              onTap: () => _openDetail(i),
              onLongPress: () => _onItemLongPress(_items[i]),
              autoplay: _feed,
              autoplayIndex: i,
              baseUrl: _base,
            ),
        ),
      ),
    );
  }
}
