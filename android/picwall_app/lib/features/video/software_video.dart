import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';

import '../../services/debug_service.dart';

/// media_kit（libmpv / ffmpeg）软件解码回退播放器。
///
/// ExoPlayer（video_player）在设备缺少对应硬解（如 HEVC/H.265 或特殊
/// container/profile）时报 MediaCodec 错误，此时由本组件接管，用内置
/// ffmpeg 软件解码继续播放。界面交互与 [NativeVideoPlayer] 对齐
/// （点按播放/暂停、声音开关、缓冲提示、出错可重试或复制链接）。
class SoftwareVideo extends StatefulWidget {
  const SoftwareVideo({
    super.key,
    required this.url,
    this.autoplay = false,
    this.loop = false,
    this.muted = true,
    this.controls = false,
    this.showTapToUnmute = false,
  });

  /// 绝对直链（http/https）。
  final String url;

  /// 打开即自动播放。
  final bool autoplay;

  /// 循环播放。
  final bool loop;

  /// 初始是否静音；控制层内可切换。
  final bool muted;

  /// 显示轻量控制层（播放/暂停 + 声音开关）。
  final bool controls;

  /// [controls] 为 false 时整画面轻触切换静音/开声，静音态显示提示浮层。
  final bool showTapToUnmute;

  @override
  State<SoftwareVideo> createState() => _SoftwareVideoState();
}

class _SoftwareVideoState extends State<SoftwareVideo>
    with WidgetsBindingObserver {
  Player? _player;
  VideoController? _controller;
  final List<StreamSubscription<dynamic>> _subs = [];
  bool _failed = false;
  bool _playing = false;
  bool _buffering = true;
  bool _muted = true;
  String _errorMsg = '';
  bool _resumeAfterBg = false;
  int _openToken = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _muted = widget.muted;
    // 首次打开由 initState 触发：字段已是初始值，无需同步 setState。
    _open(resetUi: false);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _openToken++;
    for (final s in _subs) {
      s.cancel();
    }
    _player?.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.inactive) {
      final p = _player;
      if (p != null && _playing) {
        _resumeAfterBg = true;
        p.pause();
      }
    } else if (state == AppLifecycleState.resumed) {
      if (_resumeAfterBg && !_failed && widget.autoplay) {
        _resumeAfterBg = false;
        _player?.play();
      }
    }
  }

  Future<void> _open({bool resetUi = true}) async {
    final token = ++_openToken;
    for (final s in _subs) {
      s.cancel();
    }
    _subs.clear();
    _player?.dispose();
    _player = null;
    _controller = null;
    _failed = false;
    _buffering = true;
    _playing = false;
    _errorMsg = '';
    if (resetUi && mounted) setState(() {});
    try {
      final p = Player();
      _player = p;
      _controller = VideoController(p);
      _subs.add(p.stream.error.listen((e) {
        if (token != _openToken || !mounted) return;
        _failed = true;
        _buffering = false;
        _errorMsg = e.isEmpty ? '播放失败' : e;
        DebugService.instance.recordError('SoftwareVideo.error', e);
        if (mounted) setState(() {});
      }));
      _subs.add(p.stream.playing.listen((v) {
        if (token != _openToken || !mounted) return;
        if (v != _playing) {
          _playing = v;
          if (mounted) setState(() {});
        }
      }));
      _subs.add(p.stream.buffering.listen((v) {
        if (token != _openToken || !mounted) return;
        _buffering = v;
        if (mounted) setState(() {});
      }));
      _subs.add(p.stream.completed.listen((_) {
        if (token != _openToken || !mounted) return;
        if (!widget.loop) {
          _playing = false;
          if (mounted) setState(() {});
        }
      }));
      if (_muted) {
        await p.setVolume(0);
      }
      await p.open(Media(widget.url), play: widget.autoplay);
      if (!mounted || token != _openToken) return;
      if (widget.loop) {
        await p.setPlaylistMode(PlaylistMode.loop);
      }
    } catch (e) {
      DebugService.instance.recordError('SoftwareVideo.open', e);
      if (!mounted || token != _openToken) return;
      setState(() {
        _failed = true;
        _buffering = false;
        _errorMsg = e.toString();
      });
    }
  }

  void _togglePlay() {
    final p = _player;
    if (p == null || _failed) return;
    if (_playing) {
      p.pause();
    } else {
      p.play();
    }
  }

  void _toggleMute() {
    final p = _player;
    if (p == null) return;
    _muted = !_muted;
    p.setVolume(_muted ? 0 : 100);
    if (mounted) setState(() {});
  }

  Future<void> _copyUrl() async {
    await Clipboard.setData(ClipboardData(text: widget.url));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('播放链接已复制，可粘贴到浏览器打开')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final body = _buildBody();
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: _failed
          ? null
          : (widget.controls
              ? _togglePlay
              : (widget.showTapToUnmute ? _toggleMute : null)),
      child: body,
    );
  }

  Widget _buildBody() {
    final c = _controller;
    if (c == null) {
      return const Center(
        child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white54),
      );
    }
    return Stack(
      fit: StackFit.expand,
      children: [
        Container(color: Colors.black, child: Video(controller: c, controls: NoVideoControls)),
        if (_buffering && !_failed)
          const Center(
            child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white54),
          ),
        if (widget.showTapToUnmute &&
            !widget.controls &&
            _muted &&
            !_failed &&
            !_buffering)
          _buildSoundHint(),
        if (_failed) _buildError(),
        if (widget.controls && !_failed && !_buffering) _buildControls(),
      ],
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
              tooltip: _playing ? '暂停' : '播放',
              onPressed: _togglePlay,
              icon: Icon(_playing ? Icons.pause : Icons.play_arrow),
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
            '软件解码播放失败',
            style: TextStyle(color: Colors.white70, fontSize: 14),
          ),
          if (_errorMsg.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                _errorMsg,
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
            children: [
              OutlinedButton.icon(
                onPressed: () => _open(resetUi: true),
                style: OutlinedButton.styleFrom(
                  foregroundColor: Colors.white,
                  side: const BorderSide(color: Colors.white38),
                ),
                icon: const Icon(Icons.refresh, size: 16),
                label: const Text('重试'),
              ),
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
}
