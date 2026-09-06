import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/models/media_item.dart';

/// 详情页：大图 + 左右滑切 + 缩放 + 操作条（收藏/保存/分享/复制）。
class DetailPage extends StatefulWidget {
  const DetailPage({
    super.key,
    required this.items,
    this.initialIndex = 0,
  });

  final List<MediaItem> items;
  final int initialIndex;

  @override
  State<DetailPage> createState() => _DetailPageState();
}

class _DetailPageState extends State<DetailPage> {
  late final PageController _pageController;
  late int _index;

  @override
  void initState() {
    super.initState();
    _index = widget.initialIndex;
    _pageController = PageController(initialPage: widget.initialIndex);
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  MediaItem get _current => widget.items[_index];

  Future<void> _copyLink() async {
    await Clipboard.setData(ClipboardData(text: _current.url));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('直链已复制')));
    }
  }

  void _favorite() {
    // TODO(T1.9): 落本地 drift 收藏库。
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('收藏功能即将上线')));
  }

  void _save() {
    // TODO(T1.9/T2.x): 写系统相册，需权限。
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('保存功能即将上线')));
  }

  void _share() {
    // TODO: share_plus 分享。
    _copyLink();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          PageView.builder(
            controller: _pageController,
            itemCount: widget.items.length,
            onPageChanged: (i) => setState(() => _index = i),
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
                        const Text('${_index + 1} / ${widget.items.length}',
                            style: TextStyle(color: Colors.white70, fontSize: 13)),
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
                    _ActionBtn(icon: Icons.favorite_outline, label: '收藏', onTap: _favorite),
                    _ActionBtn(icon: Icons.download_outlined, label: '保存', onTap: _save),
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
          ? const Center(child: Icon(Icons.play_circle_outline, size: 64, color: Colors.white38))
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

class _ActionBtn extends StatelessWidget {
  const _ActionBtn({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

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
            Icon(icon, color: Colors.white),
            const SizedBox(height: 2),
            Text(label, style: const TextStyle(color: Colors.white70, fontSize: 11)),
          ],
        ),
      ),
    );
  }
}
