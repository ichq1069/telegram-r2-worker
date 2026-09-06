import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/repositories/gallery_repository.dart';
import 'paged_media_grid.dart';

/// 图库：共享库瀑布流，支持类型筛选（photo/video）+ 无限滚动。
class GalleryPage extends ConsumerStatefulWidget {
  const GalleryPage({super.key});

  @override
  ConsumerState<GalleryPage> createState() => _GalleryPageState();
}

class _GalleryPageState extends ConsumerState<GalleryPage> {
  String _type = '';

  void _onType(String type) {
    if (_type == type) return;
    setState(() => _type = type);
  }

  Future<PagedMedia> _loader(GalleryRepository repo, int page) {
    return repo.galleryData(limit: 60, offset: (page - 1) * 60, type: _type);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('图库'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(52),
          child: SizedBox(
            height: 44,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: [
                for (final (value, label) in const [('', '全部'), ('photo', '图片'), ('video', '视频')])
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(
                      label: Text(label),
                      selected: _type == value,
                      onSelected: (_) => _onType(value),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
      body: PagedMediaGrid(
        key: ValueKey('$_type'),
        title: '图库',
        embedded: true,
        loader: _loader,
      ),
    );
  }
}
