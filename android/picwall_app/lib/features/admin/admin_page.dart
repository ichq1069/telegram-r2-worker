import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../services/api_client.dart';
import '../../services/providers.dart';

/// 管理员后台（隐藏入口：我的页连续点击 5 次版本号进入）。
///
/// 校验规则与 worker 一致：`api_key === env.API_KEY`（master API key），
/// 通过后展示 `GET /admin/api/stats` 大盘；采集/回收/仓储等模块后续迭代接入。
class AdminPage extends ConsumerStatefulWidget {
  const AdminPage({super.key});

  @override
  ConsumerState<AdminPage> createState() => _AdminPageState();
}

class _AdminPageState extends ConsumerState<AdminPage> {
  final _keyCtrl = TextEditingController();
  bool _busy = false;
  String? _error;
  Map<String, dynamic>? _stats;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final key = ref.read(settingsControllerProvider).settings.adminKey;
      if (key.isNotEmpty) {
        _verify(key);
      }
    });
  }

  @override
  void dispose() {
    _keyCtrl.dispose();
    super.dispose();
  }

  Future<void> _verify(String key) async {
    if (_busy || key.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final stats = await ref.read(galleryRepositoryProvider).adminStats(key);
      await ref.read(settingsControllerProvider).saveAdminKey(key);
      if (!mounted) return;
      setState(() => _stats = stats);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = normalizeError(e).toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _exit() async {
    await ref.read(settingsControllerProvider).saveAdminKey('');
    if (!mounted) return;
    setState(() {
      _stats = null;
      _error = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsControllerProvider).settings;
    final configured = settings.adminKey.isNotEmpty;
    return Scaffold(
      appBar: AppBar(title: const Text('管理员后台')),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          if (!configured)
            _GateCard(
              busy: _busy,
              error: _error,
              controller: _keyCtrl,
              onVerify: () => _verify(_keyCtrl.text.trim()),
            )
          else ...[
            _ModeCard(
              mask: _mask(settings.adminKey),
              onExit: _exit,
            ),
            const SizedBox(height: 12),
            _StatsCard(
              stats: _stats,
              busy: _busy,
              error: _error,
              onRefresh: () => _verify(settings.adminKey),
            ),
          ],
        ],
      ),
    );
  }

  static String _mask(String key) {
    if (key.isEmpty) return '';
    if (key.length <= 4) return '••••';
    return '••••••••${key.substring(key.length - 4)}';
  }
}

class _GateCard extends StatelessWidget {
  const _GateCard({
    required this.busy,
    required this.error,
    required this.controller,
    required this.onVerify,
  });

  final bool busy;
  final String? error;
  final TextEditingController controller;
  final VoidCallback onVerify;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('管理模式',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
            const SizedBox(height: 6),
            const Text('输入服务器主 API Key（env.API_KEY）以开启管理后台。',
                style: TextStyle(fontSize: 13)),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              obscureText: true,
              autofocus: false,
              decoration: const InputDecoration(
                labelText: '主 API Key',
                hintText: 'sk_ 开头的服务器主密钥',
                isDense: true,
                border: OutlineInputBorder(),
              ),
              onSubmitted: (_) => onVerify(),
            ),
            if (error != null) ...[
              const SizedBox(height: 8),
              Text(error!,
                  style: TextStyle(color: theme.colorScheme.error, fontSize: 12)),
            ],
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: busy ? null : onVerify,
                icon: busy
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.admin_panel_settings_outlined),
                label: const Text('验证并进入'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ModeCard extends StatelessWidget {
  const _ModeCard({required this.mask, required this.onExit});

  final String mask;
  final VoidCallback onExit;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: ListTile(
        leading: Icon(Icons.verified_user_outlined, color: theme.colorScheme.primary),
        title: const Text('管理模式已开启'),
        subtitle: Text('主 Key：$mask'),
        trailing: TextButton(
          onPressed: onExit,
          child: Text('退出', style: TextStyle(color: theme.colorScheme.error)),
        ),
      ),
    );
  }
}

class _StatsCard extends StatelessWidget {
  const _StatsCard({
    required this.stats,
    required this.busy,
    required this.error,
    required this.onRefresh,
  });

  final Map<String, dynamic>? stats;
  final bool busy;
  final String? error;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = stats;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Expanded(
                  child: Text('存储大盘',
                      style:
                          TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                ),
                IconButton(
                  tooltip: '刷新',
                  onPressed: busy ? null : onRefresh,
                  icon: const Icon(Icons.refresh),
                ),
              ],
            ),
            if (busy && s == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (s == null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text(
                  error ?? '加载失败',
                  style: TextStyle(color: theme.colorScheme.error, fontSize: 13),
                ),
              )
            else ...[
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  _StatChip(label: '文件总数', value: _nf(_int(s, 'total_files'))),
                  _StatChip(label: '已完成', value: _nf(_int(s, 'completed_files'))),
                  _StatChip(label: '待处理', value: _nf(_int(s, 'unsaved_files'))),
                  _StatChip(label: '今日上传', value: _nf(_int(s, 'today_uploads'))),
                  _StatChip(label: '本月上传', value: _nf(_int(s, 'month_uploads'))),
                  _StatChip(label: '存储', value: _str(s, 'total_size_formatted', '—')),
                ],
              ),
              if (s['by_type'] is List && (s['by_type'] as List).isNotEmpty) ...[
                const SizedBox(height: 10),
                Text('类型分布：${_typeText(s['by_type'] as List)}',
                    style: TextStyle(fontSize: 12, color: theme.colorScheme.onSurfaceVariant)),
              ],
              const SizedBox(height: 6),
              Text(
                '精选池：${_nf(_int(s, 'pool_total'))} 个（启用 ${_nf(_int(s, 'pool_enabled'))}'
                ' · 手动 ${_nf(_int(s, 'pool_manual'))} · TG ${_nf(_int(s, 'pool_tg'))}）',
                style: TextStyle(fontSize: 12, color: theme.colorScheme.onSurfaceVariant),
              ),
              const SizedBox(height: 10),
              Text(
                '采集 / 回收站 / R2 仓储等运维模块将在后续版本上线。',
                style: TextStyle(fontSize: 12, color: theme.colorScheme.outline),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _StatChip extends StatelessWidget {
  const _StatChip({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      constraints: const BoxConstraints(minWidth: 84),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
          const SizedBox(height: 2),
          Text(value,
              style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
        ],
      ),
    );
  }
}

int _int(Map<String, dynamic> m, String k) {
  final v = m[k];
  if (v is num) return v.toInt();
  return 0;
}

String _str(Map<String, dynamic> m, String k, String fallback) {
  final v = m[k];
  if (v == null) return fallback;
  if (v is String) return v.isEmpty ? fallback : v;
  return v.toString();
}

String _typeText(List list) {
  final parts = <String>[];
  for (final e in list) {
    if (e is Map) {
      final t = (e['file_type'] ?? '').toString();
      final c = e['c'] is num ? (e['c'] as num).toInt() : 0;
      if (t.isNotEmpty) parts.add('$t ×${_nf(c)}');
    }
  }
  return parts.isEmpty ? '—' : parts.join('，');
}

String _nf(int n) {
  final s = n.toString();
  final buf = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    final fromEnd = s.length - i;
    buf.write(s[i]);
    if (fromEnd > 1 && (fromEnd - 1) % 3 == 0) buf.write(',');
  }
  return buf.toString();
}
