import 'dart:async';
import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:uuid/uuid.dart';

import 'debug_service.dart';

/// App 统计服务：安装上报 + 心跳保活。
///
/// 首次启动生成唯一 device_id（持久化到本地），上报安装信息；
/// 之后每 30 分钟发送一次心跳，服务端据此计算在线数和存活率。
class StatsService {
  StatsService._();
  static final StatsService instance = StatsService._();

  static const _heartbeatInterval = Duration(minutes: 30);
  Timer? _heartbeatTimer;
  String? _deviceId;
  String _apiBase = '';
  String _apiKey = '';

  /// 初始化统计服务：生成/读取 device_id，上报安装，启动心跳。
  Future<void> init({required String apiBase, required String apiKey}) async {
    _apiBase = apiBase;
    _apiKey = apiKey;
    if (_apiBase.isEmpty || _apiKey.isEmpty) return;
    try {
      _deviceId = await _getOrCreateDeviceId();
      await _reportInstall();
      _startHeartbeat();
    } catch (e) {
      DebugService.instance.recordError('StatsService.init', e);
    }
  }

  /// 更新 API 配置（切换服务器时调用）。
  void updateConfig({required String apiBase, required String apiKey}) {
    _apiBase = apiBase;
    _apiKey = apiKey;
    if (_heartbeatTimer != null) {
      _heartbeatTimer!.cancel();
      _heartbeatTimer = null;
    }
    if (_apiBase.isNotEmpty && _apiKey.isNotEmpty) {
      _reportInstall().catchError((e) => DebugService.instance.recordError('StatsService.reinstall', e));
      _startHeartbeat();
    }
  }

  /// 停止心跳（app 进入后台时可选调用）。
  void stop() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
  }

  // ─── 内部实现 ────────────────────────────────────────

  Future<void> _startHeartbeat() async {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(_heartbeatInterval, (_) => _sendHeartbeat());
  }

  Future<void> _sendHeartbeat() async {
    if (_apiBase.isEmpty || _deviceId == null) return;
    try {
      final info = await PackageInfo.fromPlatform();
      final dio = Dio(BaseOptions(
        baseUrl: _apiBase,
        headers: {'X-API-Key': _apiKey},
        connectTimeout: const Duration(seconds: 10),
        receiveTimeout: const Duration(seconds: 10),
      ));
      await dio.post('/api/app/stats/heartbeat', data: {
        'device_id': _deviceId,
        'app_version': info.version,
        'build_number': int.tryParse(info.buildNumber) ?? 0,
      });
    } catch (e) {
      DebugService.instance.recordError('StatsService.heartbeat', e);
    }
  }

  Future<void> _reportInstall() async {
    if (_apiBase.isEmpty || _deviceId == null) return;
    try {
      final info = await PackageInfo.fromPlatform();
      final deviceInfo = await _getDeviceInfo();
      final dio = Dio(BaseOptions(
        baseUrl: _apiBase,
        headers: {'X-API-Key': _apiKey},
        connectTimeout: const Duration(seconds: 10),
        receiveTimeout: const Duration(seconds: 10),
      ));
      await dio.post('/api/app/stats/install', data: {
        'device_id': _deviceId,
        'app_version': info.version,
        'build_number': int.tryParse(info.buildNumber) ?? 0,
        'platform': Platform.operatingSystem,
        'model': deviceInfo['model'] ?? '',
        'os_version': deviceInfo['os_version'] ?? '',
        'screen_width': deviceInfo['screen_width'] ?? 0,
        'screen_height': deviceInfo['screen_height'] ?? 0,
      });
    } catch (e) {
      DebugService.instance.recordError('StatsService.install', e);
    }
  }

  Future<Map<String, dynamic>> _getDeviceInfo() async {
    try {
      final plugin = DeviceInfoPlugin();
      if (Platform.isAndroid) {
        final android = await plugin.androidInfo;
        return {
          'model': '${android.manufacturer} ${android.model}',
          'os_version': 'Android ${android.version.release} (API ${android.version.sdkInt})',
          'screen_width': 0,
          'screen_height': 0,
        };
      } else if (Platform.isIOS) {
        final ios = await plugin.iosInfo;
        return {
          'model': ios.model,
          'os_version': 'iOS ${ios.systemVersion}',
          'screen_width': 0,
          'screen_height': 0,
        };
      }
    } catch (e) {
      DebugService.instance.recordError('StatsService.deviceInfo', e);
    }
    return {};
  }

  /// 生成或读取持久化 device_id（基于 UUID v4，存入本地文件）。
  Future<String> _getOrCreateDeviceId() async {
    // 使用简单文件存储，避免引入额外依赖
    final dir = Directory.current;
    final idFile = File('${dir.path}/.picwall_device_id');
    if (await idFile.exists()) {
      final id = (await idFile.readAsString()).trim();
      if (id.isNotEmpty) return id;
    }
    final newId = const Uuid().v4();
    await idFile.writeAsString(newId);
    return newId;
  }
}
