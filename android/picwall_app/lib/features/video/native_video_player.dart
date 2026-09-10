import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:video_player/video_player.dart';

import '../../services/debug_service.dart';
import 'software_video.dart';
import 'video_preloader.dart';

/// 原生内联视频播放器（基于 video_player / ExoPlayer）。
///
/// - [posterUrl]：加载/错误时显示的封面，避免黑屏闪烁；
/// - [controls] 为 true 时显示轻量控制层（点按暂停/播放、声音开关）；
/// - [showTapToUnmute] 为 true 且 [controls] 为 false 时，整画面轻触切换
///   静音/开声（抖音视图点击画面开声），静音态浮层提示音量图标；
/// - 应用退后台自动暂停，回前台自动恢复；
/// - 出错提供重试；dispose 时释放解码器。
/// - [softwareFallback] 为 true 时，遇到设备解码器不支持的编码/容器
///   （ExoPlayer MediaCodec 错误）会自动切到内置 ffmpeg 软解继续播放。
class NativeVideoPlayer extends StatefulWidget {
  const NativeVideoPlayer({
    super.key,
    required this.url,
    this.posterUrl = '',
    this.autoplay = false,
    this.loop = false,
    this.muted = true,
    this.controls = false,
    this.showTapToUnmute = false,
    this.fit = BoxFit.contain,
    this.softwareFallback = false,
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

  /// [controls] 为 false 时整画面轻触切换静音/开声，静音态显示提示浮层。
  final bool showTapToUnmute;

  /// 视频在画布内的适配方式。
  final BoxFit fit;

  /// ExoPlayer 解码失败时自动切软件解码回退（media_kit/ffmpeg）。
  final bool softwareFallback;

  @override
  State<NativeVideoPlayer> createState() => _NativeVideoPlayerState();
}

class _NativeVideoPlayerState extends State<NativeVideoPlayer>
    with WidgetsBindingObserver {
  VideoPlayerController? _controller;
  bool _initialized = false;
  bool _failed = false;
  String _errorDetail = '';
  bool _decoderUnsupported = false;
  bool _useSoft = false;
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
    // 优先接管预加载好的控制器（邻屏预加载），避免切页时重新 initialize。
    final pre = VideoPreloader.instance.take(widget.url);
    if (pre != null) {
      _adoptPreloaded(pre);
    } else {
      _create();
    }
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
    if (v.hasError && !_failed) {
      _failed = true;
      _setError(v.errorDescription ?? '播放出错');
      DebugService.instance.recordError(
          'NativeVideoPlayer.play', v.errorDescription ?? 'VideoPlayer error');
      _scheduleSoftFallback();
      if (mounted) setState(() {});
      return;
    }
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
    _errorDetail = '';
    _decoderUnsupported = false;
    _useSoft = false;
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
    } catch (e) {
      if (!mounted || token != _initToken || _controller != c) return;
      _failed = true;
      _setError(_describe(e));
      DebugService.instance.recordError('NativeVideoPlayer.init', e);
      _scheduleSoftFallback();
      if (mounted) setState(() {});
    }
  }

  /// 接管预加载好的控制器：直接进入可播放态，再异步补设循环/音量并起播。
  /// 仅在 initState 调用，初始 build 会直接读取 _initialized 状态。
  void _adoptPreloaded(VideoPlayerController c) {
    _controller = c;
    _initialized = true;
    _failed = false;
    _lastPlaying = c.value.isPlaying;
    _lastBuffering = c.value.isBuffering;
    c.addListener(_onValue);
    _configurePreloaded(c);
  }

  Future<void> _configurePreloaded(VideoPlayerController c) async {
    try {
      if (widget.loop) await c.setLooping(true);
      await c.setVolume(_muted ? 0 : 1);
      if (!mounted || _controller != c) return;
      if (widget.autoplay) {
        _autoPlaying = true;
        await c.play();
      }
    } catch (e) {
      if (!mounted || _controller != c) return;
      _failed = true;
      _setError(_describe(e));
      DebugService.instance.recordError('NativeVideoPlayer.adopt', e);
      if (mounted) setState(() {});
    }
  }

  /// 记录错误原文；解码不支持时把展示文案换成可读建议，原文记录进调试日志。
  void _setError(String raw) {
    _decoderUnsupported = _isDecoderError(raw);
    _errorDetail = _decoderUnsupported
        ? '该视频的编码格式当前设备不支持解码。可复制链接到浏览器观看，或用支持该编码的本地播放器打开。'
        : raw;
  }

  /// 在下一帧切换软解：避免在 video_player 的监听/异常回调内直接
  /// dispose 控制器（通知期间销毁同一通知源会触发断言）。
  void _scheduleSoftFallback() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _maybeSoftFallback();
    });
  }

  /// 解码不支持且开启回退时：释放 ExoPlayer，改由软件解码（ffmpeg）接管。
  void _maybeSoftFallback() {
    if (!widget.softwareFallback || _useSoft || !_decoderUnsupported) return;
    _switchToSoft();
  }

  /// 强制切到软解播放器（手动兜底按钮与自动回退共用）。
  void _switchToSoft() {
    if (_useSoft) return;
    _useSoft = true;
    _initToken++;
    final old = _controller;
    _controller = null;
    if (old != null) {
      old.removeListener(_onValue);
      old.dispose();
    }
    // 关键：置 _useSoft 后必须重建，否则 build 仍停留在硬解错误界面。
    if (mounted) setState(() {});
  }

  /// 判断是否为解码器/编码不支持的播放失败（ExoPlayer 报 MediaCodec 渲染错误）。
  static bool _isDecoderError(String raw) {
    final low = raw.toLowerCase();
    return low.contains('mediacodec') ||
        low.contains('exoplaybackexception') ||
        (low.contains('codec') && low.contains('renderer')) ||
        low.contains('unsupported format') ||
        low.contains('cannot decode') ||
        low.contains('format not supported');
  }

  /// 把平台层异常收敛为可读文本（VideoError / PlatformException → 消息 + details）。
  static String _describe(Object e) {
    if (e is PlatformException) {
      final base = e.message ?? '';
      final det = e.details;
      if (det is Map && det.isNotEmpty) {
        final cause = det['cause'] ?? det['message'] ?? '';
        if (cause.toString().isNotEmpty) return '$base: $cause'.trim();
      }
      if (det is String && det.isNotEmpty) return '$base: $det'.trim();
      return base;
    }
    return e.toString();
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
    if (_useSoft) {
      return SoftwareVideo(
        url: widget.url,
        autoplay: widget.autoplay,
        loop: widget.loop,
        muted: _muted,
        controls: widget.controls,
        showTapToUnmute: widget.showTapToUnmute,
      );
    }
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
          Icon(
            _decoderUnsupported ? Icons.ondemand_video : Icons.error_outline,
            size: 40,
            color: Colors.white54,
          ),
          const SizedBox(height: 8),
          Text(
            _decoderUnsupported ? '此视频无法在此设备解码' : '视频加载失败',
            style: const TextStyle(color: Colors.white70, fontSize: 14),
          ),
          if (_errorDetail.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                _errorDetail,
                textAlign: TextAlign.center,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white38, fontSize: 11),
              ),
            ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            alignment: WrapAlignment.center,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              OutlinedButton.icon(
                onPressed: _create,
                style: OutlinedButton.styleFrom(
                  foregroundColor: Colors.white,
                  side: const BorderSide(color: Colors.white38),
                ),
                icon: const Icon(Icons.refresh, size: 16),
                label: const Text('重试'),
              ),
              OutlinedButton.icon(
                onPressed: _switchToSoft,
                style: OutlinedButton.styleFrom(
                  foregroundColor: Colors.white,
                  side: const BorderSide(color: Colors.white38),
                ),
                icon: const Icon(Icons.play_circle_outline, size: 16),
                label: const Text('改用软解播放'),
              ),
              if (_decoderUnsupported)
                OutlinedButton.icon(
                  onPressed: _copyUrl,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.white,
                    side: const BorderSide(color: Colors.white38),
                  ),
                  icon: const Icon(Icons.link, size: 16),
                  label: const Text('复制链接'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  void _copyUrl() {
    Clipboard.setData(ClipboardData(text: widget.url));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('播放链接已复制，可粘贴到浏览器打开')),
      );
    }
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
      if (widget.showTapToUnmute && !widget.controls && _muted)
        _buildSoundHint(),
      if (widget.controls) _buildControls(),
    ];

    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.controls
          ? _togglePlay
          : (widget.showTapToUnmute ? _toggleMute : null),
      child: Stack(
        fit: StackFit.expand,
        children: overlayChildren,
      ),
    );
  }

  /// 静音态整画面轻触开声提示浮层（抖音视图点画面开声）。
  Widget _buildSoundHint() {
    return Positioned(
      left: 0,
      right: 0,
      bottom: 40,
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            color: Colors.black.withValues(alpha: 0.5),
            borderRadius: BorderRadius.circular(16),
          ),
          child: const Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.volume_off, size: 16, color: Colors.white),
              SizedBox(width: 6),
              Text('轻点画面开启声音',
                  style: TextStyle(color: Colors.white, fontSize: 12)),
            ],
          ),
        ),
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
