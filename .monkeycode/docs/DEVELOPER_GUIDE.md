# 开发指南

## 1. 技术栈

- Cloudflare Workers(ESM,`worker.js` 为唯一入口)
- R2 存储(`bot-telegram`,smart_tiered_cache)
- D1 SQLite(`telegram-url`)
- Cloudflare Queues(后台长任务)
- 纯静态管理后台 `admin.html`(原生 JS,无框架)
- GitHub Actions 自动部署(wrangler-action v3)

## 2. 本地开发

环境要求:Node.js ≥ 18、`npx wrangler` 可用。

### 2.1 语法校验

```bash
node --check worker.js
for f in src/*.js; do node --check "$f"; done
```

管理后台 JS 校验:把 `admin.html` 中 `<script>` 内容抽出后用 `node --new-function` 语法检查(无 DOM 环境,用 `new Function` 包一层)。

### 2.2 本地预览(需要本机 Cloudflare 登录与 secrets)

```bash
npx wrangler dev
```

需本机已配置 `CLOUDFLARE_API_TOKEN`(含 Worker/R2/D1 权限),且 `TG_BOT_TOKEN`/`API_KEY` 等 secret 已在 Dashboard 或 `.dev.vars` 存在。

## 3. 部署(推荐 GitOps)

push `main` 分支即自动部署,无需本机 wrangler。流水线见 [模块/部署流水线](./模块/部署流水线.md)。

### 3.1 需要的 GitHub Secrets

| Secret | 权限要求 | 用途 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Worker Scripts:Edit、D1:Edit、R2 Storage:Edit、Workers R2 Storage:Edit、Account Settings:Read | 部署 |
| `CLOUDFLARE_ACCOUNT_ID` | — | 账号 ID |
| `TG_BOT_TOKEN` | — | 每次部署写入 Worker secret |
| `API_KEY` | — | 管理员 API Key(写入 secret) |
| `CF_API_TOKEN`(可选) | R2 Storage:Read | R2 官方用量查询;缺省复用 `CLOUDFLARE_API_TOKEN` |

### 3.2 手动部署(备选)

```bash
npx wrangler deploy
echo "$TG_BOT_TOKEN" | npx wrangler secret put TG_BOT_TOKEN
echo "$API_KEY" | npx wrangler secret put API_KEY
npx wrangler deploy
npx wrangler r2 object put bot-telegram/admin.html --file=admin.html \
  --content-type text/html --cache-control "public, max-age=300"
```

注意:先 deploy 再 `secret put` 再 deploy —— Cloudflare 版本管理不允许「最新版本未部署」时写 secret。

## 4. 数据模型变更规范

新列/新表必须走 `src/db.js` 的双路径:

1. 同步加入 `CREATE TABLE IF NOT EXISTS` 的列定义(新库生效)
2. 在 `wantCols` 或对应表的 PRAGMA 迁移块补一条 `ALTER TABLE`(旧库生效)

迁移是幂等的:先 `PRAGMA table_info` 检查,已存在则跳过;关键列迁移失败会抛错,下一请求重试。参考 `src/db.js:38-123` 中 `files.level`、`random_pool.is_private`、`api_keys.level` 的写法。

## 5. 测试

项目无自动化测试框架,验证方式:

- 语法:`node --check`(见 2.1)
- 集成:本地 `wrangler dev` + 真实 Telegram 消息/webhook 手测
- 部署冒烟:`/health` 返回 200、`/admin` 可打开、`/api/v1/files` 用测试密钥返回数据

## 6. 常见任务

### 6.1 修改管理后台

直接编辑 `admin.html`,推 main 后流水线自动上传到 R2(`GET /admin` 读取的是 R2 上的文件)。版本号由 `bump-version.js` 注入 `APP_VERSION`,改版后需 `Cmd+Shift+R` 强刷缓存(缓存 `max-age=300`)。

### 6.2 修改 Bot 命令

内置命令在 `worker.js` 中定义,`syncBuiltinCommands` 每次调度用 `INSERT OR IGNORE` 登记,不覆盖用户在后台的修改。用户自建命令存 `bot_commands` 表,后台「命令」tab 管理。

### 6.3 新增公开 API

- 认证走 `api_keys` 表:`checkApiKey(request, env)` 拿 `{rec, limited}`,失败返回 401/429
- 分级过滤:`levelFilter(keyLevel)` 生成 SQL 片段;公共内容恒加 `is_private=0`(非 vvip)
- 在 `worker.js` fetch 的 v1 分支(`worker.js:173-180`)加路由

## 7. 排障速查

| 现象 | 排查方向 |
|---|---|
| webhook 失效 | 后台「运维」tab → webhook 状态/一键修复;或 `/admin/api/webhook-fix` |
| 文件未转存 | 后台「未转存」tab 查看列表并批量重试;检查 R2 权限与 Queue 是否正常 |
| 公开 API 401/429 | `api_keys` 表密钥是否启用/过期;`rate_limits` 是否触发;级别配置 |
| 看不到某内容 | 密钥级别 < 内容级别,或内容 `is_private=1` 而非 vvip 密钥 |
| 冷启动慢 | `ensureTablesOnce` 已做 isolate 级幂等;仍慢时检查 D1 查询索引是否命中 |
| 用量超预期 | 后台「用量预测」;R2 smart_tiered_cache 已降冷数据成本 |

## 8. 约定

- 所有响应统一 `{ok, data}` / `{ok, error}` 结构
- 表名/路由名稳定优先:更名只改 UI 文案,保留 API 路径与表名(如 shared pool 更名未改 `/admin/api/pool`)
- 机密永不写入 `wrangler.toml` 或仓库;文档中的 Key 一律用 `<API_KEY>` 占位
- 新增后台 tab:在 `admin.html` 增加 tab 按钮 + 面板 + 对应 `/admin/api/*` handler
