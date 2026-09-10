import 'package:flutter_test/flutter_test.dart';
import 'package:picwall_app/data/models/scrape_job.dart';

void main() {
  group('ScrapeJob', () {
    test('toDb/fromDb 往返保持参数', () {
      const job = ScrapeJob(
        id: 7,
        createdAtMs: 1700000000000,
        title: '标题',
        tags: '美女,壁纸',
        level: 'vip',
        ref: 'https://a.com/post',
        ignoreKw: 'gif',
        ignoreExt: 'webp',
        must: 'model',
        maxMb: 12,
        cookie: 'k=v',
        state: 'running',
      );
      final back = ScrapeJob.fromDb(job.toDb());
      expect(back.id, 7);
      expect(back.createdAtMs, 1700000000000);
      expect(back.title, '标题');
      expect(back.tags, '美女,壁纸');
      expect(back.level, 'vip');
      expect(back.ref, 'https://a.com/post');
      expect(back.ignoreKw, 'gif');
      expect(back.ignoreExt, 'webp');
      expect(back.must, 'model');
      expect(back.maxMb, 12);
      expect(back.cookie, 'k=v');
      expect(back.state, 'running');
    });

    test('maxMb 缺省为 null', () {
      final db = const ScrapeJob(createdAtMs: 1).toDb();
      expect(db['max_mb'], isNull);
      expect(ScrapeJob.fromDb(db).maxMb, isNull);
    });
  });

  group('ScrapeItem', () {
    test('fromDb 解析并回退缺省状态', () {
      final item = ScrapeItem.fromDb({
        'id': 3,
        'job_id': 7,
        'seq': 2,
        'url': 'https://a.com/1.jpg',
        'status': 'added',
        'reason': 'ok',
      });
      expect(item.id, 3);
      expect(item.jobId, 7);
      expect(item.seq, 2);
      expect(item.url, 'https://a.com/1.jpg');
      expect(item.status, 'added');
      expect(item.reason, 'ok');

      final fallback = ScrapeItem.fromDb({'job_id': 1, 'seq': 1, 'url': 'u'});
      expect(fallback.status, 'pending');
      expect(fallback.id, isNull);
    });
  });

  group('ScrapeJobSnapshot', () {
    ScrapeItem it(int seq, String status) =>
        ScrapeItem(jobId: 1, seq: seq, url: 'u$seq', status: status);

    test('聚合总数/完成/成功/失败/待处理', () {
      final snap = ScrapeJobSnapshot(
        job: const ScrapeJob(createdAtMs: 1),
        items: [
          it(1, 'added'),
          it(2, 'exists'),
          it(3, 'failed'),
          it(4, 'pending'),
          it(5, 'ignored'),
        ],
      );
      expect(snap.total, 5);
      expect(snap.done, 4);
      expect(snap.added, 1);
      expect(snap.failed, 1);
      expect(snap.hasPending, isTrue);
      expect(snap.summary, '完成 4 / 共 5 · 成功 1 · 失败 1');
    });

    test('无失败项时 summary 不显示失败', () {
      final snap = ScrapeJobSnapshot(
        job: const ScrapeJob(createdAtMs: 1),
        items: [it(1, 'added'), it(2, 'added')],
      );
      expect(snap.hasPending, isFalse);
      expect(snap.summary, '完成 2 / 共 2 · 成功 2');
    });
  });
}
