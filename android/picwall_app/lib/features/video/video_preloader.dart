import 'package:video_player/video_player.dart';

/// 抖音视图相邻视频预加载器（进程内单例）。
///
/// 短视频 Feed 起播慢的主因是「切到该屏才开始 initialize（建解码器 + 拉流）」。
/// 这里在静止时提前把相邻视频控制器初始化好，滑动切页时由 NativeVideoPlayer
/// 直接取用，省掉一次初始化等待；离开页面时统一释放，避免继续占用解码器。
///
/// - [retain]：更新保留集合（通常为当前屏前后各 1 个视频 url），不在集合内的
///   已就绪控制器立即释放；
/// - [preload]：幂等预初始化，不阻塞调用方；
/// - [take]：取走已就绪控制器并移交所有权（调用方负责 dispose）。
class VideoPreloader {
  VideoPreloader._();

  static final VideoPreloader instance = VideoPreloader._();

  final Map<String, VideoPlayerController> _ready = {};
  final Set<String> _pending = {};
  final Set<String> _keep = {};

  /// 更新保留集合：不在其中的已就绪控制器立即释放。
  void retain(Set<String> keep) {
    _keep
      ..clear()
      ..addAll(keep);
    for (final url in _ready.keys.toList()) {
      if (!_keep.contains(url)) {
        _ready.remove(url)?.dispose();
      }
    }
  }

  /// 预初始化指定视频（幂等，不阻塞）。
  void preload(String url, {bool muted = true, bool loop = true}) {
    if (url.isEmpty) return;
    _keep.add(url);
    if (_ready.containsKey(url) || _pending.contains(url)) return;
    _pending.add(url);
    _create(url, muted: muted, loop: loop)
        .whenComplete(() => _pending.remove(url));
  }

  Future<void> _create(String url,
      {required bool muted, required bool loop}) async {
    final c = VideoPlayerController.networkUrl(Uri.parse(url));
    try {
      await c.initialize();
      // 初始化期间用户可能已滑走（被 retain 移除），此时直接释放。
      if (!_keep.contains(url)) {
        await c.dispose();
        return;
      }
      if (loop) await c.setLooping(true);
      await c.setVolume(muted ? 0 : 1);
      _ready[url] = c;
    } catch (_) {
      try {
        await c.dispose();
      } catch (_) {
        // 释放失败无可挽回，忽略。
      }
    }
  }

  /// 取走已就绪控制器（所有权转移）；未就绪返回 null。
  VideoPlayerController? take(String url) {
    _keep.remove(url);
    return _ready.remove(url);
  }

  /// 释放全部预加载控制器（离开抖音视图时调用）。
  void clear() {
    _keep.clear();
    for (final c in _ready.values) {
      c.dispose();
    }
    _ready.clear();
  }
}
