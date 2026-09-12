import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// 双列瀑布流虚拟化容器。
///
/// 替代「SingleChildScrollView + Wrap」一次性构建全部卡片：把条目按下标
/// 每两个分一行（奇数尾行单独一行、左对齐占原格宽），用 [SliverList] 只
/// 构建视口 ± [cacheExtent] 内的行，离屏卡片不构建、不请求缩略图。
///
/// [buildCell] 返回的单格内容应能根据 [cellWidth] 撑出自己的高度
/// （如 [MediaThumb] 用宽高比撑高）；[itemAspect] 返回每格宽高比
/// （宽/高），仅用于行高预排估算，需与单格实际撑高口径一致
/// （见 `media_thumb.dart` 的 `mediaItemAspectRatio`）。
class MasonryVirtualGrid extends StatelessWidget {
  const MasonryVirtualGrid({
    super.key,
    required this.itemCount,
    required this.buildCell,
    required this.itemAspect,
    this.controller,
    this.padding = 10,
    this.spacing = 10,
    this.cacheExtent = 300,
    this.footer,
  });

  /// 条目总数。
  final int itemCount;

  /// 构建第 [index] 格的 cell；[cellWidth] 为该格宽度（含页边距折算）。
  final Widget Function(BuildContext context, int index, double cellWidth)
      buildCell;

  /// 第 [index] 格的宽高比（宽/高），用于行高预排。
  final double Function(int index) itemAspect;

  /// 滚动控制器（外部持有，分页/自动播放监听复用）。
  final ScrollController? controller;

  /// 容器四周内边距。
  final double padding;

  /// 行内两格间距；同时作为行与行之间的纵向间距。
  final double spacing;

  /// 视口上下额外构建的缓存带宽度（逻辑像素）。
  final double cacheExtent;

  /// 追加在网格末尾的整行（加载指示 / 没有更多等），占整行宽。
  final Widget? footer;

  /// 双列行数：两两分组，奇数尾行单独成行。
  static int rowCountOf(int itemCount) => (itemCount + 1) ~/ 2;

  /// 给定可用总宽与间距折算出的单格宽度：
  /// 左右各 [padding] + 行内 [spacing]，两格均分。
  static double cellWidthOf(double maxWidth, double padding, double spacing) {
    return (maxWidth - padding * 2 - spacing) / 2;
  }

  /// 预估某一格的高度：宽 / 宽高比。
  static double cellHeightOf(double cellWidth, double aspect) {
    final a = aspect <= 0 ? 0.75 : aspect;
    return cellWidth / a;
  }

  /// 预估一行的高度：取该行两格高度的较大者。
  static double rowHeightOf(
    double cellWidth,
    double firstAspect,
    double? secondAspect,
  ) {
    final h0 = cellHeightOf(cellWidth, firstAspect);
    final h1 = secondAspect == null
        ? 0.0
        : cellHeightOf(cellWidth, secondAspect);
    return h0 > h1 ? h0 : h1;
  }

  @override
  Widget build(BuildContext context) {
    final rowCount = rowCountOf(itemCount);
    final hasFooter = footer != null;
    final rowCountWithFooter = rowCount + (hasFooter ? 1 : 0);
    return LayoutBuilder(
      builder: (context, constraints) {
        final cellW = cellWidthOf(constraints.maxWidth, padding, spacing);
        final rows = <double>[
          for (var r = 0; r < rowCount; r++)
            rowHeightOf(cellW, itemAspect(r * 2),
                r * 2 + 1 < itemCount ? itemAspect(r * 2 + 1) : null),
        ];
        return CustomScrollView(
          controller: controller,
          physics: const AlwaysScrollableScrollPhysics(),
          cacheExtent: cacheExtent,
          slivers: [
            SliverPadding(
              padding: EdgeInsets.all(padding),
              sliver: SliverList(
                delegate: SliverChildBuilderDelegate(
                  (context, i) {
                    if (hasFooter && i == rowCount) {
                      return footer!;
                    }
                    final first = i * 2;
                    final hasSecond = first + 1 < itemCount;
                    final row = SizedBox(
                      height: rows[i],
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.max,
                        children: [
                          SizedBox(
                            width: cellW,
                            child: buildCell(context, first, cellW),
                          ),
                          if (hasSecond) ...[
                            SizedBox(width: spacing),
                            SizedBox(
                              width: cellW,
                              child: buildCell(context, first + 1, cellW),
                            ),
                          ],
                        ],
                      ),
                    );
                    // 仅在行后还有内容（下一数据行或 footer）时加纵向间距，
                    // 与原先 Wrap runSpacing 的语义保持一致。
                    final hasFollowing = hasFooter || i + 1 < rowCount;
                    return Padding(
                      padding: EdgeInsets.only(
                          bottom: hasFollowing ? spacing : 0),
                      child: row,
                    );
                  },
                  childCount: rowCountWithFooter,
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}
