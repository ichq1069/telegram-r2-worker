import 'package:flutter_test/flutter_test.dart';
import 'package:picwall_app/data/models/upload_task.dart';

void main() {
  group('UploadState', () {
    test('fromWire parses known states', () {
      expect(UploadState.fromWire('uploading'), UploadState.uploading);
      expect(UploadState.fromWire('done'), UploadState.done);
      expect(UploadState.fromWire('failed'), UploadState.failed);
    });

    test('fromWire defaults to queued', () {
      expect(UploadState.fromWire(null), UploadState.queued);
      expect(UploadState.fromWire('unknown'), UploadState.queued);
      expect(UploadState.fromWire(''), UploadState.queued);
    });
  });

  group('UploadSource', () {
    test('fromWire parses known sources', () {
      expect(UploadSource.fromWire('gallery'), UploadSource.gallery);
      expect(UploadSource.fromWire('camera'), UploadSource.camera);
      expect(UploadSource.fromWire('url'), UploadSource.url);
    });

    test('fromWire defaults to unknown', () {
      expect(UploadSource.fromWire(null), UploadSource.unknown);
      expect(UploadSource.fromWire('bluetooth'), UploadSource.unknown);
    });
  });

  group('UploadTask', () {
    test('isTerminal only on done/failed', () {
      expect(const UploadTask(filePath: '', fileName: '', createdAt: 0).isTerminal, isFalse);
      expect(const UploadTask(filePath: '', fileName: '', createdAt: 0, state: UploadState.uploading).isTerminal, isFalse);
      expect(const UploadTask(filePath: '', fileName: '', createdAt: 0, state: UploadState.done).isTerminal, isTrue);
      expect(const UploadTask(filePath: '', fileName: '', createdAt: 0, state: UploadState.failed).isTerminal, isTrue);
    });

    test('toDb/fromDb round trip preserves fields', () {
      const t = UploadTask(
        id: 42,
        filePath: '/tmp/x.jpg',
        fileName: 'x.jpg',
        source: UploadSource.camera,
        tags: 'a,b',
        state: UploadState.uploading,
        error: 'timeout',
        sizeBytes: 2048,
        createdAt: 1700000000,
        finishedAt: 1700000100,
      );
      final back = UploadTask.fromDb(t.toDb());
      expect(back.id, 42);
      expect(back.filePath, '/tmp/x.jpg');
      expect(back.fileName, 'x.jpg');
      expect(back.source, UploadSource.camera);
      expect(back.tags, 'a,b');
      expect(back.state, UploadState.uploading);
      expect(back.error, 'timeout');
      expect(back.sizeBytes, 2048);
      expect(back.createdAt, 1700000000);
      expect(back.finishedAt, 1700000100);
    });

    test('copyWith updates only requested fields', () {
      const t = UploadTask(filePath: '/tmp/a.jpg', fileName: 'a.jpg', createdAt: 100, state: UploadState.queued);
      final u = t.copyWith(state: UploadState.failed, error: 'network', finishedAt: 200);
      expect(u.state, UploadState.failed);
      expect(u.error, 'network');
      expect(u.finishedAt, 200);
      expect(u.filePath, '/tmp/a.jpg');

      final v = u.copyWith(clearError: true);
      expect(v.error, isNull);
      expect(v.state, UploadState.failed);
    });
  });
}
