/// 全局常量与默认端点。
class AppDefaults {
  AppDefaults._();

  /// API 入口（Worker）
  static const String apiBase = 'https://telegram-r2-bot.wo58.cn';

  /// R2 静态直链（作为 cdnBase 默认值；多数直链由后端签名返回，原样使用）
  static const String cdnBase = 'https://telegramup.wo58.cn';

  /// 网络超时
  static const int connectTimeoutMs = 30000;
  static const int uploadTimeoutMs = 240000;
}

/// 用户内容级别（与后端 level 字段对齐，未分级默认 pt）。
enum UserLevel {
  pt,
  vip,
  svip,
  vvip,
}

extension UserLevelX on UserLevel {
  String get wire => name;

  String get label {
    switch (this) {
      case UserLevel.pt:
        return '基础';
      case UserLevel.vip:
        return 'VIP';
      case UserLevel.svip:
        return 'SVIP';
      case UserLevel.vvip:
        return 'VVIP';
    }
  }

  int get rank {
    switch (this) {
      case UserLevel.pt:
        return 0;
      case UserLevel.vip:
        return 1;
      case UserLevel.svip:
        return 2;
      case UserLevel.vvip:
        return 3;
    }
  }
}

/// 解析字符串级别（未知值兜底为 pt）。
UserLevel levelFromWire(String? s) {
  switch (s) {
    case 'vip':
      return UserLevel.vip;
    case 'svip':
      return UserLevel.svip;
    case 'vvip':
      return UserLevel.vvip;
    default:
      return UserLevel.pt;
  }
}

/// 当前密钥级别能否查看目标内容级别。
bool canSee(UserLevel keyLevel, UserLevel target, {bool isPrivate = false}) {
  if (isPrivate) return keyLevel == UserLevel.vvip;
  return keyLevel.rank >= target.rank;
}
