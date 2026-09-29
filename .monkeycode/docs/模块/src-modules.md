# src/ 辅助模块

被 `worker.js` import。与废弃的 `handlers/` `services/` `utils/` 无关。

## db.js — D1 初始化

| 导出 | 说明 |
|---|---|
| `ensureTablesOnce(db)` | isolate 级幂等建表 |
| `ensureTables(db)` | 建表 + 列迁移 |

- `SCHEMA_VERSION = '14'`：settings 命中则跳过全部 CREATE/ALTER
- 单次 `db.exec` 建全部表和索引
- `files.original_url` 条件唯一索引防抓取重复入库

表：`files`、`bot_config`、`bot_commands`、`settings`、`api_keys`、`random_pool`、`show_groups`、`rate_limits`、`worker_stats`、`user_stats`、`known_chats`、`redeem_codes`、`api_call_logs`、`tags`、`folders`、`user_uploads`、`app_installs`。

## core.js — 纯工具

东八区时间（`cnShift` / `cnTodayStr` / `cnDayIso` / `cnNowISO`）、`LEVEL_RANK` / `LEVEL_ORDER` / `sanitizeLevel` / `levelFilter`（支持逗号多级别与 `*`）、`genApiKey` / `genRedeemCode` / `hashKeyPass`。

## util.js

`json`、`cors`、`fmtSize`、`genHash`、isolate 内存 `cacheGet/cacheSet`。

## ratelimit.js

| 导出 | 说明 |
|---|---|
| `applyRateLimit` | 按 api_key 分钟窗口 |
| `applyIPRateLimit` | 公开端点按 IP（`CF-Connecting-IP`） |
| `applyAdminRateLimit` | 管理 API |
| `applyUserRateLimit` | 用户门户 |
| `hasScope` / `hasLevel` | 权限 |

配置来自 `settings.api_rate_limit` JSON，isolate 缓存 30s。管理员/用户限流默认开启。

## notify.js

`notifyAdmin`（5 分钟节流）、`genThumb`（Image Resizing → `thumbs/`）、告警配置 handler。

## backup.js

`dumpAllTables` 跳过 `sqlite_%` / `_cf_%`。R2 `backups/db-*.json` 保留 20 份。删除校验 `backups/db-` 前缀。

## telegram.js

Bot API 基址、流式/大文件下载、`putR2` / `putR2Stream`、`fileTok` 签名、快捷键盘、`/bot/*` 代理。

## api.js

`handleTgFileRedirect`：签名校验、R2 302、Telegram 代理、Range→206、懒转存 `scheduleLazyTransfer`（含 ranged 请求）。`handleFiles` / `handleStats` 等旧式列表。代理模式开关。

## webhook.js

`handleWebhook`、`ensureWebhook`、`handlePollUpdates`、`processFileAsync`、`processShareLinkAsync`、webhook 投递日志。

## commands.js

内置命令、数字菜单、AI 调用、用量 GraphQL、`syncBuiltinCommands`。

## public.js

公开 v1 API、密钥/兑换码/用户注册、共享库 CRUD、文件夹、网页抓取（`grabViaRelay`）、用户上传。体积最大的业务文件。

## admin.js

未转存、去重、WebP 压缩 Cron、日报、存储维护、命令 CRUD。

## events.js

事件回调 `fireWebhook`、回收站、R2 检视/清理、多 Bot、`handleSetFilePoolStatus`。

## pages.js

从 R2 读 `admin.html` / `user.html` 等。`/admin` 不再把 API Key 嵌进 HTML。

## batch.js

`allocTgRef`（5 分钟新批次）、`scheduleBatchRef`、`refreshGroupReceipt`、`#开始`/`#结束` 手动批次、`handleDeletedMsg`。

## parser.js

cobalt：Instagram / X / YouTube / TikTok。配置在 `/admin/api/settings/cobalt`。

## mysql.js / dbaccess.js / migrate.js

Hyperdrive 绑定 `telequnphoto`，`mysql2/promise` + `disableEval: true`。D1 为主，auto 模式命中限额/故障特征后 30s 降级窗口。`GET /admin/api/migrate` 幂等 `INSERT IGNORE`。

## app_stats.js

`app_installs` UPSERT、心跳、后台统计、`/api/app/update` 读 R2 `latest.json`。必须用 `env.D1_DB`，不要写 `env.DB`。
