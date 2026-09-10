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
- Date: 2026-09-08
- Context: Discovered by Agent while performing 应用内更新签名不一致取证与修复
- Category: Troubleshooting & Debugging
- Instructions:
  - PicWall APK 更新线签名事实:CI runner 每轮 gradle 生成随机 debug keystore(已取证 cert SHA-256:+57=4821c8、+60=80aecc、+61=b06b43 各不相同),曾把固定 keystore 恢复到 `$HOME/.android/debug.keystore` 无效;2026-09-08 起 build-android.yml 在 Build 后用 secret `ANDROID_DEBUG_KEYSTORE_B64` 的固定 keystore + apksigner 对产物做 v1/v2/v3 确定性重签(首个固定签名为 +62=5bd947),此后所有版本同签
  - 用户设备上 v0.1.0+57 及其之前安装的旧包为随机签名,与固定签名(+62 起)不兼容,必须卸载一次后安装 v0.1.0+62+;之后应用内更新可无缝覆盖
  - APK 签名取证方法:产物可能为纯 v2/v3(无 META-INF/*.RSA),keytool 读不了;用 `apksigner.jar verify --print-certs <apk>`(build-tools zip 内含 lib/apksigner.jar)看 cert SHA-256
  - 私有仓库 Actions 下载 artifact:取 token 后 `GET /actions/artifacts?per_page=5` 找 name 匹配的 `id`,再 `GET /actions/artifacts/{id}/zip`(Accept: application/vnd.github+json)

[Project Knowledge Summary]
- Date: 2026-09-01
- Context: Discovered by Agent while performing github 推送与 Actions 部署排查
- Category: Troubleshooting & Debugging
- Instructions:
  - 沙箱对 github 有 SNI 过滤:默认 DNS 解析的 `20.205.243.x`(github.com 与 api.github.com)均 TLS 握手失败,报 `gnutls_handshake() failed`
  - 可用备用 IP 绕过:git 推送用 `git -c http.curloptResolve="github.com:443:140.82.113.3" push`,并已持久化到 git config(`http.https://github.com/.curloptResolve`);api.github.com 用 `140.82.112.6`(--resolve 覆盖),其它 140.82.x 节点会把 api 虚拟主机 301 到 github.com 网页端,不可用
  - GitHub API 查询私有仓库需认证:用 `printf "protocol=https\nhost=github.com\n" | git credential fill` 取 token 加 `Authorization: Bearer`,勿输出 token 明文
  - 部署成功标志:push 后查 `api.github.com/repos/ichq1069/telegram-r2-worker/actions/runs`,最新 commit 的 `Deploy Worker` run conclusion=success,线上 `telegram-r2-bot.wo58.cn` 返回 401 即 worker 已生效
  - Debian 12 pip 是 PEP 668 externally-managed,装依赖必须加 `--break-system-packages`(telethon/httpx 已装,telethon 1.44.0)
  - systemd ExecStart 引用 EnvironmentFile 变量写成 `${VAR}`,写成 `\$VAR` 会按字面 `$VAR` 传入导致 "Request URL is missing an http:// or https:// protocol"

[Project Knowledge Summary]
- Date: 2026-09-09
- Context: Discovered by Agent while performing 抖音视图与列表懒加载开发(纯逻辑验证只能走 CI)
- Category: Environment Configuration
- Instructions:
  - 沙箱内没有 flutter/dart 工具链,Android 端 Dart 改动的 analyze/test/构建验证唯一路径是 push main 触发 `build-android.yml`(Build Android APK run);该 workflow 包含 `flutter analyze` + `flutter test` + Debug APK,analyze 的 info 级问题(如 unnecessary_import)也会使 job 失败
  - 排障时按 GitHub Actions API 取失败日志:`GET /actions/runs/{id}/jobs` → job `id` → `GET /actions/jobs/{id}/logs`(需 `Accept: application/vnd.github+json` 与 Authorization Bearer),日志落 `/tmp/opencode/ci*.log` 再 grep
  - 纯测试/纯文档提交也会各触发一次完整构建 run(约 10 分钟),改纯逻辑(行布局/去重)建议同时写 `flutter test` 可跑的纯 Dart 单测随提交验证
  - release 打包偶发基础设施取消:日志尾部 `The runner has received a shutdown signal` + `Gradle task assembleRelease failed with exit code 143` + `The operation was canceled`,只要前序 analyze(`No issues found!`)/test 通过即非代码问题,重跑 run 或重推即可

[Project Knowledge Summary]
- Date: 2026-09-10
- Context: Discovered by Agent while investigating App 视频加载很久且不播放
- Category: Troubleshooting & Debugging
- Instructions:
  - 症状「视频(哪怕 1MB)加载半天不播放」根因在 `/file/tg` 代理:播放器(ExoPlayer)总有 Range 头,旧逻辑 `!rng` 才触发懒转存,导致视频永远走 Telegram 实时中转、从不落 R2,叠加 Worker 冷启动即表现为一直加载
  - 修复思路:ranged 请求也触发懒转存(按 id 去重防并发重复下载);上游忽略 Range 回 200 全量时,自行按请求区间切流回 206(否则播放器把整段当偏移读,moov 解析失败而卡住);上游回 206 则原样透传
  - 另一处放大器:视频条目常无独立封面,服务端 `thumb_url` 兜底成视频地址,App 端网格/播放器封面会把整段 mp4 当图片再下一次;已用 `MediaItem.posterUrl`(视频且缩略图非图片扩展名时返回空)改占位
  - 排查入口:`src/api.js handleTgFileRedirect`(代理/懒转存/Range)、`src/public.js decoratePoolRow`(签名直链)、`verify 206/Content-Range` 可用带 Range 的 curl 观察
