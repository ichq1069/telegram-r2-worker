# src/ 辅助模块

`src/` 是被 `worker.js` 引用的纯辅助模块(与废弃的 `handlers/ services/ utils/` 无关)。它们只做一件事,无框架依赖。

## src/db.js — D1 初始化与迁移

| 导出 | 说明 |
|---|---|
| `ensureTablesOnce(db)` | isolate 级幂等建表(每次请求调用,仅首次执行) |
| `ensureTables(db)` | 建表 + 列迁移的完整逻辑 |

- 单次 `db.exec` 建全部 `CREATE TABLE IF NOT EXISTS` 与索引(替代原先 10+ 次串行 D1 调用,消除冷启动秒级延迟)
- 列迁移:`PRAGMA table_info` 检查后逐个 `ALTER TABLE`,幂等;关键列迁移失败会抛错(不置 once 标记)让下个请求重试
- 迁移覆盖:`files`(md5/processing_state/tg_file_url/error_msg/进度/缩略图/quick_hash/tags/pool_status/group_ref/deleted_at/view_count/**level**/**is_private**)、`bot_commands.menu/builtin`、`api_keys.expires_at/**level**`、`show_groups.mode/daily_count/updated_at`、`random_pool.**level**/**is_private**`

## src/util.js — 纯函数工具

| 导出 | 说明 |
|---|---|
| `json(d, s)` | JSON 响应(带 CORS) |
| `cors(d, s)` | CORS 空响应(预检) |
| `fmtSize(b)` | 字节 → 人类可读(B/KB/MB/GB/TB) |
| `genHash()` | 32 位 hex 随机哈希(基于 `crypto.getRandomValues`) |

## src/notify.js — 失败告警 + 缩略图

| 导出 | 说明 |
|---|---|
| `notifyAdmin(env, text)` | 转存失败时向管理员 chat 发 Telegram 消息;同一错误 5 分钟节流去重;目标 chat 取 `settings.admin_chat_id` 或 `env.ADMIN_CHAT_ID` |
| `genThumb(env, r2Url, key)` | 用 Cloudflare Image Resizing 生成 480w WebP 缩略图写入 `thumbs/`,失败静默跳过 |

## src/ratelimit.js — 公开 API 限流

| 导出 | 说明 |
|---|---|
| `applyRateLimit(env, key)` | 按 `api_key + 分钟窗口` 在 `rate_limits` 表计数,超过 `settings.api_rate_limit.limit_per_min` 返回 true(应拒绝 429);配置 `enabled=false` 时不限流 |

配置项来自 `settings` 表 `api_rate_limit` 的 JSON:`{enabled, limit_per_min}`。

## src/backup.js — D1 备份

| 导出 | 说明 |
|---|---|
| `dumpAllTables(env)` | 导出全部用户表为 JSON(跳过 `sqlite_%`/`_cf_%` 内部表) |
| `handleAdminBackup(env)` | 立即导出返回给调用方 |
| `handleAdminBackupSave(env)` | 导出并写入 R2 `backups/db-*.json`,自动保留最近 20 份 |
| `handleAdminBackupList(env)` | 备份列表 |
| `handleAdminBackupDelete(request, env)` | 删除指定备份(严格校验 `backups/db-` 前缀与路径穿越) |

对应后台「运维」tab 的备份功能与 `/admin/api/backup*` 端点。
