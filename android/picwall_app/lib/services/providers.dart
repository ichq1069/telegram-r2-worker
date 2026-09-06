import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/local/local_db.dart';
import '../data/repositories/auth_repository.dart';
import '../data/repositories/gallery_repository.dart';
import 'api_client.dart';
import 'secure_store.dart';
import 'settings.dart';

/// 安全存储。
final secureStoreProvider = Provider<SecureStore>(
  (ref) => SecureStore(),
);

/// 设置控制器（含默认端点 + apiKey + adminKey 持久化）。
final settingsControllerProvider = ChangeNotifierProvider<SettingsController>(
  (ref) => SettingsController(ref.watch(secureStoreProvider))..load(),
);

/// API 客户端：base 来自 settings，注入 apiKey。
final apiClientProvider = Provider<ApiClient>(
  (ref) {
    final settings = ref.watch(settingsControllerProvider);
    return ApiClient(
      baseUrl: settings.settings.apiBase,
      apiKey: settings.settings.apiKey,
    );
  },
);

/// 认证仓库。
final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => AuthRepository(
    ref.watch(apiClientProvider),
    ref.watch(secureStoreProvider),
  ),
);

/// 图库仓库。
final galleryRepositoryProvider = Provider<GalleryRepository>(
  (ref) => GalleryRepository(ref.watch(apiClientProvider)),
);

/// 本地库（收藏/历史，sqflite）。懒加载：仅进入收藏/历史/详情页时打开。
final localDbProvider = FutureProvider<LocalDb>(
  (ref) => LocalDb.open(),
);
