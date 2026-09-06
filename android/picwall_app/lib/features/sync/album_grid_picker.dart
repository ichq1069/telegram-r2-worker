import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:photo_manager/photo_manager.dart';

/// 网格化相册选择：每相册以封面缩略图网格展示，便于识别内容后选择。
/// 返回选中的 [AssetPathEntity]；取消返回 null。
Future<AssetPathEntity?> showAlbumGridPicker(
  BuildContext context, {
  required List<AssetPathEntity> albums,
}) {
  return showModalBottomSheet<AssetPathEntity>(
    context: context,
    isScrollControlled: true,
    builder: (_) => _AlbumGridPicker(albums: albums),
  );
}

class _AlbumGridPicker extends StatelessWidget {
  const _AlbumGridPicker({required this.albums});

  final List<AssetPathEntity> albums;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.82,
      minChildSize: 0.4,
      maxChildSize: 0.95,
      builder: (context, scrollController) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: Row(
              children: [
                const Expanded(
                  child: Text('选择要同步的相册',
                      style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                ),
                Text('共 ${albums.length} 个',
                    style: TextStyle(
                        fontSize: 12, color: theme.colorScheme.onSurfaceVariant)),
              ],
            ),
          ),
          const SizedBox(height: 4),
          Expanded(
            child: GridView.builder(
              controller: scrollController,
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 16),
              gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                maxCrossAxisExtent: 150,
                mainAxisSpacing: 8,
                crossAxisSpacing: 8,
                childAspectRatio: 0.82,
              ),
              itemCount: albums.length,
              itemBuilder: (context, i) => _AlbumCover(
                album: albums[i],
                onTap: () => Navigator.pop(context, albums[i]),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AlbumCover extends StatelessWidget {
  const _AlbumCover({required this.album, required this.onTap});

  final AssetPathEntity album;
  final VoidCallback onTap;

  Future<Uint8List?> _cover() async {
    try {
      final assets =
          await album.getAssetListPaged(page: 0, size: 1);
      if (assets.isEmpty) return null;
      return assets.first.thumbnailDataWithSize(
        const ThumbnailSize.square(160),
        quality: 80,
      );
    } catch (_) {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: onTap,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: Stack(
          fit: StackFit.expand,
          children: [
            FutureBuilder<Uint8List?>(
              future: _cover(),
              builder: (context, snap) {
                final bytes = snap.data;
                if (bytes == null || bytes.isEmpty) {
                  return Container(
                    color: theme.colorScheme.surfaceContainerHighest,
                    alignment: Alignment.center,
                    child: Icon(Icons.photo_library_outlined,
                        color: theme.colorScheme.onSurfaceVariant),
                  );
                }
                return Image.memory(
                  bytes,
                  fit: BoxFit.cover,
                  gaplessPlayback: true,
                );
              },
            ),
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                decoration: const BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [Colors.transparent, Colors.black87],
                  ),
                ),
                child: Text(
                  album.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Colors.white, fontSize: 12),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
