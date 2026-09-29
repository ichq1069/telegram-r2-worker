# 接口文档

线上域名：`https://telegram-r2-bot.wo58.cn`。认证分五类：无认证、管理员 Key、`api_keys` 表、用户门户 key-pass、Telegram。

文档中的密钥一律写 `<API_KEY>`，不要填真实值。

## 1. 认证方式速查

| 认证类型 | 凭证位置 | 适用端点 |
|---|---|---|
| 无认证 | — | `/health`、`/show*`、`/gallery`、`/docs`、`/dashboard`、`/webhook`、`/api/app/*` |
| 管理员 | `?api_key=` 或 `X-API-Key` = `env.API_KEY` | `/admin`、`/admin/api/*`、`/jx`、`/scrape`、旧式 `/api/*` |
| api_keys 表 | `X-API-Key` 或 `?api_key=`，值在 `api_keys` 表 | `/api/v1/files`、`/api/v1/random`、`/api/v1/upload`、`/gallery/data` |
| 用户门户 | key + key-pass（body） | `/api/user/*`、`/api/v1/user/*` |
| 签名直链 | 路径 token | `/file/tg/<token>/<id>.<ext>` |
| Telegram | webhook secret_token（可选） | `/webhook`、`/bot/*` |

管理员 `/admin/api/*` 另受 `applyAdminRateLimit` 限制。公开页 `/show/data`、`/gallery/data`、`/file/tg/*` 受 IP 限流。

## 2. 公开端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | `{ok, time, version}`，当前 `version` 为 `v8` |
| `/dashboard` | GET | 内置简版面板（建议改用 `/admin`） |
| `/docs` | GET | 内置文档页 |
| `/show` | GET | 公开轮播页 |
| `/show/data` | GET | 轮播数据，仅 `level='pt' AND is_private=0` |
| `/gallery` | GET | 画廊瀑布流页 |
| `/gallery/data` | GET | 画廊数据（IP 限流；筛选逻辑见实现） |
| `/admin` | GET | 管理后台静态页（从 R2 读，页面内再填管理员 Key） |
| `/admin/guide` | GET | 管理员手册 |
| `/user` | GET | 用户门户静态页 |
| `/user-manage` | GET | 用户管理页 |
| `/jx` | GET | 链接解析页（管理员页，鉴权在页内） |
| `/scrape` | GET | 网页图片直传页 |
| `/file/tg/<token>/<id>.<ext>` | GET | 签名直链；无 token 返回 403。有 R2 URL 则 302，否则代理 Telegram 并支持 Range/206 |
| `/favicon.ico` | GET | 204 |
| `/webhook` | POST | Telegram webhook |

旧格式 `/file/tg/<id>.<ext>?k=<token>` 仍可用。无签名一律 403。

## 3. 公开 JSON API v1（api_keys + 限流）

认证：`X-API-Key: <api_keys.key>` 或 `?api_key=`。401 无效，429 限流。按密钥 `level` 过滤；`is_private=1` 仅 vvip 可见。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/v1/files` | GET | 文件列表。`page/page_size/type/chat_id/user_id/keyword/start_date/end_date`。200 时 `Cache-Control: public, s-maxage=30` |
| `/api/v1/random` | GET | 随机内容，`count` 指定条数 |
| `/api/v1/upload` | POST | 上传。需要 scope `files:write` 或 `upload`，否则 403 |
| `/api/v1/diagnose-key` | GET | 诊断密钥是否存在（不完整鉴权） |
| `/gallery/data` | GET | 画廊数据 |

级别：密钥 `L` 可见 `level <= L` 且（非 vvip 时）`is_private=0`。详见 [专有概念/内容分级与私密库](./专有概念/内容分级与私密库.md)。

### 3.1 `POST /api/v1/upload`

multipart/form-data，字段名 `file`，单文件上限 **19MB**。

| 参数 | 位置 | 说明 |
|---|---|---|
| `api_key` | query/header | 必填 |
| `pool` | query | `1` = 进 `random_pool`；不带 = 进 `files` |
| `tags` | query | 逗号分隔 |
| `title` | query | 默认文件名 |
| `level` | query | 不得超过密钥级别，默认等于密钥级别 |
| `is_private` | query | `1` 仅 vvip 可用 |

返回：`{ ok, data: { id, url, added, pool, level, is_private, file_type, file_size } }`。

```bash
curl -F "file=@cat.jpg" "https://telegram-r2-bot.wo58.cn/api/v1/upload?api_key=<API_KEY>&pool=1&tags=cat"
```

## 4. 用户门户

IP 限流。登录后接口用 key + key-pass。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/user/login` | POST | 登录 |
| `/api/user/register` | POST | 注册 |
| `/api/user/redeem` | POST | 兑换码 |
| `/api/user/reset-password` | POST | 重置密码 |
| `/api/user/key-info` | POST | 查密钥信息 |
| `/api/user/stats` | POST | 当前密钥统计（需 key-pass） |
| `/api/user/tags` | POST | 标签列表 |
| `/api/user/logs` | POST | 调用日志 |
| `/api/user/log-stats` | POST | 1h/6h/24h 统计 |
| `/api/v1/user/upload` | POST | 用户上传 |
| `/api/v1/user/files` | GET | 用户文件列表 |
| `/api/v1/user/files/:id` | GET/DELETE | 详情 / 删除 |
| `/api/v1/user/files/:id/tags` | POST | 打标 |
| `/api/v1/user/files/cleanup` | POST | 清理 |
| `/api/v1/user/random` | GET | 用户随机 |
| `/api/v1/user/quota` | GET | 配额 |

## 5. App 统计（无认证）

PicWall 直接调用。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/app/stats/install` | POST | 安装上报 |
| `/api/app/stats/heartbeat` | POST | 心跳 |
| `/api/app/update` | GET | 更新源（读 R2 `latest.json`） |

## 6. 管理 API

前缀 `/admin/api/`，凭证 `env.API_KEY`，否则 401。另有管理员 IP 限流。

### 6.1 文件与统计

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/files` | GET | 文件列表；不传 `pool_state` 时默认未导入共享/私密库的条目 |
| `/admin/api/files` | DELETE | 软删到回收站 |
| `/admin/api/files/upload` | POST | base64 上传到 Tele 库 |
| `/admin/api/files/upload-tg` | POST | 经 Telegram 上传入库 |
| `/admin/api/files/import` | POST | 外链 URL 入库（`storage_key` 占位 `external`） |
| `/admin/api/files/tags` | POST | 批量打标；命中自动入池标签则转入共享库 |
| `/admin/api/files/pool-status` | POST | 设置是否入池 |
| `/admin/api/stats` | GET | 总览 |
| `/admin/api/app/stats` | GET | App 安装汇总 |
| `/admin/api/app/installs` | GET | 安装明细 |
| `/admin/api/app/users` | GET | 设备用户 |
| `/admin/api/trash` | GET | 回收站 |
| `/admin/api/trash/restore` | POST | 恢复 |
| `/admin/api/unsaved` | GET | 未转存列表 |
| `/admin/api/unsaved/retry` | POST | 批量重试 |
| `/admin/api/processing` | GET | 处理中任务 |
| `/admin/api/retry` | POST | 重试单条 |

### 6.2 去重与存储

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/dedup` | POST | 触发查重 |
| `/admin/api/dedup/stats` | GET | 统计 |
| `/admin/api/dedup/groups` | GET | 重复分组 |
| `/admin/api/dedup/row` | POST | 单行清理/保留 |
| `/admin/api/dedup/rows` | POST | 批量行操作 |
| `/admin/api/r2/inspect` | GET | R2 对象检视 |
| `/admin/api/r2/cleanup` | POST | 回收站超期对象清理 |
| `/admin/api/r2/fix-mime` | POST | 修 MIME |
| `/admin/api/r2/list` | GET | 列对象 |
| `/admin/api/r2/delete` | POST | 删对象 |
| `/admin/api/compress/stats` | GET | WebP 压缩统计 |
| `/admin/api/compress/run` | POST | 手动压缩 |

### 6.3 共享库 / 私密库 / 文件夹

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/pool` | GET/POST/DELETE | 列表 / 新增 / 删除 |
| `/admin/api/pool/batch` | POST | 批量改级别/私密/启停 |
| `/admin/api/pool/batch-delete` | POST | 批量删除 |
| `/admin/api/pool/import-page` | POST | 从页面抓图导入 |
| `/admin/api/pool/upload` | POST | 上传入池 |
| `/admin/api/pool/upload-postimages` | POST | Postimages 入池 |
| `/admin/api/pool/upload-tg` | POST | 经 Telegram 入池 |
| `/admin/api/pool/toggle` | POST | 启停 |
| `/admin/api/pool/tags` | POST | 标签 |
| `/admin/api/pool/from-tg` | POST | 从 Tele 文件导入共享库 |
| `/admin/api/pool/move` | POST | 移到文件夹 |
| `/admin/api/private-pool` | GET | 私密库列表 |
| `/admin/api/private-pool/from-tg` | POST | 从 Tele 导入私密库（级别固定 vvip） |
| `/admin/api/folders` | GET/POST | 文件夹列表 / 创建 |
| `/admin/api/folders/:id/rename` | PATCH | 重命名 |
| `/admin/api/folders/:id` | DELETE | 删除 |

### 6.4 网页抓取

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/scrape/analyze` | POST | 分析页面图片 |
| `/admin/api/scrape/grab` | POST | 批量抓取 |
| `/admin/api/scrape/grab_one` | POST | 单张抓取（优先 relay） |
| `/admin/api/scrape/rule-groups` | GET/POST | 规则组 |
| `/admin/api/scrape/relay-health` | GET | 中转健康检查 |

### 6.5 节目组、标签、命令、密钥、用户

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/show-groups` | GET/POST/DELETE | 节目组 |
| `/admin/api/show-groups/roll` | POST | 手动换图 |
| `/admin/api/show-config` | GET/POST | 轮播配置 |
| `/admin/api/tags` | GET/POST/PATCH/DELETE | 标签 CRUD |
| `/admin/api/tags/list` | GET | 标签列表 |
| `/admin/api/commands` | GET/POST/PATCH/DELETE | Bot 命令 |
| `/admin/api/keys` | GET/POST/PATCH/DELETE | API 密钥 |
| `/admin/api/keys/toggle` | POST | 启停密钥 |
| `/admin/api/key-users` | GET | 注册用户 |
| `/admin/api/key-users/username-check` | POST | 用户名查重 |
| `/admin/api/redeem` | GET/POST/PATCH/DELETE | 兑换码 |
| `/admin/api/call-logs` | GET | 调用日志 |
| `/admin/api/call-stats` | GET | 调用统计 |
| `/admin/api/users` | GET | 用户统计 |
| `/admin/api/users/interactions` | GET | 聊天交互统计 |
| `/admin/api/user-quotas` | GET/POST | 用户配额 |
| `/admin/api/user-files` | GET | 管理端看用户文件 |
| `/admin/api/known-groups` | GET | 已知群组 |

### 6.6 设置

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/settings/pi-key` | GET/POST | Postimages Key |
| `/admin/api/settings/pool-tags` | GET/POST | 池标签预设 |
| `/admin/api/settings/auto-pool-tags` | GET/POST | 自动入共享库标签 |
| `/admin/api/settings/proxy-mode` | GET/POST | 入库不转存 R2 |
| `/admin/api/settings/proxy-only` | GET/POST | 全部走代理 |
| `/admin/api/settings/ai` | GET/POST | AI 配置 |
| `/admin/api/settings/notify` | GET/POST | 失败告警 |
| `/admin/api/settings/notify-test` | POST | 告警测试 |
| `/admin/api/settings/rate-limit` | GET/POST | 限流配置 |
| `/admin/api/settings/r2-quota` | GET/POST | R2 配额 |
| `/admin/api/settings/webhook` | GET/POST | 事件回调 URL |
| `/admin/api/settings/webhook/test` | POST | 回调测试 |
| `/admin/api/settings/cobalt` | GET/POST | cobalt 解析配置 |
| `/admin/api/settings/main-menu` | GET/POST | 快捷键盘 |
| `/admin/api/settings/main-menu/broadcast` | POST | 广播键盘 |
| `/admin/api/settings/upload-group` | GET/POST | 用户上传目标群 |
| `/admin/api/settings/pool-fallback` | GET/POST | 共享库回退 |
| `/admin/api/parse-link` | POST | 解析社媒链接 |

### 6.7 用量、DB、运维

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/r2-usage` | GET | R2 用量 |
| `/admin/api/worker-usage` | GET | Worker 用量 |
| `/admin/api/usage-forecast` | GET | 用量预测 |
| `/admin/api/bot-info` | GET | getMe |
| `/admin/api/webhook-status` | GET | webhook 检查 |
| `/admin/api/webhook-fix` | POST | 一键修复 |
| `/admin/api/webhook-logs` | GET | 最近投递日志 |
| `/admin/api/poll` | GET | 手动 getUpdates |
| `/admin/api/backup` | GET/POST/DELETE | 导出 / 存 R2 / 删除 |
| `/admin/api/backup/list` | GET | 备份列表 |
| `/admin/api/ai/test` | POST | AI 测试发消息 |
| `/admin/api/ai/ask` | POST | AI 浮窗 |
| `/admin/api/migrate` | GET | D1 → MySQL 分批迁移 |
| `/admin/api/db-mode` | GET/POST | `d1` / `mysql` / `auto` |
| `/admin/api/db-stats` | GET | 双库统计 |
| `/admin/api/db-test-mysql` | GET | MySQL 连通 |
| `/admin/api/db-rebuild-mysql` | POST | 重建 MySQL 表 |
| `/admin/api/db-force-sync` | POST | 强制同步 |
| `/admin/api/db-sync` | POST | 增量同步 |
| `/admin/api/db-full-sync` | POST | 全量同步 |

## 7. Bot API 代理

`/bot/*` POST，由调用方持有 Bot token。实现于 `src/telegram.js`：

`sendMessage`、`sendPhoto`、`sendDocument`、`sendVideo`、`getFile`、`getMe`、`getWebhookInfo`、`setWebhook`、`getUpdates`、`getChat`、`getChatMemberCount`、`banChatMember`、`unbanChatMember`、`deleteMessage`、`forwardMessage`、`copyMessage`、`answerInlineQuery`、`sendMediaGroup`、`editMessageText`、`editMessageCaption`、`pinChatMessage`、`unpinChatMessage`、`sendChatAction`。

## 8. 旧式 API（管理员 Key）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/files` | GET | 文件列表 |
| `/api/file` | GET/DELETE | 详情 / 删除 |
| `/api/stats` | GET | 统计 |
| `/api/by-chat` | GET | 按群组 |
| `/api/by-user` | GET | 按用户 |
| `/api/by-date` | GET | 按日期 |
| `/api/search` | GET | 搜索 |
| `/api/latest` | GET | 最新 |
| `/api/stream` | GET | 文件流 |
| `/api/bots` | GET/POST/DELETE | 多 Bot |
| `/api/config` | GET/POST | 配置 |
| `/api/bot-info` | GET | Bot 信息 |

## 9. 中转 Relay（独立进程）

不在 Worker 域上。默认监听 `18088`，鉴权环境变量 `API_KEY`。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/relay/grab` | POST | `{url, chat_id, bot_token, caption, as_photo}` → 下载并发到 Telegram，返回 `file_id` |

Worker 通过 `RELAY_URL` / `RELAY_KEY` 调用。详见 [模块/relay-server](./模块/relay-server.md)。

## 10. 统一返回格式

- 成功：`{"ok": true, "data": ...}`
- 失败：`{"ok": false, "error": "..."}`，配合 400/401/403/404/429/500
- 管理端未认证：401 `Unauthorized`
- 所有 JSON 响应带 CORS
