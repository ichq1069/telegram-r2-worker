import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../services/providers.dart';

/// 网页采集：输入链接(可选规则) → 候选缩略图网格(默认全选) → 逐张入库进度。
/// 依赖服务端 /admin/api/scrape/analyze 与 grab_one（忽略规则服务端强校验）。
class ScrapeTab extends ConsumerStatefulWidget {
  const ScrapeTab({super.key, required this.adminKey});

  final String adminKey;

  @override
  ConsumerState<ScrapeTab> createState() => _ScrapeTabState();
}

class _ScrapeCandidate {
  _ScrapeCandidate(this.url);
  final String url;
  bool sel = true;
  String status = '';
  String reason = '';
}

class _ScrapeTabState extends ConsumerState<ScrapeTab> {
  static const _levels = [
    ('pt', '基础'),
    ('vip', 'VIP'),
    ('svip', 'SVIP'),
    ('vvip', 'VVIP 私密'),
  ];

  // 输入参数
  final _urlCtrl = TextEditingController();
  final _cookieCtrl = TextEditingController();
  final _tagsCtrl = TextEditingController();
  final _kwCtrl = TextEditingController();
  final _extCtrl = TextEditingController();
  final _mustCtrl = TextEditingController();
  final _maxMbCtrl = TextEditingController();
  final _titleCtrl = TextEditingController();
  String _level = 'pt';

  // 状态
  int _stage = 0; // 0 输入 / 1 候选 / 2 入库
  bool _analyzing = false;
  String? _inputError;
  String _pageTitle = '';
  List<_ScrapeCandidate> _cands = [];
  int _total = 0;
  int _filtered = 0;

  bool _running = false;
  bool _stop = false;
  int _done = 0;
  int _added = 0;
  String _progressText = '';

  @override
  void dispose() {
    _urlCtrl.dispose();
    _cookieCtrl.dispose();
    _tagsCtrl.dispose();
    _kwCtrl.dispose();
    _extCtrl.dispose();
    _mustCtrl.dispose();
    _maxMbCtrl.dispose();
    _titleCtrl.dispose();
    super.dispose();
  }

  int? get _maxMb {
    final t = _maxMbCtrl.text.trim();
    if (t.isEmpty) return null;
    final v = int.tryParse(t);
    if (v == null || v < 1 || v > 30) return null;
    return v;
  }

  String get _cookie => _cookieCtrl.text.trim();

  Future<void> _analyze() async {
    final url = _urlCtrl.text.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      setState(() => _inputError = '请输入 http(s) 链接');
      return;
    }
    setState(() {
      _analyzing = true;
      _inputError = null;
    });
    try {
      final d = await ref.read(galleryRepositoryProvider).adminScrapeAnalyze(
            widget.adminKey,
            url: url,
            cookie: _cookie,
            ignoreKw: _kwCtrl.text.trim(),
            ignoreExt: _extCtrl.text.trim(),
            must: _mustCtrl.text.trim(),
          );
      if (!mounted) return;
      final rawImages = d['images'];
      final list = <String>[];
      if (rawImages is List) {
        for (final e in rawImages) {
          final s = e?.toString() ?? '';
          if (s.isNotEmpty) list.add(s);
        }
      }
      setState(() {
        _pageTitle = (d['title'] ?? '').toString();
        _total = d['total'] is num ? (d['total'] as num).toInt() : list.length;
        _filtered = d['filtered'] is num ? (d['filtered'] as num).toInt() : 0;
        _cands = [for (final u in list) _ScrapeCandidate(u)];
        if (_titleCtrl.text.trim().isEmpty && _pageTitle.isNotEmpty) {
          _titleCtrl.text = _pageTitle;
        }
        _stage = list.isEmpty ? 0 : 1;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _inputError = e.toString());
    } finally {
      if (mounted) setState(() => _analyzing = false);
    }
  }

  void _toggleAll(bool on) {
    setState(() {
      for (final c in _cands) {
        c.sel = on;
      }
    });
  }

  int get _selCount => _cands.where((c) => c.sel).length;

  Future<void> _run({bool onlyFailed = false}) async {
    if (_running) return;
    final selected = <int>[];
    for (var i = 0; i < _cands.length; i++) {
      final c = _cands[i];
      if (!c.sel) continue;
      if (onlyFailed && c.status != 'failed') continue;
      selected.add(i);
    }
    if (selected.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(onlyFailed ? '没有失败项' : '请先勾选要入库的图片')),
      );
      return;
    }
    if (!onlyFailed) {
      // 重置本轮全部选中项状态
      for (final i in selected) {
        _cands[i].status = '';
        _cands[i].reason = '';
      }
    }
    final repo = ref.read(galleryRepositoryProvider);
    final tags = _tagsCtrl.text.trim();
    final title = _titleCtrl.text.trim().isEmpty ? _pageTitle : _titleCtrl.text.trim();
    final ref_ = _urlCtrl.text.trim();
    final maxMb = _maxMb;
    setState(() {
      _running = true;
      _stop = false;
      _done = 0;
      _added = 0;
      _stage = 2;
    });
    for (final i in selected) {
      if (_stop || !mounted) break;
      final c = _cands[i];
      setState(() => _progressText = '正在入库 ${_done + 1}/${selected.length}…');
      try {
        final r = await repo.adminScrapeGrabOne(
          widget.adminKey,
          url: c.url,
          title: title,
          tags: tags,
          level: _level,
          ref: ref_,
          ignoreKw: _kwCtrl.text.trim(),
          ignoreExt: _extCtrl.text.trim(),
          must: _mustCtrl.text.trim(),
          maxMb: maxMb,
          cookie: _cookie,
          seq: i + 1,
        );
        if (!mounted) return;
        setState(() {
          c.status = r.status;
          c.reason = r.reason;
          if (r.status == 'added') _added++;
        });
      } catch (e) {
        if (!mounted) return;
        setState(() {
          c.status = 'failed';
          c.reason = e.toString();
        });
      } finally {
        if (mounted) setState(() => _done++);
      }
    }
    if (!mounted) return;
    setState(() {
      _running = false;
      _progressText = '';
    });
  }

  void _cancelRun() {
    setState(() => _stop = true);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        if (_stage > 0)
          _Stepper(onStep: (s) => setState(() => _stage = s), current: _stage),
        Expanded(child: switch (_stage) {
          0 => _buildInput(),
          1 => _buildGrid(),
          _ => _buildRun(),
        }),
      ],
    );
  }

  Widget _buildInput() {
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: Text('入库级别',
              style: Theme.of(context).textTheme.bodySmall),
        ),
        const SizedBox(height: 4),
        SegmentedButton<String>(
          segments: [
            for (final l in _levels)
              ButtonSegment(value: l.$1, label: Text(l.$2)),
          ],
          selected: {_level},
          onSelectionChanged: (s) => setState(() => _level = s.first),
          showSelectedIcon: false,
        ),
        const SizedBox(height: 10),
        _field(_urlCtrl, '网页链接', 'https://…（文章/相册/帖子页）', keyboard: TextInputType.url),
        _field(_tagsCtrl, '入库标签', '用 , 分隔（如 美女,壁纸）'),
        _field(_maxMbCtrl, '单张上限 MB（留空=服务端默认）', '1–30',
            keyboard: TextInputType.number),
        _field(_kwCtrl, '忽略关键词', '链接含这些词不采集，用 , 分隔'),
        _field(_extCtrl, '忽略格式', '如 gif,webp'),
        _field(_mustCtrl, '必带内容', '链接必须包含的词'),
        _field(_cookieCtrl, 'Cookie（可选，贴吧/需登录站点）', '填登录 Cookie 提高抓取成功率',
            multiLine: 2, mono: true),
        if (_inputError != null) ...[
          const SizedBox(height: 8),
          Text(_inputError!,
              style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12)),
        ],
        const SizedBox(height: 14),
        FilledButton.icon(
          onPressed: _analyzing ? null : _analyze,
          icon: _analyzing
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.travel_explore),
          label: const Text('解析页面'),
        ),
      ],
    );
  }

  Widget _buildGrid() {
    final theme = Theme.of(context);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  '${_pageTitle.isEmpty ? '页面' : _pageTitle}'
                  '\n共 ${fmtCount(_total)} · 过滤 ${fmtCount(_filtered)} · 选中 ${fmtCount(_selCount)}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall,
                ),
              ),
              TextButton(onPressed: () => _toggleAll(true), child: const Text('全选')),
              TextButton(onPressed: () => _toggleAll(false), child: const Text('全不选')),
            ],
          ),
        ),
        Expanded(
          child: GridView.builder(
            padding: const EdgeInsets.all(8),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 120,
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
            ),
            itemCount: _cands.length,
            itemBuilder: (context, i) {
              final c = _cands[i];
              return GestureDetector(
                onTap: () => setState(() => c.sel = !c.sel),
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Image.network(
                        c.url,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => ColoredBox(
                          color: theme.colorScheme.surfaceContainerHighest,
                          child: const Icon(Icons.broken_image_outlined),
                        ),
                      ),
                    ),
                    Positioned(
                      right: 4,
                      top: 4,
                      child: Checkbox(
                        value: c.sel,
                        onChanged: (_) => setState(() => c.sel = !c.sel),
                      ),
                    ),
                    Positioned(
                      left: 4,
                      bottom: 4,
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: Colors.black54,
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text('${i + 1}',
                            style: const TextStyle(fontSize: 11, color: Colors.white)),
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _selCount == 0
                    ? null
                    : () => _run(),
                icon: const Icon(Icons.cloud_upload_outlined),
                label: Text('开始入库（${fmtCount(_selCount)} 张）'),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildRun() {
    final theme = Theme.of(context);
    final stats = <String, int>{};
    for (final c in _cands) {
      if (!c.sel || c.status.isEmpty) continue;
      stats[c.status] = (stats[c.status] ?? 0) + 1;
    }
    final failed = stats['failed'] ?? 0;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 6, 12, 4),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  _running
                      ? _progressText
                      : '完成 ${fmtCount(_done)} · 成功 ${fmtCount(_added)}'
                          '${failed > 0 ? ' · 失败 ${fmtCount(failed)}' : ''}',
                  style: theme.textTheme.bodySmall,
                ),
              ),
              if (_running)
                TextButton(onPressed: _cancelRun, child: const Text('停止'))
              else if (failed > 0)
                TextButton(
                  onPressed: () => _run(onlyFailed: true),
                  child: const Text('重试失败项'),
                ),
            ],
          ),
        ),
        if (_running) const LinearProgressIndicator(minHeight: 3),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.all(8),
            itemCount: _cands.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (context, i) {
              final c = _cands[i];
              if (!c.sel) return const SizedBox.shrink();
              final (label, color) = switch (c.status) {
                'added' => ('已入库', Colors.lightGreen),
                'exists' => ('已存在', Colors.lightBlue),
                'ignored' => ('已忽略', Colors.grey),
                'failed' => ('失败', theme.colorScheme.error),
                _ => ('等待', theme.colorScheme.outline),
              };
              return ListTile(
                dense: true,
                leading: SizedBox(
                  width: 30,
                  child: Text('${i + 1}',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: theme.colorScheme.onSurfaceVariant)),
                ),
                title: Text(c.url,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12)),
                subtitle: c.reason.isEmpty
                    ? null
                    : Text(c.reason,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 11)),
                trailing: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(label,
                      style: TextStyle(
                          color: color, fontSize: 11, fontWeight: FontWeight.w700)),
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _field(TextEditingController ctrl, String label, String hint,
      {TextInputType? keyboard, bool multiLine = false, bool mono = false}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: TextField(
        controller: ctrl,
        keyboardType: keyboard,
        maxLines: multiLine ? 3 : 1,
        style: mono
            ? const TextStyle(fontFamily: 'monospace', fontSize: 12)
            : null,
        decoration: InputDecoration(
          labelText: label,
          hintText: hint,
          isDense: true,
          border: const OutlineInputBorder(),
        ),
      ),
    );
  }
}

/// 采集阶段选择与顶部级别选择。
class _Stepper extends StatelessWidget {
  const _Stepper({required this.current, required this.onStep});

  final int current;
  final void Function(int) onStep;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    const labels = ['链接与规则', '选择图片', '入库进度'];
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
      child: Row(
        children: [
          for (var i = 0; i < labels.length; i++) ...[
            if (i > 0)
              Expanded(
                child: Divider(
                  height: 1,
                  thickness: 2,
                  color: i <= current
                      ? theme.colorScheme.primary
                      : theme.colorScheme.outlineVariant,
                ),
              ),
            GestureDetector(
              onTap: i < current ? () => onStep(i) : null,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  CircleAvatar(
                    radius: 12,
                    backgroundColor: i <= current
                        ? theme.colorScheme.primary
                        : theme.colorScheme.surfaceContainerHighest,
                    child: Text('${i + 1}',
                        style: TextStyle(
                            fontSize: 12,
                            color: i <= current
                                ? theme.colorScheme.onPrimary
                                : theme.colorScheme.onSurfaceVariant)),
                  ),
                  const SizedBox(height: 2),
                  Text(labels[i],
                      style: TextStyle(
                          fontSize: 10,
                          color: i == current
                              ? theme.colorScheme.primary
                              : theme.colorScheme.onSurfaceVariant)),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
