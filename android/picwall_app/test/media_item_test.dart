import 'package:flutter_test/flutter_test.dart';
import 'package:picwall_app/data/models/media_item.dart';

void main() {
  group('MediaItem.fromPoolJson', () {
    test('video item flags video and falls back thumb to url', () {
      final m = MediaItem.fromPoolJson(<String, dynamic>{
        'id': 'v1',
        'url': 'https://cdn/x/a.mp4',
        'file_type': 'video',
        'tags': 'one,two',
      });
      expect(m.isVideo, isTrue);
      expect(m.isPhoto, isFalse);
      expect(m.displayThumb, 'https://cdn/x/a.mp4');
      expect(m.dedupeKey, 'video:v1');
      expect(m.tags, containsAll(<String>['one', 'two']));
      expect(m.fileTypeLabel, '视频');
    });

    test('photo default with thumb_url preferred', () {
      final m = MediaItem.fromPoolJson(<String, dynamic>{
        'id': 'p1',
        'url': 'https://cdn/x/b.jpg',
        'thumb_url': 'https://cdn/x/b_thumb.jpg',
        'file_type': 'image',
      });
      expect(m.isPhoto, isTrue);
      expect(m.isVideo, isFalse);
      expect(m.displayThumb, 'https://cdn/x/b_thumb.jpg');
    });

    test('empty id falls back dedupe to url', () {
      final m = MediaItem.fromPoolJson(<String, dynamic>{'url': 'https://cdn/x/c.jpg'});
      expect(m.dedupeKey, 'https://cdn/x/c.jpg');
      expect(m.fileTypeLabel, '图片');
      expect(m.id, isEmpty);
    });
  });

  group('MediaItem.fromFilesJson', () {
    test('falls back url to proxy_url and title to file_name', () {
      final m = MediaItem.fromFilesJson(<String, dynamic>{
        'id': 'f1',
        'proxy_url': '/media/f1.jpg',
        'file_name': 'hello.jpg',
        'is_private': '1',
      });
      expect(m.url, '/media/f1.jpg');
      expect(m.title, 'hello.jpg');
      expect(m.isPrivate, isTrue);
    });
  });

  group('MediaItem local round trip', () {
    test('toJson -> fromLocalJson keeps core fields and tags', () {
      final m = MediaItem.fromPoolJson(<String, dynamic>{
        'id': 'x9',
        'url': '/media/x9.mp4',
        'thumb_url': '/media/x9_t.jpg',
        'title': 'clip',
        'tags': ['a', 'b'],
        'file_type': 'video',
        'width': 1280,
        'height': 720,
        'file_size': 2048,
        'source': 'tg',
        'created_at': '2026-01-01',
      });
      final back = MediaItem.fromLocalJson(m.toJson());
      expect(back.id, 'x9');
      expect(back.url, '/media/x9.mp4');
      expect(back.thumbUrl, '/media/x9_t.jpg');
      expect(back.title, 'clip');
      expect(back.tags, <String>['a', 'b']);
      expect(back.isVideo, isTrue);
      expect(back.width, 1280);
      expect(back.height, 720);
      expect(back.fileSize, 2048);
      expect(back.source, 'tg');
    });

    test('document label', () {
      final m = MediaItem.fromPoolJson(<String, dynamic>{
        'id': 'd1',
        'url': '/media/d1.pdf',
        'file_type': 'document',
      });
      expect(m.isPhoto, isFalse);
      expect(m.fileTypeLabel, '文档');
    });
  });

  group('GalleryPage', () {
    test('parses items and hasMore logic', () {
      final p = GalleryPage.fromJson(<String, dynamic>{
        'total': 10,
        'limit': 5,
        'offset': 0,
        'level': 'pt',
        'items': <Map<String, dynamic>>[
          <String, dynamic>{'id': 'a', 'url': 'https://cdn/x/a.jpg'},
        ],
      });
      expect(p.items, hasLength(1));
      expect(p.items.first.isPhoto, isTrue);
      expect(p.hasMore, isTrue);
      expect(p.total, 10);
    });

    test('hasMore false at tail', () {
      final p = GalleryPage.fromJson(<String, dynamic>{
        'total': 5,
        'limit': 5,
        'offset': 5,
        'level': 'pt',
        'items': <dynamic>[],
      });
      expect(p.items, isEmpty);
      expect(p.hasMore, isFalse);
    });
  });
}
