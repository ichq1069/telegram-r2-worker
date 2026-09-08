import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

import '../core/constants.dart';
import 'debug_service.dart';

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

  /// 语义化版本比较（含 build 号）：返回 >0 表示 a > b。
  /// 解析时兼容 v 前缀与 `X.Y.Z+build` / `X.Y.Z-build` 写法。
  static int _compareVersions(String a, String b) {
    final pa = _parts(a);
    final pb = _parts(b);
    final n = pa.length > pb.length ? pa.length : pb.length;
    for (var i = 0; i < n; i++) {
      final va = i < pa.length ? pa[i] : 0;
      final vb = i < pb.length ? pb[i] : 0;
      if (va != vb) return va - vb;
    }
    return 0;
  }

  static List<int> _parts(String v) {
    final clean = v.trim().replaceFirst(RegExp(r'^[vV]'), '');
    return clean
        .split(RegExp(r'[.\-+]'))
        .map((s) => int.tryParse(s) ?? 0)
        .toList();
  }
}

/// 应用更新服务：请求同源 Worker `/api/app/update`（Worker 读 R2 公开静态托管清单）。
///
/// 更新链路：CI 构建成功 → 上传 APK + apk/latest.json 到 R2（telegramup.wo58.cn）
/// → App 请求 `{apiBase}/api/app/update` 拿最新版本号与 APK 直链 → 下载安装。
class UpdateService {
  UpdateService._();
  static final UpdateService instance = UpdateService._();

  final Dio _dio = Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 30),
  ));

  /// 原生安装通道（Android 侧经 FileProvider 以 content:// 拉起安装器）。
  static const MethodChannel _installChannel = MethodChannel('picwall/install');

  String _apiBase = '';
  DateTime? _lastCheck;
  bool _autoCheck = true;
  bool _checking = false;

  bool get checking => _checking;
  bool get autoCheck => _autoCheck;
  DateTime? get lastCheck => _lastCheck;

  /// 用当前配置的 API 根地址驱动更新检查。
  void init({DateTime? lastCheck, bool autoCheck = true, String? apiBase}) {
    _lastCheck = lastCheck;
    _autoCheck = autoCheck;
    if (apiBase != null && apiBase.trim().isNotEmpty) {
      _apiBase = apiBase.trim().replaceAll(RegExp(r'/+$'), '');
    }
  }

  /// 切换服务器后同步更新源地址。
  void updateConfig({required String apiBase}) {
    _apiBase = apiBase.trim().replaceAll(RegExp(r'/+$'), '');
  }

  void setAutoCheck(bool value) {
    _autoCheck = value;
  }

  String _base() {
    if (_apiBase.isNotEmpty) return _apiBase;
    return AppDefaults.apiBase.replaceAll(RegExp(r'/+$'), '');
  }

  /// 检查是否有新版本（Worker 读取 R2 清单，返回 ok + version + download_url）。
  Future<UpdateInfo?> checkForUpdate() async {
    if (_checking) return null;
    _checking = true;
    try {
      final base = _base();
      final resp = await _dio.get<Map<String, dynamic>>('$base/api/app/update');
      final data = resp.data;
      if (data == null) return null;
      if (data['ok'] != true) return null;

      final version = (data['version'] ?? '')
          .toString()
          .replaceFirst(RegExp(r'^[vV]'), '');
      if (version.isEmpty) return null;

      final currentInfo = await PackageInfo.fromPlatform();
      // 带上 build 号比较，保证仅 bump 构建号时也能识别到新版本。
      final build = currentInfo.buildNumber.trim();
      final currentVersion = build.isEmpty
          ? currentInfo.version
          : '${currentInfo.version}+$build';

      final downloadUrl = (data['download_url'] ?? '').toString();
      // 清单缺 APK 直链（R2_PUBLIC_URL 未配置等）视为暂无可用更新源，避免可更新但下载必败。
      if (downloadUrl.isEmpty) return null;

      _lastCheck = DateTime.now();

      return UpdateInfo(
        latestVersion: version,
        currentVersion: currentVersion,
        downloadUrl: downloadUrl,
        body: (data['body'] ?? '').toString(),
        publishedAt: (data['published_at'] ?? '').toString(),
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

  /// 拉起系统安装器安装已下载的 APK。
  ///
  /// Android 通过 MethodChannel 走 FileProvider（content:// + 读授权），
  /// 避免 file:// 触发 FileUriExposedException；异常转成可读错误抛出。
  Future<void> installApk(String path) async {
    try {
      final ok = await _installChannel.invokeMethod<bool>('installApk', {
        'path': path,
      });
      if (ok != true) {
        throw Exception('未能启动安装程序');
      }
    } on PlatformException catch (e) {
      final msg = switch (e.code) {
        'no_installer' => '未找到可用的安装程序',
        'bad_argument' => '安装参数无效',
        _ => (e.message == null || e.message!.isEmpty)
            ? '无法安装（${e.code}）'
            : e.message!,
      };
      throw Exception(msg);
    } on MissingPluginException {
      throw Exception('当前设备不支持自动安装，请手动安装 APK');
    }
  }
}
