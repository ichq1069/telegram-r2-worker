import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import '../models/media_item.dart';
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
      version: 2,
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
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await _createUploadQueue(db);
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
