# Worker 主入口 worker.js

生产唯一入口（`wrangler.toml` `main = "worker.js"`），约 930 行。只做 import、路由、`queue` / `scheduled`。业务在 `src/`。

`/health` 返回 `version: 'v8'`。

## 三个回调

| 回调 | 位置 | 职责 |
|---|---|---|
| `fetch` | `worker.js:41` | HTTP 分发 |
| `queue` | `worker.js:454` | 消费 Queue，调 `handleQueueMessage`（`worker.js:521`） |
| `scheduled` | `worker.js:466` | Cron：日报、webhook 自愈、轮询、未转存、查重、存储维护、压缩、内置命令、节目换图 |

## fetch 分发顺序

1. `OPTIONS` → CORS；`ensureTablesOnce`；`bumpWorkerStat`
2. 公开页：`/health` `/webhook` `/dashboard` `/docs` `/show` `/gallery` `/admin` `/jx` `/scrape` `/user` `/user-manage` `/admin/guide`
3. 用户门户公开写接口：`/api/user/login|register|redeem|reset-password|key-info`（IP 限流）
4. 用户上传 API：`/api/v1/user/*`
5. `/file/tg/` 签名直链（IP 限流）
6. `/admin/api/*`（`env.API_KEY` + 管理员限流）
7. `/bot/*`
8. `/api/v1/files|random|upload`（`api_keys` + 限流 + 级别）
9. `/api/user/stats|tags|logs`（key-pass）
10. `/api/app/stats/*`、`/api/app/update`
11. 旧式 `/api/*`（`env.API_KEY`）
12. 未匹配 404；外层 catch 转 JSON 500

## Queue

`handleQueueMessage`：body 含 `link` 走 `processShareLinkAsync`；否则需要 `fi` 与 `dbId`，缺 `dbId` 直接跳过（INSERT 失败避免幽灵转存）。

## 关键设计

- **先入库再转存**：webhook 快回；未完成由「未转存」tab 与 Cron 补齐
- **分级在 SQL 层**：`levelFilter`；非 vvip 加 `is_private=0`
- **webhook + 轮询**：`ensureWebhook` 自愈，Cron `getUpdates` 兜底（Local Bot API 可超 20MB）
- **直链签名**：`fileTok`，无 token 403
- **统计**：`worker_stats` 兜底，主统计走 GraphQL

## 修改注意

- 新路由按上面顺序插入；v1 要同时处理 `checkApiKey` 与级别
- 分级逻辑在 `src/core.js`，不要在 `worker.js` 再写一份
- 改完 `node --check worker.js` 与相关 `src/*.js`
