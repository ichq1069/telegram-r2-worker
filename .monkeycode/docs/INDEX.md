# Telegram R2 Bot Worker

Telegram Bot + Cloudflare R2 + D1 的永久存储系统。Webhook 把群组/频道消息中的文件转存到 R2，元数据写入 D1（故障时可降级 MySQL），并提供签名直链、分级 JSON API、轮播/画廊页、用户门户、管理后台，以及 Flutter 客户端 PicWall。

线上 Worker 域名：`https://telegram-r2-bot.wo58.cn`；R2 静态托管：`https://telegramup.wo58.cn`。Worker `/health` 当前版本字段为 `v8`。

## 快速定位

| 你想做什么 | 入口 |
|---|---|
| 了解整体架构与数据流 | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| 对接公开 API / 管理 API / Bot API | [INTERFACES.md](./INTERFACES.md) |
| 本地开发 / 部署 / 排障 | [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md) |
| 内容分级(pt/vip/svip/vvip)与私密库 | [专有概念/内容分级与私密库](./专有概念/内容分级与私密库.md) |
| 共享库与私密库的区别 | [专有概念/共享库与私密库](./专有概念/共享库与私密库.md) |
| 文件从 Telegram 到 R2 的完整链路 | [专有概念/文件转存流程](./专有概念/文件转存流程.md) |
| 群资源编号(group_ref)规则 | [专有概念/群资源编号](./专有概念/群资源编号.md) |
| 签名直链与 Range 代理 | [专有概念/签名直链与代理](./专有概念/签名直链与代理.md) |
| D1 与 MySQL 双写 / 降级 | [专有概念/D1与MySQL双写](./专有概念/D1与MySQL双写.md) |
| 网页抓取与中转服务器 | [专有概念/网页抓取与中转](./专有概念/网页抓取与中转.md) |
| Worker 主入口(路由/调度) | [模块/worker-main](./模块/worker-main.md) |
| src/ 辅助模块 | [模块/src-modules](./模块/src-modules.md) |
| 管理后台 admin.html | [模块/admin-dashboard](./模块/admin-dashboard.md) |
| 部署流水线 | [模块/部署流水线](./模块/部署流水线.md) |
| PicWall Android 客户端 | [模块/picwall-android](./模块/picwall-android.md) |
| 抓取中转 relay | [模块/relay-server](./模块/relay-server.md) |

## 一句话介绍

Cloudflare Worker（`telegram-r2-bot`，入口 `worker.js`）接收 Telegram webhook → 下载或代理文件 → 元数据写 D1（可选镜像 MySQL）→ 回执签名直链；同时提供分级 JSON API、用户门户、公开轮播/画廊，以及上传到 R2 的纯静态管理后台。Android 端 PicWall 对接同一套 API。

## 功能亮点

- **全文件类型**：图片、视频、文档、音频、语音
- **签名直链**：`/file/tg/<token>/<id>.<ext>`，防枚举；代理模式支持 Range / 206，视频可懒转存到 R2
- **内容分级**：`pt/vip/svip/vvip` 四级，密钥级别对等过滤；私密库仅 vvip 可见
- **共享库 / 私密库**：`random_pool` 表，靠 `is_private` 隔离
- **公开 JSON API**：`/api/v1/files`、`/api/v1/random`、`/api/v1/upload`，走 `api_keys` 表认证 + 分钟级限流
- **用户门户**：`/user` 用 key + key-pass 登录；注册、兑换码、配额、用户上传
- **管理后台**：约 21 个 tab（文件/回收站/共享库/密钥/兑换码/抓取/R2/运维/App 等）
- **网页抓取**：`/scrape` + 外部 Python 中转，避开 Worker 256MB 内存限制
- **双库**：D1 为主，Hyperdrive 连 MySQL 作故障/限额备库
- **GitOps**：push `main` 部署 Worker；`android/picwall_app/**` 单独构建 APK

## 部署拓扑

```
GitHub main push
      │
      ├── Deploy Worker（路径忽略 android/**）
      └── Build Android APK（仅 android/picwall_app/**）
              │
Cloudflare  ┌── Worker telegram-r2-bot（worker.js + src/）
            ├── R2  bot-telegram（文件 + 静态页 + backups/）
            ├── D1  telegram-url
            ├── Hyperdrive telequnphoto → VPS MySQL
            └── Cron */2 * * * * 与 0 1 * * *
      │
      ├─ Telegram Bot API
      ├─ 抓取中转 relay（独立进程，默认 18088）
      └─ PicWall App / 公开 API / 管理后台
```

## 仓库布局（实际运行）

```
/workspace
├── worker.js            # 生产入口：路由分发 + queue/scheduled（约 930 行）
├── src/                 # 被 worker.js import 的业务模块（约 20 个文件）
├── admin.html           # 管理后台（上传到 R2）
├── admin-guide.html / user.html / user-manage.html / jx.html / scrape.html
├── wrangler.toml        # R2 / D1 / Hyperdrive / Cron / limits
├── android/picwall_app  # Flutter 客户端 PicWall
├── relay/               # 网页抓取中转（Python aiohttp）
├── .github/workflows/   # deploy-worker.yml + build-android.yml
├── index.js + handlers/ + services/ + utils/  # 早期实验版，wrangler 不引用
└── .monkeycode/docs/    # 本文档
```

`wrangler.toml` 的 `main = "worker.js"`。`index.js` 及 `handlers/`、`services/`、`utils/` 不被部署引用。

## 安全要点

- 密钥（`TG_BOT_TOKEN` / `API_KEY` / `CF_API_TOKEN` / `TG_SECRET` / `RELAY_KEY`）只存在 GitHub Secrets 与 Cloudflare secrets，不落仓库
- 公开 API 用 `api_keys` 表；管理 API 用 `env.API_KEY`；用户门户用 key + key-pass
- `/file/tg/` 必须带签名 token，无 token 的旧链接返回 403
- 私密库内容仅 vvip 密钥可见；查询在 SQL 层按级别过滤
- 文档与示例中的密钥一律用 `<API_KEY>` 占位
