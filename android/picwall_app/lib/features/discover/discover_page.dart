import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/media_item.dart';
import '../../data/repositories/gallery_repository.dart';
import '../../services/api_client.dart';
import '../../services/providers.dart';
import '../../ui/app_widgets.dart';
import '../../ui/page_transitions.dart';
import '../detail/detail_page.dart';
import '../douyin/douyin_view_page.dart';
import '../gallery/masonry_virtual_grid.dart';
import '../gallery/media_thumb.dart';
import '../video/feed_video_autoplay.dart';

/// 发现页：共享库随机推荐（每次取一批，可换一批/筛选类型）。
class DiscoverPage extends ConsumerStatefulWidget {
  const DiscoverPage({super.key});

  @override
  ConsumerState<DiscoverPage> createState() => _DiscoverPageState();
}

class _DiscoverPageState extends ConsumerState<DiscoverPage> {
  final ScrollController _scroll = ScrollController();
  final FeedVideoAutoplay _feed = FeedVideoAutoplay();
  List<MediaItem> _items = const [];
  String _type = '';
  bool _loading = true;
  bool _hasError = false;
  String _errorText = '';

  String get _base =>
      ref.read(settingsControllerProvider).settings.apiBase;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_feed.onScroll);
    _loadRandom();
  }

  @override
  void dispose() {
    _scroll.removeListener(_feed.onScroll);
    _scroll.dispose();
    _feed.dispose();
    super.dispose();
  }

  Future<void> _loadRandom() async {
    setState(() {
      _loading = true;
      _hasError = false;
    });
    try {
      final repo = ref.read(galleryRepositoryProvider);
      final items = await repo.randomPool(count: 10, type: _type);
      if (!mounted) return;
      setState(() {
        _items = items;
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

  void _openDetail(int index) {
    Navigator.of(context).push(
      SlideFadePageRoute<void>(
        builder: (_) => DetailPage(
          items: List.of(_items),
          initialIndex: index,
          heroTagPrefix: 'discover',
        ),
      ),
    );
  }

  Future<PagedMedia> _douyinLoadPage(GalleryRepository repo, int page) async {
    final items = await repo.randomPool(count: 10, type: _type);
    return PagedMedia(
        items: items, total: -1, offset: page, hasMore: items.isNotEmpty);
  }

  void _openDouyin() {
    if (_items.isEmpty || !mounted) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DouyinViewPage(
          initialItems: List.of(_items),
          startPage: 1,
          title: '发现',
          loadPage: _douyinLoadPage,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('发现'),
        actions: [
          IconButton(
            tooltip: '抖音视图',
            icon: const Icon(Icons.swipe_vertical),
            onPressed: _loading || _items.isEmpty ? null : _openDouyin,
          ),
          IconButton(
            tooltip: '换一批',
            icon: const Icon(Icons.refresh),
            onPressed: _loading ? null : _loadRandom,
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    '为你随机推荐，轻点「换一批」刷新',
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                      fontSize: 12,
                    ),
                  ),
                ),
              ],
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
                      onSelected: (sel) {
                        if (sel && _type != value) {
                          setState(() => _type = value);
                          _loadRandom();
                        }
                      },
                    ),
                  ),
              ],
            ),
          ),
          Expanded(
            child: FeedGate(
              feed: _feed,
              tabIndex: 0,
              child: _body(context),
            ),
          ),
        ],
      ),
      floatingActionButton: _loading || _hasError || _items.isEmpty
          ? null
          : FloatingActionButton.extended(
              onPressed: _loadRandom,
              icon: const Icon(Icons.casino_outlined),
              label: const Text('换一批'),
            ),
    );
  }

  Widget _body(BuildContext context) {
    if (_loading) {
      return const AppLoadingIndicator();
    }
    if (_hasError) {
      return AppErrorState(
        message: _errorText,
        onRetry: _loadRandom,
      );
    }
    if (_items.isEmpty) {
      return AppEmptyState(
        icon: Icons.inbox_outlined,
        text: '当前没有可推荐的',
        actionLabel: '换一批',
        onAction: _loadRandom,
      );
    }
    return RefreshIndicator(
      onRefresh: _loadRandom,
      child: MasonryVirtualGrid(
        controller: _scroll,
        itemCount: _items.length,
        itemAspect: (i) => mediaItemAspectRatio(_items[i]),
        buildCell: (context, i, cellW) => MediaThumb(
          item: _items[i],
          onTap: () => _openDetail(i),
          autoplay: _feed,
          autoplayIndex: i,
          baseUrl: _base,
          heroTag: 'discover_${_items[i].id}',
        ),
      ),
    );
  }
}
