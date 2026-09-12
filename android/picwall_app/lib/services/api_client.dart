import 'dart:io';

import 'package:dio/dio.dart';

import '../core/constants.dart';

/// 基于配置的 API 客户端：注入 apiKey、统一错误归一。
class ApiClient {
  ApiClient({required String baseUrl, String apiKey = ''})
      : _apiKey = apiKey,
        _dio = Dio(
          BaseOptions(
            baseUrl: baseUrl,
            connectTimeout: const Duration(milliseconds: AppDefaults.connectTimeoutMs),
            receiveTimeout: const Duration(seconds: 60),
            headers: {'Content-Type': 'application/json'},
          ),
        ),
        _upDio = Dio(
          BaseOptions(
            baseUrl: baseUrl,
            connectTimeout: const Duration(milliseconds: AppDefaults.connectTimeoutMs),
            receiveTimeout: const Duration(seconds: 120),
            sendTimeout: const Duration(milliseconds: AppDefaults.uploadTimeoutMs),
          ),
        );

  final String _apiKey;
  final Dio _dio;
  final Dio _upDio;

  Dio get dio => _dio;

  Options _opts({bool long = false, bool noKey = false}) {
    final headers = <String, dynamic>{};
    if (!noKey && _apiKey.isNotEmpty) headers['X-API-Key'] = _apiKey;
    return Options(
      headers: headers,
      sendTimeout: long
          ? const Duration(milliseconds: AppDefaults.uploadTimeoutMs)
          : const Duration(milliseconds: AppDefaults.connectTimeoutMs),
      receiveTimeout: long
          ? const Duration(seconds: 240)
          : const Duration(seconds: 60),
    );
  }

  /// GET，返回 {ok:true,...} 中的 data。
  Future<dynamic> getData(
    String path, {
    Map<String, dynamic>? query,
    bool noKey = false,
  }) async {
    final resp = await _dio.get<Map<String, dynamic>>(
      path,
      queryParameters: query,
      options: _opts(noKey: noKey),
    );
    final body = resp.data;
    if (body == null) throw ApiException('空响应');
    _ensureOk(body);
    return body['data'];
  }

  /// GET 原样返回整包（部分接口如 admin/stats 结构不定）。
  Future<Map<String, dynamic>> getRaw(
    String path, {
    Map<String, dynamic>? query,
    bool noKey = false,
  }) async {
    final resp = await _dio.get<Map<String, dynamic>>(
      path,
      queryParameters: query,
      options: _opts(noKey: noKey),
    );
    return resp.data ?? const {};
  }

  /// POST，返回 {ok:true,...} 中的 data。
  Future<dynamic> postData(
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    bool noKey = false,
    bool long = false,
  }) async {
    final resp = await _dio.post<Map<String, dynamic>>(
      path,
      data: body,
      queryParameters: query,
      options: _opts(noKey: noKey, long: long),
    );
    final data = resp.data;
    if (data == null) throw ApiException('空响应');
    _ensureOk(data);
    return data['data'];
  }

  /// POST，返回完整响应 map（供个别需要 total 等顶层字段的接口）。
  Future<Map<String, dynamic>> postRaw(
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    bool noKey = false,
    bool long = false,
  }) async {
    final resp = await _dio.post<Map<String, dynamic>>(
      path,
      data: body,
      queryParameters: query,
      options: _opts(noKey: noKey, long: long),
    );
    return resp.data ?? const {};
  }

  /// DELETE，返回完整响应 map。
  Future<Map<String, dynamic>> deleteRaw(
    String path, {
    Map<String, dynamic>? query,
    bool noKey = false,
  }) async {
    final resp = await _dio.delete<Map<String, dynamic>>(
      path,
      queryParameters: query,
      options: _opts(noKey: noKey),
    );
    return resp.data ?? const {};
  }

  /// 上传：multipart POST，files 统一以字段名 [field] 提交。
  /// 返回后端完整响应 map（data.results 含每张结果）。
  Future<Map<String, dynamic>> postMultipart(
    String path, {
    required List<MultipartFile> files,
    String field = 'files',
    Map<String, dynamic>? query,
    bool noKey = false,
  }) async {
    final form = FormData();
    for (final f in files) {
      form.files.add(MapEntry(field, f));
    }
    final resp = await _upDio.post<Map<String, dynamic>>(
      path,
      data: form,
      queryParameters: query,
      options: Options(
        headers: noKey || _apiKey.isEmpty ? null : {'X-API-Key': _apiKey},
        sendTimeout: const Duration(milliseconds: AppDefaults.uploadTimeoutMs),
      ),
    );
    final body = resp.data;
    if (body == null) throw ApiException('空响应');
    return body;
  }

  void _ensureOk(Map<String, dynamic> body) {
    if (body['ok'] != true) {
      throw ApiException(
        (body['error'] ?? '请求失败').toString(),
        hint: body['hint']?.toString(),
      );
    }
  }
}

/// 业务错误（带可选提示）。
class ApiException implements Exception {
  ApiException(this.message, {this.hint});

  final String message;
  final String? hint;

  @override
  String toString() {
    if (hint != null && hint!.isNotEmpty) return '$message（$hint）';
    return message;
  }
}

/// 将 dio / 网络异常归一为 ApiException。
ApiException normalizeError(Object e) {
  if (e is ApiException) return e;
  if (e is DioException) {
    switch (e.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
        return ApiException('网络超时，请检查服务器地址或稍后重试');
      case DioExceptionType.connectionError:
        return ApiException('无法连接服务器，请检查网络或地址');
      case DioExceptionType.badResponse:
        final status = e.response?.statusCode;
        final data = e.response?.data;
        final msg = data is Map
            ? data['error']?.toString() ?? data['message']?.toString()
            : null;
        if (status == 401) return ApiException('未授权或密钥已失效，请重新登录');
        if (status == 429) return ApiException('请求过于频繁，请稍后再试');
        if (status != null && status >= 500) {
          return ApiException(msg ?? '服务器错误（$status）');
        }
        return ApiException(msg ?? '请求失败（$status）');
      case DioExceptionType.cancel:
        return ApiException('请求已取消');
      default:
        return ApiException('网络错误');
    }
  }
  if (e is SocketException) return ApiException('网络连接失败');
  return ApiException(e.toString());
}
