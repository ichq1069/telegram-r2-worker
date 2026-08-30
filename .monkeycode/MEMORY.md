# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[Project Knowledge Summary]
- Date: 2026-08-30
- Context: Discovered by Agent while performing 群历史图片抓取功能开发与部署
- Category: Operations & Deployment
- Instructions:
  - 部署链路已验证:push 到 `main` 分支触发 GitHub Actions 自动部署;线上 worker 域名 `https://telegram-r2-bot.wo58.cn`,R2 admin.html 地址 `https://telegramup.wo58.cn/admin.html`
  - 部署成功标志:线上 admin.html 的 `APP_VERSION` 变成 `v1.0.<run#>`(本地位 v1.0.0 占位),且页面含新面板标记;worker 路由无 token 返回 401 无法区分新旧,以 admin.html 版本为准
  - 群抓取设计:worker 当控制面(全局配置存 settings 表键 `ub_api_id/ub_api_hash/ub_session/ub_token/ub_api_key`,任务存 `userbot_tasks` 表),Telethon 脚本在本地/VPS 跑,参数全从后台拉(`/api/ubot/task/<id>/config?token=<ub_token>`),换机无感
  - `userbot_tasks` 表 `limit` 列名是 SQLite 保留字,建表/INSERT/UPDATE 必须写成 `"limit"`(双引号),否则报 `near "limit": syntax error`
  - 脚本侧鉴权用专用 `ub_token`(admin 可重置),不把 admin API_KEY 交给脚本;上传走 `/api/v1/upload` 用 `api_key` query 参数,脚本从后台拉 `ub_api_key`

[Project Knowledge Summary]
- Date: 2026-08-29
- Context: Discovered by Agent while performing 内容分级需求设计
- Category: Troubleshooting & Debugging
- Instructions:
  - 内容分级为 pt/vip/svip/vvip 四级,未分级数据默认最低级 `pt`(存量兼容);密钥级别 L 可见 `level<=L` 的公共内容,私密内容(`is_private=1`)仅 vvip 密钥可见
  - 展示页 `/show/data`、节目换图、`groupItems` 仅取 `level='pt' AND is_private=0` 的公共条目
  - 共享库更名只改 UI 文案,表名 `random_pool` 与路由 `/admin/api/pool` 保持不变,避免破坏外部调用
