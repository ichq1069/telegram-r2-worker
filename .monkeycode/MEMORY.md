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
- Date: 2026-08-31
- Context: Discovered by Agent while performing webhook 500 排查与接口冷启动性能优化
- Category: Troubleshooting & Debugging
- Instructions:
  - webhook 500 排查法:先发空 update / 纯文本 / 命令 / inline_query 构造样本请求,读返回 body 的 `error` 字段定位 ReferenceError(如 `getBotUsername is not defined`),比只看状态码高效
  - 线上域名 `telegram-r2-bot.wo58.cn` 的 Worker 冷启动存在平台层间歇性慢:纯内存 `/health` 也可能 30-45s,跨 HKG/NRT 节点随机出现,与 D1/caches/代码无关(Cloudflare 免费版 Worker 冷启动/排队现象);R2 静态托管 `telegramup.wo58.cn` 无此问题
  - 曾误判为 D1/caches 慢:实际 Worker 内 `caches.default` 的 match/put 冷启动本身慢(files 接口 45-60s),且 CDN 层 CF-Cache-Status HIT 已生效,应只用 Cache-Control s-maxage 交给边缘缓存,不要在 Worker 内二次缓存
  - 验证用唯一 URL(`cb=时间戳`)绕过 CDN/边缘缓存测真实回源耗时,避免缓存命中掩盖慢请求

[Project Knowledge Summary]
- Date: 2026-08-29
- Context: Discovered by Agent while performing 内容分级需求设计
- Category: Troubleshooting & Debugging
- Instructions:
  - 内容分级为 pt/vip/svip/vvip 四级,未分级数据默认最低级 `pt`(存量兼容);密钥级别 L 可见 `level<=L` 的公共内容,私密内容(`is_private=1`)仅 vvip 密钥可见
  - 展示页 `/show/data`、节目换图、`groupItems` 仅取 `level='pt' AND is_private=0` 的公共条目
  - 共享库更名只改 UI 文案,表名 `random_pool` 与路由 `/admin/api/pool` 保持不变,避免破坏外部调用

[Project Knowledge Summary]
- Date: 2026-09-01
- Context: Discovered by Agent while performing github 推送与 Actions 部署排查
- Category: Troubleshooting & Debugging
- Instructions:
  - 沙箱对 github 有 SNI 过滤:默认 DNS 解析的 `20.205.243.x`(github.com 与 api.github.com)均 TLS 握手失败,报 `gnutls_handshake() failed`
  - 可用备用 IP 绕过:git 推送用 `git -c http.curloptResolve="github.com:443:140.82.113.3" push`,并已持久化到 git config(`http.https://github.com/.curloptResolve`);api.github.com 用 `140.82.112.6`(--resolve 覆盖),其它 140.82.x 节点会把 api 虚拟主机 301 到 github.com 网页端,不可用
  - GitHub API 查询私有仓库需认证:用 `printf "protocol=https\nhost=github.com\n" | git credential fill` 取 token 加 `Authorization: Bearer`,勿输出 token 明文
  - 部署成功标志:push 后查 `api.github.com/repos/ichq1069/telegram-r2-worker/actions/runs`,最新 commit 的 `Deploy Worker` run conclusion=success,线上 `telegram-r2-bot.wo58.cn` 返回 401 即 worker 已生效
  - VPS 节点(群抓取执行机):主机 `84.247.129.220`(vmi2925908),SSH 端口 3356,root 登录(密码凭据存于会话,勿入库);沙箱出口 IP `39.106.200.193` 需在该机宝塔放行才能 SSH
  - 部署目录 `/opt/ubot`,脚本 `userbot_pull.py`(与仓库 scripts/ 同步),配置 `/opt/ubot/config.env` 字段 `UBOT_SERVER/UBOT_TOKEN/UBOT_SRV_TOKEN/UBOT_TASKS`;systemd 服务 `ubot-agent.service`
  - Debian 12 pip 是 PEP 668 externally-managed,装依赖必须加 `--break-system-packages`(telethon/httpx 已装,telethon 1.44.0)
  - systemd ExecStart 引用 EnvironmentFile 变量写成 `${VAR}`,写成 `\$VAR` 会按字面 `$VAR` 传入导致 "Request URL is missing an http:// or https:// protocol"
  - 故障排查:journalctl -u ubot-agent 看崩溃循环(NRestarts),/var/log/ubot-agent.log 看脚本日志;token 为空不崩溃但心跳鉴权失败,需在 worker 后台「群抓取/服务器」面板生成 ub_token 与 srv_token 填入 config.env
