import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:media_kit/media_kit.dart';

import 'app.dart';
import 'features/sync/sync_background.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (Platform.isAndroid) {
    // media_kit(mpv/ffmpeg)：ExoPlayer 解码不支持时软解回退所需的原生初始化。
    try {
      MediaKit.ensureInitialized();
    } catch (e) {
      debugPrint('MediaKit.ensureInitialized failed: $e');
    }
    await SyncService.init();
  }
  runApp(const ProviderScope(child: PicWallApp()));
}
