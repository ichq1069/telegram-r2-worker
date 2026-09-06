import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:picwall_app/app.dart';
import 'package:picwall_app/services/providers.dart';
import 'package:picwall_app/services/secure_store.dart';

/// 内存版安全存储，避免测试环境缺少平台通道。
class _MemoryStore extends SecureStore {
  final Map<String, String> _mem = {};

  @override
  Future<String?> read(String key) async => _mem[key];

  @override
  Future<void> write(String key, String value) async => _mem[key] = value;

  @override
  Future<void> delete(String key) async => _mem.remove(key);

  @override
  Future<Map<String, String>> readSettings() async {
    final raw = _mem[SecureStore.kSettings];
    if (raw == null || raw.isEmpty) return const {};
    final decoded = jsonDecode(raw);
    if (decoded is Map) {
      return decoded.map((k, v) => MapEntry(k.toString(), v?.toString() ?? ''));
    }
    return const {};
  }

  @override
  Future<void> writeSettings(Map<String, String> settings) async {
    _mem[SecureStore.kSettings] = jsonEncode(settings);
  }
}

void main() {
  testWidgets('App boots to onboarding', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          secureStoreProvider.overrideWithValue(_MemoryStore()),
        ],
        child: const PicWallApp(),
      ),
    );
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('PicWall 图墙'), findsOneWidget);
  });
}
