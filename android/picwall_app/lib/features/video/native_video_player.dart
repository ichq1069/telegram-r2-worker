import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

/// 原生内联视频播放器（基于 video_player / ExoPlayer）。
///
/// - [posterUrl]：加载/错误时显示的封面，避免黑屏闪烁；
/// - [controls] 为 true 时显示轻量控制层（点按暂停/播放、声音开关）；
/// - 应用退后台自动暂停，回前台自动恢复；
/// - 出错提供重试；dispose 时释放解码器。
class NativeVideoPlayer extends StatefulWidget {
  const NativeVideoPlayer({
    super.key,
    required this.url,
    this.posterUrl = '',
    this.autoplay = false,
    this.loop = false,
    this.muted = true,
    this.controls = false,
    this.fit = BoxFit.contain,
  });

  /// 绝对直链（http/https）。
  final String url;

  /// 封面绝对直链（可为空，则加载期显示黑底/转圈）。
  final String posterUrl;

  /// 初始化完成即自动播放。
  final bool autoplay;

  /// 循环播放。
  final bool loop;

  /// 初始是否静音；控制层内可切换。
  final bool muted;

  /// 显示轻量控制层（播放/暂停 + 声音开关）。
  final bool controls;

  /// 视频在画布内的适配方式。
  final BoxFit fit;

  @override
  State<NativeVideoPlayer> createState() => _NativeVideoPlayerState();
}

class _NativeVideoPlayerState extends State<NativeVideoPlayer>
    with WidgetsBindingObserver {
  VideoPlayerController? _controller;
  bool _initialized = false;
  bool _failed = false;
  bool _muted = true;
  bool _autoPlaying = false;
  bool _lastPlaying = false;
  bool _lastBuffering = false;
  int _initToken = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _muted = widget.muted;
    _autoPlaying = widget.autoplay;
    _create();
  }

  @override
  void didUpdateWidget(NativeVideoPlayer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.url != widget.url) {
      _muted = widget.muted;
      _autoPlaying = widget.autoplay;
      _create();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _initToken++;
    final c = _controller;
    _controller = null;
    if (c != null) {
      c.removeListener(_onValue);
      c.dispose();
    }
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final c = _controller;
    if (c == null || !_initialized) return;
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.inactive) {
      if (c.value.isPlaying) c.pause();
    } else if (state == AppLifecycleState.resumed) {
      if (_autoPlaying && !_failed) c.play();
    }
  }

  void _onValue() {
    final v = _controller?.value;
    if (v == null) return;
    final playing = v.isPlaying;
    final buffering = v.isBuffering;
    if (playing != _lastPlaying || buffering != _lastBuffering) {
      _lastPlaying = playing;
      _lastBuffering = buffering;
      if (mounted) setState(() {});
    }
  }

  Future<void> _create() async {
    _initToken++;
    final old = _controller;
    _controller = null;
    if (old != null) {
      old.removeListener(_onValue);
      old.dispose();
    }
    final token = _initToken;
    _initialized = false;
    _failed = false;
    _lastPlaying = false;
    _lastBuffering = false;
    if (mounted) setState(() {});
    final c = VideoPlayerController.networkUrl(Uri.parse(widget.url));
    _controller = c;
    c.addListener(_onValue);
    try {
      await c.initialize();
      if (!mounted || token != _initToken || _controller != c) return;
      if (widget.loop) await c.setLooping(true);
      await c.setVolume(_muted ? 0 : 1);
      _initialized = true;
      if (mounted) setState(() {});
      if (widget.autoplay) {
        _autoPlaying = true;
        await c.play();
      }
    } catch (_) {
      if (!mounted || token != _initToken || _controller != c) return;
      _failed = true;
      if (mounted) setState(() {});
    }
  }

  void _togglePlay() {
    final c = _controller;
    if (c == null || !_initialized || _failed) return;
    if (c.value.isPlaying) {
      _autoPlaying = false;
      c.pause();
    } else {
      _autoPlaying = true;
      c.play();
    }
  }

  void _toggleMute() {
    final c = _controller;
    final next = !_muted;
    _muted = next;
    if (c != null && _initialized) c.setVolume(next ? 0 : 1);
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final Widget body;
    if (_failed) {
      body = _buildError();
    } else if (!_initialized || _controller == null) {
      body = _buildPoster(showSpinner: true);
    } else {
      body = _buildVideo();
    }
    return body;
  }

  Widget _buildPoster({bool showSpinner = false}) {
    Widget poster = Container(color: Colors.black);
    if (widget.posterUrl.isNotEmpty) {
      poster = Image.network(
        widget.posterUrl,
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => Container(color: Colors.black),
      );
    }
    if (!showSpinner) return poster;
    return Stack(
      fit: StackFit.expand,
      children: [
        poster,
        const Center(
          child: SizedBox(
            width: 28,
            height: 28,
            child: CircularProgressIndicator(
              strokeWidth: 2.5,
              color: Colors.white70,
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildError() {
    return Container(
      color: Colors.black,
      alignment: Alignment.center,
      padding: const EdgeInsets.all(16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.error_outline, size: 40, color: Colors.white54),
          const SizedBox(height: 8),
          const Text(
            '视频加载失败',
            style: TextStyle(color: Colors.white70, fontSize: 14),
          ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: _create,
            style: OutlinedButton.styleFrom(
              foregroundColor: Colors.white,
              side: const BorderSide(color: Colors.white38),
            ),
            icon: const Icon(Icons.refresh, size: 16),
            label: const Text('重试'),
          ),
        ],
      ),
    );
  }

  Widget _buildVideo() {
    final c = _controller!;
    final v = c.value;
    final hasSize = v.isInitialized && v.size.width > 0 && v.size.height > 0;
    final video = Center(
      child: AspectRatio(
        aspectRatio: hasSize ? v.aspectRatio : 1,
        child: VideoPlayer(c),
      ),
    );
    final fitted = SizedBox.expand(
      child: FittedBox(fit: widget.fit, clipBehavior: Clip.hardEdge, child: video),
    );

    final overlayChildren = <Widget>[
      fitted,
      if (v.isBuffering)
        const Center(
          child: SizedBox(
            width: 30,
            height: 30,
            child: CircularProgressIndicator(
              strokeWidth: 2.5,
              color: Colors.white70,
            ),
          ),
        ),
      if (widget.controls) _buildControls(),
    ];

    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.controls ? _togglePlay : null,
      child: Stack(
        fit: StackFit.expand,
        children: overlayChildren,
      ),
    );
  }

  Widget _buildControls() {
    final playing = _controller?.value.isPlaying ?? false;
    return Positioned(
      right: 8,
      bottom: 8,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.45),
          borderRadius: BorderRadius.circular(18),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(
              visualDensity: VisualDensity.compact,
              iconSize: 20,
              color: Colors.white,
              tooltip: playing ? '暂停' : '播放',
              onPressed: _togglePlay,
              icon: Icon(playing ? Icons.pause : Icons.play_arrow),
            ),
            IconButton(
              visualDensity: VisualDensity.compact,
              iconSize: 18,
              color: Colors.white,
              tooltip: _muted ? '开启声音' : '静音',
              onPressed: _toggleMute,
              icon: Icon(_muted ? Icons.volume_off : Icons.volume_up),
            ),
          ],
        ),
      ),
    );
  }
}
