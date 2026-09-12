import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/media_item.dart';
import '../../data/repositories/gallery_repository.dart';
import '../../services/api_client.dart';
import '../../services/debug_service.dart';
import '../../services/providers.dart';
import '../../ui/app_widgets.dart';
import '../detail/detail_page.dart';
import '../video/feed_video_autoplay.dart';
import 'masonry_virtual_grid.dart';
import 'media_thumb.dart';

/// 通用双列瀑布流分页浏览容器（虚拟化构建，仅渲染视口附近行）。
class PagedMediaGrid extends ConsumerStatefulWidget {
  const PagedMediaGrid({
    super.key,
    required this.title,
    required this.loader,
    this.embedded = false,
    this.tabIndex,
    this.controller,
    this.onItemsChanged,
  });

  final String title;

  /// 分页加载函数：page 从 1 开始。
  final Future<PagedMedia> Function(GalleryRepository repo, int page) loader;

  /// 内嵌到已有 Scaffold 时传 true，隐藏自己的 AppBar。
  final bool embedded;

  /// 所在 HomeShell Tab 下标；独立页传 null（按路由可见性门控即可）。
  final int? tabIndex;

  /// 宿主用于读取当前已加载条目/页码快照（如抖音视图入口）。
  final PagedMediaGridController? controller;

  /// 已加载内容变化（首屏/续载成功）后回调，供宿主刷新入口可用态。
  final VoidCallback? onItemsChanged;

  @override
  ConsumerState<PagedMediaGrid> createState() => _PagedMediaGridState();
}

/// 供宿主读取网格运行时快照的控制器（绑定到网格 State 生命周期）。
class PagedMediaGridController {
  _PagedMediaGridState? _state;

  List<MediaItem> get items =>
      List.unmodifiable(_state?._items ?? const <MediaItem>[]);

  int get currentPage => _state?._page ?? 1;
}

class _PagedMediaGridState extends ConsumerState<PagedMediaGrid> {
  final ScrollController _scroll = ScrollController();
  final FeedVideoAutoplay _feed = FeedVideoAutoplay();
  final List<MediaItem> _items = [];
  int _page = 1;
  int _total = 0;
  bool _loading = false;
  bool _loadingMore = false;
  bool _hasError = false;
  String _errorText = '';

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _scroll.addListener(_feed.onScroll);
    widget.controller?._state = this;
    _loadFirst();
  }

  @override
  void dispose() {
    if (widget.controller?._state == this) {
      widget.controller?._state = null;
    }
    _scroll.removeListener(_feed.onScroll);
    _scroll.dispose();
    _feed.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scroll.position.pixels >= _scroll.position.maxScrollExtent - 400) {
      _loadMore();
    }
  }

  Future<void> _loadFirst() async {
    setState(() {
      _loading = true;
      _hasError = false;
    });
    try {
      final repo = ref.read(galleryRepositoryProvider);
      final res = await widget.loader(repo, 1);
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(res.items);
        _total = res.total;
        _page = 1;
        _loading = false;
      });
      widget.onItemsChanged?.call();
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
      final repo = ref.read(galleryRepositoryProvider);
      final res = await widget.loader(repo, next);
      if (!mounted) return;
      setState(() {
        _items.addAll(res.items);
        _total = res.total;
        _page = next;
        _loadingMore = false;
      });
      widget.onItemsChanged?.call();
    } catch (e, st) {
      DebugService.instance.recordError('PagedMediaGrid.load', e, st);
      if (!mounted) return;
      setState(() => _loadingMore = false);
    }
  }

  void _openDetail(int index) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DetailPage(
          items: _items,
          initialIndex: index,
          heroTagPrefix: 'gallery',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final body = RefreshIndicator(
      onRefresh: _loadFirst,
      child: _body(context),
    );
    if (widget.embedded) return body;
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: body,
    );
  }

  Widget _body(BuildContext context) {
    if (_loading) {
      return const AppSkeletonGrid();
    }
    if (_hasError) {
      return AppErrorState(
        message: _errorText,
        onRetry: _loadFirst,
      );
    }
    if (_items.isEmpty) {
      return AppEmptyState(
        icon: Icons.image_not_supported_outlined,
        text: '还没有内容',
        actionLabel: '刷新',
        onAction: _loadFirst,
      );
    }
    return FeedGate(
      feed: _feed,
      tabIndex: widget.tabIndex,
      child: MasonryVirtualGrid(
        controller: _scroll,
        itemCount: _items.length,
        itemAspect: (i) => mediaItemAspectRatio(_items[i]),
        footer: _loadingMore
            ? const Padding(
                padding: EdgeInsets.symmetric(vertical: 16),
                child: AppLoadingIndicator(size: 22, strokeWidth: 2),
              )
            : null,
        buildCell: (context, i, cellW) => MediaThumb(
          item: _items[i],
          onTap: () => _openDetail(i),
          autoplay: _feed,
          autoplayIndex: i,
          baseUrl: ref.read(settingsControllerProvider).settings.apiBase,
          heroTag: 'gallery_${_items[i].key}',
        ),
      ),
    );
  }
}
