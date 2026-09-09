import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/repositories/gallery_repository.dart';
import '../douyin/douyin_view_page.dart';
import 'paged_media_grid.dart';

/// 图库：共享库瀑布流，支持类型（photo/video）+ 标签搜索 + 内容等级 +
/// 时间排序过滤 + 无限滚动。
class GalleryPage extends ConsumerStatefulWidget {
  const GalleryPage({super.key});

  @override
  ConsumerState<GalleryPage> createState() => _GalleryPageState();
}

class _GalleryPageState extends ConsumerState<GalleryPage> {
  String _type = '';
  String _level = '';
  bool _oldestFirst = false;
  final TextEditingController _tagCtrl = TextEditingController();
  String _appliedTag = '';
  final PagedMediaGridController _gridCtrl = PagedMediaGridController();

  bool get _hasFilter =>
      _type.isNotEmpty || _level.isNotEmpty || _appliedTag.isNotEmpty || _oldestFirst;

  @override
  void dispose() {
    _tagCtrl.dispose();
    super.dispose();
  }

  void _applySearch() {
    final v = _tagCtrl.text.trim();
    if (v == _appliedTag) return;
    setState(() => _appliedTag = v);
  }

  void _clearSearch() {
    _tagCtrl.clear();
    if (_appliedTag.isEmpty) return;
    setState(() => _appliedTag = '');
  }

  void _resetFilters() {
    _tagCtrl.clear();
    setState(() {
      _type = '';
      _level = '';
      _oldestFirst = false;
      _appliedTag = '';
    });
  }

  Future<PagedMedia> _loader(GalleryRepository repo, int page) {
    return repo.galleryData(
      limit: 60,
      offset: (page - 1) * 60,
      type: _type,
      level: _level,
      tags: _appliedTag,
      oldestFirst: _oldestFirst,
    );
  }

  String get _gridKey =>
      '$_type|$_level|$_appliedTag|${_oldestFirst ? 'asc' : 'desc'}';

  void _openDouyin() {
    final items = _gridCtrl.items;
    if (items.isEmpty || !mounted) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DouyinViewPage(
          initialItems: items,
          startPage: _gridCtrl.currentPage,
          title: '图库',
          loadPage: _loader,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('图库'),
        actions: [
          IconButton(
            tooltip: '抖音视图',
            icon: const Icon(Icons.swipe_vertical),
            onPressed: _gridCtrl.items.isEmpty ? null : _openDouyin,
          ),
        ],
      ),
      body: Column(
        children: [
          _FilterCard(
            type: _type,
            level: _level,
            oldestFirst: _oldestFirst,
            tagCtrl: _tagCtrl,
            onType: (v) => setState(() => _type = v),
            onLevel: (v) => setState(() => _level = v),
            onSort: () => setState(() => _oldestFirst = !_oldestFirst),
            onSearch: _applySearch,
            onClearTag: _clearSearch,
            onReset: _resetFilters,
            hasFilter: _hasFilter,
          ),
          Divider(height: 1, color: theme.dividerColor),
          Expanded(
            child: PagedMediaGrid(
              key: ValueKey(_gridKey),
              title: '图库',
              embedded: true,
              tabIndex: 1,
              loader: _loader,
              controller: _gridCtrl,
              onItemsChanged: () {
                if (mounted) setState(() {});
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// 图库筛选条：类型/等级横向 chips + 标签搜索 + 时间排序。
class _FilterCard extends StatelessWidget {
  const _FilterCard({
    required this.type,
    required this.level,
    required this.oldestFirst,
    required this.tagCtrl,
    required this.onType,
    required this.onLevel,
    required this.onSort,
    required this.onSearch,
    required this.onClearTag,
    required this.onReset,
    required this.hasFilter,
  });

  final String type;
  final String level;
  final bool oldestFirst;
  final TextEditingController tagCtrl;
  final ValueChanged<String> onType;
  final ValueChanged<String> onLevel;
  final VoidCallback onSort;
  final VoidCallback onSearch;
  final VoidCallback onClearTag;
  final VoidCallback onReset;
  final bool hasFilter;

  static const List<(String, String)> _types = [
    ('', '全部'),
    ('photo', '图片'),
    ('video', '视频'),
  ];

  static const List<(String, String)> _levels = [
    ('', '全部等级'),
    ('pt', '基础'),
    ('vip', 'VIP'),
    ('svip', 'SVIP'),
    ('vvip', 'VVIP'),
  ];

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            height: 34,
            child: ListView(
              scrollDirection: Axis.horizontal,
              children: [
                for (final (value, label) in _types)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(
                      label: Text(label),
                      visualDensity: VisualDensity.compact,
                      selected: type == value,
                      onSelected: (_) => onType(value),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: tagCtrl,
                  textInputAction: TextInputAction.search,
                  onSubmitted: (_) => onSearch(),
                  decoration: InputDecoration(
                    hintText: '按标签搜索，多个用逗号分隔',
                    isDense: true,
                    prefixIcon: const Icon(Icons.tag, size: 18),
                    suffixIcon: IconButton(
                      tooltip: '清除',
                      icon: const Icon(Icons.close, size: 18),
                      onPressed: onClearTag,
                    ),
                    contentPadding: const EdgeInsets.symmetric(vertical: 8),
                    border: const OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filledTonal(
                tooltip: '搜索',
                onPressed: onSearch,
                icon: const Icon(Icons.search),
              ),
              const SizedBox(width: 4),
              IconButton(
                tooltip: oldestFirst ? '当前：时间正序' : '当前：时间倒序',
                onPressed: onSort,
                icon: Icon(
                  oldestFirst ? Icons.arrow_upward : Icons.arrow_downward,
                  size: 20,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: SizedBox(
                  height: 34,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    children: [
                      for (final (value, label) in _levels)
                        Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: ChoiceChip(
                            label: Text(label),
                            visualDensity: VisualDensity.compact,
                            selected: level == value,
                            onSelected: (_) => onLevel(value),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              if (hasFilter)
                TextButton(
                  onPressed: onReset,
                  child: const Text('重置筛选'),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
