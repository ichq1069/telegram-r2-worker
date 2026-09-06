import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 安全存储封装：密钥/口令/会话/配置仅存 Keystore 加密区。
class SecureStore {
  SecureStore([FlutterSecureStorage? storage])
      : _s = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _s;

  static const String kSettings = 'pw_settings_v1';
  static const String kSession = 'pw_session_v1';
  static const String kKeyPass = 'pw_keypass_v1';

  Future<String?> read(String key) => _s.read(key: key);
  Future<void> write(String key, String value) => _s.write(key: key, value: value);
  Future<void> delete(String key) => _s.delete(key: key);

  /// 配置表整体读写（JSON map of string）。
  Future<Map<String, String>> readSettings() async {
    final raw = await _s.read(key: kSettings);
    if (raw == null || raw.isEmpty) return const {};
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) {
        return decoded.map((k, v) => MapEntry(k.toString(), v?.toString() ?? ''));
      }
    } catch (_) {}
    return const {};
  }

  Future<void> writeSettings(Map<String, String> settings) =>
      write(kSettings, jsonEncode(settings));

  Future<String?> readApiKey() async => (await readSettings())['apiKey'];

  Future<void> writeApiKey(String value) async {
    final s = await readSettings();
    s['apiKey'] = value;
    await writeSettings(s);
  }

  Future<String?> readAdminKey() async => (await readSettings())['adminKey'];

  Future<void> writeAdminKey(String value) async {
    final s = await readSettings();
    s['adminKey'] = value;
    await writeSettings(s);
  }
}
