/// 上传任务状态。
enum UploadState {
  queued,
  uploading,
  done,
  failed;

  static UploadState fromWire(String? s) {
    switch (s) {
      case 'uploading':
        return UploadState.uploading;
      case 'done':
        return UploadState.done;
      case 'failed':
        return UploadState.failed;
      default:
        return UploadState.queued;
    }
  }
}

/// 待传文件来源。
enum UploadSource {
  gallery,
  camera,
  url,
  unknown;

  static UploadSource fromWire(String? s) {
    switch (s) {
      case 'gallery':
        return UploadSource.gallery;
      case 'camera':
        return UploadSource.camera;
      case 'url':
        return UploadSource.url;
      default:
        return UploadSource.unknown;
    }
  }
}

/// 上传任务：一个本地文件，对应一次上传尝试。
///
/// [filePath] 指向应用文档目录下的待传副本，重启后仍可继续；
/// 上传成功后由引擎负责清理副本与记录。
class UploadTask {
  const UploadTask({
    this.id,
    required this.filePath,
    required this.fileName,
    this.source = UploadSource.unknown,
    this.tags = '',
    this.state = UploadState.queued,
    this.error,
    this.sizeBytes = 0,
    required this.createdAt,
    this.finishedAt,
  });

  final int? id;
  final String filePath;
  final String fileName;
  final UploadSource source;
  final String tags;
  final UploadState state;
  final String? error;
  final int sizeBytes;
  final int createdAt;
  final int? finishedAt;

  bool get isTerminal => state == UploadState.done || state == UploadState.failed;

  UploadTask copyWith({
    int? id,
    UploadState? state,
    String? error,
    int? finishedAt,
    bool clearError = false,
  }) {
    return UploadTask(
      id: id ?? this.id,
      filePath: filePath,
      fileName: fileName,
      source: source,
      tags: tags,
      state: state ?? this.state,
      error: clearError ? null : (error ?? this.error),
      sizeBytes: sizeBytes,
      createdAt: createdAt,
      finishedAt: finishedAt ?? this.finishedAt,
    );
  }

  Map<String, Object?> toDb() => {
        if (id != null) 'id': id,
        'file_path': filePath,
        'file_name': fileName,
        'source': source.name,
        'tags': tags,
        'state': state.name,
        'error': error,
        'size_bytes': sizeBytes,
        'created_at': createdAt,
        'finished_at': finishedAt,
      };

  factory UploadTask.fromDb(Map<String, Object?> r) {
    return UploadTask(
      id: (r['id'] as int?) ?? (r['id'] as num?)?.toInt(),
      filePath: (r['file_path'] as String?) ?? '',
      fileName: (r['file_name'] as String?) ?? '',
      source: UploadSource.fromWire(r['source']?.toString()),
      tags: (r['tags'] as String?) ?? '',
      state: UploadState.fromWire(r['state']?.toString()),
      error: r['error'] as String?,
      sizeBytes: ((r['size_bytes'] as num?) ?? 0).toInt(),
      createdAt: ((r['created_at'] as num?) ?? 0).toInt(),
      finishedAt: (r['finished_at'] as num?)?.toInt(),
    );
  }
}
