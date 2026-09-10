/// 采集入库后台任务的持久化模型：一次入库任务（job）与其中逐条待入库项（item）。
///
/// 采集页发起入库后，任务与各图片状态写入本地库；前台服务在独立 isolate 中
/// 逐条调用 `/admin/api/scrape/grab_one`，进程被杀后由 WorkManager 依据这些
/// 记录续跑。模型保持纯 Dart，便于单测。
library;

/// 入库任务参数（对齐 grab_one 请求体，不含单条 url）。
class ScrapeJob {
  const ScrapeJob({
    this.id,
    required this.createdAtMs,
    this.title = '',
    this.tags = '',
    this.level = 'pt',
    this.ref = '',
    this.ignoreKw = '',
    this.ignoreExt = '',
    this.must = '',
    this.maxMb,
    this.cookie = '',
    this.state = 'running',
  });

  final int? id;
  final int createdAtMs;
  final String title;
  final String tags;
  final String level;
  final String ref;
  final String ignoreKw;
  final String ignoreExt;
  final String must;
  final int? maxMb;
  final String cookie;

  /// running（进行中/未完成，可续跑）/ done（已完成）/ stopped（用户停止）。
  final String state;

  Map<String, Object?> toDb() => {
        if (id != null) 'id': id,
        'created_at': createdAtMs,
        'title': title,
        'tags': tags,
        'level': level,
        'ref': ref,
        'ignore_kw': ignoreKw,
        'ignore_ext': ignoreExt,
        'must': must,
        'max_mb': maxMb,
        'cookie': cookie,
        'state': state,
      };

  static ScrapeJob fromDb(Map<String, Object?> r) => ScrapeJob(
        id: (r['id'] as num?)?.toInt(),
        createdAtMs: (r['created_at'] as num?)?.toInt() ?? 0,
        title: (r['title'] ?? '').toString(),
        tags: (r['tags'] ?? '').toString(),
        level: (r['level'] ?? 'pt').toString(),
        ref: (r['ref'] ?? '').toString(),
        ignoreKw: (r['ignore_kw'] ?? '').toString(),
        ignoreExt: (r['ignore_ext'] ?? '').toString(),
        must: (r['must'] ?? '').toString(),
        maxMb: (r['max_mb'] as num?)?.toInt(),
        cookie: (r['cookie'] ?? '').toString(),
        state: (r['state'] ?? 'running').toString(),
      );
}

/// 单条待入库图片及其状态。
///
/// status：pending / added / exists / ignored / failed（与服务端 grab_one 对齐）。
class ScrapeItem {
  const ScrapeItem({
    this.id,
    required this.jobId,
    required this.seq,
    required this.url,
    this.status = 'pending',
    this.reason = '',
  });

  final int? id;
  final int jobId;
  final int seq;
  final String url;
  final String status;
  final String reason;

  static ScrapeItem fromDb(Map<String, Object?> r) => ScrapeItem(
        id: (r['id'] as num?)?.toInt(),
        jobId: (r['job_id'] as num?)?.toInt() ?? 0,
        seq: (r['seq'] as num?)?.toInt() ?? 0,
        url: (r['url'] ?? '').toString(),
        status: (r['status'] ?? 'pending').toString(),
        reason: (r['reason'] ?? '').toString(),
      );
}

/// 任务 + 全部条目，供后台服务与界面共用的只读快照。
class ScrapeJobSnapshot {
  const ScrapeJobSnapshot({required this.job, required this.items});

  final ScrapeJob job;
  final List<ScrapeItem> items;

  int get total => items.length;
  int get done => items.where((i) => i.status != 'pending').length;
  int get added => items.where((i) => i.status == 'added').length;
  int get failed => items.where((i) => i.status == 'failed').length;
  bool get hasPending => items.any((i) => i.status == 'pending');

  /// 界面/通知用的一句话进度。
  String get summary {
    final base = '完成 $done / 共 $total · 成功 $added';
    return failed > 0 ? '$base · 失败 $failed' : base;
  }
}
