import 'package:flutter_test/flutter_test.dart';
import 'package:picwall_app/services/settings.dart';

void main() {
  group('AppLock.valid', () {
    test('rejects too short', () {
      expect(AppLock.valid(<int>[0, 1]), isFalse);
      expect(AppLock.valid(<int>[0, 1, 2]), isFalse);
    });

    test('rejects out-of-range and duplicates', () {
      expect(AppLock.valid(<int>[0, 1, 2, 9]), isFalse);
      expect(AppLock.valid(<int>[0, 1, 2, -1]), isFalse);
      expect(AppLock.valid(<int>[0, 1, 2, 0]), isFalse);
    });

    test('accepts 4..9 distinct nodes', () {
      expect(AppLock.valid(<int>[0, 1, 2, 5]), isTrue);
      expect(AppLock.valid(<int>[0, 1, 2, 3, 4, 5, 6, 7, 8]), isTrue);
    });
  });

  group('AppLock encode/verify', () {
    const seq = '01342';

    test('encode stores salt:sha256hex and verifies ok', () {
      final stored = AppLock.encode(seq);
      expect(stored, contains(':'));
      expect(stored.split(':').first.length, 16);
      expect(AppLock.verify(stored, seq), isTrue);
    });

    test('wrong sequence rejected', () {
      final stored = AppLock.encode(seq);
      expect(AppLock.verify(stored, '01343'), isFalse);
    });

    test('same sequence yields distinct salts', () {
      final a = AppLock.encode(seq);
      final b = AppLock.encode(seq);
      expect(a, isNot(b));
      expect(AppLock.verify(a, seq), isTrue);
      expect(AppLock.verify(b, seq), isTrue);
    });

    test('malformed stored value rejected', () {
      expect(AppLock.verify('', seq), isFalse);
      expect(AppLock.verify('salt-no-hash', seq), isFalse);
    });
  });

  group('AppSettings.resolve', () {
    test('resolve keeps absolute and joins relative', () {
      final s = AppSettings(apiBase: 'https://api.example.com');
      expect(s.resolve('https://cdn.example.com/x.jpg'), 'https://cdn.example.com/x.jpg');
      expect(s.resolve('/media/x.jpg'), 'https://api.example.com/media/x.jpg');
      expect(s.resolve('media/x.jpg'), 'https://api.example.com/media/x.jpg');
      expect(s.resolve(''), isEmpty);
      expect(s.resolve(null), isEmpty);
    });
  });
}
