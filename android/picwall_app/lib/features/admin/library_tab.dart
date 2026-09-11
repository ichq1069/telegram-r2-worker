/// 素材库 Tab：Telegram 文件库 / 共享库 / 私密库三个子视图。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../data/models/admin_file.dart';
import '../../data/models/pool_item.dart';
import '../../data/repositories/gallery_repository.dart';
import '../../services/providers.dart';
import 'level_picker.dart';
import 'library_grid_view.dart';
import 'tag_picker.dart';

enum _LibKind { tele, shared, private }

class LibraryTab extends ConsumerStatefulWidget {
  const LibraryTab({super.key, required this.adminKey});
  final String adminKey;

  @override
  ConsumerState<LibraryTab> createState() => _LibraryTabState();
}

class _LibraryTabState extends ConsumerState<LibraryTab> {
  _LibKind _kind = _LibKind.tele;
  bool _gridMode = true;
  bool _asc = false; // false = 最新优先

  // 列表数据
  List<LibraryEntry> _items = [];
  int _total = 0;
  int _page = 1;
  static const _pageSize = 50;
  bool _loading = false;
  bool _loadingMore = false;
  String _keyword = '';

  // 多选
  final Set<String> _sel = {};
  bool _acting = false;

  final _scrollCtrl = ScrollController();
  final _searchCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _scrollCtrl.addListener(_onScroll);
    WidgetsBinding.instance.addPostFrameCallback((_) => _load(reset: true));
  }

  @override
  void dispose() {
    _scrollCtrl.dispose();
    _searchCtrl.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scrollCtrl.position.pixels >= _scrollCtrl.position.maxScrollExtent - 200 &&
        !_loadingMore &&
        _items.length < _total) {
      _loadMore();
    }
  }

  GalleryRepository get _repo => ref.read(galleryRepositoryProvider);

  // ─── 数据加载 ──────────────────────────────────────────────────────

  Future<void> _load({bool reset = false}) async {
    if (_loading) return;
    if (reset) {
      _page = 1;
      _items = [];
      _total = 0;
    }
    setState(() => _loading = true);
    try {
      final orderBy = _asc ? 'id' : 'id';
      final order = _asc ? 'asc' : 'desc';
      switch (_kind) {
        case _LibKind.tele:
          final (total, records) = await _repo.adminFilesSearch(
            widget.adminKey,
            page: _page,
            pageSize: _pageSize,
            keyword: _keyword,
            state: 'completed',
          );
          if (!mounted) return;
          setState(() {
            _total = total;
            _items = [
              ..._items,
              for (final r in records) LibraryEntry.fromFile(r),
            ];
          });
        case _LibKind.shared:
          final (total, poolItems) = await _repo.adminPoolList(
            widget.adminKey,
            isPrivate: 0,
            keyword: _keyword,
            orderBy: orderBy,
            order: order,
            limit: _pageSize,
            offset: (_page - 1) * _pageSize,
          );
          if (!mounted) return;
          setState(() {
            _total = total;
            _items = [..._items, for (final p in poolItems) LibraryEntry.fromPool(p)];
          });
        case _LibKind.private:
          final (total, poolItems) = await _repo.adminPrivatePoolList(
            widget.adminKey,
            keyword: _keyword,
            limit: _pageSize,
            offset: (_page - 1) * _pageSize,
          );
          if (!mounted) return;
          setState(() {
            _total = total;
            _items = [..._items, for (final p in poolItems) LibraryEntry.fromPool(p)];
          });
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore) return;
    setState(() => _loadingMore = true);
    _page++;
    await _load();
    if (mounted) setState(() => _loadingMore = false);
  }

  // ─── 操作 ──────────────────────────────────────────────────────────

  List<int> get _selIds => [
        for (final k in _sel)
          int.tryParse(k.replaceFirst(RegExp(r'^(pool|file)_'), '')) ?? 0,
      ]..removeWhere((e) => e == 0);

  Future<void> _batchTag() async {
    if (_sel.isEmpty) return;
    final tags = await showTagPicker(context, adminKey: widget.adminKey);
    if (tags == null || !mounted) return;
    setState(() => _acting = true);
    try {
      if (_kind == _LibKind.tele) {
        await _repo.adminFilesTags(widget.adminKey, ids: _selIds, tags: tags);
      } else {
        await _repo.adminPoolTags(widget.adminKey, ids: _selIds, tags: tags);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已为 ${_sel.length} 张设置标签')));
      _sel.clear();
      await _load(reset: true);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _batchLevel() async {
    if (_sel.isEmpty) return;
    final level = await showLevelPicker(context);
    if (level == null || !mounted) return;
    setState(() => _acting = true);
    try {
      await _repo.adminPoolBatch(widget.adminKey, ids: _selIds, level: level);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已为 ${_sel.length} 张设置级别')));
      _sel.clear();
      await _load(reset: true);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _teleToShared() async {
    if (_sel.isEmpty) return;
    setState(() => _acting = true);
    try {
      final r = await _repo.adminPoolFromTg(widget.adminKey, ids: _selIds);
      if (!mounted) return;
      final msg = '已入库 ${r.added} 张${r.duplicated > 0 ? '，跳过 ${r.duplicated} 张已存在' : ''}';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      _sel.clear();
      await _load(reset: true);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _teleToPrivate() async {
    if (_sel.isEmpty) return;
    setState(() => _acting = true);
    try {
      final r = await _repo.adminPrivatePoolFromTg(widget.adminKey, ids: _selIds);
      if (!mounted) return;
      final msg = '已入库私密库 ${r.added} 张${r.duplicated > 0 ? '，跳过 ${r.duplicated} 张已存在' : ''}';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      _sel.clear();
      await _load(reset: true);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _moveToPrivate() async {
    if (_sel.isEmpty) return;
    setState(() => _acting = true);
    try {
      await _repo.adminPoolBatch(widget.adminKey, ids: _selIds, isPrivate: 1);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已将 ${_sel.length} 张转入私密库')));
      _sel.clear();
      await _load(reset: true);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _moveToShared() async {
    if (_sel.isEmpty) return;
    setState(() => _acting = true);
    try {
      await _repo.adminPoolBatch(widget.adminKey, ids: _selIds, isPrivate: 0);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已将 ${_sel.length} 张转入共享库')));
      _sel.clear();
      await _load(reset: true);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _batchDelete() async {
    if (_sel.isEmpty) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('删除 ${_sel.length} 张'),
        content: const Text('确定删除选中条目？此操作不可撤销。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _acting = true);
    try {
      await _repo.adminPoolBatchDelete(widget.adminKey, ids: _selIds);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已删除 ${_sel.length} 张')));
      _sel.clear();
      await _load(reset: true);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  // ─── UI ────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        _buildToolbar(),
        if (_sel.isNotEmpty) _buildActionBar(),
        Expanded(
          child: LibraryGridView(
            entries: _items,
            selected: _sel,
            gridMode: _gridMode,
            loading: _loadingMore,
            scrollController: _scrollCtrl,
            onTap: (e) {},
            onLongPress: (e) {
              setState(() {
                if (_sel.contains(e.key)) {
                  _sel.remove(e.key);
                } else {
                  _sel.add(e.key);
                }
              });
            },
            onSelect: (key, selected) {
              setState(() {
                if (selected) {
                  _sel.add(key);
                } else {
                  _sel.remove(key);
                }
              });
            },
          ),
        ),
      ],
    );
  }

  Widget _buildToolbar() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 4),
      child: Column(
        children: [
          // 子 Tab 切换
          SegmentedButton<_LibKind>(
            segments: const [
              ButtonSegment(value: _LibKind.tele, label: Text('Telegram')),
              ButtonSegment(value: _LibKind.shared, label: Text('共享库')),
              ButtonSegment(value: _LibKind.private, label: Text('私密库')),
            ],
            selected: {_kind},
            onSelectionChanged: (s) {
              setState(() {
                _kind = s.first;
                _sel.clear();
                _keyword = '';
                _searchCtrl.clear();
              });
              _load(reset: true);
            },
            showSelectedIcon: false,
            style: ButtonStyle(
              visualDensity: VisualDensity.compact,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
          ),
          const SizedBox(height: 6),
          // 搜索 + 排序 + 视图切换
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _searchCtrl,
                  decoration: InputDecoration(
                    hintText: _kind == _LibKind.tele ? '搜索文件名…' : '搜索标题/标签…',
                    isDense: true,
                    border: const OutlineInputBorder(),
                    prefixIcon: const Icon(Icons.search, size: 18),
                    suffixIcon: _searchCtrl.text.isNotEmpty
                        ? IconButton(
                            icon: const Icon(Icons.clear, size: 16),
                            onPressed: () {
                              _searchCtrl.clear();
                              setState(() => _keyword = '');
                              _load(reset: true);
                            },
                          )
                        : null,
                  ),
                  onSubmitted: (v) {
                    setState(() => _keyword = v.trim());
                    _load(reset: true);
                  },
                ),
              ),
              if (_kind != _LibKind.tele) ...[
                const SizedBox(width: 6),
                IconButton(
                  tooltip: _asc ? '最旧优先' : '最新优先',
                  icon: Icon(_asc ? Icons.arrow_upward : Icons.arrow_downward, size: 20),
                  onPressed: () {
                    setState(() => _asc = !_asc);
                    _load(reset: true);
                  },
                ),
              ],
              IconButton(
                tooltip: _gridMode ? '列表视图' : '网格视图',
                icon: Icon(_gridMode ? Icons.view_list : Icons.grid_view, size: 20),
                onPressed: () => setState(() => _gridMode = !_gridMode),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildActionBar() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      color: Theme.of(context).colorScheme.primaryContainer,
      child: Row(
        children: [
          Text('已选 ${fmtCount(_sel.length)}',
              style: TextStyle(color: Theme.of(context).colorScheme.onPrimaryContainer)),
          const SizedBox(width: 8),
          TextButton(onPressed: _acting ? null : _batchTag, child: const Text('标签')),
          if (_kind != _LibKind.tele) ...[
            TextButton(onPressed: _acting ? null : _batchLevel, child: const Text('分级')),
            if (_kind == _LibKind.shared)
              TextButton(onPressed: _acting ? null : _moveToPrivate, child: const Text('转私密')),
            if (_kind == _LibKind.private)
              TextButton(onPressed: _acting ? null : _moveToShared, child: const Text('转共享')),
            TextButton(onPressed: _acting ? null : _batchDelete,
                child: Text('删除', style: TextStyle(color: Theme.of(context).colorScheme.error))),
          ],
          if (_kind == _LibKind.tele) ...[
            TextButton(onPressed: _acting ? null : _teleToShared, child: const Text('入库共享')),
            TextButton(onPressed: _acting ? null : _teleToPrivate, child: const Text('入库私密')),
          ],
          const Spacer(),
          TextButton(
            onPressed: () => setState(() => _sel.clear()),
            child: const Text('取消'),
          ),
        ],
      ),
    );
  }
}
