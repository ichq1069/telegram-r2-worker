# 管理后台 admin.html

纯静态（原生 HTML/JS），部署上传到 R2 `bot-telegram/admin.html`，`GET /admin` 从 R2 读取。数据走 `/admin/api/*`（`?api_key=` 或 `X-API-Key` = `env.API_KEY`）。

页面不再把管理员 Key 嵌进源码；从 `?api_key=` / localStorage / 登录框读取。

## Tab 分组（`admin.html` `tabGroups`）

| 分组 | Tab id | 名称 |
|---|---|---|
| 概览 | `stats` / `users` | 概览、用户统计 |
| 文件 | `files` / `unsaved` / `trash` | Tele 文件、未转存、回收站 |
| 素材库 | `pool` / `private` / `quicktag` / `tags` | 共享库、私密库、快速打标、标签库 |
| 接口 | `gen` / `keys` / `keyusers` / `redeem` / `logs` | 接口生成、密钥、密钥用户、兑换码、调用日志 |
| Bot 配置 | `show` / `cmds` / `api` / `scrape` | 轮播、命令、Bot API、网页拾取 |
| 系统 | `r2files` / `ops` | R2 文件、运维 |
| App | `app` | App 安装/心跳 |

`allTabNames` 共 21 项。运维 tab 含 webhook、备份、AI、用量、配额、限流、通知、DB 模式（D1/MySQL）。

## 关键交互

- `switchTab` 按 tab 拉对应数据；`files` 页可见时自动刷新
- 级别徽章：pt 灰 / vip 蓝 / svip 紫 / vvip 金
- 共享库支持文件夹、批量改级别、导入（上传 / Telegram / 页面 / Postimages）
- Toast 可堆叠，3 秒消失

## 版本

流水线 `bump-version.js` 注入 `APP_VERSION = v1.0.<run#>`。仓库占位 `v1.0.0`。R2 `Cache-Control: public, max-age=300`。

## 约定

- 更名只改文案，不改 `/admin/api/pool` 与表 `random_pool`
- 新 tab：`tabGroups` + panel + handler
