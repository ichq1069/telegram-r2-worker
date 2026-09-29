# PicWall Android 客户端

路径 `android/picwall_app`。Flutter，Riverpod。默认 API `https://telegram-r2-bot.wo58.cn`，CDN `https://telegramup.wo58.cn`（`lib/core/constants.dart`）。版本见 `pubspec.yaml`（仓库 `0.2.1+1`，CI 用 run number 改 build）。

## 功能

| 模块 | 说明 |
|---|---|
| 发现 | 采集配置（Telegram/Reddit/Bilibili/微博等）、触发、看结果 |
| 画廊 | 瀑布流、收藏、详情、抖音流、视频软解（media_kit） |
| 上传 | 相册/拍照/URL、WiFi-only、队列 |
| 相册同步 | 增量扫描、前台服务后台同步、类型/大小过滤 |
| 管理 | 统计、回收站、库管理、采集规则（连点版本号 5 次） |
| 设置 | 主题、服务器、缓存、应用锁（3×3 + 生物识别） |

入口：`lib/main.dart` → `PicWallApp` → `RootGate`（锁 → 引导 → 登录 → Shell）。

## 构建

仓库只提交 Dart。CI `flutter create --platforms=android` 后注入 Manifest 权限与前台服务，再 analyze/test/打包。固定 keystore 重签，见 [部署流水线](./部署流水线.md)。

沙箱无 Flutter：Android 逻辑验证只能 push 触发 `build-android.yml`。`flutter analyze` 的 info 也会失败。

## 视频

ExoPlayer 总带 Range。服务端 ranged 请求必须懒转存并正确回 206，否则表现为加载很久不播放。封面不要用整段 mp4 当地址。
