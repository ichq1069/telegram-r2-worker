# 开发指南

## 1. 技术栈

- Cloudflare Workers（ESM，`worker.js` 为唯一入口，业务在 `src/`）
- R2（`bot-telegram`）
- D1 SQLite（`telegram-url`），schema 版本 `14`
- Hyperdrive + mysql2（VPS MySQL 备库）
- Cloudflare Queues（后台长任务）
- 纯静态管理后台 `admin.html`
- Flutter 3.x（PicWall，`android/picwall_app`）
- Python aiohttp（`relay/`）
- GitHub Actions：`wrangler-action@v4` + wrangler `4.128.0`

## 2. 本地开发

环境要求：Node.js ≥ 18、`npx wrangler`。Android 改动在沙箱里没有 Flutter，只能 push `main` 走 `build-android.yml` 验证。

### 2.1 语法校验

```bash
node --check worker.js
for f in src/*.js; do node --check "$f"; done
```

流水线同样跑这两步。`src/public.js` 曾因多余 `}` 导致 wrangler 打包失败（`Expected "finally" but found "const"`），改完务必本地 `--check`。

### 2.2 本地预览

```bash
npx wrangler dev
```

需要本机 `CLOUDFLARE_API_TOKEN`，以及 `TG_BOT_TOKEN` / `API_KEY` 等（Dashboard 或 `.dev.vars`）。不要把真实密钥写进仓库。

## 3. 部署（推荐 GitOps）

push `main` 且变更不只在 `android/**` 时自动部署 Worker。流水线见 [模块/部署流水线](./模块/部署流水线.md)。

线上验收：`GET https://telegram-r2-bot.wo58.cn/health` 的 `version` 应变为仓库里 `worker.js` 写的版本（当前 `v8`）；`admin.html` 右上角 `APP_VERSION` 变为 `v1.0.<run#>`。

### 3.1 GitHub Secrets

| Secret | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 部署（Worker/D1/R2 编辑 + Account Settings:Read） |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID |
| `TG_BOT_TOKEN` | 写入 Worker secret |
| `API_KEY` | 管理员 Key |
| `CF_API_TOKEN`（可选） | R2 官方用量；缺省复用部署 token |
| `RELAY_URL` / `RELAY_KEY` | 抓取中转；未配时流水线回退 `https://botzzxz.wo58.cn` |
| `ANDROID_DEBUG_KEYSTORE_B64` | PicWall 固定签名（从 +62 起） |

### 3.2 手动部署

```bash
npm ci
npx wrangler deploy
echo "$TG_BOT_TOKEN" | npx wrangler secret put TG_BOT_TOKEN
echo "$API_KEY" | npx wrangler secret put API_KEY
npx wrangler deploy
node .github/scripts/bump-version.js
npx wrangler r2 object put bot-telegram/admin.html --file=admin.html \
  --content-type text/html --cache-control "public, max-age=300" --remote
```

先 deploy 再 `secret put` 再 deploy。wrangler 4 的 `r2 object put` 必须加 `--remote`，否则只写本地假成功。

## 4. 数据模型变更

新列/新表必须走 `src/db.js` 双路径，并递增 `SCHEMA_VERSION`（当前 `'14'`）：

1. 加入 `CREATE TABLE IF NOT EXISTS`
2. 在 `wantCols` 或对应 PRAGMA 块补 `ALTER TABLE`
3. 改 `SCHEMA_VERSION`，否则旧 isolate 命中旧标记会跳过迁移

迁移幂等：先 `PRAGMA table_info`。关键列仍缺失会抛错，下一请求重试。

## 5. 测试

Worker 无自动化测试框架：

- 语法：`node --check`
- 集成：`wrangler dev` + 真实 Telegram / webhook
- 冒烟：`/health` 200、`/admin` 可开、`/api/v1/files` 用测试密钥返回数据

PicWall：`android/picwall_app/test/` 下 Dart 单测。CI 跑 `flutter analyze`（info 级也会失败）+ `flutter test`。纯逻辑改动应带单测，避免只靠 10 分钟 APK 构建。

## 6. 常见任务

### 6.1 改管理后台

编辑 `admin.html`，push `main` 后上传到 R2。`GET /admin` 读的是 R2 文件。版本由 `bump-version.js` 注入。缓存 `max-age=300`，改完需强刷。

### 6.2 改 Bot 命令

内置命令在 `src/commands.js`，`syncBuiltinCommands` 每次调度 `INSERT OR IGNORE`，不覆盖后台改过的行。用户命令在 `bot_commands` 表。

### 6.3 新增公开 API

- 认证：`checkApiKey(request, env)`，失败 401/429
- 分级：`levelFilter(keyLevel)`；非 vvip 加 `is_private=0`
- 写权限用 `hasScope(rec, 'files:write')`
- 在 `worker.js` 的 `fetch` 里按现有顺序加路由

### 6.4 改 Android

仓库只保留 Dart 源码。CI `flutter create --platforms=android` 脚手架后再注入权限与签名。本地无 Flutter 时不要声称已 analyze。

## 7. 排障速查

| 现象 | 排查方向 |
|---|---|
| webhook 失效 | 运维 tab → webhook 状态 / `/admin/api/webhook-fix` |
| webhook 500 | 构造空 update / 文本 / 命令样本，看返回 `error`（常见 ReferenceError） |
| 文件未转存 | 未转存 tab；R2 权限；Queue |
| 视频一直加载 | `/file/tg` 代理：Range 也要触发懒转存；上游 200 全量时要自行切 206。见 `src/api.js` `handleTgFileRedirect` |
| 公开 API 401/429 | 密钥启用/过期；`rate_limits`；级别 |
| 看不到某内容 | 密钥级别低于内容，或 `is_private=1` 而非 vvip |
| 冷启动 30s+ | 免费版 Worker 跨节点排队；不要在 Worker 内再 `caches.default`；用 `Cache-Control s-maxage` |
| Deploy 失败 `Expected finally` | `src/*.js` 括号不配，先 `node --check` |
| APK 无法覆盖安装 | +62 之前是随机 debug 签名，需卸载后装固定签名包 |
| 抓取 OOM | 走 relay，不要让 Worker 下载大图 |

验证真实回源耗时用带 `cb=` 时间戳的 URL，避免 CDN HIT 掩盖慢请求。

## 8. 约定

- 响应统一 `{ok, data}` / `{ok, error}`
- 表名/路由稳定：更名只改 UI（共享库仍是 `random_pool` / `/admin/api/pool`）
- 机密不进 `wrangler.toml` 和仓库
- 东八区统计用 `src/core.js` 的 `cnTodayStr` / `cnDayIso`
- 新增后台 tab：`admin.html` 的 `tabGroups` + panel + `/admin/api/*`
