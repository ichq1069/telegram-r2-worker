import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';

import '../../services/providers.dart';
import '../../services/settings.dart';
import 'lock_screen.dart';

/// 我的→应用锁：启用/关闭、指纹开关、首次设置与重置解锁图案。
class LockSettingsSheet extends ConsumerStatefulWidget {
  const LockSettingsSheet({super.key});

  @override
  ConsumerState<LockSettingsSheet> createState() => _LockSettingsSheetState();
}

class _LockSettingsSheetState extends ConsumerState<LockSettingsSheet> {
  /// null=不在创建流程；1=第一遍；2=第二遍确认。
  int? _createStep;
  List<int>? _firstSeq;
  final List<int> _cur = [];
  bool _error = false;
  String _hint = '';
  bool _saving = false;
  bool _bioAvailable = false;
  bool _bioChecked = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _probeBio());
  }

  Future<void> _probeBio() async {
    try {
      final ok = await LocalAuthentication().canCheckBiometrics;
      if (mounted) {
        setState(() {
          _bioAvailable = ok;
          _bioChecked = true;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _bioChecked = true);
    }
  }

  AppSettings get _settings =>
      ref.watch(settingsControllerProvider).settings;

  void _tap(int i) {
    if (_cur.contains(i)) return;
    setState(() {
      _cur.add(i);
      _error = false;
    });
    _hint = _cur.length >= 4 ? '点击 ✓ 确认当前图案' : '至少连接 4 个点';
  }

  void _clear() {
    setState(() {
      _cur.clear();
      _error = false;
    });
    _updateHint();
  }

  void _updateHint() {
    setState(() {
      if (_createStep == 1) {
        _hint = '设置解锁图案：至少连接 4 个点';
      } else if (_createStep == 2) {
        _hint = '再画一次刚才的图案进行确认';
      } else {
        _hint = '';
      }
    });
  }

  void _submitPattern() {
    if (_createStep == null || _cur.length < 4) return;
    if (_createStep == 1) {
      setState(() {
        _firstSeq = List.of(_cur);
        _cur.clear();
        _createStep = 2;
        _hint = '再画一次刚才的图案进行确认';
      });
      return;
    }
    final second = _cur;
    final first = _firstSeq;
    if (first == null) {
      setState(() => _createStep = 1);
      _updateHint();
      return;
    }
    if (!_listEq(first, second)) {
      setState(() {
        _error = true;
        _cur.clear();
        _hint = '两次图案不一致，请重新绘制';
      });
      Timer(const Duration(milliseconds: 1200), () {
        if (mounted && _createStep == 2) {
          setState(() {
            _error = false;
            _hint = '再画一次刚才的图案进行确认';
          });
        }
      });
      return;
    }
    _savePattern(second);
  }

  static bool _listEq(List<int> a, List<int> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  Future<void> _savePattern(List<int> seq) async {
    setState(() => _saving = true);
    try {
      await ref
          .read(settingsControllerProvider)
          .saveAppLock(enabled: true, pattern: AppLock.encode(seq.join('-')));
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('解锁图案已设置，应用锁已启用')),
      );
      setState(() {
        _createStep = null;
        _firstSeq = null;
        _cur.clear();
        _hint = '';
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _toggleEnabled(bool v) async {
    if (v) {
      if (!_settings.hasPattern) {
        setState(() {
          _createStep = 1;
          _cur.clear();
        });
        _updateHint();
        return;
      }
      await ref.read(settingsControllerProvider).saveAppLock(enabled: true);
      return;
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('关闭应用锁？'),
        content: const Text('关闭后打开 App 不再需要图案/指纹验证。'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('关闭')),
        ],
      ),
    );
    if (ok == true) {
      await ref.read(settingsControllerProvider).saveAppLock(enabled: false);
    }
  }

  Future<void> _toggleBio(bool v) async {
    if (!_bioAvailable && v) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('当前设备未检测到可用指纹')),
      );
      return;
    }
    await ref.read(settingsControllerProvider).saveAppLock(biometric: v);
  }

  void _startReset() {
    setState(() {
      _createStep = 1;
      _firstSeq = null;
      _cur.clear();
    });
    _updateHint();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = _settings;
    final creating = _createStep != null;

    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('应用锁',
                  style: theme.textTheme.titleLarge
                      ?.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text('冷启动或切到后台后需解锁；图案保存在本机加密存储',
                  style: theme.textTheme.bodySmall),
              const SizedBox(height: 12),
              if (creating) ..._buildCreatePane(theme) else ..._buildManagePane(theme, s),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _buildCreatePane(ThemeData theme) {
    final step = _createStep!;
    return [
      Text(
        step == 1
            ? '设置解锁图案（至少连接 4 个点，最多 9 个）'
            : '确认图案（与上一遍一致）',
        style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
      ),
      const SizedBox(height: 16),
      Center(
        child: PatternBoard(
          seq: _cur,
          error: _error,
          onTap: _tap,
          size: 200,
        ),
      ),
      const SizedBox(height: 10),
      PatternConfirmBar(
        canSubmit: _cur.length >= 4 && !_saving,
        error: _error,
        hint: _hint,
        onSubmit: _submitPattern,
        onClear: _clear,
      ),
      const SizedBox(height: 8),
      TextButton(
        onPressed: _saving
            ? null
            : () {
                setState(() {
                  _createStep = null;
                  _firstSeq = null;
                  _cur.clear();
                });
                _updateHint();
              },
        child: const Text('取消'),
      ),
    ];
  }

  List<Widget> _buildManagePane(ThemeData theme, AppSettings s) {
    final sub = <String>[
      if (s.hasPattern) '图案已设置',
      if (_bioChecked && _bioAvailable) '支持指纹',
      if (s.lockEnabled) '当前：已启用' else '当前：未启用',
    ];
    return [
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('启用应用锁'),
        subtitle: Text(s.hasPattern ? '图案解锁' : '开启前需先设置解锁图案'),
        value: s.lockEnabled,
        onChanged: _saving ? null : _toggleEnabled,
      ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('指纹解锁'),
        subtitle: Text(_bioChecked
            ? (_bioAvailable ? '验证设备指纹快速解锁' : '当前设备未检测到可用指纹')
            : '检测中…'),
        value: s.lockEnabled && s.lockBiometric,
        onChanged: s.lockEnabled && !_saving ? _toggleBio : null,
      ),
      if (s.hasPattern)
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.refresh),
          title: const Text('重置解锁图案'),
          onTap: _startReset,
        ),
      const SizedBox(height: 6),
      Text(
        sub.join(' · '),
        style: theme.textTheme.bodySmall,
        textAlign: TextAlign.center,
      ),
    ];
  }
}
