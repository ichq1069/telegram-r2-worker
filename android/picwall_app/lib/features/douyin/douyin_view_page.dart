import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/media_item.dart';
import '../../data/repositories/gallery_repository.dart';
import '../../services/debug_service.dart';
import '../../services/providers.dart';
import '../detail/detail_actions.dart';
import '../video/native_video_player.dart';

/// 抖音视图：竖向全屏一屏一媒体浏览。
///
/// - 视频：默认静音自动循环播放，轻点画面开声（再点静音），仅当前屏初始化
///   解码器，邻屏显示封面占位；解码失败自动软解回退。
/// - 图片：contain 完整展示 + 底部渐变信息层。
/// - 右侧常驻操作栏：收藏 / 保存 / 分享 / 详情 / 下载视频，行为与详情页一致。
/// - 滑动近尾部自动调用 [loadPage] 续载（按 dedupeKey 去重），到尾显示「没有更多了」。
class DouyinViewPage extends ConsumerStatefulWidget {
  const DouyinViewPage({
    super.key,
    required this.initialItems,
    required this.loadPage,
    required this.startPage,
    required this.title,
  });

  /// 进入瞬间的数据快照（含当前列表过滤上下文已加载的内容）。
  final List<MediaItem> initialItems;

  /// 续载函数：page 从已加载到的页码之后继续。图库传 galleryData loader，
  /// 发现传 randomPool 包装（页码无意义，靠去重判断是否到底）。
  final Future<PagedMedia> Function(GalleryRepository repo, int page) loadPage;

  /// 进入前已加载到的页码（从 startPage + 1 起续载）。
  final int startPage;

  final String title;

  @override
  ConsumerState<DouyinViewPage> createState() => _DouyinViewPageState();
}

class _DouyinViewPageState extends ConsumerState<DouyinViewPage>
    with DetailActionsMixin<DouyinViewPage> {
  late final PageController _pageController;
  final List<MediaItem> _items = [];
  final Set<String> _seenKeys = {};
  int _page = 1;
  bool _loadingMore = false;
  bool _endReached = false;
  int _current = 0;

  @override
  String get apiBase => ref.read(settingsControllerProvider).settings.apiBase;

  @override
  void initState() {
    super.initState();
    for (final it in widget.initialItems) {
      if (_seenKeys.add(it.dedupeKey)) _items.add(it);
    }
    _page = widget.startPage;
    _pageController = PageController();
    _syncBrowse();
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  MediaItem get _currentItem => _items[_current];

  void _syncBrowse() {
    if (_current < _items.length) syncBrowse(_items[_current]);
  }

  void _onPageChanged(int i) {
    if (i == _current) return;
    setState(() => _current = i);
    _syncBrowse();
    _maybeLoadMore();
  }

  Future<void> _maybeLoadMore() async {
    if (_loadingMore || _endReached) return;
    if (_current < _items.length - 3) return;
    setState(() => _loadingMore = true);
    try {
      final repo = ref.read(galleryRepositoryProvider);
      final next = _page + 1;
      final res = await widget.loadPage(repo, next);
      if (!mounted) return;
      final fresh = <MediaItem>[];
      for (final it in res.items) {
        if (_seenKeys.add(it.dedupeKey)) fresh.add(it);
      }
      if (fresh.isEmpty) {
        setState(() {
          _endReached = true;
          _loadingMore = false;
        });
        return;
      }
      setState(() {
        _page = next;
        _items.addAll(fresh);
        _loadingMore = false;
        if (res.total > 0 && _items.length >= res.total) {
          _endReached = true;
        }
      });
    } catch (e, st) {
      DebugService.instance.recordError('DouyinViewPage.loadMore', e, st);
      if (!mounted) return;
      setState(() => _loadingMore = false);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('加载失败，请检查网络')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final n = _items.length;
    final totalPages = n + (_endReached ? 1 : 0);
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          PageView.builder(
            controller: _pageController,
            itemCount: totalPages,
            onPageChanged: _onPageChanged,
            itemBuilder: (context, i) {
              if (i >= n) return _buildEndHint();
              return _MediaPage(
                item: _items[i],
                apiBase: apiBase,
                active: i == _current,
                index: i,
                total: n,
              );
            },
          ),
          if (_current < n) ...[
            _buildTopPill(),
            _buildBottomInfo(),
            _buildActionRail(),
          ],
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(4),
              child: Align(
                alignment: Alignment.topRight,
                child: IconButton(
                  icon: const Icon(Icons.close, color: Colors.white),
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTopPill() {
    final item = _currentItem;
    return SafeArea(
      child: Align(
        alignment: Alignment.topCenter,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.55),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (item.title.isNotEmpty)
                  Flexible(
                    child: Text(
                      item.title,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: Colors.white, fontSize: 13),
                    ),
                  )
                else
                  Text('${_current + 1} / ${_items.length}',
                      style: const TextStyle(color: Colors.white70, fontSize: 13)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildBottomInfo() {
    final item = _currentItem;
    return Positioned(
      left: 0,
      right: 0,
      bottom: 0,
      child: IgnorePointer(
        child: Container(
          height: 150,
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [
                Colors.black.withValues(alpha: 0),
                Colors.black.withValues(alpha: 0.78),
              ],
            ),
          ),
          padding: const EdgeInsets.fromLTRB(16, 60, 96, 20),
          child: Align(
            alignment: Alignment.bottomLeft,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (item.title.isNotEmpty) ...[
                  Text(
                    item.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        color: Colors.white, fontSize: 15, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 4),
                ],
                Text('${_current + 1} / ${_items.length}',
                    style: const TextStyle(color: Colors.white70, fontSize: 12)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildActionRail() {
    final item = _currentItem;
    return Positioned(
      right: 6,
      bottom: 0,
      child: SafeArea(
        minimum: const EdgeInsets.only(bottom: 16, right: 6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _railAction(
              icon: fav ? Icons.favorite : Icons.favorite_outline,
              label: '收藏',
              color: fav ? const Color(0xFFE91E63) : Colors.white,
              onTap: () => toggleFavorite(item),
            ),
            _railAction(
              icon: Icons.download_outlined,
              label: saving ? '保存中' : '保存',
              onTap: () => savePhoto(item),
            ),
            _railAction(
              icon: Icons.share_outlined,
              label: '分享',
              onTap: () => shareItem(item),
            ),
            if (item.isVideo)
              _railAction(
                icon: Icons.movie_outlined,
                label: saving ? '下载中' : '下载',
                onTap: () => downloadVideo(item),
              ),
            _railAction(
              icon: Icons.info_outline,
              label: '详情',
              onTap: () => showInfo(item),
            ),
          ],
        ),
      ),
    );
  }

  Widget _railAction({
    required IconData icon,
    required String label,
    required VoidCallback onTap,
    Color color = Colors.white,
  }) {
    return InkResponse(
      onTap: onTap,
      radius: 28,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: color, size: 26),
            const SizedBox(height: 3),
            Text(label,
                style: const TextStyle(color: Colors.white70, fontSize: 10)),
          ],
        ),
      ),
    );
  }

  Widget _buildEndHint() {
    return Container(
      color: Colors.black,
      alignment: Alignment.center,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.inbox_outlined, size: 40, color: Colors.white24),
          const SizedBox(height: 10),
          Text(_loadingMore ? '加载中…' : '没有更多了',
              style: const TextStyle(color: Colors.white38, fontSize: 14)),
        ],
      ),
    );
  }
}

/// 抖音视图单屏：视频（当前屏播、邻屏封面）/ 图片 contain 展示。
class _MediaPage extends StatelessWidget {
  const _MediaPage({
    required this.item,
    required this.apiBase,
    required this.active,
    required this.index,
    required this.total,
  });

  final MediaItem item;
  final String apiBase;

  /// 是否 PageView 当前屏：仅当前屏初始化解码器并自动播放。
  final bool active;
  final int index;
  final int total;

  @override
  Widget build(BuildContext context) {
    final videoUrl = absUrl(apiBase, item.url);
    final thumb = absUrl(apiBase, item.displayThumb);
    return Container(
      color: Colors.black,
      alignment: Alignment.center,
      child: item.isVideo
          ? (active
              ? NativeVideoPlayer(
                  url: videoUrl,
                  posterUrl: thumb,
                  autoplay: true,
                  loop: true,
                  muted: true,
                  controls: false,
                  showTapToUnmute: true,
                  softwareFallback: true,
                )
              : _VideoPoster(url: thumb, hint: '${index + 1} / $total'))
          : _PhotoView(url: thumb),
    );
  }
}

/// 邻屏视频封面占位：封面图 + 播放提示（不初始化解码器）。
class _VideoPoster extends StatelessWidget {
  const _VideoPoster({required this.url, required this.hint});

  final String url;
  final String hint;

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        Image.network(
          url,
          fit: BoxFit.contain,
          loadingBuilder: (_, child, progress) {
            if (progress == null) return child;
            return const Center(
              child: CircularProgressIndicator(color: Colors.white38),
            );
          },
          errorBuilder: (_, __, ___) => const Center(
            child: Icon(Icons.play_circle_outline, size: 64, color: Colors.white38),
          ),
        ),
        const Center(
          child: Icon(Icons.play_circle_outline, size: 56, color: Colors.white70),
        ),
        Positioned(
          bottom: 30,
          left: 0,
          right: 0,
          child: Text(
            hint,
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white54, fontSize: 12),
          ),
        ),
      ],
    );
  }
}

/// 图片单屏：contain 完整展示，不做缩放裁切。
class _PhotoView extends StatelessWidget {
  const _PhotoView({required this.url});

  final String url;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black,
      alignment: Alignment.center,
      child: Image.network(
        url,
        fit: BoxFit.contain,
        loadingBuilder: (_, child, progress) {
          if (progress == null) return child;
          return const Center(
            child: CircularProgressIndicator(color: Colors.white38),
          );
        },
        errorBuilder: (_, __, ___) => const Center(
          child: Icon(Icons.broken_image_outlined, size: 64, color: Colors.white38),
        ),
      ),
    );
  }
}
