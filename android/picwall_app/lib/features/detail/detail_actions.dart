import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:gal/gal.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/time_utils.dart';
import '../../data/models/media_item.dart';
import '../../services/debug_service.dart';
import '../../services/providers.dart';

/// 详情类页面共享的媒体操作集合（自 DetailPage 抽取）。
///
/// 承载 浏览历史写入/收藏态读写/收藏切换/保存图片/下载视频/分享/详情底部面板/直链补全，
/// [DetailPage] 与 [DouyinViewPage] 共用，保证两处操作行为一致。
mixin DetailActionsMixin<T extends ConsumerStatefulWidget>
    on ConsumerState<T> {
  /// 宿主提供当前配置的 API 根地址（用于把相对直链补成绝对地址）。
  String get apiBase;

  /// 标签点击回调（宿主可配置）。默认仅关闭详情底部面板。
  ///
  /// DetailPage 原语义为「pop 两层面板 + 跳转标签搜索(TODO)」，
  /// 抽取时以回调形式保留；抖音视图默认不注入，即不实现跳转。
  Future<void> Function(String tag)? onOpenTag;

  bool fav = false;
  bool saving = false;
  bool _favBusy = false;

  /// 写入浏览历史（幂等覆盖）并读取当前收藏态。
  Future<void> syncBrowse(MediaItem item) async {
    try {
      final db = await ref.read(localDbProvider.future);
      await db.record(item);
    } catch (e, st) {
      DebugService.instance.recordError('DetailActions.record', e, st);
    }
    await refreshFav(item);
  }

  /// 仅读取当前收藏态（不写历史）。
  Future<void> refreshFav(MediaItem item) async {
    bool isFav = false;
    try {
      final db = await ref.read(localDbProvider.future);
      isFav = await db.isFavorited(item.dedupeKey);
    } catch (e, st) {
      DebugService.instance.recordError('DetailActions.isFavorited', e, st);
    }
    if (mounted) setState(() => fav = isFav);
  }

  Future<void> toggleFavorite(MediaItem item) async {
    if (_favBusy) return;
    setState(() {
      _favBusy = true;
      fav = !fav;
    });
    try {
      final db = await ref.read(localDbProvider.future);
      if (fav) {
        await db.favorite(item);
      } else {
        await db.unfavorite(item.dedupeKey);
      }
    } catch (e, st) {
      DebugService.instance.recordError('DetailActions.toggleFav', e, st);
      if (mounted) setState(() => fav = !fav);
    } finally {
      if (mounted) setState(() => _favBusy = false);
    }
  }

  void showInfo(MediaItem item) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFF1E1E1E),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (_) => DraggableScrollableSheet(
        initialChildSize: 0.5,
        minChildSize: 0.2,
        maxChildSize: 0.8,
        expand: false,
        builder: (ctx, ctrl) => ListView(
          controller: ctrl,
          padding: const EdgeInsets.all(20),
          children: [
            Center(
              child: Container(
                width: 36, height: 4,
                decoration: BoxDecoration(
                    color: Colors.white24, borderRadius: BorderRadius.circular(2)),
              ),
            ),
            const SizedBox(height: 16),
            const Text('文件详情',
                style: TextStyle(
                    color: Colors.white, fontSize: 16, fontWeight: FontWeight.w600)),
            const SizedBox(height: 16),
            if (item.title.isNotEmpty) _infoRow('文件名', item.title),
            _infoRow('类型', item.fileTypeLabel),
            if (item.width != null && item.height != null)
              _infoRow('尺寸', '${item.width} × ${item.height}'),
            if (item.fileSize != null) _infoRow('大小', _fmtSize(item.fileSize!)),
            if (item.source.isNotEmpty) _infoRow('来源', item.source),
            if (item.createdAt.isNotEmpty)
              _infoRow('时间', BJT.formatDateTime(item.createdAt)),
            _infoRow('等级', item.level.label),
            if (item.tags.isNotEmpty) ...[
              const SizedBox(height: 4),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const SizedBox(
                    width: 64,
                    child: Text('标签',
                        style: TextStyle(color: Colors.white54, fontSize: 13)),
                  ),
                  Expanded(
                    child: Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        for (final tag in item.tags)
                          GestureDetector(
                            onTap: () async {
                              Navigator.pop(ctx);
                              final cb = onOpenTag;
                              if (cb != null) await cb(tag);
                            },
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 8, vertical: 3),
                              decoration: BoxDecoration(
                                color: const Color(0xFF6C7CFF)
                                    .withValues(alpha: 0.25),
                                borderRadius: BorderRadius.circular(10),
                              ),
                              child: Text(tag,
                                  style: const TextStyle(
                                      color: Color(0xFF9FA8FF), fontSize: 12)),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: () {
                  Clipboard.setData(
                      ClipboardData(text: absUrl(apiBase, item.url)));
                  ScaffoldMessenger.of(ctx).showSnackBar(
                      const SnackBar(content: Text('直链已复制')));
                },
                icon: const Icon(Icons.copy, size: 16, color: Colors.white70),
                label: const Text('复制直链',
                    style: TextStyle(color: Colors.white70, fontSize: 13)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  static Widget _infoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 64,
            child: Text(label,
                style: const TextStyle(color: Colors.white54, fontSize: 13)),
          ),
          Expanded(
            child: Text(value,
                style: const TextStyle(color: Colors.white, fontSize: 13)),
          ),
        ],
      ),
    );
  }

  Future<void> downloadVideo(MediaItem item) async {
    if (saving) return;
    setState(() => saving = true);
    try {
      final resp = await ref.read(apiClientProvider).dio.get<List<int>>(
            item.url,
            options: Options(responseType: ResponseType.bytes),
          );
      final bytes = resp.data;
      if (bytes == null || bytes.isEmpty) throw StateError('empty');
      final accessible = await Gal.hasAccess();
      if (!accessible) {
        final granted = await Gal.requestAccess();
        if (!granted) {
          showSnack('需要相册权限才能保存');
          return;
        }
      }
      await Gal.putImageBytes(Uint8List.fromList(bytes),
          name: item.title.isNotEmpty ? item.title : 'picwall_video');
      showSnack('视频已保存到相册');
    } catch (e) {
      DebugService.instance.recordError('DetailActions.downloadVideo', e);
      showSnack('下载失败：请检查网络');
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  static String _fmtSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1048576) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    if (bytes < 1073741824) return '${(bytes / 1048576).toStringAsFixed(1)} MB';
    return '${(bytes / 1073741824).toStringAsFixed(1)} GB';
  }

  Future<void> shareItem(MediaItem item) async {
    final url = absUrl(apiBase, item.url);
    if (!mounted) return;
    try {
      final title = item.title.isNotEmpty ? item.title : 'PicWall 图片';
      await SharePlus.instance.share(ShareParams(text: url, subject: title));
    } catch (e) {
      showSnack('分享不可用，可先复制直链');
    }
  }

  Future<void> savePhoto(MediaItem item) async {
    if (saving) return;
    if (!item.isPhoto) {
      showSnack('当前仅支持图片保存到相册，其它类型可复制直链');
      return;
    }
    setState(() => saving = true);
    try {
      // 下载原图字节
      final resp = await ref.read(apiClientProvider).dio.get<List<int>>(
            item.url,
            options: Options(responseType: ResponseType.bytes),
          );
      final bytes = resp.data;
      if (bytes == null || bytes.isEmpty) throw StateError('empty');
      final accessible = await Gal.hasAccess();
      if (!accessible) {
        final granted = await Gal.requestAccess();
        if (!granted) {
          showSnack('需要相册权限才能保存');
          return;
        }
      }
      await Gal.putImageBytes(Uint8List.fromList(bytes));
      showSnack('已保存到系统相册');
    } catch (e) {
      DebugService.instance.recordError('DetailActions.savePhoto', e);
      showSnack('保存失败：请检查网络或复制直链');
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  void showSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }
}

/// 相对路径(/file/…)拼上根地址；已是绝对直链则原样返回。
String absUrl(String base, String u) {
  if (u.isEmpty) return u;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  if (base.isEmpty) return u;
  if (u.startsWith('/')) return '$base$u';
  return '$base/$u';
}
