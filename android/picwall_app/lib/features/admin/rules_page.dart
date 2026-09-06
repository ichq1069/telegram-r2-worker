import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/admin_file.dart';
import '../../services/providers.dart';

/// 采集域名规则组管理：按域名配置忽略词/格式/上限/必带词，云端全量覆盖保存。
class RulesPage extends ConsumerStatefulWidget {
  const RulesPage({super.key, required this.adminKey});

  final String adminKey;

  @override
  ConsumerState<RulesPage> createState() => _RulesPageState();
}

class _RulesPageState extends ConsumerState<RulesPage> {
  List<RuleGroup> _groups = [];
  bool _loading = true;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final groups =
          await ref.read(galleryRepositoryProvider).adminRuleGroups(widget.adminKey);
      if (mounted) setState(() => _groups = groups);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      final saved = await ref
          .read(galleryRepositoryProvider)
          .adminRuleGroupsSave(widget.adminKey, _groups);
      if (!mounted) return;
      setState(() => _groups = saved);
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('规则组已保存到云端')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _edit([RuleGroup? origin]) async {
    final g = await showDialog<RuleGroup>(
      context: context,
      builder: (_) => _GroupSheet(group: origin),
    );
    if (g == null || !mounted) return;
    setState(() {
      final idx = _groups.indexWhere((x) => x.key == origin?.key);
      if (origin == null) {
        if (_groups.any((x) => x.key == g.key)) {
          ScaffoldMessenger.of(context)
              .showSnackBar(SnackBar(content: Text('已存在域名「${g.key}」的规则组')));
          return;
        }
        _groups.add(g);
      } else if (idx >= 0) {
        _groups[idx] = g;
      }
    });
  }

  Future<void> _remove(RuleGroup g) async {
    if (g.key == '*') return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('删除规则组「${g.name.isEmpty ? g.key : g.name}」？'),
        content: const Text('该操作保存后生效。'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('取消')),
          FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true), child: const Text('删除')),
        ],
      ),
    );
    if (ok == true && mounted) {
      setState(() => _groups.removeWhere((x) => x.key == g.key));
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('采集规则组'),
        actions: [
          IconButton(
            tooltip: '刷新',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          IconButton(
            tooltip: '新增规则组',
            onPressed: () => _edit(),
            icon: const Icon(Icons.add),
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: FilledButton.icon(
            onPressed: _saving ? null : _save,
            icon: _saving
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.cloud_upload_outlined),
            label: Text(_saving ? '保存中…' : '保存到云端'),
          ),
        ),
      ),
      body: _buildBody(theme),
    );
  }

  Widget _buildBody(ThemeData theme) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_groups.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            _error ?? '还没有规则组，点右上角 + 新建（域名留 * 为默认组）',
            textAlign: TextAlign.center,
            style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
          ),
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        Text('规则按域名匹配采集链接；域名可用 * 作为兜底默认组。',
            style: TextStyle(fontSize: 12, color: theme.colorScheme.onSurfaceVariant)),
        const SizedBox(height: 8),
        for (final g in _groups) _GroupCard(group: g, onEdit: () => _edit(g), onDelete: () => _remove(g)),
      ],
    );
  }
}

class _GroupCard extends StatelessWidget {
  const _GroupCard({required this.group, required this.onEdit, required this.onDelete});

  final RuleGroup group;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final g = group;
    final parts = <String>[
      if (g.kw.isNotEmpty) '忽略词:${g.kw}',
      if (g.ext.isNotEmpty) '忽略:${g.ext}',
      '上限:${g.mb}MB',
      if (g.must.isNotEmpty) '必带:${g.must}',
    ];
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        title: Text(g.key == '*' ? '默认（所有页面）' : g.key,
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (g.name.isNotEmpty && g.name != g.key)
              Text(g.name, style: TextStyle(fontSize: 11, color: theme.colorScheme.onSurfaceVariant)),
            Text(parts.isEmpty ? '（无附加规则）' : parts.join(' · '),
                style: const TextStyle(fontSize: 11)),
          ],
        ),
        isThreeLine: g.name.isNotEmpty && g.name != g.key,
        trailing: PopupMenuButton<String>(
          onSelected: (v) {
            if (v == 'edit') onEdit();
            if (v == 'del') onDelete();
          },
          itemBuilder: (_) => [
            const PopupMenuItem(value: 'edit', child: Text('编辑')),
            if (g.key != '*')
              const PopupMenuItem(value: 'del', child: Text('删除')),
          ],
        ),
      ),
    );
  }
}

class _GroupSheet extends StatefulWidget {
  const _GroupSheet({this.group});

  final RuleGroup? group;

  @override
  State<_GroupSheet> createState() => _GroupSheetState();
}

class _GroupSheetState extends State<_GroupSheet> {
  late final _key = TextEditingController(text: widget.group?.key ?? '');
  late final _name = TextEditingController(text: widget.group?.name ?? '');
  late final _kw = TextEditingController(text: widget.group?.kw ?? '');
  late final _ext = TextEditingController(text: widget.group?.ext ?? '');
  late final _mb = TextEditingController(text: (widget.group?.mb ?? 10).toString());
  late final _must = TextEditingController(text: widget.group?.must ?? '');
  bool get _isNew => widget.group == null;

  @override
  void dispose() {
    _key.dispose();
    _name.dispose();
    _kw.dispose();
    _ext.dispose();
    _mb.dispose();
    _must.dispose();
    super.dispose();
  }

  void _submit() {
    final key = _key.text.trim();
    if (key.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请填写域名（* 为默认）')));
      return;
    }
    final mb = int.tryParse(_mb.text.trim());
    Navigator.of(context).pop(RuleGroup(
      key: key,
      name: _name.text.trim(),
      kw: _kw.text.trim(),
      ext: _ext.text.trim(),
      mb: mb == null || mb < 1 ? 10 : (mb > 30 ? 30 : mb),
      must: _must.text.trim(),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(_isNew ? '新增规则组' : '编辑规则组'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: _key,
              enabled: _isNew,
              decoration: const InputDecoration(
                labelText: '域名（* = 默认组）',
                hintText: '如 example.com 或 *',
                isDense: true,
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _name,
              decoration: const InputDecoration(
                labelText: '显示名称（可空）',
                isDense: true,
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _kw,
              decoration: const InputDecoration(
                labelText: '忽略关键词',
                hintText: '逗号分隔',
                isDense: true,
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _ext,
              decoration: const InputDecoration(
                labelText: '忽略格式',
                hintText: '如 gif,svg',
                isDense: true,
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _mb,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: '单张上限 MB',
                hintText: '1–30',
                isDense: true,
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _must,
              decoration: const InputDecoration(
                labelText: '必带内容',
                isDense: true,
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(onPressed: _submit, child: const Text('确定')),
      ],
    );
  }
}
