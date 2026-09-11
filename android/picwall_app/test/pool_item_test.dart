import 'package:flutter_test/flutter_test.dart';
import 'package:picwall_app/data/models/admin_file.dart';
import 'package:picwall_app/data/models/pool_item.dart';
import 'package:picwall_app/features/admin/library_grid_view.dart';

void main() {
  group('PoolItem', () {
    test('fromJson 解析完整字段', () {
      final item = PoolItem.fromJson({
        'id': 42,
        'url': 'https://example.com/img.jpg',
        'thumb_url': 'https://example.com/thumb.jpg',
        'title': '测试标题',
        'tags': '美女,壁纸',
        'file_type': 'photo',
        'width': 1920,
        'height': 1080,
        'file_size': 524288,
        'source': 'tg',
        'tg_file_id': 123,
        'enabled': 1,
        'created_at': '2026-09-10T00:00:00Z',
        'level': 'vip',
        'is_private': 0,
        'folder_id': 5,
      });
      expect(item.id, 42);
      expect(item.url, 'https://example.com/img.jpg');
      expect(item.thumbUrl, 'https://example.com/thumb.jpg');
      expect(item.title, '测试标题');
      expect(item.tags, '美女,壁纸');
      expect(item.fileType, 'photo');
      expect(item.width, 1920);
      expect(item.height, 1080);
      expect(item.fileSize, 524288);
      expect(item.source, 'tg');
      expect(item.tgFileId, 123);
      expect(item.enabled, 1);
      expect(item.createdAt, '2026-09-10T00:00:00Z');
      expect(item.level, 'vip');
      expect(item.isPrivate, 0);
      expect(item.folderId, 5);
    });

    test('fromJson 缺失字段使用默认值', () {
      final item = PoolItem.fromJson({'id': 1, 'url': 'https://a.com/b.jpg'});
      expect(item.thumbUrl, '');
      expect(item.title, '');
      expect(item.tags, '');
      expect(item.fileType, 'photo');
      expect(item.width, isNull);
      expect(item.height, isNull);
      expect(item.fileSize, isNull);
      expect(item.source, 'manual');
      expect(item.tgFileId, isNull);
      expect(item.enabled, 1);
      expect(item.level, 'pt');
      expect(item.isPrivate, 0);
      expect(item.folderId, isNull);
    });

    test('fromJson 非数值 id 安全降级为 0', () {
      final item = PoolItem.fromJson({'id': 'abc', 'url': ''});
      expect(item.id, 0);
    });

    test('displayUrl 优先使用 thumbUrl', () {
      final item = PoolItem.fromJson({
        'id': 1,
        'url': 'https://a.com/full.jpg',
        'thumb_url': 'https://a.com/thumb.jpg',
      });
      expect(item.displayUrl, 'https://a.com/thumb.jpg');
    });

    test('displayUrl thumbUrl 为空时回退 url', () {
      final item = PoolItem.fromJson({
        'id': 1,
        'url': 'https://a.com/full.jpg',
      });
      expect(item.displayUrl, 'https://a.com/full.jpg');
    });

    test('isImage 判断 fileType', () {
      expect(PoolItem.fromJson({'id': 1, 'url': '', 'file_type': 'photo'}).isImage, isTrue);
      expect(PoolItem.fromJson({'id': 1, 'url': '', 'file_type': 'image'}).isImage, isTrue);
      expect(PoolItem.fromJson({'id': 1, 'url': '', 'file_type': 'video'}).isImage, isFalse);
    });
  });

  group('LibraryEntry', () {
    test('fromPool 创建条目', () {
      final pool = PoolItem.fromJson({
        'id': 10,
        'url': 'https://a.com/1.jpg',
        'level': 'svip',
        'source': 'tg',
      });
      final entry = LibraryEntry.fromPool(pool);
      expect(entry.key, 'pool_10');
      expect(entry.id, 10);
      expect(entry.level, 'svip');
      expect(entry.source, 'tg');
      expect(entry.poolItem, pool);
      expect(entry.fileRecord, isNull);
    });

    test('fromFile 创建条目', () {
      final file = AdminFileRecord.fromJson({
        'id': 20,
        'display_url': 'https://b.com/2.jpg',
        'file_name': 'test.jpg',
        'level': 'pt',
      });
      final entry = LibraryEntry.fromFile(file);
      expect(entry.key, 'file_20');
      expect(entry.id, 20);
      expect(entry.source, 'tg');
      expect(entry.fileRecord, file);
      expect(entry.poolItem, isNull);
      expect(entry.imported, isFalse);
    });

    test('fromFile 识别已入库 pool_state', () {
      final file = AdminFileRecord.fromJson({
        'id': 21,
        'display_url': 'https://b.com/3.jpg',
        'pool_state': 'imported',
      });
      final entry = LibraryEntry.fromFile(file);
      expect(entry.poolState, 'imported');
      expect(entry.imported, isTrue);
    });
  });
}
