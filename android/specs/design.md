# PicWall / 图墙 — Technical Design Document

## Overview

为现有 Worker 内容库提供 Flutter 安卓客户端。代码与后端 Worker 同仓（monorepo）：安卓文件位于仓库 `/android/` 子目录，Worker 位于仓库根。改动路径决定 CI：`android/**` → 安卓 APK 构建；根/其它路径 → Worker 部署。两者 workflow 以 `paths`/`paths-ignore` 隔离。

## Architecture

### 技术栈
- **客户端**: Flutter (stable) + Dart；Material 3，深色沉浸 + 瀑布流，跟随系统深浅色
- **状态管理**: Riverpod (flutter_riverpod)
- **网络**: dio + 自定义拦截器（注入 api_key/密钥鉴权、错误归一、429 退避）；基础 URL 由设置仓库提供
- **本地存储**: flutter_secure_storage（密钥/口令/admin KEY）；drift (SQLite)（收藏、历史、同步游标、上传队列）
- **图片**: cached_network_image + flutter_cache_manager；瀑布流用 masonry (flutter_staggered_grid_view)；详情缩放 photo_view
- **媒体**: video_player + chewie（视频播放）；文档直链打开（webview / 外部分享）
- **相册与同步**: photo_manager（相册浏览/监听增量）；workmanager + 前台服务 + 通知（自动同步）
- **应用锁**: local_auth（指纹）+ 图案锁自绘 fallback
- **构建**: GitHub Actions（ubuntu + Flutter stable + JDK 17）产出 release APK

### 仓库目录结构（monorepo）
```
/workspace/
├── worker.js, admin.html, scrape.html ...     # Worker 侧（现状不动）
├── src/                                        # Worker 后端源码
├── .github/workflows/
│   ├── deploy-worker.yml                       # 加 paths-ignore: android/**
│   └── build-android.yml                       # 新增：android/** 触发 APK 构建
└── android/
    ├── specs/                                  # requirements / design / tasklist（本目录）
    └── picwall_app/                            # Flutter 工程（M1 起在此创建）
```

### 配置与默认端点
设置项持久化于 secure storage（`settings` 表）：
| key | 默认值 | 说明 |
|---|---|---|
| apiBase | `https://telegram-r2-bot.wo58.cn` | API 入口（Worker） |
| cdnBase | `https://telegramup.wo58.cn` | R2 静态直链 |
| apiKey | — | vk_ 用户密钥（登录后写入） |
| keyPass | — | 密钥密码（可选保存） |
| adminKey | — | 管理模式 admin API_KEY |

所有 URL 均以用户配置为准；若响应中的媒体直链以 cdnBase 开头则原样使用，否则拼接用户配置。

## Module Design

### 应用状态与路由
```
App 启动
  ├─ LockGate (应用锁，若开启)
  ├─ Onboarding (服务器地址引导)      ─┐ 未完成 → 阻塞
  ├─ 登录/注册/兑换 AuthFlow          ─┤
  └─ Shell
       ├─ 用户端: UserTabs(发现/图库/我的)
       └─ 管理模式: AdminShell(统计/采集/回收站/仓储)  ← 由「我的→管理模式」进入
```
状态：`sessionProvider`（UserSession: id/name/level/expires）、`settingsProvider`、`adminModeProvider`。

### 认证与 API 层
- **普通用户**: 登录用 `POST /api/user/login`{key: 用户名, key_pass}；接口鉴权用密钥参数 `?api_key=vk_xxx`（gallery/user upload 系列）。
- **管理员**: `/admin/api/*` 携带 `?api_key=<adminKey>`（与网页一致）。管理模式开关校验 adminKey 有效后启用。
- dio 拦截器统一：
  - 无 token 请求公开/需 key 接口 → 附带已存 key
  - 401 → 触发登出/重登提示；429 → 读取 Retry-After 退避重试；网络错 → 本地错误提示
- 请求超时：常规 30s，上传/采集长任务 4 分钟并支持 abort。

### 模块拆分（功能包）
| package | 职责 |
|---|---|
| `core/` | 常量、枚举(Level)、工具、主题 |
| `data/` | repositories + models + local db（drift） |
| `services/` | api_client、upload_queue、sync_engine、secure_store、notifier |
| `features/` | auth / discover / gallery / detail / my / upload / sync / admin_stats / admin_scrape / admin_trash / admin_storage / lock / settings |

## API 对接设计

### 用户端

**登录/账号**
```
POST /api/user/login      body {key, key_pass} → {id,name,level,expires_at}
POST /api/user/register   body {username,password,redeem_code} → {key,...}
POST /api/user/redeem     body {key,redeem_code} → {message,new_level,expires_at}
```

**浏览（图库双源）**
```
GET /gallery/data?api_key=...&tags=&type=&limit=&offset=
    → {total, limit, offset, level, items:[poolFileJson]}
    共享库主体：WHERE enabled=1 AND level<=keyLevel 且 vvip 才能看 is_private
GET /api/v1/user/random?count=&tags=
GET /show/data            （幻灯片/推荐，level=pt）
```
模型 `MediaItem{id,url,thumb_url,title,tags[],level,is_private,file_type,width,height,file_size,created_at}`（对齐 poolFileJson）。

**files 库检索（管理端仓储复用）**
```
GET /admin/api/files?api_key=&page=&type=&keyword=&chat_id=   → files 全量检索（管理）
```

**我的图片**
```
GET    /api/v1/user/files?page=&page_size=&keyword=&tags=
GET    /api/v1/user/files/:id
DELETE /api/v1/user/files/:id
POST   /api/v1/user/files/:id/tags   body {tags:"a,b"}
GET    /api/v1/user/quota
```

**上传**
```
POST /api/v1/user/upload    multipart; 字段与网页一致（files 多字段时逐张循环）
```

### 管理端
```
POST /admin/api/scrape/analyze    body {url, ignore_kw, ignore_ext, must, cookie} → {title,images[],total,filtered}
POST /admin/api/scrape/grab_one   body {url,title,tags,level,ref,ignore_kw,ignore_ext,max_mb,must,seq,cookie}
GET/POST /admin/api/scrape/rule-groups                       → 规则组云端同步
GET  /admin/api/stats            → 总览卡片
GET  /admin/api/r2-usage         → 存储用量/趋势
GET  /admin/api/r2/list          → 对象浏览
POST /admin/api/r2/delete, /admin/api/r2/cleanup
GET  /admin/api/trash, POST 恢复
GET  /admin/api/unsaved, POST /admin/api/unsaved/retry
```

## UI / UX 设计

### 主题
- Material 3，`ColorScheme.dark` 为主视觉；`themeMode = system` 可手动覆盖
- 强调色：品牌蓝紫 `#6C7CFF`（参考现 gallery `#4f6ef7`）；背景深底 `#0B0F19` 系
- 图片浏览为绝对主角：弱化 chrome，卡片圆角 12，内容区大图优先

### 页面清单与信息架构
| 页面 | 结构 |
|---|---|
| Onboarding | Logo + 双域名表单 → 检测 `/health` |
| Auth | Tab(登录/注册)；兑换码折叠面板 |
| Discover(发现) | 顶部横幅推荐流(show) + 双列 masonry 瀑布 + 下拉刷新；顶栏搜索+级别徽标 |
| Gallery(图库) | Segmented：共享库/文件库；chip 标签行；type 筛选；masonry；无限滚动 |
| Detail(详情) | PageView 大图滑动 / video_player；photo_view；底部操作条(收藏/保存/分享/复制/打开原图)；级别角标 |
| My(我的) | 头部资料卡(级别/到期/配额进度) + 列表项(我的图片/收藏/历史/上传/兑换/设置/管理模式) |
| MyImages | 网格 + 多选删除/打标 + 搜索 |
| UploadFlow | 三个来源 tab + 队列卡 + 进度 + WiFi-only 指示 |
| SyncSettings | 相册选择 + 开关 + 状态/上次同步 |
| AdminShell | 侧栏/底部：统计、采集、回收站、仓储 |
| AdminScrape | 三步：输入链接→候选瀑布(全选/规则面板)→入库进度(失败续传) |
| LockGate | 指纹/图案验证 |
| Settings | 服务器、主题、缓存、应用锁、关于 |

### 空状态 / 错误
统一组件：`loading`(骨架)、`error`(文案+重试)、`empty`(引导文案)。级别不可见内容：卡片角标「VIP」并提示升级（不可见条目本身不返回，仅筛选器提示）。

## Data Model（本地库）

`android/picwall_app/lib/data/db.g.dart`（drift schema）：
```sql
CREATE TABLE local_favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id TEXT NOT NULL, url TEXT NOT NULL, thumb TEXT, title TEXT,
  tags TEXT, level TEXT, created_at TEXT NOT NULL, saved_at TEXT NOT NULL,
  UNIQUE(media_id, url)
);
CREATE TABLE browse_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id TEXT, url TEXT NOT NULL, thumb TEXT, title TEXT,
  seen_at TEXT NOT NULL
);
CREATE TABLE upload_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_path TEXT, url_source TEXT, status TEXT,   -- pending/done/failed
  error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE sync_state (
  album_id TEXT PRIMARY KEY, cursor TEXT, last_sync TEXT, enabled INTEGER DEFAULT 0
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY, value TEXT
);
```
收藏/历史本地化：仅本机（不依赖后端）；`MediaItem` 以 `(media_id=id+源)` 去重。上传队列与同步游标支持断点续传。

## Security Design

- **密钥存放**: flutter_secure_storage（Android Keystore 加密）；不落 SharedPreferences 明文。
- **密钥口令**: 仅存「记住登录」勾选时保存；日志与上报中屏蔽。
- **应用锁**: local_auth 指纹（可回退设备 PIN）；图案锁为本地 fallback（hash 存 secure storage）。锁定时清空内存中的列表缓存，避免截图恢复泄露。
- **上传安全**: multipart 直传使用配置的 API 服务器，不外泄至第三方；仅 WiFi 上传尊重用户网络选择。
- **隐私说明**: 相册/通知权限在功能首次使用点请求，配套说明文案；自动同步默认关闭，需用户显式开启并指定相册。

## Build & CI

### build-android.yml（新增）
触发：`push: paths: ['android/**']`、`workflow_dispatch`。
步骤：checkout → setup Flutter(stable)+Java17 → `flutter pub get` → `flutter analyze` → `flutter test`(若有) → `flutter build apk --release` → upload artifact `picwall-release.apk`；发布时由 keystore secrets 签名。

### deploy-worker.yml（修改）
`push` 增加 `paths-ignore: ['android/**']`，保证安卓改动不触发 wrangler 部署与 R2 上传。

### 版本标识
- Android: `versionName` 由 `version: 1.0.0+1`；CI 内可注入 build number。
- 保留独立 git 提交粒度：worker 与 android 改动分开 commit，便于回滚。

## Testing Strategy
- 单元：规则解析（忽略/必带/格式/大小）、级别可见性函数、上传队列状态机。
- Widget：登录表单、规则面板、采集候选勾选/全选。
- 集成（手动/CI smoke）：登录→浏览→详情→上传→管理模式切换冒烟。

## Migration & Backward Compatibility
- Worker 侧零改动：App 只消费既有 HTTP API（已核对 route 与 JSON 结构）。
- 后端预留：管理模式沿用 admin API_KEY，无新鉴权协议。
- 多账号/服务器切换：不同配置的会话各自独立存储 key，切换服务器不串号。

## Open Items（待用户确认）
1. 应用包名默认建议 `com.picwall.app`（可改为你的域名反写）。
2. App 图标需要设计稿或先用占位图标。
3. Release 签名：正式分发需你提供 keystore + 别名/密码 secret（或先出 debug 包自装）。
