import 'package:flutter/material.dart';

import '../gallery/paged_media_grid.dart';

/// 发现页：共享库最新/推荐内容流（gallery/data 无参即最新发布）。
class DiscoverPage extends StatelessWidget {
  const DiscoverPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const PagedMediaGrid(
      title: '发现',
      loader: loadSharedPool,
    );
  }
}
