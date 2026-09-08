import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../services/providers.dart';

/// 全局路由观察者：列表页借此感知自己被上层路由（详情/弹层）遮挡与恢复，
/// 在被遮挡时暂停列表自动播放，避免下层播放器空转。
final RouteObserver<ModalRoute<dynamic>> appRouteObserver =
    RouteObserver<ModalRoute<dynamic>>();

/// 视频格相对视口的测量结果（滚动内容坐标系）。
///
/// [offset]/[viewport] 为列表视口当前的滚动偏移与可见高度，
/// [top]/[bottom] 为该格上下缘换算到滚动内容中的纵向位置。
class SlotMetrics {
  const SlotMetrics({
    required this.top,
    required this.bottom,
    required this.offset,
    required this.viewport,
  });

  final double top;
  final double bottom;
  final double offset;
  final double viewport;
}

/// 单个列表页的视频自动播放仲裁器。
///
/// 监听其所在列表的滚动，从所有已注册的视频格中选出「可见占比最大」的一格
/// 作为播放格（其余格保持静态封面，不占用解码器）；仅当页面可见且所在
/// Tab 被选中时才允许播放，切换/滚动时会自动暂停与回收。
class FeedVideoAutoplay extends ChangeNotifier {
  FeedVideoAutoplay({bool enabled = true}) : _enabled = enabled;

  bool _enabled;
  int? _activeIndex;
  bool _scheduled = false;
  bool _disposed = false;
  final Map<int, _VideoSlot> _slots = <int, _VideoSlot>{};

  /// 是否允许播放（由外层 FeedGate 依据路由可见性与 Tab 状态维护）。
  bool get enabled => _enabled;
  set enabled(bool value) {
    if (_disposed || _enabled == value) return;
    _enabled = value;
    if (!value && _activeIndex != null) {
      _activeIndex = null;
      notifyListeners();
    } else {
      _scheduleCompute();
    }
  }

  /// 当前处于播放态的格子序号（在列表中的下标）。
  int? get activeIndex => _activeIndex;

  bool isActive(int index) => _activeIndex == index;

  /// 视频格挂载时注册；[measure] 返回该格当前的视口位置测量，可为 null。
  void registerVideo(int index, SlotMetrics? Function() measure) {
    _slots[index] = _VideoSlot(measure);
    _scheduleCompute();
  }

  void unregisterVideo(int index) {
    _slots.remove(index);
    if (_activeIndex == index) {
      _activeIndex = null;
    }
    _scheduleCompute();
  }

  /// 列表滚动事件入口（节流到一帧末再统一仲裁）。
  void onScroll() => _scheduleCompute();

  void _scheduleCompute() {
    if (_disposed || _scheduled) return;
    _scheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scheduled = false;
      if (!_disposed) _compute();
    });
  }

  void _compute() {
    if (!_enabled) {
      _setActive(null);
      return;
    }
    int? best;
    var bestFrac = 0.0;
    var bestTop = double.infinity;
    _slots.forEach((index, slot) {
      final m = _safeMeasure(slot);
      if (m == null) return;
      final frac = _fraction(m);
      if (frac <= 0) return;
      final fracTie = (frac - bestFrac).abs() <= 1e-9;
      if (frac > bestFrac + 1e-9 || (fracTie && m.top < bestTop)) {
        best = index;
        bestFrac = frac;
        bestTop = m.top;
      }
    });
    _setActive(best != null && bestFrac >= 0.5 ? best : null);
  }

  SlotMetrics? _safeMeasure(_VideoSlot slot) {
    try {
      return slot.measure();
    } catch (_) {
      return null;
    }
  }

  /// 可见占比：格子在视口纵向带内的可见长度 / 格子自身高度。
  double _fraction(SlotMetrics m) {
    final lo = math.max(m.top, m.offset);
    final hi = math.min(m.bottom, m.offset + m.viewport);
    if (hi <= lo) return 0;
    final height = math.max(m.bottom - m.top, 1.0);
    return (hi - lo) / height;
  }

  void _setActive(int? index) {
    if (_disposed || _activeIndex == index) return;
    _activeIndex = index;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

class _VideoSlot {
  _VideoSlot(this.measure);

  final SlotMetrics? Function() measure;
}

/// 列表自动播放门控容器：包住某个网格列表，负责在
/// 「路由被上层遮挡 / 底部 Tab 切走 / 页面销毁」时关闭对应 feed 的播放。
///
/// [tabIndex] 表示该 feed 位于 HomeShell 的哪一个 Tab；独立路由页传 null，
/// 此时仅按路由可见性门控。
class FeedGate extends ConsumerStatefulWidget {
  const FeedGate({
    super.key,
    required this.feed,
    required this.child,
    this.tabIndex,
  });

  final FeedVideoAutoplay feed;
  final Widget child;
  final int? tabIndex;

  @override
  ConsumerState<FeedGate> createState() => _FeedGateState();
}

class _FeedGateState extends ConsumerState<FeedGate> with RouteAware {
  ModalRoute<dynamic>? _route;
  bool _routeVisible = true;
  bool _pendingApply = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    if (!identical(route, _route)) {
      if (_route != null) appRouteObserver.unsubscribe(this);
      _route = route;
      if (_route != null) appRouteObserver.subscribe(this, _route!);
    }
    _scheduleApply();
  }

  @override
  void dispose() {
    final route = _route;
    if (route != null) appRouteObserver.unsubscribe(this);
    super.dispose();
  }

  @override
  void didPushNext() {
    _setRouteVisible(false);
  }

  @override
  void didPopNext() {
    _setRouteVisible(true);
  }

  void _setRouteVisible(bool value) {
    if (_routeVisible == value) return;
    _routeVisible = value;
    _apply();
  }

  void _scheduleApply() {
    if (_pendingApply) return;
    _pendingApply = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _pendingApply = false;
      if (mounted) _apply();
    });
  }

  void _apply() {
    if (!mounted) return;
    var visible = _routeVisible;
    final tab = widget.tabIndex;
    if (visible && tab != null) {
      visible = ref.read(homeTabIndexProvider) == tab;
    }
    widget.feed.enabled = visible;
  }

  @override
  Widget build(BuildContext context) {
    final tab = widget.tabIndex;
    if (tab != null) {
      // ref.listen 仅允许在 build 内调用（didChangeDependencies 中首次执行时
      // debugDoingBuild 已复位，Riverpod 会抛断言）；每次 build 重注册自动替换旧监听。
      ref.listen<int>(homeTabIndexProvider, (_, __) => _scheduleApply());
    }
    return widget.child;
  }
}
