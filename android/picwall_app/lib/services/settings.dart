import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

import '../core/constants.dart';
import 'secure_store.dart';

/// 应用运行配置：双端点 + 可选密钥。持久化于 secure storage。
class AppSettings {
  AppSettings({
    this.apiBase = AppDefaults.apiBase,
    this.cdnBase = AppDefaults.cdnBase,
    this.apiKey = '',
    this.adminKey = '',
    this.onboarded = false,
    this.wifiOnlyUpload = false,
    this.lockEnabled = false,
    this.lockBiometric = false,
    this.lockPattern = '',
    this.themeMode = 'dark',
  });

  String apiBase;
  String cdnBase;
  String apiKey;
  String adminKey;
  bool onboarded;
  bool wifiOnlyUpload;
  bool lockEnabled;
  bool lockBiometric;

  /// 存储为 `salt:sha256hex`；仅在解锁校验时本地比对，不落明文。
  String lockPattern;

  /// 外观：system / light / dark。
  String themeMode;

  bool get hasPattern => lockPattern.isNotEmpty;

  bool get configured => apiBase.isNotEmpty;

  /// 直链归一：相对路径拼 apiBase，绝对直链原样。
  String resolve(String? url) {
    if (url == null || url.isEmpty) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/')) return '$apiBase$url';
    return '$apiBase/$url';
  }
}

/// 应用锁工具：图案序列号 -> 加盐哈希比对。
class AppLock {
  /// 校验图案格式：3x3 九个点 index 0..8 的去重序列，长度 >= 4。
  static bool valid(List<int> seq) {
    if (seq.length < 4) return false;
    if (seq.length > 9) return false;
    final set = <int>{};
    for (final i in seq) {
      if (i < 0 || i > 8 || !set.add(i)) return false;
    }
    return true;
  }

  static String salt() {
    final r = Random.secure();
    return List.generate(8, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
  }

  static String _hash(String salt, String seq) =>
      sha256.convert(utf8.encode('pw-lock:$salt:$seq')).toString();

  /// 生成可持久化串 `salt:hash`。
  static String encode(String seq) {
    final s = salt();
    return '$s:${_hash(s, seq)}';
  }

  static bool verify(String stored, String seq) {
    final idx = stored.indexOf(':');
    if (idx <= 0) return false;
    final salt = stored.substring(0, idx);
    return _hash(salt, seq) == stored.substring(idx + 1);
  }
}

/// 配置控制器：ChangeNotifier，供 Riverpod 监听与持久化。
class SettingsController extends ChangeNotifier {
  SettingsController(this._secure);

  final SecureStore _secure;

  AppSettings _settings = AppSettings();
  bool _loaded = false;
  String? _error;

  AppSettings get settings => _settings;
  bool get loaded => _loaded;
  String? get error => _error;

  Future<void> load() async {
    try {
      final map = await _secure.readSettings();
      _settings = AppSettings(
        apiBase: (map['apiBase']?.isNotEmpty ?? false)
            ? map['apiBase']!
            : AppDefaults.apiBase,
        cdnBase: (map['cdnBase']?.isNotEmpty ?? false)
            ? map['cdnBase']!
            : AppDefaults.cdnBase,
        apiKey: map['apiKey'] ?? '',
        adminKey: map['adminKey'] ?? '',
        onboarded: map['onboarded'] == '1',
        wifiOnlyUpload: map['wifiOnlyUpload'] == '1',
        lockEnabled: map['lockEnabled'] == '1',
        lockBiometric: map['lockBiometric'] == '1',
        lockPattern: map['lockPattern'] ?? '',
        themeMode: map['themeMode'] ?? 'dark',
      );
      _loaded = true;
    } catch (e) {
      _error = e.toString();
    }
    notifyListeners();
  }

  Future<void> save({
    String? apiBase,
    String? cdnBase,
    bool? onboarded,
    bool? wifiOnlyUpload,
  }) async {
    if (apiBase != null && apiBase.trim().isNotEmpty) {
      _settings.apiBase = normalizeHost(apiBase);
    }
    if (cdnBase != null && cdnBase.trim().isNotEmpty) {
      _settings.cdnBase = normalizeHost(cdnBase);
    }
    if (onboarded != null) _settings.onboarded = onboarded;
    if (wifiOnlyUpload != null) _settings.wifiOnlyUpload = wifiOnlyUpload;
    await _persist();
  }
  Future<void> saveApiKey(String key) async {
    _settings.apiKey = key;
    await _persist();
  }

  Future<void> saveAdminKey(String key) async {
    _settings.adminKey = key;
    await _persist();
  }

  /// 更新应用锁配置：enabled 总开关 / biometric 指纹 / pattern 图案(已编码)。
  Future<void> saveAppLock({
    bool? enabled,
    bool? biometric,
    String? pattern,
  }) async {
    if (enabled != null) _settings.lockEnabled = enabled;
    if (biometric != null) _settings.lockBiometric = biometric;
    if (pattern != null) {
      _settings.lockPattern = pattern;
      if (pattern.isEmpty) {
        _settings.lockEnabled = false;
        _settings.lockBiometric = false;
      }
    }
    await _persist();
  }

  Future<void> saveThemeMode(String mode) async {
    if (mode != 'system' && mode != 'light' && mode != 'dark') return;
    _settings.themeMode = mode;
    await _persist();
  }

  Future<void> _persist() async {
    await _secure.writeSettings({
      'apiBase': _settings.apiBase,
      'cdnBase': _settings.cdnBase,
      'apiKey': _settings.apiKey,
      'adminKey': _settings.adminKey,
      'onboarded': _settings.onboarded ? '1' : '0',
      'wifiOnlyUpload': _settings.wifiOnlyUpload ? '1' : '0',
      'lockEnabled': _settings.lockEnabled ? '1' : '0',
      'lockBiometric': _settings.lockBiometric ? '1' : '0',
      'lockPattern': _settings.lockPattern,
      'themeMode': _settings.themeMode,
    });
    notifyListeners();
  }

  /// 容忍用户输入带 https:// / 尾斜杠 / 子路径。
  static String normalizeHost(String input) {
    var s = input.trim();
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    if (!s.startsWith('http://') && !s.startsWith('https://')) {
      s = 'https://$s';
    }
    return s;
  }
}
