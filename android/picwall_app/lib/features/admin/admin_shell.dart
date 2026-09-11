import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../services/providers.dart';
import 'library_tab.dart';
import 'scrape_tab.dart';
import 'trash_tab.dart';

/// 管理模式壳：承载 统计 / 采集 / 素材库 / 回收站 四个运维 Tab。
class AdminShellPage extends ConsumerStatefulWidget {
  const AdminShellPage({super.key, required this.adminKey});

  final String adminKey;

  @override
  ConsumerState<AdminShellPage> createState() => _AdminShellPageState();
}

class _AdminShellPageState extends ConsumerState<AdminShellPage> {
  int _index = 0;

  String get _key => widget.adminKey;

  Future<void> _exit() async {
    await ref.read(settingsControllerProvider).saveAdminKey('');
    if (!mounted) return;
    Navigator.of(context).pop();
  }

  static String _mask(String key) {
    if (key.isEmpty) return '';
    if (key.length <= 4) return '••••';
    return '••••••••${key.substring(key.length - 4)}';
  }

  @override
  Widget build(BuildContext context) {
    final pages = <Widget>[
      StatsTab(adminKey: _key),
      ScrapeTab(adminKey: _key),
      LibraryTab(adminKey: _key),
      TrashTab(adminKey: _key),
    ];
    return Scaffold(
      appBar: AppBar(
        title: const Text('管理后台'),
        actions: [
          Center(
            child: Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Text('主 Key ${_mask(_key)}',
                  style: Theme.of(context).textTheme.bodySmall),
            ),
          ),
          IconButton(
            tooltip: '退出管理',
            icon: const Icon(Icons.logout),
            onPressed: _exit,
          ),
        ],
      ),
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.insert_chart_outlined), label: '统计'),
          NavigationDestination(icon: Icon(Icons.auto_awesome_mosaic_outlined), label: '采集'),
          NavigationDestination(icon: Icon(Icons.library_books_outlined), label: '素材库'),
          NavigationDestination(icon: Icon(Icons.delete_outline), label: '回收站'),
        ],
      ),
    );
  }
}

/// 统计概览：/admin/api/stats 卡片大盘。
class StatsTab extends ConsumerStatefulWidget {
  const StatsTab({super.key, required this.adminKey});

  final String adminKey;

  @override
  ConsumerState<StatsTab> createState() => _StatsTabState();
}

class _StatsTabState extends ConsumerState<StatsTab> {
  Map<String, dynamic>? _stats;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final stats =
          await ref.read(galleryRepositoryProvider).adminStats(widget.adminKey);
      if (mounted) setState(() => _stats = stats);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = _stats;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Expanded(
                        child: Text('存储大盘',
                            style: TextStyle(
                                fontWeight: FontWeight.w700, fontSize: 16)),
                      ),
                      IconButton(
                        tooltip: '刷新',
                        onPressed: _busy ? null : _load,
                        icon: const Icon(Icons.refresh),
                      ),
                    ],
                  ),
                  if (_busy && s == null)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 24),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  else if (s == null)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      child: Text(
                        _error ?? '加载失败',
                        style: TextStyle(color: theme.colorScheme.error, fontSize: 13),
                      ),
                    )
                  else ...[
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        _chip(theme, '文件总数', fmtCount(_i(s, 'total_files'))),
                        _chip(theme, '已完成', fmtCount(_i(s, 'completed_files'))),
                        _chip(theme, '待处理', fmtCount(_i(s, 'unsaved_files'))),
                        _chip(theme, '今日上传', fmtCount(_i(s, 'today_uploads'))),
                        _chip(theme, '本月上传', fmtCount(_i(s, 'month_uploads'))),
                        _chip(theme, '存储', _str(s, 'total_size_formatted', '—')),
                      ],
                    ),
                    if (s['by_type'] is List && (s['by_type'] as List).isNotEmpty) ...[
                      const SizedBox(height: 10),
                      Text('类型分布：${_types(s['by_type'] as List)}',
                          style: TextStyle(
                              fontSize: 12,
                              color: theme.colorScheme.onSurfaceVariant)),
                    ],
                    const SizedBox(height: 6),
                    Text(
                      '精选池：${fmtCount(_i(s, 'pool_total'))} 个'
                      '（启用 ${fmtCount(_i(s, 'pool_enabled'))}'
                      ' · 手动 ${fmtCount(_i(s, 'pool_manual'))}'
                      ' · TG ${fmtCount(_i(s, 'pool_tg'))}）',
                      style: TextStyle(
                          fontSize: 12, color: theme.colorScheme.onSurfaceVariant),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _chip(ThemeData theme, String label, String value) {
    return Container(
      constraints: const BoxConstraints(minWidth: 84),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label,
              style: TextStyle(fontSize: 11, color: theme.colorScheme.onSurfaceVariant)),
          const SizedBox(height: 2),
          Text(value,
              style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
        ],
      ),
    );
  }
}

int _i(Map<String, dynamic> m, String k) {
  final v = m[k];
  return v is num ? v.toInt() : 0;
}

String _str(Map<String, dynamic> m, String k, String fallback) {
  final v = m[k];
  if (v == null) return fallback;
  final s = v.toString();
  return s.isEmpty ? fallback : s;
}

String _types(List list) {
  final parts = <String>[];
  for (final e in list) {
    if (e is Map) {
      final t = (e['file_type'] ?? '').toString();
      final c = e['c'] is num ? (e['c'] as num).toInt() : 0;
      if (t.isNotEmpty) parts.add('$t ×${fmtCount(c)}');
    }
  }
  return parts.isEmpty ? '—' : parts.join('，');
}
