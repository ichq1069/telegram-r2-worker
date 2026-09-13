import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../video/native_video_player.dart';

import '../../data/models/media_item.dart';
import '../../services/providers.dart';
import 'detail_actions.dart';

/// 详情页：大图 + 左右滑切 + 缩放 + 操作条（收藏/保存/分享/复制）。
///
/// 浏览时自动写入本地历史；收藏落本地库；保存调用系统相册（图片）。
class DetailPage extends ConsumerStatefulWidget {
  const DetailPage({
    super.key,
    required this.items,
    this.initialIndex = 0,
    this.heroTagPrefix,
  });

  final List<MediaItem> items;
  final int initialIndex;

  /// Hero tag 前缀（与列表页 MediaThumb 的 heroTag 对应）。
  final String? heroTagPrefix;

  @override
  ConsumerState<DetailPage> createState() => _DetailPageState();
}

class _DetailPageState extends ConsumerState<DetailPage>
    with DetailActionsMixin<DetailPage> {
  late final PageController _pageController;
  late int _index;

  /// 当前配置的 API 根地址（用于把相对直链补成绝对地址）。
  @override
  String get apiBase => ref.read(settingsControllerProvider).settings.apiBase;

  @override
  void initState() {
    super.initState();
    _index = widget.initialIndex;
    _pageController = PageController(initialPage: widget.initialIndex);
    // 标签点击原语义为「关闭详情面板 + 关掉详情页 + 跳转标签搜索(TODO)」，
    // 抽取进混入后以回调恢复「关掉详情页」这一段。
    onOpenTag = (tag) async {
      if (mounted) Navigator.of(context).maybePop();
    };
    syncBrowse(_current);
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  MediaItem get _current => widget.items[_index];

  void _onPage(int i) {
    setState(() => _index = i);
    syncBrowse(widget.items[i]);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          PageView.builder(
            controller: _pageController,
            itemCount: widget.items.length,
            onPageChanged: _onPage,
            itemBuilder: (context, i) {
              final item = widget.items[i];
              final heroTag = widget.heroTagPrefix != null
                  ? '${widget.heroTagPrefix}_${item.id}'
                  : null;
              return _MediaViewer(
                item: item,
                apiBase: apiBase,
                active: i == _index,
                heroTag: heroTag,
              );
            },
          ),
          // 顶部信息
          SafeArea(
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
                      if (_current.title.isNotEmpty)
                        Flexible(
                          child: Text(
                            _current.title,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: Colors.white, fontSize: 13),
                          ),
                        )
                      else
                        Text('${_index + 1} / ${widget.items.length}',
                            style: const TextStyle(color: Colors.white70, fontSize: 13)),
                    ],
                  ),
                ),
              ),
            ),
          ),
          // 底部操作条
          SafeArea(
            child: Align(
              alignment: Alignment.bottomCenter,
              child: Container(
                color: Colors.black.withValues(alpha: 0.6),
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                  children: [
                    _ActionBtn(
                      icon: fav ? Icons.favorite : Icons.favorite_outline,
                      label: fav ? '已收藏' : '收藏',
                      color: fav ? const Color(0xFFE91E63) : Colors.white,
                      onTap: () => toggleFavorite(_current),
                    ),
                    _ActionBtn(
                      icon: Icons.download_outlined,
                      label: saving ? '保存中…' : '保存',
                      onTap: () => savePhoto(_current),
                    ),
                    _ActionBtn(
                        icon: Icons.share_outlined,
                        label: '分享',
                        onTap: () => shareItem(_current)),
                    if (_current.isVideo)
                      _ActionBtn(
                        icon: Icons.download_outlined,
                        label: saving ? '下载中…' : '下载',
                        onTap: () => downloadVideo(_current),
                      ),
                    _ActionBtn(
                        icon: Icons.info_outline,
                        label: '详情',
                        onTap: () => showInfo(_current)),
                  ],
                ),
              ),
            ),
          ),
          // 关闭按钮
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(4),
              child: IconButton(
                icon: const Icon(Icons.close, color: Colors.white),
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _MediaViewer extends StatelessWidget {
  const _MediaViewer({
    required this.item,
    required this.apiBase,
    required this.active,
    this.heroTag,
  });

  final MediaItem item;
  final String apiBase;

  /// 是否为 PageView 当前页：仅当前页的视频原生自动播放，邻页保持封面。
  final bool active;

  final String? heroTag;

  @override
  Widget build(BuildContext context) {
    // 服务端可能返回相对路径（如 /file/tg/…），补齐 scheme/host 后展示/播放。
    final thumb = absUrl(apiBase, item.displayThumb);
    final poster = absUrl(apiBase, item.posterUrl);
    final videoUrl = absUrl(apiBase, item.url);

    Widget viewer = Container(
      color: Colors.black,
      alignment: Alignment.center,
      child: item.isVideo
          ? (active
              ? NativeVideoPlayer(
                  url: videoUrl,
                  posterUrl: poster,
                  autoplay: true,
                  loop: true,
                  muted: true,
                  controls: true,
                  softwareFallback: true,
                )
              : _VideoPoster(url: poster))
          : InteractiveViewer(
              maxScale: 5,
              child: Image.network(
                thumb,
                fit: BoxFit.contain,
                loadingBuilder: (_, child, progress) {
                  if (progress == null) return child;
                  return const Center(
                    child: CircularProgressIndicator(color: Colors.white54),
                  );
                },
                errorBuilder: (_, __, ___) => const Center(
                  child: Icon(Icons.broken_image_outlined, size: 64, color: Colors.white38),
                ),
              ),
            ),
    );

    if (heroTag != null) {
      viewer = Hero(tag: heroTag!, child: viewer);
    }

    return viewer;
  }
}

/// 非当前页（滑动过渡中可见）的视频封面占位：图片 + 播放提示。
class _VideoPoster extends StatelessWidget {
  const _VideoPoster({required this.url});

  final String url;

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        if (url.isEmpty)
          Container(color: Colors.black)
        else
          Image.network(
            url,
            fit: BoxFit.contain,
            loadingBuilder: (_, child, progress) {
              if (progress == null) return child;
              return const Center(
                child: CircularProgressIndicator(color: Colors.white54),
              );
            },
            errorBuilder: (_, __, ___) => Container(
              color: Colors.black,
              alignment: Alignment.center,
              child: const Icon(Icons.play_circle_outline,
                  size: 64, color: Colors.white38),
            ),
          ),
        const Center(
          child: Icon(Icons.play_circle_outline,
              size: 64, color: Colors.white70),
        ),
        const Positioned(
          bottom: 24,
          left: 0,
          right: 0,
          child: Text(
            '当前页自动播放',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white70, fontSize: 13),
          ),
        ),
      ],
    );
  }
}

class _ActionBtn extends StatelessWidget {
  const _ActionBtn({
    required this.icon,
    required this.label,
    required this.onTap,
    this.color = Colors.white,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: color),
            const SizedBox(height: 2),
            Text(label, style: const TextStyle(color: Colors.white70, fontSize: 11)),
          ],
        ),
      ),
    );
  }
}
