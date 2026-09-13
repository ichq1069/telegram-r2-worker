import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/link_extract.dart';
import '../../data/local/local_db.dart';
import '../../data/models/admin_file.dart';
import '../../data/models/scrape_job.dart';
import '../../services/api_client.dart';
import '../../services/debug_service.dart';
import '../../services/providers.dart';
import '../../services/scrape_lock.dart';
import 'rules_page.dart';
import 'scrape_background.dart';

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
  int seq = 0;
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

  // 链接输入后自动套用域名规则：防抖 + 记录已套用域名，避免重复请求/覆盖。
  Timer? _ruleDebounce;
  String _lastAutoRuleHost = '';

  // 状态
  int _stage = 0; // 0 输入 / 1 候选 / 2 入库
  bool _analyzing = false;
  String? _inputError;
  String _pageTitle = '';
  List<_ScrapeCandidate> _cands = [];
  int _total = 0;
  int _filtered = 0;

  bool _running = false;
  int _done = 0;
  int _added = 0;
  String _progressText = '';

  // 后台入库：任务条目 + 轮询 DB 回显（前台服务在独立 isolate 中执行）
  LocalDb? _db;
  List<_ScrapeCandidate> _runItems = [];
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _urlCtrl.addListener(_onUrlChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) => _boot());
  }

  @override
  void dispose() {
    _ruleDebounce?.cancel();
    _poll?.cancel();
    _urlCtrl.removeListener(_onUrlChanged);
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

  Future<void> _openRuleGroups() async {
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => RulesPage(adminKey: widget.adminKey),
    ));
  }

  /// 一键粘贴：读取剪贴板并自动提取 http(s) 链接，省去手动删除分享文案。
  Future<void> _pasteFromClipboard() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text ?? '';
    if (!mounted) return;
    if (text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('剪贴板没有内容')),
      );
      return;
    }
    final url = extractFirstUrl(text);
    if (url.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('剪贴板里没有找到链接')),
      );
      return;
    }
    setState(() {
      _urlCtrl.text = url;
      _inputError = null;
    });
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('已从剪贴板提取链接')),
    );
  }

  /// 监听链接输入：域名变化后防抖自动套用规则（粘贴/输入分享文案同样生效）。
  void _onUrlChanged() {
    final host = _hostOf(_urlCtrl.text);
    if (host.isEmpty || host == _lastAutoRuleHost) return;
    _ruleDebounce?.cancel();
    _ruleDebounce = Timer(const Duration(milliseconds: 600), () {
      if (!mounted) return;
      _applyDomainRules(auto: true);
    });
  }

  /// 从输入（可能是分享文案）解析出域名；无法解析返回空串。
  String _hostOf(String text) {
    var url = extractFirstUrl(text);
    if (url.isEmpty) url = text.trim();
    if (url.isEmpty) return '';
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://$url';
    }
    return Uri.tryParse(url)?.host ?? '';
  }

  /// 按当前链接域名套用云端规则组（优先精确域名，回退 `*` 默认组）。
  /// [auto] 为 true 时由输入自动触发：静默、按域名去重，不打扰用户。
  Future<void> _applyDomainRules({bool auto = false}) async {
    final host = _hostOf(_urlCtrl.text);
    if (host.isEmpty) {
      if (auto) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('请先输入网页链接')),
      );
      return;
    }
    if (auto) {
      if (host == _lastAutoRuleHost) return;
      // 请求前登记，避免网络抖动/连续输入导致同域名重复请求。
      _lastAutoRuleHost = host;
    }
    try {
      final groups =
          await ref.read(galleryRepositoryProvider).adminRuleGroups(widget.adminKey);
      var g = groups.firstWhere(
        (x) => x.key == host || (host.startsWith('www.') && x.key == host.substring(4)),
        orElse: () => const RuleGroup(key: ''),
      );
      if (g.key.isEmpty) {
        g = groups.firstWhere(
          (x) => x.key == '*',
          orElse: () => const RuleGroup(key: ''),
        );
      }
      if (g.key.isEmpty) {
        if (auto || !mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('云端暂无「$host」规则，可在规则组管理里新建')),
        );
        return;
      }
      if (!mounted) return;
      setState(() {
        _kwCtrl.text = g.kw;
        _extCtrl.text = g.ext;
        _mustCtrl.text = g.must;
        _maxMbCtrl.text = g.mb > 0 ? g.mb.toString() : '';
      });
      if (auto || !mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('已套用「${g.key == '*' ? '默认' : g.key}」规则组'),
      ));
    } catch (e) {
      if (auto || !mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  void _enterDirect(List<String> urls, {String title = ''}) {
    setState(() {
      _pageTitle = title;
      _total = urls.length;
      _filtered = 0;
      _cands = [for (final u in urls) _ScrapeCandidate(u)];
      _inputError = null;
      _stage = 1;
    });
  }

  Future<void> _analyze() async {
    final raw = _urlCtrl.text.trim();
    final all = extractAllUrls(raw);
    if (all.isEmpty) {
      setState(() => _inputError = '未识别到 http(s) 链接，可粘贴网页地址或分享文案');
      return;
    }
    final imgOnes = all.where(isDirectImageUrl).toList();
    if (imgOnes.isNotEmpty && imgOnes.length == all.length) {
      _enterDirect(imgOnes, title: '直链 ${imgOnes.length} 张');
      return;
    }
    final url = all.length == 1
        ? all.first
        : all.firstWhere((u) => !isDirectImageUrl(u), orElse: () => all.first);
    if (url != raw) {
      _urlCtrl.text = url;
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
      final total =
          d['total'] is num ? (d['total'] as num).toInt() : list.length;
      final filtered =
          d['filtered'] is num ? (d['filtered'] as num).toInt() : 0;
      setState(() {
        _pageTitle = (d['title'] ?? '').toString();
        _total = total;
        _filtered = filtered;
        _cands = [for (final u in list) _ScrapeCandidate(u)];
        if (_titleCtrl.text.trim().isEmpty && _pageTitle.isNotEmpty) {
          _titleCtrl.text = _pageTitle;
        }
        if (list.isEmpty) {
          _stage = 0;
          if (filtered > 0) {
            _inputError =
                '解析完成：提取 $total 张，全部被规则过滤（$filtered 张）。请放宽忽略关键词/必带内容/格式后重试';
          } else {
            _inputError =
                '页面未提取到图片。站点可能是动态加载或反爬，可改贴图片直链（每行一条）';
          }
        } else {
          _inputError = null;
          _stage = 1;
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _inputError = normalizeError(e).toString());
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

  /// 打开本地库并恢复未完成的入库任务（后台服务在跑，或进程被杀留下待处理项）。
  Future<void> _boot() async {
    try {
      final db = await ref.read(localDbProvider.future);
      if (!mounted) return;
      _db = db;
      final snap = await db.loadScrapeJob();
      if (snap == null) return;
      var active = await ScrapeLock.activeOrHeal(db);
      if (!active && snap.hasPending) {
        await ScrapeService.resumeIfNeeded();
        active = await ScrapeLock.activeOrHeal(db);
      }
      if (!active && !snap.hasPending) return;
      if (!mounted) return;
      setState(() {
        _runItems = [
          for (final it in snap.items)
            _ScrapeCandidate(it.url)
              ..seq = it.seq
              ..status = it.status == 'pending' ? '' : it.status
              ..reason = it.reason,
        ];
        _done = snap.done;
        _added = snap.added;
        _running = active;
        _progressText =
            active ? '入库中 ${snap.done}/${snap.total} · 成功 ${snap.added}' : '';
        _stage = 2;
      });
      if (active) _startPoll();
    } catch (e, st) {
      DebugService.instance.recordError('ScrapeTab.boot', e, st);
    }
  }

  Future<void> _run() async {
    if (_running) return;
    final selected = [for (final c in _cands) if (c.sel) c];
    if (selected.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('请先勾选要入库的图片')),
      );
      return;
    }
    final title =
        _titleCtrl.text.trim().isEmpty ? _pageTitle : _titleCtrl.text.trim();
    final err = await ScrapeService.startJob(
      title: title,
      urls: [for (final c in selected) c.url],
      tags: _tagsCtrl.text.trim(),
      level: _level,
      ref: _urlCtrl.text.trim(),
      ignoreKw: _kwCtrl.text.trim(),
      ignoreExt: _extCtrl.text.trim(),
      must: _mustCtrl.text.trim(),
      maxMb: _maxMb,
      cookie: _cookie,
    );
    if (!mounted) return;
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
      return;
    }
    setState(() {
      _runItems = [
        for (var i = 0; i < selected.length; i++)
          _ScrapeCandidate(selected[i].url)..seq = i + 1,
      ];
      _done = 0;
      _added = 0;
      _running = true;
      _progressText = '入库中 0/${selected.length} · 成功 0';
      _stage = 2;
    });
    _startPoll();
  }

  Future<void> _resumeJob() async {
    if (_running) return;
    final err = await ScrapeService.resumeJob();
    if (!mounted) return;
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
      return;
    }
    setState(() {
      _running = true;
      _progressText = '正在继续入库…';
    });
    _startPoll();
  }

  void _startPoll() {
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 1), (_) => _pollTick());
  }

  Future<void> _pollTick() async {
    final db = _db;
    if (db == null) return;
    final snap = await db.loadScrapeJob();
    final running = await ScrapeLock.activeOrHeal(db);
    if (!mounted) return;
    if (snap == null) {
      _poll?.cancel();
      setState(() {
        _running = false;
        _progressText = '';
      });
      return;
    }
    final bySeq = <int, ScrapeItem>{for (final it in snap.items) it.seq: it};
    setState(() {
      _running = running;
      _done = snap.done;
      _added = snap.added;
      for (final c in _runItems) {
        final it = bySeq[c.seq];
        if (it == null) continue;
        c.status = it.status == 'pending' ? '' : it.status;
        c.reason = it.reason;
      }
      _progressText = running ? '入库中 ${snap.done}/${snap.total} · 成功 ${snap.added}' : '';
    });
    if (!running) _poll?.cancel();
  }

  Future<void> _cancelRun() => ScrapeService.stopJob();

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
        _field(_urlCtrl, '网页链接', '粘贴网页地址、分享文案，或多条图片直链（每行一条）',
            keyboard: TextInputType.url,
            multiLine: true,
            suffix: IconButton(
              tooltip: '粘贴并提取链接',
              icon: const Icon(Icons.content_paste),
              onPressed: _pasteFromClipboard,
            )),
        _field(_tagsCtrl, '入库标签', '用 , 分隔（如 美女,壁纸）'),
        _field(_maxMbCtrl, '单张上限 MB（留空=服务端默认）', '1–30',
            keyboard: TextInputType.number),
        _field(_kwCtrl, '忽略关键词', '链接含这些词不采集，用 , 分隔'),
        _field(_extCtrl, '忽略格式', '如 gif,webp'),
        _field(_mustCtrl, '必带内容', '链接必须包含的词'),
        _field(_cookieCtrl, 'Cookie（可选，贴吧/需登录站点）', '填登录 Cookie 提高抓取成功率',
            multiLine: true, mono: true),
        if (_inputError != null) ...[
          const SizedBox(height: 8),
          Text(_inputError!,
              style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12)),
        ],
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () => _applyDomainRules(),
                icon: const Icon(Icons.rule, size: 18),
                label: const Text('套用域名规则'),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: _openRuleGroups,
                icon: const Icon(Icons.tune, size: 18),
                label: const Text('规则组管理'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
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
              TextButton(
                onPressed: () {
                  final urls = _cands.where((c) => c.sel).map((c) => c.url).toList();
                  if (urls.isEmpty) return;
                  Clipboard.setData(ClipboardData(text: urls.join('\n')));
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text('已复制 ${urls.length} 条图片地址')),
                  );
                },
                child: const Text('复制地址'),
              ),
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
    for (final c in _runItems) {
      if (c.status.isEmpty) continue;
      stats[c.status] = (stats[c.status] ?? 0) + 1;
    }
    final failed = stats['failed'] ?? 0;
    final pending = _runItems.where((c) => c.status.isEmpty).length;
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
                TextButton(onPressed: _resumeJob, child: const Text('重试失败项'))
              else if (pending > 0)
                TextButton(onPressed: _resumeJob, child: const Text('继续入库')),
            ],
          ),
        ),
        if (_running) const LinearProgressIndicator(minHeight: 3),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.all(8),
            itemCount: _runItems.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (context, i) {
              final c = _runItems[i];
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
                  child: Text('${c.seq}',
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
      {TextInputType? keyboard,
      bool multiLine = false,
      bool mono = false,
      Widget? suffix}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: TextField(
        controller: ctrl,
        keyboardType: keyboard,
        maxLines: multiLine ? 6 : 1,
        style: mono
            ? const TextStyle(fontFamily: 'monospace', fontSize: 12)
            : null,
        decoration: InputDecoration(
          labelText: label,
          hintText: hint,
          isDense: true,
          border: const OutlineInputBorder(),
          suffixIcon: suffix,
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
