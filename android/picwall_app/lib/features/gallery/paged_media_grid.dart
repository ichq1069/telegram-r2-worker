import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/media_item.dart';
import '../../data/repositories/gallery_repository.dart';
import '../../services/api_client.dart';
import '../../services/providers.dart';
import '../detail/detail_page.dart';
import 'media_thumb.dart';

/// 通用双列瀑布流分页浏览容器（Wrap 自适应高度）。
class PagedMediaGrid extends ConsumerStatefulWidget {
  const PagedMediaGrid({
    super.key,
    required this.title,
    required this.loader,
    this.embedded = false,
  });

  final String title;

  /// 分页加载函数：page 从 1 开始。
  final Future<PagedMedia> Function(GalleryRepository repo, int page) loader;

  /// 内嵌到已有 Scaffold 时传 true，隐藏自己的 AppBar。
  final bool embedded;

  @override
  ConsumerState<PagedMediaGrid> createState() => _PagedMediaGridState();
}

class _PagedMediaGridState extends ConsumerState<PagedMediaGrid> {
  final ScrollController _scroll = ScrollController();
  final List<MediaItem> _items = [];
  int _page = 1;
  int _total = 0;
  bool _loading = false;
  bool _loadingMore = false;
  bool _hasError = false;
  String _errorText = '';

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _loadFirst();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scroll.position.pixels >= _scroll.position.maxScrollExtent - 400) {
      _loadMore();
    }
  }

  Future<void> _loadFirst() async {
    setState(() {
      _loading = true;
      _hasError = false;
    });
    try {
      final repo = ref.read(galleryRepositoryProvider);
      final res = await widget.loader(repo, 1);
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(res.items);
        _total = res.total;
        _page = 1;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _hasError = true;
        _errorText = normalizeError(e).message;
      });
    }
  }

  Future<void> _loadMore() async {
    if (_loading || _loadingMore) return;
    if (_items.isNotEmpty && _items.length >= _total) return;
    final next = _page + 1;
    setState(() => _loadingMore = true);
    try {
      final repo = ref.read(galleryRepositoryProvider);
      final res = await widget.loader(repo, next);
      if (!mounted) return;
      setState(() {
        _items.addAll(res.items);
        _total = res.total;
        _page = next;
        _loadingMore = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loadingMore = false);
    }
  }

  void _openDetail(int index) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DetailPage(items: _items, initialIndex: index),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final body = RefreshIndicator(
      onRefresh: _loadFirst,
      child: _body(context),
    );
    if (widget.embedded) return body;
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: body,
    );
  }

  Widget _body(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_hasError) {
      return _CenterBox(
        icon: Icons.cloud_off,
        text: _errorText,
        action: FilledButton(onPressed: _loadFirst, child: const Text('重试')),
      );
    }
    if (_items.isEmpty) {
      return _CenterBox(
        icon: Icons.image_not_supported_outlined,
        text: '还没有内容',
        action: FilledButton(onPressed: _loadFirst, child: const Text('刷新')),
      );
    }
    return LayoutBuilder(
      builder: (context, constraints) {
        final cellW = (constraints.maxWidth - 30) / 2;
        return SingleChildScrollView(
          controller: _scroll,
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(10),
          child: Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              for (var i = 0; i < _items.length; i++)
                SizedBox(
                  width: cellW,
                  child: MediaThumb(
                    item: _items[i],
                    onTap: () => _openDetail(i),
                  ),
                ),
              if (_loadingMore)
                const SizedBox(
                  width: double.infinity,
                  child: Padding(
                    padding: EdgeInsets.all(16),
                    child: Center(
                      child: SizedBox(
                        width: 22,
                        height: 22,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _CenterBox extends StatelessWidget {
  const _CenterBox({
    required this.icon,
    required this.text,
    required this.action,
  });

  final IconData icon;
  final String text;
  final Widget action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 48, color: Colors.white24),
          const SizedBox(height: 12),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Text(
              text,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white54),
            ),
          ),
          const SizedBox(height: 18),
          action,
        ],
      ),
    );
  }
}
