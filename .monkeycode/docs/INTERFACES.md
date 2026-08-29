# 接口文档

所有端点都部署在 Worker 域(`https://<worker>.workers.dev`)。认证分四类:无认证、管理员 API Key、`api_keys` 表密钥、Telegram 校验。

## 1. 认证方式速查

| 认证类型 | 凭证位置 | 适用端点 |
|---|---|---|
| 无认证 | — | `/health`、`/show*`、`/file/tg/*`、`/webhook`、`/docs`、`/dashboard` |
| 管理员 | `?api_key=` 或 `X-API-Key` 头,值 `env.API_KEY` | `/admin/api/*`、旧式 `/api/*`、`/admin` |
| api_keys 表 | `X-API-Key` 头,值存于 `api_keys` 表 | `/api/v1/files`、`/api/v1/random` |
| Telegram | webhook secret_token(可选) | `/bot/*` |

## 2. 公开端点(无认证)

| 端点 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | 健康检查,返回 `{ok, time, version}` |
| `/dashboard` | GET | 内置简版面板页(废弃,建议用 `/admin`) |
| `/docs` | GET | 内置文档页(静态) |
| `/show` | GET | 公开轮播展示页(读 shared pool) |
| `/show/data` | GET | 轮播页数据接口(仅 `pt` 且非私密内容) |
| `/file/tg/<id>` | GET | 302 跳转 Telegram 官方直链(不暴露 token) |
| `/favicon.ico` | GET | 204 空响应 |
| `/webhook` | POST | Telegram webhook 入口(需 secret_token 时校验) |

## 3. 公开 JSON API v1(api_keys 表认证 + 限流)

> 认证:`X-API-Key: <api_keys.key>`。返回 401(无效)、429(限流)。按密钥 `level` 过滤结果,私密内容(`is_private=1`)仅 `vvip` 密钥可见。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/v1/files` | GET | 文件列表,支持 `page/page_size/type/chat_id/user_id/keyword/start_date/end_date`,按级别过滤 |
| `/api/v1/random` | GET | 随机内容,按级别过滤,`count` 指定条数 |

级别规则:密钥级别 `L` 可看到 `level <= L` 的公共内容(`is_private=0`);任何非 `vvip` 请求都看不到私密内容。详细见 [专有概念/内容分级与私密库](./专有概念/内容分级与私密库.md)。

## 4. 管理 API(管理员 Key)

前缀统一为 `/admin/api/`,`GET`/`POST`/`PATCH`/`DELETE` 均要求 `?api_key=` 或 `X-API-Key` = `env.API_KEY`,否则 401。

### 4.1 文件与统计

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/files` | GET | 文件列表(全量,含级别/私密标记) |
| `/admin/api/files` | DELETE | 删除文件(软删到回收站) |
| `/admin/api/files/tags` | POST | 批量设置文件标签 |
| `/admin/api/files/pool-status` | POST | 设置文件是否入池 |
| `/admin/api/stats` | GET | 总览统计 |
| `/admin/api/trash` | GET | 回收站列表 |
| `/admin/api/trash/restore` | POST | 回收站恢复 |
| `/admin/api/unsaved` | GET | 未转存完成列表 |
| `/admin/api/unsaved/retry` | POST | 批量重试未转存 |
| `/admin/api/processing` | GET | 处理中任务状态 |
| `/admin/api/retry` | POST | 重试单条转存 |

### 4.2 去重与存储维护

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/dedup` | POST | 触发查重(计算 MD5) |
| `/admin/api/dedup/stats` | GET | 查重统计 |
| `/admin/api/dedup/groups` | GET | 重复分组列表 |
| `/admin/api/dedup/row` | POST | 行级操作:清理/保留 |
| `/admin/api/dedup/rows` | POST | 批量行级操作 |
| `/admin/api/r2/inspect` | GET | R2 对象检视 |
| `/admin/api/r2/cleanup` | POST | R2 清理(回收站超期对象) |
| `/admin/api/compress/stats` | GET | WebP 压缩统计 |
| `/admin/api/compress/run` | POST | 手动触发压缩 |

### 4.3 随机库(共享)与私密库

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/pool` | GET | 共享库列表(分页/筛选) |
| `/admin/api/pool` | POST | 新增共享库条目 |
| `/admin/api/pool` | DELETE | 删除条目 |
| `/admin/api/pool/batch` | POST | 批量操作(设置级别等) |
| `/admin/api/pool/batch-delete` | POST | 批量删除 |
| `/admin/api/pool/import-page` | POST | 从展示页导入 |
| `/admin/api/pool/upload` | POST | 上传图片入池 |
| `/admin/api/pool/upload-postimages` | POST | Postimages 批量上传入池 |
| `/admin/api/pool/toggle` | POST | 启用/停用条目 |
| `/admin/api/pool/tags` | POST | 设置条目标签 |
| `/admin/api/pool/from-tg` | POST | 从 Telegram 文件导入共享库 |
| `/admin/api/private-pool` | GET | 私密库列表(仅 is_private=1) |
| `/admin/api/private-pool/from-tg` | POST | 从 Telegram 导入私密库(级别固定 vvip) |

### 4.4 节目组与轮播配置

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/show-groups` | GET/POST/DELETE | 节目组增删查 |
| `/admin/api/show-groups/roll` | POST | 手动触发换图 |
| `/admin/api/show-config` | GET/POST | 轮播页配置 |

### 4.5 标签、命令、密钥、用户

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/tags` | GET | 标签列表 |
| `/admin/api/commands` | GET/POST/PATCH/DELETE | 自定义命令 CRUD |
| `/admin/api/keys` | GET | API 密钥列表(含级别) |
| `/admin/api/keys` | POST/PATCH/DELETE | 密钥创建/更新/删除 |
| `/admin/api/keys/toggle` | POST | 启用/停用密钥 |
| `/admin/api/users` | GET | 用户统计 |

### 4.6 设置与配置

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/settings/pi-key` | GET/POST | Postimages API Key(存 D1,跨端共享) |
| `/admin/api/settings/pool-tags` | GET/POST | 池标签预设 |
| `/admin/api/settings/proxy-mode` | GET/POST | 代理模式(入库不转存 R2) |
| `/admin/api/settings/proxy-only` | GET/POST | 仅代理(全部走直链实时拉取) |
| `/admin/api/settings/ai` | GET/POST | AI 管理配置(enabled/base/model/api_key/prompt) |
| `/admin/api/settings/notify` | GET/POST | 失败告警配置 |
| `/admin/api/settings/notify-test` | POST | 告警测试 |
| `/admin/api/settings/rate-limit` | GET/POST | 公开 API 限流配置 |
| `/admin/api/settings/r2-quota` | GET/POST | R2 套餐配额配置 |

### 4.7 用量、诊断与运维

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/r2-usage` | GET | R2 用量(GraphQL 官方 + 本地兜底) |
| `/admin/api/worker-usage` | GET | Worker 用量统计 |
| `/admin/api/usage-forecast` | GET | 用量预测与趋势 |
| `/admin/api/bot-info` | GET | Bot 信息(getMe) |
| `/admin/api/webhook-status` | GET | webhook 有效性检查 |
| `/admin/api/webhook-fix` | POST | 一键修复 webhook |
| `/admin/api/poll` | GET | 手动触发 getUpdates 轮询(兜底) |
| `/admin/api/backup` | GET | 立即导出全表 JSON |
| `/admin/api/backup` | POST | 导出并上传 R2(保留 20 份) |
| `/admin/api/backup/list` | GET | 备份列表 |
| `/admin/api/backup` | DELETE | 删除指定备份(仅限 `backups/db-` 前缀) |
| `/admin/api/ai/test` | POST | AI 测试(往指定 chat 发消息) |
| `/admin/api/ai/ask` | POST | AI 浮窗问答 |

## 5. Bot API 代理(Telegram 校验)

`/bot/*` 为 Telegram Bot API 的 worker 代理(免管理员认证,由 Telegram 侧签名/调用方持有 token),用于 webhook 外的管理操作:

`sendMessage`、`sendPhoto`、`sendDocument`、`sendVideo`、`getFile`、`getMe`、`getWebhookInfo`、`setWebhook`、`getUpdates`、`getChat`、`getChatMemberCount`、`banChatMember`、`unbanChatMember`、`deleteMessage`、`forwardMessage`、`copyMessage`。均 POST。

## 6. 旧式 API(管理员 Key,兼容)

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/files` | GET | 文件列表(分页/筛选) |
| `/api/file` | GET | 文件详情 |
| `/api/file` | DELETE | 删除文件 |
| `/api/stats` | GET | 统计 |
| `/api/by-chat` | GET | 按群组查询 |
| `/api/by-user` | GET | 按用户查询 |
| `/api/by-date` | GET | 按日期查询 |
| `/api/search` | GET | 搜索 |
| `/api/latest` | GET | 最新文件 |
| `/api/stream` | GET | 文件流 |
| `/api/bots` | GET/POST/DELETE | 多 Bot 管理 |
| `/api/config` | GET/POST | 配置读写 |
| `/api/bot-info` | GET | Bot 信息 |

## 7. 统一返回格式

- 成功:JSON `{"ok": true, "data": ...}`
- 失败:`{"ok": false, "error": "..."}`,配合 400/401/404/429/500 状态码
- 管理端未认证:401 `{"ok": false, "error": "Unauthorized"}`
- 所有响应带 CORS 头,支持跨域调用
