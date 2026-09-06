import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../../data/models/media_item.dart';
import '../../core/constants.dart';

/// 缩略图卡片：以宽高比撑开，避免 masonry 抖动。
class MediaThumb extends StatelessWidget {
  const MediaThumb({
    super.key,
    required this.item,
    this.onTap,
    this.showBadge = true,
  });

  final MediaItem item;
  final VoidCallback? onTap;
  final bool showBadge;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final ratio = (item.width != null && item.height != null && item.height! > 0)
        ? (item.width! / item.height!).clamp(0.5, 2.2)
        : 0.75;

    return GestureDetector(
      onTap: onTap,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: AspectRatio(
          aspectRatio: ratio,
          child: Stack(
            fit: StackFit.expand,
            children: [
              CachedNetworkImage(
                imageUrl: item.displayThumb,
                fit: BoxFit.cover,
                placeholder: (_, __) => Container(
                  color: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
                ),
                errorWidget: (_, __, ___) => Container(
                  color: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
                  child: const Icon(Icons.broken_image_outlined, color: Colors.white38),
                ),
              ),
              if (item.isVideo)
                const Center(
                  child: Icon(Icons.play_circle_outline, size: 40, color: Colors.white70),
                ),
              Positioned(
                left: 6,
                top: 6,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (item.level != UserLevel.pt)
                      _Badge(
                        text: item.level.label,
                        color: item.level == UserLevel.vvip
                            ? const Color(0xFFE91E63)
                            : const Color(0xFF7C4DFF),
                      ),
                    if (item.isPrivate) ...[
                      const SizedBox(width: 4),
                      const _Badge(text: '私密', color: Color(0xFF37474F)),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.9),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        text,
        style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w600),
      ),
    );
  }
}
