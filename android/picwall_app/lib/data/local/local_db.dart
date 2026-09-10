import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import '../models/album_sync_state.dart';
import '../models/media_item.dart';
import '../models/scrape_job.dart';
import '../models/sync_filter.dart';
import '../models/upload_task.dart';

/// 本地条目（收藏/历史），media 存归一化 JSON。
class LocalEntry {
  const LocalEntry({
    required this.item,
    required this.key,
    this.updatedAt,
  });

  final MediaItem item;
  final String key;
  final DateTime? updatedAt;
}

/// 本地库：收藏 + 浏览历史。
///
/// 采用 sqflite（手写 SQL，无需 codegen）。表按条目去重键（fileType:id / url）
/// 作为主键：同一内容重复操作会覆盖更新而不产生脏数据。
class LocalDb {
  LocalDb._(this._db);

  final Database _db;

  static const String _dbName = 'picwall_local.db';
  static Database? _open;

  static Future<LocalDb> open() async {
    if (_open != null) return LocalDb._(_open!);
    final path = '${await getDatabasesPath()}/$_dbName';
    final db = await openDatabase(
      path,
      version: 5,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE favorites(
            key TEXT PRIMARY KEY,
            media TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          )
        ''');
        await db.execute('''
          CREATE TABLE history(
            key TEXT PRIMARY KEY,
            media TEXT NOT NULL,
            viewed_at INTEGER NOT NULL
          )
        ''');
        await _createUploadQueue(db);
        await _createSyncTables(db);
        await _createSyncV4Tables(db);
        await _createScrapeTables(db);
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await _createUploadQueue(db);
        }
        if (oldVersion < 3) {
          await _createSyncTables(db);
        }
        if (oldVersion < 4) {
          await _createSyncV4Tables(db);
        }
        if (oldVersion < 5) {
          await _createScrapeTables(db);
        }
      },
    );
    _open = db;
    return LocalDb._(db);
  }

  static String keyOf(MediaItem item) => item.dedupeKey;

  // ---------------- 收藏 ----------------

  Future<void> favorite(MediaItem item) async {
    await _db.insert('favorites', {
      'key': keyOf(item),
      'media': jsonEncode(item.toJson()),
      'updated_at': DateTime.now().millisecondsSinceEpoch,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<void> unfavorite(String key) async {
    await _db.delete('favorites', where: 'key = ?', whereArgs: [key]);
  }

  Future<bool> isFavorited(String key) async {
    final rows = await _db.query(
      'favorites',
      columns: ['key'],
      where: 'key = ?',
      whereArgs: [key],
      limit: 1,
    );
    return rows.isNotEmpty;
  }

  /// 收藏列表，新→旧。
  Future<List<LocalEntry>> listFavorites() async {
    final rows = await _db.query('favorites', orderBy: 'updated_at DESC');
    return _rowsToEntries(rows, 'updated_at');
  }

  Future<void> clearFavorites() async {
    await _db.delete('favorites');
  }

  // ---------------- 历史 ----------------

  Future<void> record(MediaItem item) async {
    await _db.insert('history', {
      'key': keyOf(item),
      'media': jsonEncode(item.toJson()),
      'viewed_at': DateTime.now().millisecondsSinceEpoch,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<List<LocalEntry>> listHistory({int limit = 200}) async {
    final rows = await _db.query(
      'history',
      orderBy: 'viewed_at DESC',
      limit: limit,
    );
    return _rowsToEntries(rows, 'viewed_at');
  }

  Future<void> clearHistory() async {
    await _db.delete('history');
  }

  Future<void> clearHistoryKey(String key) async {
    await _db.delete('history', where: 'key = ?', whereArgs: [key]);
  }

  // ---------------- 上传队列 ----------------

  static Future<void> _createUploadQueue(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS upload_queue(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        tags TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      )
    ''');
  }

  Future<int> insertUploadTask(UploadTask task) async {
    return _db.insert('upload_queue', task.toDb());
  }

  Future<void> updateUploadTask(UploadTask task) async {
    final id = task.id;
    if (id == null) return;
    final data = task.toDb()..remove('id');
    await _db.update(
      'upload_queue',
      data,
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  Future<void> deleteUploadTask(int id) async {
    await _db.delete('upload_queue', where: 'id = ?', whereArgs: [id]);
  }

  /// 未完成任务（queued/uploading/failed 且文件仍存在），old→new。
  Future<List<UploadTask>> listPendingUploads() async {
    final rows = await _db.query(
      'upload_queue',
      orderBy: 'created_at ASC',
    );
    final tasks = rows.map((r) => UploadTask.fromDb(r)).toList();
    return tasks.where((t) => t.state != UploadState.done).toList();
  }

  // ---------------- 相册同步 ----------------

  static Future<void> _createSyncTables(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS sync_state(
        album_id TEXT PRIMARY KEY,
        album_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        cursor TEXT,
        last_sync INTEGER,
        synced_count INTEGER NOT NULL DEFAULT 0
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS synced_assets(
        asset_id TEXT PRIMARY KEY,
        uploaded_at INTEGER NOT NULL
      )
    ''');
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_synced_assets_id ON synced_assets(asset_id)');
  }

  Future<void> saveAlbumSync(AlbumSyncState state) async {
    await _db.insert('sync_state', state.toDb(),
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  /// 将某相册设为唯一启用的同步相册（其它全部停用）。
  Future<void> setEnabledAlbum(String albumId, String albumName) async {
    await _db.update('sync_state', {'enabled': 0});
    await _db.insert(
      'sync_state',
      AlbumSyncState(albumId: albumId, albumName: albumName, enabled: true)
          .toDb(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<void> disableAllSyncAlbums() async {
    await _db.update('sync_state', {'enabled': 0});
  }

  Future<AlbumSyncState?> getEnabledAlbum() async {
    final rows = await _db.query(
      'sync_state',
      where: 'enabled = 1',
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return AlbumSyncState.fromDb(rows.first);
  }

  Future<AlbumSyncState?> getAlbumSync(String albumId) async {
    final rows = await _db.query(
      'sync_state',
      where: 'album_id = ?',
      whereArgs: [albumId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return AlbumSyncState.fromDb(rows.first);
  }

  Future<void> updateAlbumSyncProgress(
    String albumId, {
    String? cursorAssetId,
    int syncedCount = 0,
    bool updateLastSync = false,
  }) async {
    final state = await getAlbumSync(albumId);
    if (state == null) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    await _db.update(
      'sync_state',
      {
        'cursor': cursorAssetId ?? state.cursorAssetId,
        'synced_count': state.syncedCount + syncedCount,
        'last_sync': updateLastSync ? now : state.lastSync?.millisecondsSinceEpoch,
      },
      where: 'album_id = ?',
      whereArgs: [albumId],
    );
  }

  Future<void> markAssetSynced(String assetId) async {
    await _db.insert(
      'synced_assets',
      {'asset_id': assetId, 'uploaded_at': DateTime.now().millisecondsSinceEpoch},
      conflictAlgorithm: ConflictAlgorithm.ignore,
    );
  }

  Future<bool> isAssetSynced(String assetId) async {
    final rows = await _db.query(
      'synced_assets',
      columns: ['asset_id'],
      where: 'asset_id = ?',
      whereArgs: [assetId],
      limit: 1,
    );
    return rows.isNotEmpty;
  }

  /// 一次取出所有已同步 asset id（用于一轮扫描的去重集合）。
  Future<Set<String>> loadAllSyncedAssetIds() async {
    final rows = await _db.query('synced_assets', columns: ['asset_id']);
    return rows.map((r) => (r['asset_id'] as String?) ?? '').where((s) => s.isNotEmpty).toSet();
  }

  // ---------------- 同步筛选与运行元信息（v4） ----------------

  static Future<void> _createSyncV4Tables(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS sync_filter(
        row_id INTEGER PRIMARY KEY,
        min_bytes INTEGER NOT NULL DEFAULT 0,
        max_bytes INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'both',
        exts TEXT NOT NULL DEFAULT ''
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS sync_meta(
        key TEXT PRIMARY KEY,
        value TEXT
      )
    ''');
  }

  Future<void> saveSyncFilter(SyncFilter filter) async {
    await _db.insert('sync_filter', filter.toDb(),
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<SyncFilter> loadSyncFilter() async {
    final rows = await _db.query('sync_filter', limit: 1);
    if (rows.isEmpty) return const SyncFilter();
    return SyncFilter.fromDb(rows.first);
  }

  Future<String?> syncMeta(String key) async {
    final rows = await _db.query('sync_meta',
        columns: ['value'], where: 'key = ?', whereArgs: [key], limit: 1);
    if (rows.isEmpty) return null;
    return rows.first['value'] as String?;
  }

  Future<void> setSyncMeta(String key, String value) async {
    await _db.insert('sync_meta', {'key': key, 'value': value},
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<void> delSyncMeta(String key) async {
    await _db.delete('sync_meta', where: 'key = ?', whereArgs: [key]);
  }

  /// 同步前台服务运行锁（防止主进程引擎与后台服务同时上传）。
  Future<void> setSyncRunning(bool running) async {
    if (running) {
      await setSyncMeta('sync_running', '1');
      await setSyncMeta(
          'sync_started_at', DateTime.now().millisecondsSinceEpoch.toString());
    } else {
      await delSyncMeta('sync_running');
      await delSyncMeta('sync_started_at');
    }
  }

  /// 服务正在运行（超过 10 分钟的陈旧锁视为已死并自动清除）。
  Future<bool> isSyncRunning() async {
    final v = await syncMeta('sync_running');
    if (v != '1') return false;
    final started = int.tryParse(await syncMeta('sync_started_at') ?? '0') ?? 0;
    final ageMs = DateTime.now().millisecondsSinceEpoch - started;
    if (ageMs > 10 * 60 * 1000) {
      await setSyncRunning(false);
      return false;
    }
    return true;
  }

  /// 队列状态聚合（同步/上传状态页轮询用）。
  Future<QueueSnapshot> queueSnapshot() async {
    var queued = 0, uploading = 0, done = 0, failed = 0;
    final rows = await _db.rawQuery(
        'SELECT state, COUNT(*) AS c FROM upload_queue GROUP BY state');
    for (final r in rows) {
      final c = ((r['c'] as num?) ?? 0).toInt();
      switch (r['state']) {
        case 'queued':
          queued = c;
          break;
        case 'uploading':
          uploading = c;
          break;
        case 'done':
          done = c;
          break;
        case 'failed':
          failed = c;
          break;
      }
    }
    return QueueSnapshot(
        queued: queued, uploading: uploading, done: done, failed: failed);
  }

  // ---------------- 采集入库后台任务（v5） ----------------

  static Future<void> _createScrapeTables(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS scrape_job(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        level TEXT NOT NULL DEFAULT 'pt',
        ref TEXT NOT NULL DEFAULT '',
        ignore_kw TEXT NOT NULL DEFAULT '',
        ignore_ext TEXT NOT NULL DEFAULT '',
        must TEXT NOT NULL DEFAULT '',
        max_mb INTEGER,
        cookie TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'running'
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS scrape_item(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT NOT NULL DEFAULT '',
        updated_at INTEGER
      )
    ''');
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_scrape_item_job ON scrape_item(job_id)');
  }

  /// 建立一次新的采集入库任务：清空旧任务与条目，写入任务参数与全部待入库 URL。
  /// 返回新任务 id。
  Future<int> createScrapeJob(ScrapeJob job, List<String> urls) async {
    return _db.transaction((txn) async {
      await txn.delete('scrape_item');
      await txn.delete('scrape_job');
      final jobId = await txn.insert('scrape_job', job.toDb());
      for (var i = 0; i < urls.length; i++) {
        await txn.insert('scrape_item', {
          'job_id': jobId,
          'seq': i + 1,
          'url': urls[i],
          'status': 'pending',
          'reason': '',
        });
      }
      return jobId;
    });
  }

  /// 读取当前（最新）任务及全部条目；无任务返回 null。
  Future<ScrapeJobSnapshot?> loadScrapeJob() async {
    final jobs = await _db.query('scrape_job', orderBy: 'id DESC', limit: 1);
    if (jobs.isEmpty) return null;
    final job = ScrapeJob.fromDb(jobs.first);
    final rows = await _db.query(
      'scrape_item',
      where: 'job_id = ?',
      whereArgs: [job.id],
      orderBy: 'seq ASC',
    );
    return ScrapeJobSnapshot(
      job: job,
      items: [for (final r in rows) ScrapeItem.fromDb(r)],
    );
  }

  Future<void> updateScrapeItemStatus(int id, String status, String reason) async {
    await _db.update(
      'scrape_item',
      {
        'status': status,
        'reason': reason,
        'updated_at': DateTime.now().millisecondsSinceEpoch,
      },
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  /// 将当前任务的失败项重置为待入库（对应界面“重试失败项”）。
  Future<void> resetFailedScrapeItems() async {
    final jobs = await _db.query('scrape_job', orderBy: 'id DESC', limit: 1);
    if (jobs.isEmpty) return;
    final jobId = jobs.first['id'];
    await _db.update(
      'scrape_item',
      {'status': 'pending', 'reason': '', 'updated_at': null},
      where: "job_id = ? AND status = 'failed'",
      whereArgs: [jobId],
    );
    await _db.update(
      'scrape_job',
      {'state': 'running'},
      where: 'id = ?',
      whereArgs: [jobId],
    );
  }

  Future<void> setScrapeJobState(int id, String state) async {
    await _db.update(
      'scrape_job',
      {'state': state},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  /// 是否存在可续跑的未完成任务（任务运行中、仍有待入库项且未请求停止）。
  Future<bool> hasPendingScrapeJob() async {
    if (await scrapeStopRequested()) return false;
    final rows = await _db.rawQuery(
      "SELECT COUNT(*) AS c FROM scrape_item i JOIN scrape_job j ON j.id = i.job_id "
      "WHERE j.state = 'running' AND i.status = 'pending'",
    );
    return (((rows.first['c'] as num?) ?? 0).toInt()) > 0;
  }

  /// 是否存在运行中的采集任务（用于与相册同步互斥）。
  Future<bool> hasActiveScrapeJob() async {
    final rows = await _db
        .rawQuery("SELECT COUNT(*) AS c FROM scrape_job WHERE state = 'running'");
    return (((rows.first['c'] as num?) ?? 0).toInt()) > 0;
  }

  Future<void> clearScrapeJob() async {
    await _db.transaction((txn) async {
      await txn.delete('scrape_item');
      await txn.delete('scrape_job');
    });
  }

  /// 采集前台服务运行锁（与相册同步同理，跨 isolate 互斥）。
  Future<void> setScrapeRunning(bool running) async {
    if (running) {
      await setSyncMeta('scrape_running', '1');
      await setSyncMeta(
          'scrape_started_at', DateTime.now().millisecondsSinceEpoch.toString());
    } else {
      await delSyncMeta('scrape_running');
      await delSyncMeta('scrape_started_at');
    }
  }

  /// 服务正在运行（超过 10 分钟的陈旧锁视为已死并自动清除）。
  Future<bool> isScrapeRunning() async {
    final v = await syncMeta('scrape_running');
    if (v != '1') return false;
    final started = int.tryParse(await syncMeta('scrape_started_at') ?? '0') ?? 0;
    final ageMs = DateTime.now().millisecondsSinceEpoch - started;
    if (ageMs > 10 * 60 * 1000) {
      await setScrapeRunning(false);
      return false;
    }
    return true;
  }

  Future<void> requestScrapeStop() => setSyncMeta('scrape_stop', '1');

  Future<bool> scrapeStopRequested() async =>
      (await syncMeta('scrape_stop')) == '1';

  Future<void> clearScrapeStop() => delSyncMeta('scrape_stop');

  List<LocalEntry> _rowsToEntries(List<Map<String, Object?>> rows, String timeCol) {
    return rows.map((r) {
      final raw = (r['media'] as String?) ?? '';
      MediaItem item;
      try {
        final decoded = jsonDecode(raw);
        item = MediaItem.fromLocalJson(
          decoded is Map ? Map<String, dynamic>.from(decoded) : const {},
        );
      } catch (_) {
        item = const MediaItem(id: '', url: '', title: '(已损坏的本地记录)');
      }
      final ts = (r[timeCol] as int?) ?? 0;
      return LocalEntry(
        item: item,
        key: (r['key'] as String?) ?? '',
        updatedAt: ts > 0 ? DateTime.fromMillisecondsSinceEpoch(ts) : null,
      );
    }).toList();
  }
}
