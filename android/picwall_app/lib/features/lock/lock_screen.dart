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
      ref.watch(settingsControllerProvider).settings.lockBiometric;

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
      // 设备不支持/无录入时保持图案解锁
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
      if (mounted) {
        setState(() {
          _error = true;
          _msg = '指纹不可用：${e.toString()}';
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
          child: Column(
            children: [
              const Spacer(flex: 2),
              Icon(Icons.lock_outline,
                  size: 64, color: theme.colorScheme.primary),
              const SizedBox(height: 18),
              Text('PicWall 已锁定',
                  style: theme.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: 24),
              _PatternPad(
                seq: _seq,
                error: _error,
                onTap: _tap,
              ),
              const SizedBox(height: 12),
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 200),
                child: Text(
                  _msg,
                  key: ValueKey(_msg),
                  style: TextStyle(
                    fontSize: 13,
                    color: _error
                        ? theme.colorScheme.error
                        : theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              const Spacer(flex: 1),
              if (_bioEnabled)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: OutlinedButton.icon(
                    onPressed: _checkingBio ? null : _unlockWithBio,
                    icon: _checkingBio
                        ? const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.fingerprint, size: 20),
                    label: const Text('指纹解锁'),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.only(bottom: 24),
                child: TextButton(
                  onPressed: _seq.isEmpty ? null : _clear,
                  child: const Text('清除'),
                ),
              ),
            ],
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

/// 3x3 图案盘。seq 为已选点（0..8，行优先）。
class _PatternPad extends StatelessWidget {
  const _PatternPad({
    required this.seq,
    required this.error,
    required this.onTap,
  });

  final List<int> seq;
  final bool error;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final size = 240.0;
    final r = 16.0;
    final centers = <Offset>[];
    final step = (size - r * 2) / 2;
    for (var row = 0; row < 3; row++) {
      for (var col = 0; col < 3; col++) {
        centers.add(Offset(r + step * col, r + step * row));
      }
    }
    return SizedBox(
      width: size,
      height: size,
      child: LayoutBuilder(
        builder: (context, constraints) {
          return GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTapDown: (d) {
              final p = d.localPosition;
              for (var i = 0; i < centers.length; i++) {
                if ((p - centers[i]).distance <= 34) {
                  onTap(i);
                  return;
                }
              }
            },
            child: Stack(
              children: [
                for (var i = 0; i < 9; i++)
                  Positioned(
                    left: centers[i].dx - r,
                    top: centers[i].dy - r,
                    width: r * 2,
                    height: r * 2,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: seq.contains(i)
                            ? theme.colorScheme.primary
                            : (error
                                ? theme.colorScheme.error.withValues(alpha: 0.6)
                                : theme.colorScheme.surfaceContainerHighest),
                        border: Border.all(
                          color: seq.contains(i)
                              ? theme.colorScheme.primary
                              : theme.colorScheme.outlineVariant,
                          width: 2,
                        ),
                      ),
                      child: Center(
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: Colors.transparent,
                          ),
                          child: SizedBox(
                            width: 8,
                            height: 8,
                            child: DecoratedBox(
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: seq.contains(i)
                                    ? theme.colorScheme.onPrimary
                                    : Colors.transparent,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}
