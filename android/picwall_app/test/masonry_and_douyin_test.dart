import 'package:flutter_test/flutter_test.dart';
import 'package:picwall_app/data/models/media_item.dart';
import 'package:picwall_app/features/douyin/douyin_view_page.dart';
import 'package:picwall_app/features/gallery/masonry_virtual_grid.dart';
import 'package:picwall_app/features/gallery/media_thumb.dart';

void main() {
  group('MasonryVirtualGrid 行分组', () {
    test('rowCountOf 覆盖 0/1/2/3/5', () {
      expect(MasonryVirtualGrid.rowCountOf(0), 0);
      expect(MasonryVirtualGrid.rowCountOf(1), 1);
      expect(MasonryVirtualGrid.rowCountOf(2), 1);
      expect(MasonryVirtualGrid.rowCountOf(3), 2);
      expect(MasonryVirtualGrid.rowCountOf(4), 2);
      expect(MasonryVirtualGrid.rowCountOf(5), 3);
    });
  });

  group('MasonryVirtualGrid cell 宽度公式', () {
    test('两格均分并扣除页边距与行内间距', () {
      // (400 - 10*2 - 10) / 2 = 185
      expect(MasonryVirtualGrid.cellWidthOf(400, 10, 10), 185.0);
      // (360 - 12*2 - 8) / 2 = 164
      expect(MasonryVirtualGrid.cellWidthOf(360, 12, 8), 164.0);
    });

    test('cellHeightOf 按宽高比撑高，非法比值兜底 0.75', () {
      expect(MasonryVirtualGrid.cellHeightOf(150, 0.75), 200.0);
      expect(MasonryVirtualGrid.cellHeightOf(150, 0), 200.0);
      expect(MasonryVirtualGrid.cellHeightOf(150, -1), 200.0);
      expect(MasonryVirtualGrid.cellHeightOf(110, 2.2),
          closeTo(50.0, 1e-9));
    });

    test('rowHeightOf 取两格较高者；奇数尾行仅计首格', () {
      // 首格 1.0、次格 2.0 => 高分别为 100 / 50
      final two = MasonryVirtualGrid.rowHeightOf(100, 1.0, 2.0);
      expect(two, 100.0);
      // 首格 2.0 单格行 => 50
      final single = MasonryVirtualGrid.rowHeightOf(100, 2.0, null);
      expect(single, 50.0);
    });
  });

  group('mediaItemAspectRatio 口径一致', () {
    MediaItem itemOf(int? w, int? h) => MediaItem(
          id: 'x',
          url: 'https://cdn/x/a.jpg',
          width: w,
          height: h,
        );

    test('缺尺寸按 0.75', () {
      expect(mediaItemAspectRatio(itemOf(null, null)), 0.75);
      expect(mediaItemAspectRatio(itemOf(100, null)), 0.75);
      expect(mediaItemAspectRatio(itemOf(null, 100)), 0.75);
      expect(mediaItemAspectRatio(itemOf(100, 0)), 0.75);
    });

    test('正常比例直接用宽/高', () {
      expect(mediaItemAspectRatio(itemOf(800, 400)), 2.0);
      expect(mediaItemAspectRatio(itemOf(400, 800)), 0.5);
      expect(mediaItemAspectRatio(itemOf(300, 400)), 0.75);
    });

    test('极端比例收敛到 0.5~2.2', () {
      expect(mediaItemAspectRatio(itemOf(1000, 100)), 2.2);
      expect(mediaItemAspectRatio(itemOf(100, 1000)), 0.5);
    });
  });

  group('douyin 去重合并', () {
    MediaItem media(String fileType, String id) =>
        MediaItem(id: id, url: 'https://cdn/$fileType/$id', fileType: fileType);

    test('同批与跨批按 dedupeKey 去重，只追加新条目', () {
      final dest = [media('photo', 'a'), media('video', 'b')];
      // 与 DouyinViewPage.initState 一致：seenKeys 预置既有 dest 的 key。
      final seen = {for (final e in dest) e.dedupeKey};
      final first = dedupeAppendItems(dest, seen, [media('photo', 'c')]);
      expect(first.map((e) => e.dedupeKey), ['photo:c']);
      expect(dest.length, 3);

      final second = dedupeAppendItems(
          dest, seen, [media('photo', 'a'), media('video', 'd')]);
      expect(second.map((e) => e.dedupeKey), ['video:d']);
      expect(dest.length, 4);
    });

    test('全重复批次返回空列表（视为到底）', () {
      final dest = [media('photo', 'a')];
      final seen = {for (final e in dest) e.dedupeKey};
      final fresh = dedupeAppendItems(dest, seen, [media('photo', 'a')]);
      expect(fresh, isEmpty);
      expect(dest.length, 1);
    });

    test('photo:a 与 video:a 互不冲突', () {
      final dest = <MediaItem>[];
      final seen = <String>{};
      dedupeAppendItems(dest, seen, [media('photo', 'a')]);
      final fresh = dedupeAppendItems(dest, seen, [media('video', 'a')]);
      expect(fresh, hasLength(1));
      expect(dest, hasLength(2));
    });
  });

  group('posterUrl 避免拿视频地址当封面', () {
    MediaItem item({required String fileType, String? thumb, String url = ''}) =>
        MediaItem(
          id: 'x',
          url: url.isEmpty ? 'https://cdn/$fileType/x' : url,
          thumbUrl: thumb,
          fileType: fileType,
        );

    test('视频 thumb 兜底成视频地址时不作为封面', () {
      final v = item(
          fileType: 'video',
          thumb: 'https://cdn/file/tg/tok/9.mp4?x=1');
      expect(v.hasImageThumb, isFalse);
      expect(v.posterUrl, isEmpty);
    });

    test('视频有真实图片封面时正常使用', () {
      final v = item(
          fileType: 'video', thumb: 'https://cdn/file/tg/tok/9.jpg');
      expect(v.hasImageThumb, isTrue);
      expect(v.posterUrl, 'https://cdn/file/tg/tok/9.jpg');
    });

    test('图片条目保持 displayThumb 行为（含无扩展名）', () {
      final p = item(fileType: 'photo', thumb: 'https://cdn/abc');
      expect(p.hasImageThumb, isFalse);
      expect(p.posterUrl, 'https://cdn/abc');
    });
  });
}
