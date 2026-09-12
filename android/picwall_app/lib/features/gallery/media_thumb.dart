import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/constants.dart';
import '../../data/models/media_item.dart';
import '../video/feed_video_autoplay.dart';
import '../video/native_video_player.dart';

/// 媒体宽高比（宽/高，clamp 0.5~2.2，未知按 0.75）。
///
/// MasonryVirtualGrid 的行高预排与卡片 AspectRatio 撑高共用同一口径，
/// 保证虚拟化行高与卡片实际高度一致、无裁剪无抖动。
double mediaItemAspectRatio(MediaItem item) {
  return (item.width != null && item.height != null && item.height! > 0)
      ? (item.width! / item.height!).clamp(0.5, 2.2)
      : 0.75;
}

/// 缩略图卡片：以宽高比撑开，避免 masonry 抖动。
///
/// 当 [autoplay] 非空且条目为视频时，该格会以 [autoplayIndex] 注册到所在
/// 列表的 [FeedVideoAutoplay]：命中播放格时用原生播放器静音循环渲染，其余
/// 视频格保持静态封面（不初始化解码器，滚动离开即自动回收）。
class MediaThumb extends StatefulWidget {
  const MediaThumb({
    super.key,
    required this.item,
    this.onTap,
    this.onLongPress,
    this.showBadge = true,
    this.autoplay,
    this.autoplayIndex,
    this.baseUrl = '',
    this.enableAnimation = true,
    this.heroTag,
  });

  final MediaItem item;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final bool showBadge;

  /// 列表自动播放仲裁器；为 null 时保持纯缩略图行为。
  final FeedVideoAutoplay? autoplay;

  /// 在列表中的序号，作为自动播放槽位标识。
  final int? autoplayIndex;

  /// 直链补全根地址（服务端可能返回 /file/... 相对路径）。
  final String baseUrl;

  /// 是否启用入场动画（staggered fade-in + slide-up）。
  final bool enableAnimation;

  /// Hero 共享元素 tag；为 null 时不启用 Hero 过渡。
  final String? heroTag;

  @override
  State<MediaThumb> createState() => _MediaThumbState();
}

class _MediaThumbState extends State<MediaThumb>
    with SingleTickerProviderStateMixin {
  FeedVideoAutoplay? _feed;
  int? _slot;
  bool _active = false;
  bool _pressed = false;

  // 入场动画
  late final AnimationController _animCtrl;
  late final Animation<double> _fadeAnim;
  late final Animation<Offset> _slideAnim;

  bool get _wanted =>
      widget.autoplay != null &&
      widget.autoplayIndex != null &&
      widget.item.isVideo;

  @override
  void initState() {
    super.initState();
    if (widget.enableAnimation) {
      _animCtrl = AnimationController(
        vsync: this,
        duration: const Duration(milliseconds: 400),
      );
      _fadeAnim = CurvedAnimation(parent: _animCtrl, curve: Curves.easeOut);
      _slideAnim = Tween<Offset>(
        begin: const Offset(0, 0.08),
        end: Offset.zero,
      ).animate(CurvedAnimation(parent: _animCtrl, curve: Curves.easeOutCubic));
      // 延迟启动，制造 staggered 效果
      Future.delayed(
        Duration(milliseconds: (widget.autoplayIndex ?? 0) % 10 * 40),
        () {
          if (mounted) _animCtrl.forward();
        },
      );
    } else {
      _animCtrl = AnimationController(vsync: this, value: 1);
      _fadeAnim = const AlwaysStoppedAnimation(1.0);
      _slideAnim = Tween<Offset>(end: Offset.zero).animate(_animCtrl);
    }
    if (_wanted) _register();
  }

  @override
  void didUpdateWidget(MediaThumb oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.autoplay != widget.autoplay ||
        oldWidget.autoplayIndex != widget.autoplayIndex ||
        oldWidget.item.isVideo != widget.item.isVideo) {
      _unregister();
      if (_wanted) _register();
    }
  }

  @override
  void dispose() {
    _unregister();
    _animCtrl.dispose();
    super.dispose();
  }

  void _register() {
    _feed = widget.autoplay;
    _slot = widget.autoplayIndex;
    _feed!.addListener(_onFeedChanged);
    _feed!.registerVideo(_slot!, _measure);
  }

  void _unregister() {
    final feed = _feed;
    final slot = _slot;
    _feed = null;
    _slot = null;
    _active = false;
    if (feed != null && slot != null) {
      feed.removeListener(_onFeedChanged);
      feed.unregisterVideo(slot);
    }
  }

  void _onFeedChanged() {
    if (!mounted) return;
    final active = _feed?.isActive(_slot ?? -1) ?? false;
    if (active != _active) setState(() => _active = active);
  }

  /// 测量该格相对其最近滚动列表的可见区间；失败返回 null（视为不可见）。
  SlotMetrics? _measure() {
    if (!mounted) return null;
    final RenderObject? renderObject = context.findRenderObject();
    if (renderObject is! RenderBox || !renderObject.attached) return null;
    final scrollable = Scrollable.maybeOf(context);
    if (scrollable == null) return null;
    final position = scrollable.position;
    if (!position.hasPixels) return null;
    final viewportObject = scrollable.context.findRenderObject();
    if (viewportObject is! RenderBox || !viewportObject.attached) return null;
    final topLocal = renderObject.localToGlobal(Offset.zero, ancestor: viewportObject);
    final bottomLocal = renderObject
        .localToGlobal(Offset(0, renderObject.size.height), ancestor: viewportObject);
    return SlotMetrics(
      top: topLocal.dy + position.pixels,
      bottom: bottomLocal.dy + position.pixels,
      offset: position.pixels,
      viewport: position.viewportDimension,
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final ratio = mediaItemAspectRatio(widget.item);
    final playing = _wanted && _active;

    final Widget content;
    if (playing) {
      content = _buildPlayer();
    } else {
      final poster = widget.item.posterUrl;
      content = Stack(
        fit: StackFit.expand,
        children: [
          if (poster.isEmpty)
            Container(
              color: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
            )
          else
            CachedNetworkImage(
              imageUrl: poster,
              fit: BoxFit.cover,
              placeholder: (_, __) => Container(
                color: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
              ),
              errorWidget: (_, __, ___) => Container(
                color: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
                child: const Icon(Icons.broken_image_outlined, color: Colors.white38),
              ),
            ),
          if (widget.item.isVideo)
            const Center(
              child: Icon(Icons.play_circle_outline,
                  size: 40, color: Colors.white70),
            ),
        ],
      );
    }

    Widget card = GestureDetector(
      onTap: widget.onTap,
      onTapDown: (_) => setState(() => _pressed = true),
      onTapUp: (_) => setState(() => _pressed = false),
      onTapCancel: () => setState(() => _pressed = false),
      onLongPress: widget.onLongPress ?? () {
        HapticFeedback.mediumImpact();
        widget.onTap?.call();
      },
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: AspectRatio(
          aspectRatio: ratio,
          child: AnimatedScale(
            scale: _pressed ? 0.96 : 1.0,
            duration: const Duration(milliseconds: 120),
            curve: Curves.easeOutCubic,
            child: Stack(
              fit: StackFit.expand,
              children: [
                content,
                if (widget.showBadge)
                  Positioned(
                    left: 6,
                    top: 6,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (widget.item.level != UserLevel.pt)
                          _Badge(
                            text: widget.item.level.label,
                            color: widget.item.level == UserLevel.vvip
                                ? const Color(0xFFE91E63)
                                : const Color(0xFF7C4DFF),
                          ),
                        if (widget.item.isPrivate) ...[
                          const SizedBox(width: 4),
                          const _Badge(text: '私密', color: Color(0xFF37474F)),
                        ],
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );

    // Hero 过渡
    if (widget.heroTag != null) {
      card = Hero(tag: widget.heroTag!, child: card);
    }

    // 入场动画
    return FadeTransition(
      opacity: _fadeAnim,
      child: SlideTransition(
        position: _slideAnim,
        child: card,
      ),
    );
  }

  Widget _buildPlayer() {
    return NativeVideoPlayer(
      url: _abs(widget.item.url),
      posterUrl: _abs(widget.item.posterUrl),
      autoplay: true,
      loop: true,
      muted: true,
      controls: false,
      fit: BoxFit.cover,
      softwareFallback: true,
    );
  }

  String _abs(String u) {
    if (u.isEmpty) return u;
    if (u.startsWith('http://') || u.startsWith('https://')) return u;
    final base = widget.baseUrl;
    if (base.isEmpty) return u;
    if (u.startsWith('/')) return '$base$u';
    return '$base/$u';
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.9),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        text,
        style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w600),
      ),
    );
  }
}
