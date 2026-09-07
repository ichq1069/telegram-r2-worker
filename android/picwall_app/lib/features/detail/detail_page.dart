import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:gal/gal.dart';
import 'package:share_plus/share_plus.dart';
import '../video/native_video_player.dart';

import '../../core/constants.dart';
import '../../core/time_utils.dart';
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

  /// 当前配置的 API 根地址（用于把相对直链补成绝对地址）。
  String get _base => ref.read(settingsControllerProvider).settings.apiBase;

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

  void _showDetail() {
    final item = _current;
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFF1E1E1E),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (_) => DraggableScrollableSheet(
        initialChildSize: 0.5,
        minChildSize: 0.2,
        maxChildSize: 0.8,
        expand: false,
        builder: (ctx, ctrl) => ListView(
          controller: ctrl,
          padding: const EdgeInsets.all(20),
          children: [
            Center(
              child: Container(
                width: 36, height: 4,
                decoration: BoxDecoration(color: Colors.white24, borderRadius: BorderRadius.circular(2)),
              ),
            ),
            const SizedBox(height: 16),
            const Text('文件详情',
                style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w600)),
            const SizedBox(height: 16),
            if (item.title.isNotEmpty) _detailRow('文件名', item.title),
            _detailRow('类型', item.fileTypeLabel),
            if (item.width != null && item.height != null)
              _detailRow('尺寸', '${item.width} × ${item.height}'),
            if (item.fileSize != null) _detailRow('大小', _fmtSize(item.fileSize!)),
            if (item.source.isNotEmpty) _detailRow('来源', item.source),
            if (item.createdAt.isNotEmpty) _detailRow('时间', BJT.formatDateTime(item.createdAt)),
            _detailRow('等级', item.level.label),
            if (item.tags.isNotEmpty) ...[
              const SizedBox(height: 4),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const SizedBox(
                    width: 64,
                    child: Text('标签', style: TextStyle(color: Colors.white54, fontSize: 13)),
                  ),
                  Expanded(
                    child: Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        for (final tag in item.tags)
                          GestureDetector(
                            onTap: () {
                              Navigator.pop(ctx);
                              Navigator.pop(context); // close detail page
                              // TODO: navigate to gallery with tag filter
                            },
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                              decoration: BoxDecoration(
                                color: const Color(0xFF6C7CFF).withValues(alpha: 0.25),
                                borderRadius: BorderRadius.circular(10),
                              ),
                              child: Text(tag, style: const TextStyle(color: Color(0xFF9FA8FF), fontSize: 12)),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: () {
                  Clipboard.setData(
                      ClipboardData(text: _abs(_base, item.url)));
                  ScaffoldMessenger.of(ctx).showSnackBar(
                      const SnackBar(content: Text('直链已复制')));
                },
                icon: const Icon(Icons.copy, size: 16, color: Colors.white70),
                label: const Text('复制直链',
                    style: TextStyle(color: Colors.white70, fontSize: 13)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  static Widget _detailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 64,
            child: Text(label, style: const TextStyle(color: Colors.white54, fontSize: 13)),
          ),
          Expanded(
            child: Text(value, style: const TextStyle(color: Colors.white, fontSize: 13)),
          ),
        ],
      ),
    );
  }

  Future<void> _downloadVideo() async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      final item = _current;
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
              const SnackBar(content: Text('需要相册权限才能保存')));
          }
          return;
        }
      }
      await Gal.putImageBytes(Uint8List.fromList(bytes),
          name: item.title.isNotEmpty ? item.title : 'picwall_video');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('视频已保存到相册')));
      }
    } catch (e) {
      DebugService.instance.recordError('DetailPage.downloadVideo', e);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('下载失败：请检查网络')));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  static String _fmtSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1048576) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    if (bytes < 1073741824) return '${(bytes / 1048576).toStringAsFixed(1)} MB';
    return '${(bytes / 1073741824).toStringAsFixed(1)} GB';
  }

  Future<void> _share() async {
    final url = _abs(_base, _current.url);
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
              return _MediaViewer(
                item: item,
                apiBase: _base,
                active: i == _index,
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
                    if (_current.isVideo)
                      _ActionBtn(
                        icon: Icons.download_outlined,
                        label: _saving ? '下载中…' : '下载',
                        onTap: _downloadVideo,
                      ),
                    _ActionBtn(icon: Icons.info_outline, label: '详情', onTap: _showDetail),
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
  });

  final MediaItem item;
  final String apiBase;

  /// 是否为 PageView 当前页：仅当前页的视频原生自动播放，邻页保持封面。
  final bool active;

  @override
  Widget build(BuildContext context) {
    // 服务端可能返回相对路径（如 /file/tg/…），补齐 scheme/host 后展示/播放。
    final thumb = _abs(apiBase, item.displayThumb);
    final videoUrl = _abs(apiBase, item.url);
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
                  controls: true,
                )
              : _VideoPoster(url: thumb))
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

/// 相对路径(/file/…)拼上根地址；已是绝对直链则原样返回。
String _abs(String base, String u) {
  if (u.isEmpty) return u;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  if (base.isEmpty) return u;
  if (u.startsWith('/')) return '$base$u';
  return '$base/$u';
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
