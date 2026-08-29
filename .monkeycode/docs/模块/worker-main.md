# Worker 主入口 worker.js

生产 Worker 唯一入口(`wrangler.toml:8` `main = "worker.js"`),约 4800 行。包含路由分发、三个回调、全部业务 handler。

## 三个回调

| 回调 | 职责 |
|---|---|
| `fetch`(`worker.js:30`) | 所有 HTTP 请求;按 `method + pathname` 分发到公开/管理/Bot API/文件代理 |
| `queue`(`worker.js:207`) | Cloudflare Queues 消费,转交 `handleQueueMessage`(`worker.js:274`),处理分享链接与文件后台转存 |
| `scheduled`(`worker.js:219`) | Cron 触发,依次执行日报、webhook 自愈、轮询兜底、未转存重试、查重、存储维护、WebP 压缩、内置命令同步、节目组换图 |

## fetch 分发结构(按顺序匹配)

1. `OPTIONS` → CORS 预检;`ensureTablesOnce` 幂等建表;`bumpWorkerStat` 兜底统计(`worker.js:31-35`)
2. 公开端点:`/health`、`/webhook`、`/dashboard`、`/docs`、`/show`、`/show/data`、`/admin`(读 R2)、`/file/tg/*`(直链代理)
3. 管理 API:`/admin/api/*` 全量(约 80+ 路由),鉴权 `env.API_KEY`(`worker.js:50-152`)
4. Bot API 代理:`/bot/*`(`worker.js:154-170`)
5. 公开 JSON API:`/api/v1/files`、`/api/v1/random`,鉴权 `api_keys` 表 + 限流 + 级别过滤(`worker.js:172-180`)
6. 旧式 API:`/api/*`(兼容,鉴权 `env.API_KEY`,`worker.js:182-201`)
7. 兜底 404

## 主要功能区(按行号)

| 行号 | 功能区 |
|---|---|
| `14-27` | 东八区时间工具 + 内容分级 helper(`LEVEL_RANK/sanitizeLevel/levelFilter`) |
| `274-435` | Queue 消费、群资源编号分配、命令菜单交互 |
| `440-887` | AI 管理/用量查询/请求工具、Bot 命令处理(`handleBotCommand`) |
| `987-1163` | 内置命令同步、count/pending/retry/health/stats/file/search 命令 |
| `1165-1428` | webhook 处理、webhook 自愈、update 处理核心、轮询兜底 |
| `1430-1647` | 传输槽位、分享链接解析、X 链接处理、分享链接异步转存 |
| `1648-1992` | 文件异步转存(`processFileAsync` 全链路)、update 主处理 |
| `1993-2138` | 文件信息提取、下载实现(流式/分段/进度) |
| `2160-2287` | R2 写入、MD5、EXIF 剥离、回复直链/文本/按钮 |
| `2288-2480+` | 回调查询、Bot API 代理、getUpdates 轮询实现 |
| 其余 | 公开 v1 API、旧式 API、管理 API 全部 handler、各 Cron 任务函数 |

## 关键设计

- **先入库、后台转存**:webhook 先写 `files` 表(状态 pending),再入队/异步转存,webhook 快速响应;未完成记录由后台「未转存」与 Cron 自动补齐
- **分级过滤在 SQL 层**:`levelFilter(keyLevel)` 拼 SQL 片段,公共内容恒 `is_private=0`(非 vvip),避免内存全量过滤
- **webhook + 轮询双通道**:webhook 失效时由 `ensureWebhook` 自愈,Cron 兜底 `getUpdates` 轮询(适配 Local Bot API 以突破 20MB 限制)
- **统计兜底**:`worker_stats` 本地计数,主统计走 Cloudflare GraphQL(`CF_API_TOKEN`);未配置时回退本地估算
- **传输槽位**:`acquireTransferSlot/releaseTransferSlot`(`worker.js:1430`)限制并发下载,防资源耗尽

## 修改注意

- 新增路由:按 fetch 分发顺序在合适位置加一行 `if (m === ... && p === ...)`;公开 v1 需同时处理 `checkApiKey` 与级别过滤
- 修改分级逻辑:`LEVEL_RANK`/`sanitizeLevel`/`levelFilter` 集中在文件头部
- 语法校验:改完 `node --check worker.js`;推 main 触发部署流水线(见 [部署流水线](./部署流水线.md))
