import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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
    try {
      await UpdateService.instance.installApk(path);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('安装失败：$e')),
        );
      }
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
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton.icon(
                  onPressed: _copyLink,
                  icon: const Icon(Icons.link, size: 16),
                  label: const Text('复制下载链接'),
                  style: OutlinedButton.styleFrom(
                    visualDensity: VisualDensity.compact,
                    foregroundColor: theme.colorScheme.primary,
                    side: BorderSide(
                      color: theme.colorScheme.primary.withValues(alpha: 0.6),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'App 内下载失败时，可复制链接到浏览器下载 APK 后手动安装',
                style: TextStyle(
                  fontSize: 11,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('稍后'),
        ),
        if (_apkPath != null)
          FilledButton(
            onPressed: _install,
            child: const Text('安装'),
          )
        else
          FilledButton(
            onPressed: _downloading ? null : _download,
            child: _downloading
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('更新'),
          ),
      ],
    );
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
