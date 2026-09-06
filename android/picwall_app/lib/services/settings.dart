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
  });

  String apiBase;
  String cdnBase;
  String apiKey;
  String adminKey;
  bool onboarded;
  bool wifiOnlyUpload;

  bool get configured => apiBase.isNotEmpty;

  /// 直链归一：相对路径拼 apiBase，绝对直链原样。
  String resolve(String? url) {
    if (url == null || url.isEmpty) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/')) return '$apiBase$url';
    return '$apiBase/$url';
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

  Future<void> _persist() async {
    await _secure.writeSettings({
      'apiBase': _settings.apiBase,
      'cdnBase': _settings.cdnBase,
      'apiKey': _settings.apiKey,
      'adminKey': _settings.adminKey,
      'onboarded': _settings.onboarded ? '1' : '0',
      'wifiOnlyUpload': _settings.wifiOnlyUpload ? '1' : '0',
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
