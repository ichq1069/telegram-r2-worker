import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/media_item.dart';
import '../../services/api_client.dart';
import '../../services/providers.dart';
import '../../ui/app_widgets.dart';
import '../detail/detail_page.dart';
import '../gallery/media_thumb.dart';

/// 发现页：共享库随机推荐（每次取一批，可换一批/筛选类型）。
class DiscoverPage extends ConsumerStatefulWidget {
  const DiscoverPage({super.key});

  @override
  ConsumerState<DiscoverPage> createState() => _DiscoverPageState();
}

class _DiscoverPageState extends ConsumerState<DiscoverPage> {
  List<MediaItem> _items = const [];
  String _type = '';
  bool _loading = true;
  bool _hasError = false;
  String _errorText = '';

  @override
  void initState() {
    super.initState();
    _loadRandom();
  }

  Future<void> _loadRandom() async {
    setState(() {
      _loading = true;
      _hasError = false;
    });
    try {
      final repo = ref.read(galleryRepositoryProvider);
      final items = await repo.randomPool(count: 10, type: _type);
      if (!mounted) return;
      setState(() {
        _items = items;
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

  void _openDetail(int index) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DetailPage(items: List.of(_items), initialIndex: index),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('发现'),
        actions: [
          IconButton(
            tooltip: '换一批',
            icon: const Icon(Icons.refresh),
            onPressed: _loading ? null : _loadRandom,
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    '为你随机推荐，轻点「换一批」刷新',
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                      fontSize: 12,
                    ),
                  ),
                ),
              ],
            ),
          ),
          SizedBox(
            height: 48,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              children: [
                for (final (value, label) in const [('', '全部'), ('photo', '图片'), ('video', '视频')])
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(
                      label: Text(label),
                      selected: _type == value,
                      onSelected: (sel) {
                        if (sel && _type != value) {
                          setState(() => _type = value);
                          _loadRandom();
                        }
                      },
                    ),
                  ),
              ],
            ),
          ),
          Expanded(child: _body(context)),
        ],
      ),
      floatingActionButton: _loading || _hasError || _items.isEmpty
          ? null
          : FloatingActionButton.extended(
              onPressed: _loadRandom,
              icon: const Icon(Icons.casino_outlined),
              label: const Text('换一批'),
            ),
    );
  }

  Widget _body(BuildContext context) {
    if (_loading) {
      return const AppLoadingIndicator();
    }
    if (_hasError) {
      return AppErrorState(
        message: _errorText,
        onRetry: _loadRandom,
      );
    }
    if (_items.isEmpty) {
      return AppEmptyState(
        icon: Icons.inbox_outlined,
        text: '当前没有可推荐的',
        actionLabel: '换一批',
        onAction: _loadRandom,
      );
    }
    return RefreshIndicator(
      onRefresh: _loadRandom,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final cellW = (constraints.maxWidth - 30) / 2;
          return SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(10),
            child: Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                for (var i = 0; i < _items.length; i++)
                  SizedBox(
                    width: cellW,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        MediaThumb(
                          item: _items[i],
                          onTap: () => _openDetail(i),
                        ),
                        const SizedBox(height: 4),
                        SizedBox(
                          width: double.infinity,
                          child: TextButton.icon(
                            onPressed: () => _openDetail(i),
                            icon: const Icon(Icons.info_outline, size: 14),
                            label: const Text('详情', style: TextStyle(fontSize: 12)),
                            style: TextButton.styleFrom(
                              padding: const EdgeInsets.symmetric(vertical: 2),
                              minimumSize: Size.zero,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}
