import 'dart:convert';

import '../../services/api_client.dart';
import '../../services/secure_store.dart';
import '../models/user.dart';

/// 认证仓库：登录/注册/兑换 + 会话持久化。
class AuthRepository {
  AuthRepository(this._api, this._store);

  final ApiClient _api;
  final SecureStore _store;

  /// 用户名 + 密钥密码登录。
  Future<UserSession> login({
    required String username,
    required String keyPass,
  }) async {
    final d = await _api.postData(
      '/api/user/login',
      body: {
        'username': username,
        'key_pass': keyPass,
      },
      noKey: true,
    ) as Map<String, dynamic>;
    return UserSession.fromLoginJson(d, keyPass);
  }

  /// 注册（用户名+密码+兑换码）。
  Future<UserSession> register({
    required String username,
    required String password,
    required String redeemCode,
  }) async {
    final d = await _api.postData(
      '/api/user/register',
      body: {
        'username': username,
        'password': password,
        'code': redeemCode,
      },
      noKey: true,
    ) as Map<String, dynamic>;
    return UserSession.fromLoginJson(d, password);
  }

  /// 兑换升级/延时码；需要当前 key + key_pass。
  Future<Map<String, dynamic>> redeem({
    required String key,
    required String keyPass,
    required String code,
  }) async {
    final d = await _api.postData(
      '/api/user/redeem',
      body: {
        'key': key,
        'key_pass': keyPass,
        'code': code,
      },
      noKey: true,
    ) as Map<String, dynamic>;
    return d;
  }

  /// 服务健康检查（用于 Onboarding 确认服务器可达）。
  Future<bool> health() async {
    final resp = await _api.getRaw('/health', noKey: true);
    return resp['ok'] == true || resp['status'] == 'ok' || resp['status'] == 'OK';
  }

  Future<void> saveSession(UserSession s) => _store.write(
        SecureStore.kSession,
        jsonEncode(s.toJson()),
      );

  Future<void> saveKeyPass(String keyPass) => _store.write(SecureStore.kKeyPass, keyPass);

  Future<String?> readKeyPass() => _store.read(SecureStore.kKeyPass);

  Future<UserSession?> readSession() async {
    final raw = await _store.read(SecureStore.kSession);
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) {
        return UserSession.fromJson(Map<String, dynamic>.from(decoded));
      }
    } catch (_) {}
    return null;
  }

  Future<void> clearSession() async {
    await _store.delete(SecureStore.kSession);
    await _store.delete(SecureStore.kKeyPass);
  }
}
