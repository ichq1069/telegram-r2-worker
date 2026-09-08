import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/update_service.dart';

/// 应用更新弹窗：显示版本信息 + 下载进度 + 安装。
class UpdateDialog extends StatefulWidget {
  const UpdateDialog({super.key, required this.info});

  final UpdateInfo info;

  /// 静态方法：检查并显示更新弹窗。
  static Future<void> checkAndShow(BuildContext context) async {
    final service = UpdateService.instance;
    final info = await service.checkForUpdate();
    if (info == null || !info.hasUpdate) return;
    if (!context.mounted) return;
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => UpdateDialog(info: info),
    );
  }

  @override
  State<UpdateDialog> createState() => _UpdateDialogState();
}

class _UpdateDialogState extends State<UpdateDialog> {
  bool _downloading = false;
  double _progress = 0;
  String? _error;
  String? _apkPath;

  Future<void> _download() async {
    setState(() { _downloading = true; _progress = 0; _error = null; });
    final res = await UpdateService.instance.downloadApk(
      widget.info.downloadUrl,
      onProgress: (p) { if (mounted) setState(() => _progress = p); },
    );
    if (!mounted) return;
    if (res.path != null) {
      setState(() { _apkPath = res.path; _downloading = false; });
    } else {
      final reason = res.error == null || res.error!.isEmpty
          ? '请检查网络后重试'
          : res.error!;
      setState(() { _error = '下载失败：$reason'; _downloading = false; });
    }
  }

  Future<void> _install() async {
    final path = _apkPath;
    if (path == null) return;
    final canInstall =
        await UpdateService.instance.canInstallFromUnknownSources();
    if (!mounted) return;
    if (!canInstall) {
      await _showEnableInstallGuide();
      return;
    }
    try {
      await UpdateService.instance.installApk(path);
    } catch (e) {
      if (!mounted) return;
      final msg = e.toString();
      final manualOnly = msg.contains('不支持自动安装') ||
          msg.contains('未找到可用的安装程序');
      if (manualOnly) {
        await _showManualGuide();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('安装失败：$e')),
        );
      }
    }
  }

  /// 引导到系统设置开启「允许安装未知来源应用」。
  Future<void> _showEnableInstallGuide() async {
    if (!mounted) return;
    final action = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('需要允许安装应用'),
        content: const Text(
          '应用内直接安装需要系统先允许「图墙」安装未知来源应用。'
          '\n去开启后返回本页，再次点击「安装」即可。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, 'manual'),
            child: const Text('复制链接手动安装'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, 'open'),
            child: const Text('去开启'),
          ),
        ],
      ),
    );
    if (!mounted || action == null) return;
    if (action == 'manual') {
      await _copyLink();
    } else if (action == 'open') {
      final opened = await UpdateService.instance.openInstallSettings();
      if (!opened && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('未能打开系统设置，可复制下载链接手动安装')),
        );
      }
    }
  }

  /// 无法自动安装时的兜底：提示复制链接浏览器下载手动安装。
  Future<void> _showManualGuide() async {
    if (!mounted) return;
    final action = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('需要手动安装'),
        content: const Text(
          '当前设备未授权应用内自动安装，或运行中的安装包过旧。'
          '\n可复制下载链接到浏览器下载 APK 后手动安装。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('稍后'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, 'copy'),
            child: const Text('复制下载链接'),
          ),
        ],
      ),
    );
    if (action == 'copy' && mounted) {
      await _copyLink();
    }
  }

  Future<void> _copyLink() async {
    await Clipboard.setData(ClipboardData(text: widget.info.downloadUrl));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已复制下载链接，粘贴到浏览器下载后手动安装')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final info = widget.info;
    final theme = Theme.of(context);
    return AlertDialog(
      icon: const Icon(Icons.system_update, size: 40),
      title: const Text('发现新版本'),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 320),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                _versionTag('当前 v${info.currentVersion}', theme.colorScheme.outline),
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 8),
                  child: Icon(Icons.arrow_forward, size: 16),
                ),
                _versionTag('v${info.latestVersion}', theme.colorScheme.primary),
              ],
            ),
            if (info.body.isNotEmpty) ...[
              const SizedBox(height: 12),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  info.body,
                  style: TextStyle(fontSize: 12, color: theme.colorScheme.onSurfaceVariant),
                  maxLines: 8,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
            const SizedBox(height: 16),
            if (_downloading) ...[
              LinearProgressIndicator(value: _progress > 0 ? _progress : null),
              const SizedBox(height: 6),
              Text(
                _progress > 0 ? '下载中 ${(_progress * 100).toStringAsFixed(0)}%' : '准备下载…',
                style: TextStyle(fontSize: 12, color: theme.colorScheme.onSurfaceVariant),
              ),
            ] else if (_apkPath != null) ...[
              Row(
                children: [
                  Icon(Icons.check_circle, size: 16, color: theme.colorScheme.primary),
                  const SizedBox(width: 6),
                  Text('下载完成', style: TextStyle(fontSize: 12, color: theme.colorScheme.primary)),
                ],
              ),
            ] else if (_error != null) ...[
              Text(
                _error!,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: theme.colorScheme.error),
              ),
              const SizedBox(height: 10),
              _externalButtons(theme.colorScheme.primary),
              const SizedBox(height: 4),
              Text(
                'App 内下载失败时可复制链接或改用浏览器下载 APK 后手动安装',
                style: TextStyle(
                  fontSize: 11,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ] else ...[
              Text(
                '选择更新方式',
                style: TextStyle(
                  fontSize: 12,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _download,
                  icon: const Icon(Icons.download, size: 18),
                  label: const Text('APP 内下载'),
                ),
              ),
              const SizedBox(height: 10),
              _externalButtons(theme.colorScheme.primary),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('稍后'),
        ),
        if (_error != null && _apkPath == null && !_downloading)
          FilledButton(
            onPressed: _download,
            child: const Text('重试'),
          ),
        if (_apkPath != null)
          FilledButton(
            onPressed: _install,
            child: const Text('安装'),
          ),
      ],
    );
  }

  /// 外部下载的两条通道：复制链接到浏览器手动下载 / 调起系统浏览器直接下载。
  Widget _externalButtons(Color accent) {
    final outlineStyle = OutlinedButton.styleFrom(
      foregroundColor: accent,
      side: BorderSide(color: accent.withValues(alpha: 0.6)),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        OutlinedButton.icon(
          onPressed: _copyLink,
          style: outlineStyle,
          icon: const Icon(Icons.link, size: 16),
          label: const Text('复制下载链接'),
        ),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: _openInBrowser,
          style: outlineStyle,
          icon: const Icon(Icons.open_in_browser, size: 16),
          label: const Text('用浏览器打开'),
        ),
      ],
    );
  }

  /// 用系统浏览器打开 APK 直链（页面自动触发下载）；打不开时退回复制链接。
  Future<void> _openInBrowser() async {
    final ok = await launchUrl(
      Uri.parse(widget.info.downloadUrl),
      mode: LaunchMode.externalApplication,
    );
    if (ok) return;
    await Clipboard.setData(ClipboardData(text: widget.info.downloadUrl));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('无法打开浏览器，下载链接已复制')),
      );
    }
  }

  Widget _versionTag(String text, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(text, style: TextStyle(fontSize: 12, color: color, fontWeight: FontWeight.w600)),
    );
  }
}
