import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

import 'debug_service.dart';

/// GitHub 仓库信息（用于版本检查和 APK 下载）。
class GitHubRepo {
  const GitHubRepo({required this.owner, required this.repo});
  final String owner;
  final String repo;

  String get releasesUrl =>
      'https://api.github.com/repos/$owner/$repo/releases/latest';
}

/// 版本检查结果。
class UpdateInfo {
  const UpdateInfo({
    required this.latestVersion,
    required this.currentVersion,
    required this.downloadUrl,
    required this.body,
    this.publishedAt,
  });

  final String latestVersion;
  final String currentVersion;
  final String downloadUrl;
  final String body;
  final String? publishedAt;

  bool get hasUpdate => _compareVersions(latestVersion, currentVersion) > 0;

  /// 语义化版本比较：返回 >0 表示 a > b。
  static int _compareVersions(String a, String b) {
    final pa = a.split('.').map(int.tryParse).toList();
    final pb = b.split('.').map(int.tryParse).toList();
    for (var i = 0; i < 3; i++) {
      final va = (i < pa.length ? pa[i] : 0) ?? 0;
      final vb = (i < pb.length ? pb[i] : 0) ?? 0;
      if (va != vb) return va - vb;
    }
    return 0;
  }
}

/// 应用更新服务：检查 GitHub Releases + 下载 APK。
class UpdateService {
  UpdateService._();
  static final instance = UpdateService._();

  static const _repo = GitHubRepo(owner: 'ichq1069', repo: 'telegram-r2-worker');
  static const _lastCheckKey = 'last_update_check';
  static const _autoCheckKey = 'auto_update_check';

  final Dio _dio = Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 30),
    headers: {'Accept': 'application/vnd.github.v3+json'},
  ));

  DateTime? _lastCheck;
  bool _autoCheck = true;
  bool _checking = false;

  bool get checking => _checking;
  bool get autoCheck => _autoCheck;
  DateTime? get lastCheck => _lastCheck;

  /// 初始化：从本地存储恢复设置。
  void init({DateTime? lastCheck, bool autoCheck = true}) {
    _lastCheck = lastCheck;
    _autoCheck = autoCheck;
  }

  void setAutoCheck(bool value) {
    _autoCheck = value;
  }

  /// 检查是否有新版本。
  Future<UpdateInfo?> checkForUpdate() async {
    if (_checking) return null;
    _checking = true;
    try {
      final resp = await _dio.get<Map<String, dynamic>>(_repo.releasesUrl);
      final data = resp.data;
      if (data == null) return null;

      final tagName = (data['tag_name'] ?? '').toString().replaceFirst('v', '');
      if (tagName.isEmpty) return null;

      final currentInfo = await PackageInfo.fromPlatform();
      final currentVersion = currentInfo.version;

      // 查找 APK 下载链接
      String downloadUrl = '';
      final assets = data['assets'] as List<dynamic>?;
      if (assets != null) {
        for (final asset in assets) {
          final name = (asset['name'] ?? '').toString();
          if (name.endsWith('.apk')) {
            downloadUrl = (asset['browser_download_url'] ?? '').toString();
            break;
          }
        }
      }

      final body = (data['body'] ?? '').toString();
      final publishedAt = (data['published_at'] ?? '').toString();

      _lastCheck = DateTime.now();

      return UpdateInfo(
        latestVersion: tagName,
        currentVersion: currentVersion,
        downloadUrl: downloadUrl,
        body: body,
        publishedAt: publishedAt,
      );
    } catch (e) {
      DebugService.instance.recordError('UpdateService.check', e);
      return null;
    } finally {
      _checking = false;
    }
  }

  /// 下载 APK 到本地临时目录，返回文件路径。
  Future<String?> downloadApk(
    String url, {
    void Function(double progress)? onProgress,
  }) async {
    try {
      final dir = await getTemporaryDirectory();
      final filePath = '${dir.path}/picwall_update.apk';

      await _dio.download(
        url,
        filePath,
        onReceiveProgress: (received, total) {
          if (total > 0) {
            onProgress?.call(received / total);
          }
        },
      );

      return filePath;
    } catch (e) {
      DebugService.instance.recordError('UpdateService.download', e);
      return null;
    }
  }
}
