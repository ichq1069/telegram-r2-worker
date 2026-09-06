/// 同步媒体类别（影响扫描范围，与“仅 Wi-Fi”等开关配合）。
enum SyncMediaKind {
  both('图片与视频'),
  image('仅图片'),
  video('仅视频');

  const SyncMediaKind(this.label);
  final String label;
}

/// 相册同步扫描过滤条件（持久化在 sync_filter 单行表）。
///
/// 规则语义：
/// - [minBytes] / [maxBytes]：0 表示该方向不限制；
/// - [exts]：允许的扩展名白名单（小写、不含点），空集合表示全部；
/// - [kind]：只同步图片 / 只同步视频 / 两者皆可。
class SyncFilter {
  const SyncFilter({
    this.minBytes = 0,
    this.maxBytes = 0,
    this.kind = SyncMediaKind.both,
    this.exts = const <String>{},
  });

  final int minBytes;
  final int maxBytes;
  final SyncMediaKind kind;
  final Set<String> exts;

  bool get sizeLimited => minBytes > 0 || maxBytes > 0;
  bool get extLimited => exts.isNotEmpty;

  SyncFilter copyWith({
    int? minBytes,
    int? maxBytes,
    SyncMediaKind? kind,
    Set<String>? exts,
  }) {
    return SyncFilter(
      minBytes: minBytes ?? this.minBytes,
      maxBytes: maxBytes ?? this.maxBytes,
      kind: kind ?? this.kind,
      exts: exts ?? this.exts,
    );
  }

  Map<String, Object?> toDb() => {
        'row_id': 1,
        'min_bytes': minBytes,
        'max_bytes': maxBytes,
        'kind': kind.name,
        'exts': (exts.toList()..sort()).join(','),
      };

  factory SyncFilter.fromDb(Map<String, Object?> r) {
    final raw = ((r['exts'] as String?) ?? '').trim();
    final exts = raw.isEmpty
        ? <String>{}
        : raw
            .split(',')
            .map((e) => e.trim().toLowerCase())
            .where((e) => e.isNotEmpty)
            .toSet();
    final kindName = (r['kind'] as String?) ?? 'both';
    return SyncFilter(
      minBytes: ((r['min_bytes'] as num?) ?? 0).toInt(),
      maxBytes: ((r['max_bytes'] as num?) ?? 0).toInt(),
      kind: SyncMediaKind.values.firstWhere(
        (k) => k.name == kindName,
        orElse: () => SyncMediaKind.both,
      ),
      exts: exts,
    );
  }
}

/// 队列聚合快照（供同步/上传状态页轮询展示）。
class QueueSnapshot {
  const QueueSnapshot({
    required this.queued,
    required this.uploading,
    required this.done,
    required this.failed,
  });

  final int queued;
  final int uploading;
  final int done;
  final int failed;

  int get total => queued + uploading + done + failed;
  int get pending => queued + uploading;
}
