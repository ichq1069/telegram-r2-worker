import 'package:flutter_test/flutter_test.dart';
import 'package:picwall_app/core/constants.dart';
import 'package:picwall_app/data/models/admin_file.dart';

void main() {
  group('levelFromWire', () {
    test('parses valid levels', () {
      expect(levelFromWire('pt'), UserLevel.pt);
      expect(levelFromWire('vip'), UserLevel.vip);
      expect(levelFromWire('svip'), UserLevel.svip);
      expect(levelFromWire('vvip'), UserLevel.vvip);
    });

    test('unknown/null defaults to pt', () {
      expect(levelFromWire(null), UserLevel.pt);
      expect(levelFromWire('gold'), UserLevel.pt);
      expect(levelFromWire(''), UserLevel.pt);
    });
  });

  group('UserLevel extension', () {
    test('rank ordering', () {
      expect(UserLevel.pt.rank, 0);
      expect(UserLevel.vip.rank, 1);
      expect(UserLevel.svip.rank, 2);
      expect(UserLevel.vvip.rank, 3);
    });

    test('wire returns enum name', () {
      for (final lv in UserLevel.values) {
        expect(lv.wire, lv.name);
      }
    });

    test('label for each level', () {
      expect(UserLevel.pt.label, '基础');
      expect(UserLevel.vip.label, 'VIP');
      expect(UserLevel.svip.label, 'SVIP');
      expect(UserLevel.vvip.label, 'VVIP');
    });
  });

  group('canSee', () {
    test('higher rank sees lower content', () {
      expect(canSee(UserLevel.vip, UserLevel.pt), isTrue);
      expect(canSee(UserLevel.vvip, UserLevel.svip), isTrue);
    });

    test('same rank sees same content', () {
      expect(canSee(UserLevel.svip, UserLevel.svip), isTrue);
    });

    test('lower rank cannot see higher content', () {
      expect(canSee(UserLevel.pt, UserLevel.vip), isFalse);
      expect(canSee(UserLevel.vip, UserLevel.vvip), isFalse);
    });

    test('private content only visible to vvip', () {
      expect(canSee(UserLevel.vvip, UserLevel.pt, isPrivate: true), isTrue);
      expect(canSee(UserLevel.svip, UserLevel.pt, isPrivate: true), isFalse);
      expect(canSee(UserLevel.vip, UserLevel.pt, isPrivate: true), isFalse);
      expect(canSee(UserLevel.pt, UserLevel.pt, isPrivate: true), isFalse);
    });
  });

  group('RuleGroup', () {
    test('fromJson with full fields', () {
      final g = RuleGroup.fromJson(<String, dynamic>{
        'key': 'example.com',
        'name': 'Example',
        'kw': 'wallpaper',
        'ext': 'jpg,png',
        'mb': 5,
        'must': 'landscape',
      });
      expect(g.key, 'example.com');
      expect(g.name, 'Example');
      expect(g.kw, 'wallpaper');
      expect(g.ext, 'jpg,png');
      expect(g.mb, 5);
      expect(g.must, 'landscape');
    });

    test('fromJson defaults on missing/null fields', () {
      final g = RuleGroup.fromJson(<String, dynamic>{});
      expect(g.key, '');
      expect(g.name, '');
      expect(g.kw, '');
      expect(g.ext, '');
      expect(g.mb, 10);
      expect(g.must, '');
    });

    test('toJson/fromJson round trip', () {
      const g = RuleGroup(key: '*', name: 'default', kw: 'cat', ext: 'mp4', mb: 8, must: 'hd');
      final back = RuleGroup.fromJson(g.toJson());
      expect(back.key, '*');
      expect(back.name, 'default');
      expect(back.kw, 'cat');
      expect(back.ext, 'mp4');
      expect(back.mb, 8);
      expect(back.must, 'hd');
    });
  });

  group('AdminFileRecord', () {
    test('fromJson picks best url fallback', () {
      final r = AdminFileRecord.fromJson(<String, dynamic>{
        'id': 1,
        'proxy_url': '/proxy/1.jpg',
        'display_url': 'https://cdn/display/1.jpg',
      });
      expect(r.url, 'https://cdn/display/1.jpg');
      expect(r.id, 1);
    });

    test('fromJson falls back to proxy_url when display_url absent', () {
      final r = AdminFileRecord.fromJson(<String, dynamic>{
        'id': 2,
        'proxy_url': '/proxy/2.jpg',
      });
      expect(r.url, '/proxy/2.jpg');
    });

    test('fromJson defaults on empty input', () {
      final r = AdminFileRecord.fromJson(<String, dynamic>{});
      expect(r.id, 0);
      expect(r.url, '');
      expect(r.level, 'pt');
      expect(r.isPrivate, isFalse);
    });
  });
}
