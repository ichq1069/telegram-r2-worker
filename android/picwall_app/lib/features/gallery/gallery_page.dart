import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/repositories/gallery_repository.dart';
import 'paged_media_grid.dart';

/// 图库：共享库瀑布流，支持类型筛选（photo/video）。
class GalleryPage extends ConsumerStatefulWidget {
  const GalleryPage({super.key});

  @override
  ConsumerState<GalleryPage> createState() => _GalleryPageState();
}

class _GalleryPageState extends ConsumerState<GalleryPage> {
  String _type = '';
  bool _showMine = false;

  void _onType(String type) {
    if (_type == type) return;
    setState(() => _type = type);
  }

  Future<PagedMedia> _loader(GalleryRepository repo, int page) {
    if (_showMine) {
      return repo.myFiles(page: page, pageSize: 30);
    }
    return repo.galleryData(limit: 60, offset: (page - 1) * 60, type: _type);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('图库'),
        actions: [
          IconButton(
            tooltip: '我的图片',
            icon: Icon(
              _showMine ? Icons.public : Icons.person_outline,
            ),
            onPressed: () => setState(() => _showMine = !_showMine),
          ),
        ],
      ),
      body: Column(
        children: [
          if (!_showMine)
            _TypeFilterBar(current: _type, onChanged: _onType),
          Expanded(
            child: PagedMediaGrid(
              key: ValueKey('$_type-$_showMine'),
              title: '',
              embedded: true,
              loader: _loader,
            ),
          ),
        ],
      ),
    );
  }
}

class _TypeFilterBar extends StatelessWidget {
  const _TypeFilterBar({required this.current, required this.onChanged});

  final String current;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    const opts = [
      ('', '全部'),
      ('photo', '图片'),
      ('video', '视频'),
    ];
    return SizedBox(
      height: 52,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        children: [
          for (final (value, label) in opts)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ChoiceChip(
                label: Text(label),
                selected: current == value,
                onSelected: (_) => onChanged(value),
              ),
            ),
        ],
      ),
    );
  }
}
