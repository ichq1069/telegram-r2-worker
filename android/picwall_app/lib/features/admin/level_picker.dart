/// 级别选择弹窗：选择条目的内容级别（pt/vip/svip/vvip）。
library;

import 'package:flutter/material.dart';

const _levels = [
  ('pt', '基础', Color(0xFF9CA3AF)),
  ('vip', 'VIP', Color(0xFF3B82F6)),
  ('svip', 'SVIP', Color(0xFF8B5CF6)),
  ('vvip', 'VVIP', Color(0xFFD97706)),
];

/// 弹出级别选择面板，返回选中的级别字符串；取消返回 null。
Future<String?> showLevelPicker(
  BuildContext context, {
  String current = 'pt',
}) {
  return showModalBottomSheet<String>(
    context: context,
    builder: (_) => _LevelPickerSheet(current: current),
  );
}

class _LevelPickerSheet extends StatelessWidget {
  const _LevelPickerSheet({required this.current});
  final String current;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('设置级别', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            ),
          ),
          const Divider(height: 1),
          for (final (value, label, color) in _levels)
            ListTile(
              leading: CircleAvatar(
                radius: 14,
                backgroundColor: color.withValues(alpha: 0.2),
                child: Text(label.substring(0, 1),
                    style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w700)),
              ),
              title: Text(label),
              trailing: value == current
                  ? Icon(Icons.check, color: Theme.of(context).colorScheme.primary)
                  : null,
              onTap: () => Navigator.pop(context, value),
            ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}
