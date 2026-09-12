import 'package:flutter/material.dart';

/// 统一加载指示器
class AppLoadingIndicator extends StatelessWidget {
  const AppLoadingIndicator({super.key, this.size, this.strokeWidth});

  final double? size;
  final double? strokeWidth;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SizedBox(
        width: size ?? 32,
        height: size ?? 32,
        child: CircularProgressIndicator(
          strokeWidth: strokeWidth ?? 2.5,
          color: Theme.of(context).colorScheme.primary,
        ),
      ),
    );
  }
}

/// 统一加载卡片（骨架屏占位）
class AppLoadingCard extends StatelessWidget {
  const AppLoadingCard({super.key, this.aspectRatio = 1});

  final double aspectRatio;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return AspectRatio(
      aspectRatio: aspectRatio,
      child: Container(
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest.withValues(alpha: 0.5),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Center(
          child: SizedBox(
            width: 24,
            height: 24,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: scheme.onSurfaceVariant.withValues(alpha: 0.4),
            ),
          ),
        ),
      ),
    );
  }
}

/// 统一空状态
class AppEmptyState extends StatelessWidget {
  const AppEmptyState({
    super.key,
    this.icon = Icons.image_outlined,
    required this.text,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final String text;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 56, color: scheme.onSurfaceVariant.withValues(alpha: 0.35)),
            const SizedBox(height: 16),
            Text(
              text,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 14,
                color: scheme.onSurfaceVariant.withValues(alpha: 0.6),
              ),
            ),
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: 16),
              FilledButton.tonal(
                onPressed: onAction,
                child: Text(actionLabel!),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 瀑布流骨架屏：模拟双列网格的加载态，带渐变闪烁动画。
class AppSkeletonGrid extends StatefulWidget {
  const AppSkeletonGrid({super.key, this.itemCount = 8});

  final int itemCount;

  @override
  State<AppSkeletonGrid> createState() => _AppSkeletonGridState();
}

class _AppSkeletonGridState extends State<AppSkeletonGrid>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final baseColor = scheme.surfaceContainerHighest.withValues(alpha: 0.5);
    final highlightColor = scheme.surfaceContainerHighest.withValues(alpha: 0.2);
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (context, _) {
        return LayoutBuilder(
          builder: (context, constraints) {
            final w = constraints.maxWidth;
            final gap = 10.0;
            final cellW = (w - 10 * 2 - gap) / 2;
            // 交错宽高比，模拟真实瀑布流
            final aspects = [0.75, 1.0, 0.65, 0.85, 0.9, 0.7, 1.1, 0.8];
            return SingleChildScrollView(
              padding: const EdgeInsets.all(10),
              child: Wrap(
                spacing: gap,
                runSpacing: gap,
                children: [
                  for (var i = 0; i < widget.itemCount; i++)
                    SizedBox(
                      width: cellW,
                      child: _SkeletonItem(
                        aspectRatio: aspects[i % aspects.length],
                        baseColor: baseColor,
                        highlightColor: highlightColor,
                        progress: _ctrl.value,
                      ),
                    ),
                ],
              ),
            );
          },
        );
      },
    );
  }
}

class _SkeletonItem extends StatelessWidget {
  const _SkeletonItem({
    required this.aspectRatio,
    required this.baseColor,
    required this.highlightColor,
    required this.progress,
  });

  final double aspectRatio;
  final Color baseColor;
  final Color highlightColor;
  final double progress;

  @override
  Widget build(BuildContext context) {
    // 闪烁渐变位置随 progress 移动
    final shimmerX = -1.0 + progress * 3.0;
    return AspectRatio(
      aspectRatio: aspectRatio,
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          gradient: LinearGradient(
            begin: Alignment(shimmerX, 0),
            end: Alignment(shimmerX + 1, 0),
            colors: [baseColor, highlightColor, baseColor],
          ),
        ),
      ),
    );
  }
}

/// 统一错误状态
class AppErrorState extends StatelessWidget {
  const AppErrorState({
    super.key,
    required this.message,
    this.onRetry,
  });

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, size: 48, color: scheme.error.withValues(alpha: 0.6)),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant),
            ),
            if (onRetry != null) ...[
              const SizedBox(height: 16),
              FilledButton.tonal(
                onPressed: onRetry,
                child: const Text('重试'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
