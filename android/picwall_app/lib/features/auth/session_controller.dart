import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants.dart';
import '../../data/models/user.dart';
import '../../data/repositories/auth_repository.dart';
import '../../services/providers.dart';
import '../../services/settings.dart';

/// 会话状态机：记录登录态、登录流程。
class SessionController extends ChangeNotifier {
  SessionController(this._ref);

  final Ref _ref;

  AuthRepository get _auth => _ref.read(authRepositoryProvider);
  SettingsController get _settings => _ref.read(settingsControllerProvider);

  UserSession? _session;
  bool _initialized = false;
  bool _busy = false;
  String? _error;

  UserSession? get session => _session;
  bool get initialized => _initialized;
  bool get busy => _busy;
  String? get error => _error;

  /// App 启动：尝试从 secure storage 恢复会话。
  Future<void> restore() async {
    if (_initialized) return;
    _initialized = true;
    try {
      final s = await _auth.readSession();
      if (s != null && s.key.isNotEmpty) {
        _session = s;
        // apiKey 保持同步到设置
        if (_settings.settings.apiKey != s.key) {
          await _settings.saveApiKey(s.key);
        }
      }
    } catch (e) {
      _error = e.toString();
    }
    notifyListeners();
  }

  /// 登录。remember 时保存 key_pass。
  Future<bool> login({
    required String username,
    required String keyPass,
    required bool rememberPass,
  }) async {
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      final s = await _auth.login(username: username, keyPass: keyPass);
      final persisted = UserSession(
        key: s.key,
        keyPass: rememberPass ? keyPass : '',
        id: s.id,
        name: s.name,
        username: s.username.isNotEmpty ? s.username : username,
        level: s.level,
        expiresAt: s.expiresAt,
        rememberPass: rememberPass,
      );
      await _auth.saveSession(persisted);
      await _settings.saveApiKey(s.key);
      if (rememberPass) await _auth.saveKeyPass(keyPass);
      _session = persisted;
      return true;
    } catch (e) {
      _error = e.toString();
      return false;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// 注册。
  Future<bool> register({
    required String username,
    required String password,
    required String redeemCode,
    required bool rememberPass,
  }) async {
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      final s = await _auth.register(
        username: username,
        password: password,
        redeemCode: redeemCode,
      );
      final persisted = UserSession(
        key: s.key,
        keyPass: rememberPass ? password : '',
        id: s.id,
        name: s.name.isNotEmpty ? s.name : username,
        username: username,
        level: s.level,
        expiresAt: '',
        rememberPass: rememberPass,
      );
      await _auth.saveSession(persisted);
      await _settings.saveApiKey(s.key);
      if (rememberPass) await _auth.saveKeyPass(password);
      _session = persisted;
      return true;
    } catch (e) {
      _error = e.toString();
      return false;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// 兑换升级/延时：成功后用返回值更新本地级别/到期。
  Future<String?> redeem(String code) async {
    final s = _session;
    if (s == null) return '请先登录';
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      final d = await _auth.redeem(key: s.key, keyPass: s.keyPass, code: code);
      final action = d['action']?.toString() ?? '';
      String? levelWire;
      String? expires;
      if (action == 'upgrade') levelWire = d['level']?.toString();
      if (action == 'extend') expires = d['expires_at']?.toString();
      final updated = UserSession(
        key: s.key,
        keyPass: s.keyPass,
        id: s.id,
        name: s.name,
        username: s.username,
        level: levelWire != null ? levelFromWire(levelWire) : s.level,
        expiresAt: expires ?? s.expiresAt,
        rememberPass: s.rememberPass,
      );
      _session = updated;
      await _auth.saveSession(updated);
      return null;
    } catch (e) {
      return e.toString();
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  Future<void> logout() async {
    _session = null;
    await _auth.clearSession();
    notifyListeners();
  }
}

/// 会话控制器 provider。App 启动时调用 restore()。
final sessionControllerProvider =
    ChangeNotifierProvider<SessionController>(
      (ref) => SessionController(ref),
    );
