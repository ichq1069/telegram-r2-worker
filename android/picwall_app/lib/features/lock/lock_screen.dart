import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';

import '../../services/providers.dart';
import '../../services/settings.dart';

/// 全屏锁屏：图案校验为主；开启指纹时提供指纹解锁按钮。
/// - 基础态（app 冷启动门）作为根路由显示，解锁后随 provider 刷新移除；
/// - 独立路由态（回到前台时上方有其它页面）传 allowPop=true，解锁后自动 pop。
class LockScreen extends ConsumerStatefulWidget {
  const LockScreen({super.key, this.allowPop = false});

  final bool allowPop;

  @override
  ConsumerState<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends ConsumerState<LockScreen> {
  final LocalAuthentication _auth = LocalAuthentication();
  final List<int> _seq = [];
  bool _error = false;
  bool _checkingBio = false;
  String _msg = '绘制图案解锁';

  bool get _bioEnabled =>
      ref.read(settingsControllerProvider).settings.lockBiometric;

  @override
  void initState() {
    super.initState();
    if (_bioEnabled) _probeBio();
  }

  Future<void> _probeBio() async {
    setState(() => _checkingBio = true);
    try {
      final ok = await _auth.canCheckBiometrics;
      if (!ok || !mounted) return;
      if (mounted) setState(() => _msg = '指纹解锁已启用');
    } catch (_) {
      // 设备不支持/宿主 Activity 不支持时静默降级为图案解锁
      if (mounted) setState(() => _msg = '绘制图案解锁');
    } finally {
      if (mounted) setState(() => _checkingBio = false);
    }
  }

  Future<void> _unlockWithBio() async {
    setState(() => _checkingBio = true);
    try {
      final ok = await _auth.authenticate(
        localizedReason: '验证指纹以解锁 PicWall',
        options: const AuthenticationOptions(
          stickyAuth: true,
          biometricOnly: true,
        ),
      );
      if (ok && mounted) {
        ref.read(appLockControllerProvider).unlock();
        if (widget.allowPop) Navigator.of(context).pop();
      }
    } catch (e) {
      // local_auth 依赖 FragmentActivity；异常时不弹原始错误，静默回到图案解锁
      if (mounted) {
        setState(() {
          _error = false;
          _seq.clear();
          _msg = '指纹不可用，请使用图案解锁';
        });
      }
    } finally {
      if (mounted) setState(() => _checkingBio = false);
    }
  }

  void _tap(int i) {
    if (_seq.contains(i)) return;
    setState(() {
      _seq.add(i);
      _error = false;
    });
    if (_seq.length >= 4) {
      _msg = '点击 ✓ 确认';
    }
  }

  void _clear() {
    setState(() {
      _seq.clear();
      _error = false;
      _msg = _bioEnabled ? '指纹解锁已启用' : '绘制图案解锁';
    });
  }

  void _submit() {
    final settings = ref.read(settingsControllerProvider).settings;
    if (!settings.hasPattern) {
      setState(() {
        _error = true;
        _msg = '尚未设置解锁图案，请先到 我的→应用锁 完成设置';
      });
      return;
    }
    if (!AppLock.verify(settings.lockPattern, _seq.join('-'))) {
      setState(() {
        _error = true;
        _msg = '图案错误，请重试';
      });
      Timer(const Duration(milliseconds: 900), () {
        if (mounted) {
          setState(() {
            _error = false;
            _seq.clear();
            _msg = '绘制图案解锁';
          });
        }
      });
      return;
    }
    ref.read(appLockControllerProvider).unlock();
    if (widget.allowPop) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              theme.colorScheme.surface,
              theme.colorScheme.surfaceContainerLow,
            ],
          ),
        ),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.lock_outline,
                      size: 64, color: theme.colorScheme.primary),
                  const SizedBox(height: 18),
                  Text('PicWall 已锁定',
                      style: theme.textTheme.titleMedium
                          ?.copyWith(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 24),
                  PatternBoard(
                    seq: _seq,
                    error: _error,
                    onTap: _tap,
                  ),
                  const SizedBox(height: 12),
                  SizedBox(
                    width: 240,
                    child: PatternConfirmBar(
                      canSubmit: _seq.length >= 4,
                      error: _error,
                      hint: _msg,
                      onSubmit: _submit,
                      onClear: _clear,
                    ),
                  ),
                  if (_bioEnabled) ...[
                    const SizedBox(height: 20),
                    OutlinedButton.icon(
                      onPressed: _checkingBio ? null : _unlockWithBio,
                      icon: _checkingBio
                          ? const SizedBox(
                              width: 14,
                              height: 14,
                              child:
                                  CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.fingerprint, size: 20),
                      label: const Text('指纹解锁'),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 图案确认条：够 4 点后出现 ✓ 提交。
class PatternConfirmBar extends StatelessWidget {
  const PatternConfirmBar({
    super.key,
    required this.canSubmit,
    required this.error,
    required this.hint,
    required this.onSubmit,
    required this.onClear,
  });

  final bool canSubmit;
  final bool error;
  final String hint;
  final VoidCallback onSubmit;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      children: [
        IconButton(
          tooltip: '清除',
          onPressed: onClear,
          icon: const Icon(Icons.backspace_outlined),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            hint,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 13,
              color: error
                  ? theme.colorScheme.error
                  : theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
        const SizedBox(width: 8),
        IconButton.filled(
          tooltip: '确认',
          onPressed: canSubmit ? onSubmit : null,
          icon: const Icon(Icons.check),
        ),
      ],
    );
  }
}

/// 3x3 图案盘（公共组件：解锁页与设置页共用）。
/// 已选点之间绘制连线，支持手指滑动连续选点（类 Android 图案解锁）。
/// seq 为已选点（0..8，行优先）；[size] 控制整体边长。
class PatternBoard extends StatefulWidget {
  const PatternBoard({
    super.key,
    required this.seq,
    required this.error,
    required this.onTap,
    this.size = 260,
  });

  final List<int> seq;
  final bool error;
  final ValueChanged<int> onTap;
  final double size;

  @override
  State<PatternBoard> createState() => _PatternBoardState();
}

class _PatternBoardState extends State<PatternBoard> {
  late final double _dotR;
  late final List<Offset> _centers;
  late double _hitR;

  @override
  void initState() {
    super.initState();
    _recompute();
  }

  @override
  void didUpdateWidget(PatternBoard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.size != widget.size) _recompute();
  }

  void _recompute() {
    _dotR = widget.size * 0.16;
    const hitScale = 0.26;
    const stepBase = 0.34;
    final step = widget.size * stepBase;
    _centers = <Offset>[];
    for (var row = 0; row < 3; row++) {
      for (var col = 0; col < 3; col++) {
        _centers.add(Offset(
          widget.size * 0.16 + step * col,
          widget.size * 0.16 + step * row,
        ));
      }
    }
    _hitR = widget.size * hitScale;
  }

  int? _hitTest(Offset p) {
    for (var i = 0; i < _centers.length; i++) {
      if ((p - _centers[i]).distance <= _hitR) return i;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = widget.error
        ? theme.colorScheme.error
        : theme.colorScheme.primary;
    return SizedBox(
      width: widget.size,
      height: widget.size,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onPanDown: (d) {
          final i = _hitTest(d.localPosition);
          if (i != null) widget.onTap(i);
        },
        onPanUpdate: (d) {
          final i = _hitTest(d.localPosition);
          if (i != null) widget.onTap(i);
        },
        child: CustomPaint(
          painter: _PatternPainter(
            centers: _centers,
            seq: List.unmodifiable(widget.seq),
            dotR: _dotR,
            dotColor: color,
            emptyColor: theme.colorScheme.surfaceContainerHighest,
            outlineColor: theme.colorScheme.outlineVariant,
            onPrimary: theme.colorScheme.onPrimary,
          ),
        ),
      ),
    );
  }
}

class _PatternPainter extends CustomPainter {
  _PatternPainter({
    required this.centers,
    required this.seq,
    required this.dotR,
    required this.dotColor,
    required this.emptyColor,
    required this.outlineColor,
    required this.onPrimary,
  });

  final List<Offset> centers;
  final List<int> seq;
  final double dotR;
  final Color dotColor;
  final Color emptyColor;
  final Color outlineColor;
  final Color onPrimary;

  @override
  void paint(Canvas canvas, Size size) {
    // 连线（先画，避免被圆点覆盖）
    if (seq.length >= 2) {
      final paint = Paint()
        ..color = dotColor
        ..strokeWidth = 4
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke;
      for (var i = 1; i < seq.length; i++) {
        canvas.drawLine(centers[seq[i - 1]], centers[seq[i]], paint);
      }
    }
    // 9 个点
    for (var i = 0; i < centers.length; i++) {
      final selected = seq.contains(i);
      canvas.drawCircle(
        centers[i],
        dotR,
        Paint()
          ..color = selected ? dotColor : emptyColor
          ..style = PaintingStyle.fill,
      );
      canvas.drawCircle(
        centers[i],
        dotR,
        Paint()
          ..color = selected ? dotColor : outlineColor
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2,
      );
      if (selected) {
        canvas.drawCircle(centers[i], 4.5, Paint()..color = onPrimary);
      }
    }
  }

  @override
  bool shouldRepaint(_PatternPainter old) {
    if (old.dotColor != dotColor || old.seq.length != seq.length) return true;
    for (var i = 0; i < seq.length; i++) {
      if (old.seq[i] != seq[i]) return true;
    }
    return false;
  }
}
