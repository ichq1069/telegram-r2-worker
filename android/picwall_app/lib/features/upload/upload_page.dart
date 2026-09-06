import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../data/models/upload_task.dart';
import '../../services/debug_service.dart';
import '../../services/providers.dart';
import 'upload_engine.dart';

/// 上传页：三来源（相册/拍照/URL）+ 队列管理 + WiFi-only。
/// 与相册同步共用全局 [uploadEngineProvider] 队列实例。
class UploadPage extends ConsumerStatefulWidget {
  const UploadPage({super.key});

  @override
  ConsumerState<UploadPage> createState() => _UploadPageState();
}

class _UploadPageState extends ConsumerState<UploadPage> {
  final _tagsCtrl = TextEditingController();
  final _picker = ImagePicker();
  StreamSubscription<List<ConnectivityResult>>? _connSub;
  UploadEngine? _engine;
  bool _watched = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _boot());
  }

  Future<void> _boot() async {
    try {
      final engine = await ref.read(uploadEngineProvider.future);
      if (!mounted) return;
      _attach(engine);
      await engine.start();
    } catch (e, st) {
      DebugService.instance.recordError('UploadPage.boot', e, st);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('上传引擎初始化失败')),
        );
      }
    }
  }

  void _attach(UploadEngine engine) {
    if (_watched) return;
    _watched = true;
    _engine = engine;
    engine.addListener(_onEngine);
    _connSub = Connectivity().onConnectivityChanged.listen((results) {
      _onNetwork(results);
    });
  }

  void _onEngine() {
    if (mounted) setState(() {});
  }

  Future<void> _onNetwork(List<ConnectivityResult> results) async {
    if (results.isEmpty) return;
    final kind = results.any((r) =>
            r == ConnectivityResult.wifi ||
            r == ConnectivityResult.ethernet)
        ? NetworkKind.wifi
        : (results.contains(ConnectivityResult.mobile)
            ? NetworkKind.cellular
            : NetworkKind.none);
    await _engine?.onNetworkChanged(kind);
  }

  @override
  void dispose() {
    _connSub?.cancel();
    _engine?.removeListener(_onEngine);
    _tagsCtrl.dispose();
    super.dispose();
  }

  // ---------------- 来源 ----------------

  Future<void> _pickFromGallery() async {
    final picked = await _picker.pickMultiImage();
    if (picked.isEmpty) return;
    await _enqueue(
      picked.map((x) => x.path).where((p) => p.isNotEmpty).toList(),
      UploadSource.gallery,
      nameOf: (p) => p.split('/').last,
    );
  }

  Future<void> _pickFromCamera() async {
    final shot = await _picker.pickImage(source: ImageSource.camera);
    if (shot == null) return;
    await _enqueue([shot.path], UploadSource.camera,
        nameOf: (p) => p.split('/').last);
  }

  Future<void> _pasteUrls() async {
    final controller = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('粘贴图片/视频链接'),
        content: TextField(
          controller: controller,
          maxLines: 5,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(
            hintText: '每行一个 URL\n支持图片与视频直链',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('添加'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final urls = controller.text
        .split('\n')
        .map((s) => s.trim())
        .where((s) => s.isNotEmpty && s.startsWith('http'))
        .toList();
    controller.dispose();
    if (urls.isEmpty) return;
    setState(() => _busy = true);
    final saved = <String>[];
    final failed = <String>[];
    for (final url in urls) {
      final path = await _downloadToTemp(url);
      if (path != null) {
        saved.add(path);
      } else {
        failed.add(url);
      }
    }
    if (saved.isNotEmpty) {
      await _enqueue(saved, UploadSource.url,
          nameOf: (p) => p.split('/').last, thenCleanup: true);
    }
    if (mounted) {
      setState(() => _busy = false);
      if (failed.isNotEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('${failed.length} 个链接下载失败')),
        );
      }
    }
  }

  /// 下载 URL 到临时目录；成功返回本地路径。
  Future<String?> _downloadToTemp(String url) async {
    final dir = await Directory.systemTemp.createTemp('pw_dl_');
    final segments = Uri.tryParse(url)?.pathSegments ?? const [];
    final name = segments.isNotEmpty ? segments.last : 'download.bin';
    final dest = '${dir.path}${Platform.pathSeparator}'
        '${name.isEmpty ? 'file.bin' : name}';
    try {
      await Dio().download(url, dest,
          options: Options(
            receiveTimeout: const Duration(seconds: 60),
            sendTimeout: const Duration(seconds: 60),
          ));
      return dest;
    } catch (_) {
      try {
        await dir.delete(recursive: true);
      } catch (_) {}
      return null;
    }
  }

  Future<void> _enqueue(
    List<String> paths,
    UploadSource source, {
    required String Function(String) nameOf,
    bool thenCleanup = false,
  }) async {
    final engine = _engine;
    if (engine == null) return;
    setState(() => _busy = true);
    try {
      await engine.enqueueFiles(
        paths: paths,
        source: source,
        tags: _tagsCtrl.text.trim(),
        nameOf: nameOf,
      );
      if (thenCleanup) {
        for (final p in paths) {
          final f = File(p);
          if (await f.exists()) {
            try {
              await f.delete();
            } catch (_) {}
          }
        }
      }
      await engine.start();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ---------------- UI ----------------

  @override
  Widget build(BuildContext context) {
    final asyncEngine = ref.watch(uploadEngineProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('上传')),
      body: asyncEngine.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, __) => const Center(child: Text('上传引擎不可用')),
        data: (engine) {
          _engine = engine;
          if (!_watched) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              _attach(engine);
              engine.start();
            });
          }
          return _buildBody(context, engine);
        },
      ),
    );
  }

  Widget _buildBody(BuildContext context, UploadEngine engine) {
    final theme = Theme.of(context);
    final subtitleColor = theme.colorScheme.onSurfaceVariant;

    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        _SourceBar(
          busy: _busy,
          onGallery: _pickFromGallery,
          onCamera: _pickFromCamera,
          onUrl: _pasteUrls,
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _tagsCtrl,
          decoration: const InputDecoration(
            labelText: '标签（可选，逗号分隔）',
            hintText: '例如：风景, 日常',
            isDense: true,
            border: OutlineInputBorder(),
          ),
          onSubmitted: (_) => FocusScope.of(context).unfocus(),
        ),
        const SizedBox(height: 12),
        Card(
          child: SwitchListTile(
            contentPadding: const EdgeInsets.symmetric(horizontal: 12),
            title: const Text('仅 Wi-Fi 上传'),
            subtitle: const Text('非 Wi-Fi 网络下队列自动挂起'),
            value: engine.wifiOnly,
            onChanged: (v) {
              engine.setWifiOnly(v);
              ref.read(settingsControllerProvider).save(wifiOnlyUpload: v);
            },
          ),
        ),
        if (engine.tasks.isNotEmpty) ...[
          const SizedBox(height: 8),
          _QueueHeader(engine: engine),
        ],
        if (engine.failedCount > 0)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              '有 ${engine.failedCount} 张上传失败，可点击重试',
              style: TextStyle(color: theme.colorScheme.error, fontSize: 12),
            ),
          ),
        if (engine.tasks.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 48),
            child: Column(
              children: [
                Icon(Icons.cloud_upload_outlined,
                    size: 56, color: subtitleColor),
                const SizedBox(height: 12),
                Text('从相册、拍照或粘贴链接开始上传',
                    style: TextStyle(color: subtitleColor)),
              ],
            ),
          )
        else
          for (final t in engine.tasks)
            _TaskTile(
              key: ValueKey(t.id),
              task: t,
              busy: _busy,
              onRetry: () => engine.retry(t.id ?? -1),
              onRemove: () => engine.remove(t.id ?? -1),
            ),
        const SizedBox(height: 8),
        Center(
          child: TextButton.icon(
            onPressed: engine.doneCount == 0 ? null : engine.clearDone,
            icon: const Icon(Icons.delete_sweep_outlined, size: 18),
            label: Text('清除已完成（${engine.doneCount}）'),
          ),
        ),
        const SizedBox(height: 24),
      ],
    );
  }
}

class _SourceBar extends StatelessWidget {
  const _SourceBar({
    required this.busy,
    required this.onGallery,
    required this.onCamera,
    required this.onUrl,
  });

  final bool busy;
  final VoidCallback onGallery;
  final VoidCallback onCamera;
  final VoidCallback onUrl;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: FilledButton.icon(
            onPressed: busy ? null : onGallery,
            icon: const Icon(Icons.photo_library_outlined),
            label: const Text('相册多选'),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: OutlinedButton.icon(
            onPressed: busy ? null : onCamera,
            icon: const Icon(Icons.photo_camera_outlined),
            label: const Text('拍照'),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: OutlinedButton.icon(
            onPressed: busy ? null : onUrl,
            icon: const Icon(Icons.link),
            label: const Text('链接'),
          ),
        ),
      ],
    );
  }
}

class _QueueHeader extends StatelessWidget {
  const _QueueHeader({required this.engine});

  final UploadEngine engine;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final done = engine.doneCount;
    final failed = engine.failedCount;
    final remaining = engine.queuedCount + engine.uploadingCount;
    final total = engine.tasks.length;
    final progress = total == 0 ? 0.0 : done / total;
    final status = engine.running
        ? '上传中…（$done/$total 完成，剩 $remaining）'
        : engine.networkPaused
            ? '已挂起：当前非 Wi-Fi 网络'
            : remaining > 0
                ? '等待上传（$remaining 待传 / 失败 $failed）'
                : '本次队列结束（成功 $done / 失败 $failed）';

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  engine.running
                      ? Icons.cloud_upload
                      : engine.networkPaused
                          ? Icons.wifi_off
                          : Icons.cloud_done_outlined,
                  size: 18,
                  color: theme.colorScheme.primary,
                ),
                const SizedBox(width: 8),
                Expanded(child: Text(status)),
              ],
            ),
            const SizedBox(height: 8),
            LinearProgressIndicator(
              value: progress,
              minHeight: 6,
              borderRadius: BorderRadius.circular(3),
            ),
          ],
        ),
      ),
    );
  }
}

class _TaskTile extends StatelessWidget {
  const _TaskTile({
    super.key,
    required this.task,
    required this.busy,
    required this.onRetry,
    required this.onRemove,
  });

  final UploadTask task;
  final bool busy;
  final VoidCallback? onRetry;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitle = switch (task.state) {
      UploadState.queued => '等待中',
      UploadState.uploading => '上传中…',
      UploadState.done => '上传成功',
      UploadState.failed => task.error ?? '上传失败',
    };
    final leadingIcon = switch (task.source) {
      UploadSource.gallery => Icons.photo_outlined,
      UploadSource.camera => Icons.photo_camera_outlined,
      UploadSource.url => Icons.link,
      UploadSource.unknown => Icons.insert_drive_file_outlined,
    };

    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ListTile(
        leading: ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: SizedBox(
            width: 44,
            height: 44,
            child: _Thumb(path: task.filePath, fallbackIcon: leadingIcon),
          ),
        ),
        title: Text(task.fileName,
            maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text(
          subtitle,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 12,
            color: task.state == UploadState.failed
                ? theme.colorScheme.error
                : theme.colorScheme.onSurfaceVariant,
          ),
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (task.state == UploadState.uploading)
              const SizedBox(
                width: 24,
                height: 24,
                child: Padding(
                  padding: EdgeInsets.all(6),
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            if (task.state == UploadState.done)
              Icon(Icons.check_circle, color: Colors.green.shade600, size: 20),
            if (task.state == UploadState.failed)
              IconButton(
                tooltip: '重试',
                onPressed: busy || onRetry == null ? null : onRetry,
                icon: const Icon(Icons.refresh),
              ),
            IconButton(
              tooltip: '移除',
              onPressed: busy ? null : onRemove,
              icon: const Icon(Icons.close, size: 18),
            ),
          ],
        ),
      ),
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.path, required this.fallbackIcon});

  final String path;
  final IconData fallbackIcon;

  @override
  Widget build(BuildContext context) {
    return Image.file(
      File(path),
      width: 44,
      height: 44,
      fit: BoxFit.cover,
      errorBuilder: (_, __, ___) => Container(
        color: Colors.white12,
        alignment: Alignment.center,
        child: Icon(fallbackIcon, size: 20, color: Colors.white54),
      ),
    );
  }
}
