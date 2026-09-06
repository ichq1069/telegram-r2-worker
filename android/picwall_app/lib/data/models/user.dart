import '../../core/constants.dart';

/// 登录/注册会话：本地保存的账号状态。
class UserSession {
  const UserSession({
    required this.key,
    required this.keyPass,
    this.id,
    this.name = '',
    this.username = '',
    this.level = UserLevel.pt,
    this.expiresAt = '',
    this.rememberPass = false,
  });

  final String key;
  final String keyPass;
  final int? id;
  final String name;
  final String username;
  final UserLevel level;
  final String expiresAt;
  final bool rememberPass;

  bool get loggedIn => key.isNotEmpty;

  bool get expired {
    if (expiresAt.isEmpty) return false;
    final d = DateTime.tryParse(expiresAt);
    if (d == null) return false;
    final today = DateTime.now();
    return today.isAfter(DateTime(d.year, d.month, d.day + 1));
  }

  UserSession copyWith({
    String? key,
    String? keyPass,
    int? id,
    String? name,
    String? username,
    UserLevel? level,
    String? expiresAt,
    bool? rememberPass,
  }) {
    return UserSession(
      key: key ?? this.key,
      keyPass: keyPass ?? this.keyPass,
      id: id ?? this.id,
      name: name ?? this.name,
      username: username ?? this.username,
      level: level ?? this.level,
      expiresAt: expiresAt ?? this.expiresAt,
      rememberPass: rememberPass ?? this.rememberPass,
    );
  }

  /// 由 /api/user/login 成功响应 data 构造。
  factory UserSession.fromLoginJson(Map<String, dynamic> d, String keyPass) {
    return UserSession(
      id: d['id'] is num ? (d['id'] as num).toInt() : null,
      key: (d['key'] ?? d['api_key'] ?? '').toString(),
      keyPass: keyPass,
      name: (d['name'] ?? d['username'] ?? '').toString(),
      username: d['username']?.toString() ?? '',
      level: levelFromWire(d['level']?.toString()),
      expiresAt: d['expires_at']?.toString() ?? '',
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'key': key,
        'keyPass': keyPass,
        'name': name,
        'username': username,
        'level': level.wire,
        'expiresAt': expiresAt,
        'rememberPass': rememberPass,
      };

  factory UserSession.fromJson(Map<String, dynamic> j) {
    return UserSession(
      id: j['id'] is num ? (j['id'] as num).toInt() : null,
      key: j['key']?.toString() ?? '',
      keyPass: j['keyPass']?.toString() ?? '',
      name: j['name']?.toString() ?? '',
      username: j['username']?.toString() ?? '',
      level: levelFromWire(j['level']?.toString()),
      expiresAt: j['expiresAt']?.toString() ?? '',
      rememberPass: j['rememberPass'] == true,
    );
  }
}

/// 配额信息（/api/v1/user/quota）。
class QuotaInfo {
  const QuotaInfo({
    this.uploadQuota = 0,
    this.uploadUsed = 0,
    this.storageUsed = 0,
    this.files = 0,
    this.photos = 0,
    this.videos = 0,
  });

  final int uploadQuota;
  final int uploadUsed;
  final int storageUsed;
  final int files;
  final int photos;
  final int videos;

  int get quotaLeft => (uploadQuota - uploadUsed) < 0 ? 0 : uploadQuota - uploadUsed;
  double get ratio => uploadQuota <= 0 ? 0 : (uploadUsed / uploadQuota).clamp(0.0, 1.0);

  factory QuotaInfo.fromJson(Map<String, dynamic> d) {
    int asInt(String k) => d[k] is num ? (d[k] as num).toInt() : 0;
    return QuotaInfo(
      uploadQuota: asInt('upload_quota'),
      uploadUsed: asInt('upload_used'),
      storageUsed: asInt('storage_used'),
      files: asInt('files'),
      photos: asInt('photos'),
      videos: asInt('videos'),
    );
  }
}
