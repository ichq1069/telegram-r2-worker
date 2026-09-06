import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import '../../data/local/local_db.dart';
import '../../data/models/upload_task.dart';
import '../../data/repositories/gallery_repository.dart';
import '../../services/api_client.dart';

/// 当前网络类型（供上传引擎判定 WiFi-only）。
enum NetworkKind {
  wifi,
  cellular,
  none;

  bool get isUnlimited => this == NetworkKind.wifi;
}

/// 实时探测网络类型：connectivity_plus 封装；异常按无网络处理。
Future<NetworkKind> probeNetworkNow() async {
  try {
    final results = await Connectivity().checkConnectivity();
    if (results.isEmpty) return NetworkKind.none;
    for (final r in results) {
      if (r == ConnectivityResult.wifi || r == ConnectivityResult.ethernet) {
        return NetworkKind.wifi;
      }
      if (r == ConnectivityResult.mobile) return NetworkKind.cellular;
    }
    return NetworkKind.none;
  } catch (_) {
    return NetworkKind.none;
  }
}

/// 上传引擎：内存任务队列 + 本地 upload_queue 表 + 逐张上传。
///
/// 行为：
/// - [tasks] 在内存保持，任何变更同步回 sqflite（重启后可恢复 queued/failed）。
/// - 队列逐张 `POST /api/v1/user/upload`；单张失败标记 failed 并记录错误，不中断后续。
/// - WiFi-only 时：非 Wi-Fi 网络暂停队列（[networkPaused]），Wi-Fi 恢复后继续。
class UploadEngine extends ChangeNotifier {
  UploadEngine({
    required GalleryRepository repository,
    required LocalDb db,
    required bool wifiOnly,
    Future<NetworkKind> Function()? networkProbe,
  })  : _repo = repository,
        _db = db,
        _wifiOnly = wifiOnly,
        _networkProbe = networkProbe ?? probeNetworkNow;

  final GalleryRepository _repo;
  final LocalDb _db;
  final Future<NetworkKind> Function() _networkProbe;
  bool _wifiOnly;

  final List<UploadTask> tasks = [];
  bool _running = false;
  bool _networkPaused = false;
  String? _lastError;

  bool get wifiOnly => _wifiOnly;
  bool get running => _running;
  bool get networkPaused => _networkPaused;

  UploadTask? get current => _find(UploadState.uploading);

  int get queuedCount => _where(UploadState.queued).length;
  int get uploadingCount => _where(UploadState.uploading).length;
  int get doneCount => _where(UploadState.done).length;
  int get failedCount => _where(UploadState.failed).length;

  /// 队列是否还有待上传（queued/uploading）任务；failed 不计入。
  bool get hasPending => queuedCount > 0;

  String? get lastError => _lastError;

  /// 恢复中断的队列：重新载入本地未完成任务。
  Future<void> loadFromDb() async {
    final pending = await _db.listPendingUploads();
    tasks
      ..clear()
      ..addAll(pending);
    notifyListeners();
  }

  /// 将本地文件复制为待传副本并排队。
  Future<List<UploadTask>> enqueueFiles({
    required List<String> paths,
    required UploadSource source,
    required String tags,
    required String Function(String path) nameOf,
  }) async {
    final added = <UploadTask>[];
    final staging = await _stagingDir();
    for (final path in paths) {
      final src = File(path);
      if (!await src.exists()) continue;
      final name = nameOf(path);
      final safe = _sanitize(name);
      final target = File(
        '${staging.path}${Platform.pathSeparator}${DateTime.now().microsecondsSinceEpoch}_$safe',
      );
      try {
        await src.copy(target.path);
      } catch (e) {
        _lastError = '文件复制失败：$e';
        notifyListeners();
        continue;
      }
      final len = await target.length();
      var task = UploadTask(
        filePath: target.path,
        fileName: safe,
        source: source,
        tags: tags,
        sizeBytes: len,
        createdAt: DateTime.now().millisecondsSinceEpoch,
      );
      final id = await _db.insertUploadTask(task);
      task = task.copyWith(id: id);
      tasks.add(task);
      added.add(task);
    }
    notifyListeners();
    return added;
  }

  Future<Directory> _stagingDir() async {
    final docs = await getApplicationDocumentsDirectory();
    final dir = Directory('${docs.path}${Platform.pathSeparator}uploads');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  /// 启动队列（幂等）。若 wifiOnly 且当前非 Wi-Fi，则进入挂起态。
  /// 后台同步前台服务持锁运行期间不主动上传，避免双上传。
  Future<void> start() async {
    if (_running) return;
    if (await _db.isSyncRunning()) return;
    if (wifiOnly) {
      final net = await _networkProbe();
      if (!net.isUnlimited) {
        _networkPaused = true;
        notifyListeners();
        return;
      }
    }
    await _drain();
  }

  /// 网络状态变化入口：Wi-Fi 恢复后自动继续被挂起的队列。
  Future<void> onNetworkChanged(NetworkKind net) async {
    if (await _db.isSyncRunning()) return;
    if (!wifiOnly) return;
    if (net.isUnlimited) {
      if (_networkPaused && hasPending && !_running) {
        _networkPaused = false;
        notifyListeners();
        await _drain();
      }
    } else if (!_networkPaused && hasPending && !_running) {
      _networkPaused = true;
      notifyListeners();
    }
  }

  void setWifiOnly(bool value) {
    _wifiOnly = value;
    if (!value && _networkPaused && hasPending && !_running) {
      _networkPaused = false;
      notifyListeners();
      _drainWhenIdle();
    } else {
      notifyListeners();
    }
  }

  Future<void> _drainWhenIdle() async {
    if (await _db.isSyncRunning()) return;
    await _drain();
  }

  Future<void> _drain() async {
    _running = true;
    try {
      while (queuedCount > 0 && _running) {
        if (wifiOnly) {
          final net = await _networkProbe();
          if (!net.isUnlimited) {
            _networkPaused = true;
            break;
          }
        }
        _networkPaused = false;
        final next = _next();
        if (next == null) break;
        await _uploadOne(next);
      }
    } finally {
      _running = false;
      notifyListeners();
    }
  }

  Future<void> _uploadOne(UploadTask task) async {
    task = task.copyWith(
      state: UploadState.uploading,
      clearError: true,
      finishedAt: null,
    );
    _set(task);
    try {
      await _repo.uploadLocalFile(
        filePath: task.filePath,
        fileName: task.fileName,
        tags: task.tags,
      );
      task = task.copyWith(
        state: UploadState.done,
        finishedAt: DateTime.now().millisecondsSinceEpoch,
      );
      _lastError = null;
    } catch (e) {
      task = task.copyWith(
        state: UploadState.failed,
        error: normalizeError(e).toString(),
        finishedAt: DateTime.now().millisecondsSinceEpoch,
      );
      _lastError = task.error;
    }
    _set(task);
  }

  /// 重试单个失败项。
  Future<void> retry(int id) async {
    final i = tasks.indexWhere((t) => t.id == id);
    if (i < 0) return;
    if (tasks[i].state == UploadState.failed) {
      tasks[i] = tasks[i].copyWith(state: UploadState.queued, finishedAt: null);
      _persist(tasks[i]);
      notifyListeners();
    }
    await start();
  }

  /// 移除一项（同时清理本地副本）。
  Future<void> remove(int id) async {
    final i = tasks.indexWhere((t) => t.id == id);
    if (i < 0) return;
    final t = tasks[i];
    tasks.removeAt(i);
    await _db.deleteUploadTask(id);
    final f = File(t.filePath);
    if (await f.exists()) {
      try {
        await f.delete();
      } catch (_) {}
    }
    notifyListeners();
  }

  /// 清除已完成（done）项及其副本。
  Future<void> clearDone() async {
    final done = tasks.where((t) => t.state == UploadState.done).toList();
    for (final t in done) {
      tasks.remove(t);
      await _db.deleteUploadTask(t.id ?? -1);
      final f = File(t.filePath);
      if (await f.exists()) {
        try {
          await f.delete();
        } catch (_) {}
      }
    }
    notifyListeners();
  }

  UploadTask? _next() {
    for (final t in tasks) {
      if (t.state == UploadState.queued) return t;
    }
    return null;
  }

  List<UploadTask> _where(UploadState s) =>
      tasks.where((t) => t.state == s).toList();

  UploadTask? _find(UploadState s) {
    for (final t in tasks) {
      if (t.state == s) return t;
    }
    return null;
  }

  void _set(UploadTask task) {
    final i = tasks.indexWhere((t) => t.id == task.id);
    if (i >= 0) {
      tasks[i] = task;
      _persist(task);
    }
    notifyListeners();
  }

  Future<void> _persist(UploadTask task) async {
    await _db.updateUploadTask(task);
  }

  static String _sanitize(String name) {
    final cleaned = name
        .replaceAll(RegExp(r'[\\/:*?"<>|\s]'), '_')
        .replaceAll(RegExp(r'_+'), '_');
    final trimmed = cleaned.replaceAll(RegExp(r'^[_]|[_]$'), '');
    return trimmed.isEmpty ? 'file' : trimmed;
  }
}
