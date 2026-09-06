import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:gal/gal.dart';
import 'package:share_plus/share_plus.dart';
import 'package:video_player/video_player.dart';

import '../../data/models/media_item.dart';
import '../../services/debug_service.dart';
import '../../services/providers.dart';

/// 详情页：大图 + 左右滑切 + 缩放 + 操作条（收藏/保存/分享/复制）。
///
/// 浏览时自动写入本地历史；收藏落本地库；保存调用系统相册（图片）。
class DetailPage extends ConsumerStatefulWidget {
  const DetailPage({
    super.key,
    required this.items,
    this.initialIndex = 0,
  });

  final List<MediaItem> items;
  final int initialIndex;

  @override
  ConsumerState<DetailPage> createState() => _DetailPageState();
}

class _DetailPageState extends ConsumerState<DetailPage> {
  late final PageController _pageController;
  late int _index;
  bool _fav = false;
  bool _favBusy = false;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _index = widget.initialIndex;
    _pageController = PageController(initialPage: widget.initialIndex);
    _syncItem(_current);
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  MediaItem get _current => widget.items[_index];

  Future<void> _syncItem(MediaItem item) async {
    // 写入浏览历史（幂等覆盖）
    try {
      final db = await ref.read(localDbProvider.future);
      await db.record(item);
    } catch (e, st) {
      DebugService.instance.recordError('DetailPage.record', e, st);
    }
    // 读取收藏态
    bool fav = false;
    try {
      final db = await ref.read(localDbProvider.future);
      fav = await db.isFavorited(item.dedupeKey);
    } catch (e, st) {
      DebugService.instance.recordError('DetailPage.isFavorited', e, st);
    }
    if (mounted) setState(() => _fav = fav);
  }

  void _onPage(int i) {
    setState(() => _index = i);
    _syncItem(widget.items[i]);
  }

  Future<void> _toggleFavorite() async {
    if (_favBusy) return;
    setState(() {
      _favBusy = true;
      _fav = !_fav;
    });
    try {
      final db = await ref.read(localDbProvider.future);
      if (_fav) {
        await db.favorite(_current);
      } else {
        await db.unfavorite(_current.dedupeKey);
      }
    } catch (e, st) {
      DebugService.instance.recordError('DetailPage.toggleFav', e, st);
      if (mounted) setState(() => _fav = !_fav);
    } finally {
      if (mounted) setState(() => _favBusy = false);
    }
  }

  Future<void> _copyLink() async {
    await Clipboard.setData(ClipboardData(text: _current.url));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('直链已复制')));
    }
  }

  Future<void> _share() async {
    final url = _current.url;
    if (!mounted) return;
    try {
      final title = _current.title.isNotEmpty ? _current.title : 'PicWall 图片';
      await SharePlus.instance.share(ShareParams(text: url, subject: title));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('分享不可用，可先复制直链')),
        );
      }
    }
  }

  Future<void> _save() async {
    if (_saving) return;
    final item = _current;
    if (!item.isPhoto) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('当前仅支持图片保存到相册，其它类型可复制直链')),
      );
      return;
    }
    setState(() => _saving = true);
    try {
      // 下载原图字节
      final resp = await ref.read(apiClientProvider).dio.get<List<int>>(
            item.url,
            options: Options(responseType: ResponseType.bytes),
          );
      final bytes = resp.data;
      if (bytes == null || bytes.isEmpty) throw StateError('empty');
      final accessible = await Gal.hasAccess();
      if (!accessible) {
        final granted = await Gal.requestAccess();
        if (!granted) {
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('需要相册权限才能保存')),
            );
          }
          return;
        }
      }
      await Gal.putImageBytes(Uint8List.fromList(bytes));
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('已保存到系统相册')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('保存失败：请检查网络或复制直链')),
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
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
              return _MediaViewer(item: item);
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
                      icon: _fav ? Icons.favorite : Icons.favorite_outline,
                      label: _fav ? '已收藏' : '收藏',
                      color: _fav ? const Color(0xFFE91E63) : Colors.white,
                      onTap: _toggleFavorite,
                    ),
                    _ActionBtn(
                      icon: Icons.download_outlined,
                      label: _saving ? '保存中…' : '保存',
                      onTap: _save,
                    ),
                    _ActionBtn(icon: Icons.share_outlined, label: '分享', onTap: _share),
                    _ActionBtn(icon: Icons.link, label: '复制', onTap: _copyLink),
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
  const _MediaViewer({required this.item});

  final MediaItem item;

  @override
  Widget build(BuildContext context) {
    final url = item.displayThumb;
    return Container(
      color: Colors.black,
      alignment: Alignment.center,
      child: item.isVideo
          ? _VideoTile(url: item.url)
          : InteractiveViewer(
              maxScale: 5,
              child: Image.network(
                url,
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
  }
}

/// 视频查看：首次点击初始化播放器（延迟联网），支持播放/暂停、循环。
class _VideoTile extends StatefulWidget {
  const _VideoTile({required this.url});

  final String url;

  @override
  State<_VideoTile> createState() => _VideoTileState();
}

class _VideoTileState extends State<_VideoTile> {
  VideoPlayerController? _controller;
  bool _loading = false;
  bool _failed = false;

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  Future<void> _ensurePlayer() async {
    if (_controller != null) {
      await _controller!.play();
      return;
    }
    setState(() {
      _loading = true;
      _failed = false;
    });
    final c = VideoPlayerController.networkUrl(Uri.parse(widget.url));
    _controller = c;
    c.setLooping(true);
    try {
      await c.initialize();
      if (!mounted) return;
      setState(() => _loading = false);
      await c.play();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _failed = true;
      });
    }
  }

  Future<void> _toggle() async {
    if (_loading) return;
    final c = _controller;
    if (_failed) {
      // 重试：重建控制器
      _controller?.dispose();
      _controller = null;
      await _ensurePlayer();
      return;
    }
    if (c == null) {
      await _ensurePlayer();
      return;
    }
    if (c.value.isPlaying) {
      await c.pause();
    } else {
      await c.play();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = _controller;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: _toggle,
      child: Container(
        color: Colors.black,
        alignment: Alignment.center,
        child: _content(c),
      ),
    );
  }

  Widget _content(VideoPlayerController? c) {
    if (_loading) {
      return const CircularProgressIndicator(color: Colors.white70);
    }
    if (c == null) {
      return const Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.play_circle_outline, size: 72, color: Colors.white54),
          SizedBox(height: 10),
          Text('点按播放视频', style: TextStyle(color: Colors.white70, fontSize: 14)),
        ],
      );
    }
    if (_failed) {
      return const Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.error_outline, size: 72, color: Colors.white54),
          SizedBox(height: 10),
          Text('播放失败，点按重试', style: TextStyle(color: Colors.white70, fontSize: 14)),
        ],
      );
    }
    if (!c.value.isInitialized) {
      return const CircularProgressIndicator(color: Colors.white70);
    }
    return AnimatedBuilder(
      animation: c,
      builder: (context, _) {
        final v = c.value;
        final playing = v.isPlaying;
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AspectRatio(
              aspectRatio: v.aspectRatio <= 0 ? 16 / 9 : v.aspectRatio,
              child: VideoPlayer(c),
            ),
            const SizedBox(height: 8),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(playing ? Icons.pause_circle_outline : Icons.play_circle_outline,
                    color: Colors.white70, size: 36),
                const SizedBox(width: 8),
                Text(
                  '${_fmt(v.position)} / ${_fmt(v.duration)}',
                  style: const TextStyle(color: Colors.white70, fontSize: 12),
                ),
              ],
            ),
          ],
        );
      },
    );
  }

  static String _fmt(Duration d) {
    final h = d.inHours;
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return h > 0 ? '$h:$m:$s' : '$m:$s';
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
