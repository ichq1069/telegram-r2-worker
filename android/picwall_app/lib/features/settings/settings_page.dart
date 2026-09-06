import 'package:flutter/material.dart';
import 'package:flutter_cache_manager/flutter_cache_manager.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../services/debug_service.dart';
import '../../services/providers.dart';
import '../../services/settings.dart';
import '../admin/admin_page.dart';
import '../lock/lock_settings_sheet.dart';

/// 完整设置页：外观/网络/行为/管理/关于。
class SettingsPage extends ConsumerStatefulWidget {
  const SettingsPage({super.key});

  @override
  ConsumerState<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends ConsumerState<SettingsPage> {
  String? _version;
  bool _clearingCache = false;

  @override
  void initState() {
    super.initState();
    _loadVersion();
  }

  Future<void> _loadVersion() async {
    try {
      final info = await PackageInfo.fromPlatform();
      if (mounted) {
        setState(() => _version = '${info.version} (${info.buildNumber})');
      }
    } catch (_) {
      // 版本读取失败不影响页面
    }
  }

  Future<void> _openServerDialog() async {
    final s = ref.read(settingsControllerProvider).settings;
    final apiCtl = TextEditingController(text: s.apiBase);
    final cdnCtl = TextEditingController(text: s.cdnBase);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('服务器'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: apiCtl,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                labelText: 'API 地址',
                hintText: 'https://…',
                isDense: true,
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: cdnCtl,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                labelText: 'CDN 直链地址',
                hintText: 'https://…',
                isDense: true,
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    if (ok == true) {
      final v = apiCtl.text.trim();
      if (v.isEmpty) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('API 地址不能为空')),
          );
        }
        return;
      }
      await ref.read(settingsControllerProvider).save(
            apiBase: v,
            cdnBase: cdnCtl.text.trim().isEmpty ? null : cdnCtl.text.trim(),
          );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('已保存，重新连接服务生效')),
        );
      }
    }
  }

  Future<void> _clearCache() async {
    setState(() => _clearingCache = true);
    try {
      await DefaultCacheManager().emptyCache();
      PaintingBinding.instance.imageCache.clear();
      PaintingBinding.instance.imageCache.clearLiveImages();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('图片缓存已清理')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('清理失败：$e')));
    } finally {
      if (mounted) setState(() => _clearingCache = false);
    }
  }

  void _openAppLock() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => const LockSettingsSheet(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final settingsCtl = ref.watch(settingsControllerProvider);
    final s = settingsCtl.settings;
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          _sectionTitle('外观'),
          _buildThemeRow(s),
          const Divider(height: 1, indent: 16),
          _sectionTitle('网络与行为'),
          _row(Icons.dns_outlined, '服务器', s.apiBase, _openServerDialog),
          const Divider(height: 1, indent: 16),
          SwitchListTile(
            secondary: const Icon(Icons.wifi),
            title: const Text('仅 WiFi 上传'),
            subtitle: const Text('蜂窝网络下挂起上传队列'),
            value: s.wifiOnlyUpload,
            onChanged: (v) =>
                ref.read(settingsControllerProvider).save(wifiOnlyUpload: v),
          ),
          const Divider(height: 1, indent: 16),
          _row(
            Icons.cleaning_services_outlined,
            '清理图片缓存',
            _clearingCache ? '清理中…' : null,
            _clearingCache ? null : _clearCache,
          ),
          const Divider(height: 1, indent: 16),
          _sectionTitle('安全与管理'),
          _row(
            Icons.lock_outline,
            '应用锁',
            s.lockEnabled ? (s.lockBiometric ? '已启用 · 指纹' : '已启用') : '未启用',
            _openAppLock,
          ),
          const Divider(height: 1, indent: 16),
          _row(
            Icons.admin_panel_settings_outlined,
            '管理模式',
            '主密钥进入管理端',
            () => Navigator.of(context)
                .push(MaterialPageRoute<void>(builder: (_) => const AdminPage())),
          ),
          const Divider(height: 1, indent: 16),
          _sectionTitle('关于'),
          ListTile(
            dense: true,
            leading: const Icon(Icons.info_outline),
            title: const Text('PicWall / 图墙'),
            subtitle: Text(_version == null ? '' : 'v$_version'),
          ),
          const Divider(height: 1, indent: 16),
          SwitchListTile(
            secondary: const Icon(Icons.bug_report_outlined),
            title: const Text('调试模式'),
            subtitle: const Text('开启后显示页面错误浮层'),
            value: DebugService.instance.enabled,
            onChanged: (v) {
              DebugService.instance.setEnabled(v);
              setState(() {});
            },
          ),
          const SizedBox(height: 48),
        ],
      ),
    );
  }

  Widget _buildThemeRow(AppSettings s) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Row(
        children: [
          const Icon(Icons.brightness_6_outlined),
          const SizedBox(width: 20),
          const Expanded(child: Text('深色模式')),
          SegmentedButton<String>(
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(value: 'system', label: Text('跟随系统')),
              ButtonSegment(value: 'light', label: Text('浅色')),
              ButtonSegment(value: 'dark', label: Text('深色')),
            ],
            selected: {s.themeMode},
            onSelectionChanged: (sel) =>
                ref.read(settingsControllerProvider).saveThemeMode(sel.first),
          ),
        ],
      ),
    );
  }

  Widget _sectionTitle(String t) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 6),
      child: Text(
        t,
        style: Theme.of(context)
            .textTheme
            .labelLarge
            ?.copyWith(color: Theme.of(context).colorScheme.primary),
      ),
    );
  }

  Widget _row(IconData icon, String title, String? subtitle, VoidCallback? onTap) {
    return ListTile(
      leading: Icon(icon),
      title: Text(title),
      subtitle: subtitle == null || subtitle.isEmpty ? null : Text(subtitle),
      trailing: onTap == null ? null : const Icon(Icons.chevron_right),
      onTap: onTap,
    );
  }
}
