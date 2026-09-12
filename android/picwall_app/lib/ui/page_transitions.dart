import 'package:flutter/material.dart';

/// 共享的页面过渡路由：从右侧滑入 + 淡入，返回时向右滑出 + 淡出。
/// 用于所有从缩略图进入详情页的导航场景。
class SlideFadePageRoute<T> extends PageRouteBuilder<T> {
  SlideFadePageRoute({required this.builder, super.settings})
      : super(
          pageBuilder: (context, animation, secondaryAnimation) =>
              builder(context),
          transitionsBuilder: (context, animation, secondaryAnimation, child) {
            final fadeAnim = CurvedAnimation(
              parent: animation,
              curve: const Interval(0.0, 0.6, curve: Curves.easeOut),
            );
            final slideAnim = Tween<Offset>(
              begin: const Offset(0.12, 0),
              end: Offset.zero,
            ).animate(CurvedAnimation(
              parent: animation,
              curve: const Interval(0.0, 0.7, curve: Curves.easeOutCubic),
            ));
            return FadeTransition(
              opacity: fadeAnim,
              child: SlideTransition(
                position: slideAnim,
                child: child,
              ),
            );
          },
          transitionDuration: const Duration(milliseconds: 320),
          reverseTransitionDuration: const Duration(milliseconds: 280),
        );

  final WidgetBuilder builder;
}
