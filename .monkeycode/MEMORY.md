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
- Date: 2026-08-29
- Context: Discovered by Agent while performing 内容分级功能开发与部署
- Category: Operations & Deployment
- Instructions:
  - 部署链路:push 到 `main` 分支触发 GitHub Actions(`.github/workflows/deploy-worker.yml`)自动部署 worker.js 并上传 admin.html 到 R2;执行环境无本机 wrangler/Cloudflare token,只能通过 git push 触发部署
  - 本地可做的验证:`node --check worker.js` 与 `node --check src/*.js` 语法检查;admin.html 内联 JS 用 `new Function` 包一层做语法检查
  - 所有 secrets(TG_BOT_TOKEN/API_KEY/CF_API_TOKEN)只存 GitHub Secrets,推送代码时禁止写入任何配置或文档;文档中密钥一律用 `<API_KEY>` 占位

[Project Knowledge Summary]
- Date: 2026-08-29
- Context: Discovered by Agent while performing 内容分级需求设计
- Category: Troubleshooting & Debugging
- Instructions:
  - 内容分级为 pt/vip/svip/vvip 四级,未分级数据默认最低级 `pt`(存量兼容);密钥级别 L 可见 `level<=L` 的公共内容,私密内容(`is_private=1`)仅 vvip 密钥可见
  - 展示页 `/show/data`、节目换图、`groupItems` 仅取 `level='pt' AND is_private=0` 的公共条目
  - 共享库更名只改 UI 文案,表名 `random_pool` 与路由 `/admin/api/pool` 保持不变,避免破坏外部调用
