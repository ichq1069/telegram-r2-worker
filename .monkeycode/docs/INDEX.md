# Telegram R2 Bot Worker

Telegram Bot + Cloudflare R2 + D1 的永久存储系统,负责把 Telegram 群组/频道消息中的文件转存到 R2,元数据写入 D1,并提供永久直链、公开 JSON API、轮播展示页与功能完备的管理后台。

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
| Worker 主入口(路由/调度) | [模块/worker-main](./模块/worker-main.md) |
| 管理后台 admin.html | [模块/admin-dashboard](./模块/admin-dashboard.md) |
| D1 表结构 src/db.js | [模块/src-modules](./模块/src-modules.md) |

## 一句话介绍

一个 Cloudflare Worker(`telegram-r2-bot`),webhook 接收 Telegram 消息 → 下载文件存 R2 → 元数据写 D1 → 自动回复永久直链;同时提供分级 JSON API、公开轮播页与一个可替换(上传到 R2)的纯静态管理后台。

## 功能亮点

- **全文件类型**:图片、视频、文档(zip/pdf/txt/docx 等)、音频、语音
- **永久直链**:`/file/tg/<id>` 302 跳转官方直链,不暴露 bot token
- **内容分级**:`pt/vip/svip/vvip` 四级,密钥级别对等过滤,低级别请求不会拿到高级别内容
- **共享库 / 私密库**:随机轮播库(shared pool)与独立私密库(private pool)
- **公开 JSON API**:`/api/v1/files`、`/api/v1/random`,走 `api_keys` 表认证 + D1 分钟级限流
- **管理后台**:文件管理、回收站、未转存重试、去重、WebP 压缩、随机库管理、节目组、标签、API 密钥、用量预测、备份等十余个功能 tab
- **后台任务**:Queue 消费(长转存)、Cron 兜底轮询与自愈、D1 自动备份、webhook 自愈
- **GitOps 部署**:push main 即自动部署,secrets 自动写入

## 部署拓扑

```
GitHub main push
      │  GitHub Actions
      ▼
Cloudflare  ┌── Worker (telegram-r2-bot / worker.js)
            ├── R2  bot-telegram (文件 + admin.html + backups/)
            ├── D1  telegram-url (元数据 / 密钥 / 设置 / 限流)
            └── Cron (*/2 分钟, UTC 01:00)
      │
      ├─ Telegram Bot API (webhook + getUpdates 轮询 + 文件下载)
      └─ 对外 HTTP:公开 API / 管理 API / 轮播页 / 直链
```

## 仓库布局(实际运行)

```
/workspace
├── worker.js        # 生产 Worker 入口(main),约 4800 行,含路由/调度/全部 handler
├── admin.html       # 管理后台(上传到 R2,GET /admin 从 R2 读)
├── wrangler.toml    # Cloudflare 配置(R2/D1/Cron/observability)
├── src/             # Worker 引用的辅助模块(db/util/notify/ratelimit/backup)
├── .github/workflows/deploy-worker.yml  # push main 自动部署
├── .github/scripts/bump-version.js      # admin.html 版本号注入
├── DEPLOY.md        # 部署说明(历史)
├── R2_LIFECYCLE_GUIDE.md  # R2 生命周期策略说明
├── deploy.sh        # 本地部署脚本(历史)
├── index.js + handlers/ + services/ + utils/  # 早期实验版代码,已不被 wrangler 引用
└── .monkeycode/     # 需求/设计/实现文档与本文档
```

## 安全要点

- 所有密钥(`TG_BOT_TOKEN`/`API_KEY`/`CF_API_TOKEN`/`TG_SECRET`)仅存于 GitHub Secrets 与 Cloudflare secrets,不落仓库
- 公开 API 与管理员 API 认证分离:前者用 `api_keys` 表,后者用 `env.API_KEY`
- 私密库内容仅 `vvip` 密钥可见;所有查询按级别在 SQL 层过滤
- 直链跳转不携带 token;webhook 端点只接受 Telegram 的回调(secret_token 可选)
