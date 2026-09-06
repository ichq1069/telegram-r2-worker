import 'package:flutter/material.dart';

import '../../data/models/sync_filter.dart';

/// 同步筛选规则编辑弹层。返回 null=取消，否则为保存后的 [SyncFilter]。
class SyncFilterSheet extends StatefulWidget {
  const SyncFilterSheet({super.key, required this.initial});

  final SyncFilter initial;

  @override
  State<SyncFilterSheet> createState() => _SyncFilterSheetState();

  static Future<SyncFilter?> show(
    BuildContext context, {
    required SyncFilter initial,
  }) {
    return showModalBottomSheet<SyncFilter>(
      context: context,
      isScrollControlled: true,
      builder: (_) => SyncFilterSheet(initial: initial),
    );
  }
}

const List<String> kSyncExtOptions = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'heic',
  'heif',
  'mp4',
  'mov',
  'webm',
];

class _SyncFilterSheetState extends State<SyncFilterSheet> {
  late SyncFilter _filter;
  late final TextEditingController _minCtrl;
  late final TextEditingController _maxCtrl;

  @override
  void initState() {
    super.initState();
    _filter = widget.initial;
    _minCtrl = TextEditingController(text: _mb(_filter.minBytes));
    _maxCtrl = TextEditingController(text: _mb(_filter.maxBytes));
  }

  @override
  void dispose() {
    _minCtrl.dispose();
    _maxCtrl.dispose();
    super.dispose();
  }

  static String _mb(int bytes) {
    if (bytes <= 0) return '0';
    return (bytes / (1024 * 1024)).toStringAsFixed(bytes % (1024 * 1024) == 0 ? 0 : 1);
  }

  static int _toBytes(String text) {
    final v = double.tryParse(text.trim());
    if (v == null || v <= 0) return 0;
    return (v * 1024 * 1024).round();
  }

  void _toggleExt(String ext) {
    final exts = Set<String>.of(_filter.exts);
    if (!exts.add(ext)) exts.remove(ext);
    setState(() => _filter = _filter.copyWith(exts: exts));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final secondary = theme.colorScheme.onSurfaceVariant;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 16,
          right: 16,
          top: 16,
          bottom: MediaQuery.of(context).viewInsets.bottom + 16,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('同步筛选',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 17)),
            const SizedBox(height: 4),
            Text('不满足条件的照片/视频将跳过不入队。',
                style: TextStyle(fontSize: 12, color: secondary)),
            const SizedBox(height: 14),
            const Text('媒体类型', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            SegmentedButton<SyncMediaKind>(
              segments: [
                for (final k in SyncMediaKind.values)
                  ButtonSegment(
                    value: k,
                    label: Text(k.label),
                  ),
              ],
              selected: {_filter.kind},
              onSelectionChanged: (s) =>
                  setState(() => _filter = _filter.copyWith(kind: s.first)),
            ),
            const SizedBox(height: 14),
            const Text('文件大小（MB，0 表示不限）',
                style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _minCtrl,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                        labelText: '最小', isDense: true, border: OutlineInputBorder()),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  child: Text('—', style: TextStyle(color: secondary)),
                ),
                Expanded(
                  child: TextField(
                    controller: _maxCtrl,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                        labelText: '最大', isDense: true, border: OutlineInputBorder()),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            const Text(
              '格式（不选 = 全部格式）',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final ext in kSyncExtOptions)
                  FilterChip(
                    label: Text(ext),
                    selected: _filter.exts.contains(ext),
                    visualDensity: VisualDensity.compact,
                    onSelected: (_) => _toggleExt(ext),
                  ),
              ],
            ),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('取消'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: () {
                    Navigator.pop(
                      context,
                      _filter.copyWith(
                        minBytes: _toBytes(_minCtrl.text),
                        maxBytes: _toBytes(_maxCtrl.text),
                      ),
                    );
                  },
                  child: const Text('保存'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
