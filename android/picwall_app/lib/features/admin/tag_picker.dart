/// 标签选择弹窗：从预设标签库中多选标签。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../services/providers.dart';

/// 弹出标签选择面板，返回用户选中的标签列表；取消返回 null。
Future<List<String>?> showTagPicker(
  BuildContext context, {
  required String adminKey,
  List<String> initial = const [],
}) {
  return showModalBottomSheet<List<String>>(
    context: context,
    isScrollControlled: true,
    builder: (_) => _TagPickerSheet(adminKey: adminKey, initial: initial),
  );
}

class _TagPickerSheet extends ConsumerStatefulWidget {
  const _TagPickerSheet({required this.adminKey, required this.initial});
  final String adminKey;
  final List<String> initial;

  @override
  ConsumerState<_TagPickerSheet> createState() => _TagPickerSheetState();
}

class _TagPickerSheetState extends ConsumerState<_TagPickerSheet> {
  late final Set<String> _sel;
  List<({String tag, int count})> _tags = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _sel = Set<String>.from(widget.initial);
    _load();
  }

  Future<void> _load() async {
    try {
      final tags = await ref.read(galleryRepositoryProvider).adminTagsList(widget.adminKey);
      if (!mounted) return;
      setState(() {
        _tags = tags;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      initialChildSize: 0.6,
      minChildSize: 0.3,
      maxChildSize: 0.9,
      expand: false,
      builder: (context, scrollCtrl) => Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 8, 0),
            child: Row(
              children: [
                const Expanded(
                  child: Text('选择标签', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(context, _sel.toList()),
                  child: const Text('确定'),
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                    ? Center(
                        child: Text(_error!,
                            style: TextStyle(color: Theme.of(context).colorScheme.error)),
                      )
                    : _tags.isEmpty
                        ? const Center(child: Text('暂无预设标签'))
                        : ListView(
                            controller: scrollCtrl,
                            padding: const EdgeInsets.all(12),
                            children: [
                              Wrap(
                                spacing: 8,
                                runSpacing: 8,
                                children: [
                                  for (final t in _tags)
                                    FilterChip(
                                      label: Text('${t.tag} (${t.count})'),
                                      selected: _sel.contains(t.tag),
                                      onSelected: (on) {
                                        setState(() {
                                          if (on) {
                                            _sel.add(t.tag);
                                          } else {
                                            _sel.remove(t.tag);
                                          }
                                        });
                                      },
                                    ),
                                ],
                              ),
                            ],
                          ),
          ),
        ],
      ),
    );
  }
}
