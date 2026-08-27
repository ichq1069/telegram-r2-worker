# Telegram R2 Worker 自动部署说明

推送本仓库 `main` 分支后，GitHub Actions 会自动：
1. 语法校验 `worker.js`
2. `wrangler deploy` 部署 Worker（`telegram-r2-bot`）
3. 上传 `admin.html` 到 R2（覆盖同名文件）

## 首次配置（一次性）

1. **确认 GitHub 账号**：需要一个 GitHub 账号来放仓库（私有仓库即可，免费）。
2. **Cloudflare API Token**：Dashboard → 我的个人资料 → API 令牌 → 创建令牌 → 自定义，权限勾选：
   - Account · Cloudflare Workers Scripts · **Edit**
   - Account · D1 · **Edit**
   - Account · R2 Storage · **Edit**
   - Account · Workers R2 Storage · **Edit**
   - Account · Account Settings · **Read**
   范围限定到部署用的账号。创建后复制 token（只显示一次）。
3. **GitHub Secrets**（仓库 → Settings → Secrets and variables → Actions）新增 2 个：
   - `CLOUDFLARE_API_TOKEN` = 第 2 步的 token
   - `CLOUDFLARE_ACCOUNT_ID` = `77fc93b832a9f816ee841c3a321b57b5`
4. **确认 Dashboard secrets**：`TG_BOT_TOKEN`、`API_KEY`、`TG_SECRET` 已在
   Dashboard → Workers → `telegram-r2-bot` → Settings → Variables and Secrets 中配置
   （wrangler 部署不会删除它们，无需迁移）。
5. **本地推送**（若换电脑则先 clone）：
   ```bash
   git push
   ```
   push 后到 GitHub → Actions 页看部署是否成功。

## 日常操作（任何电脑）

```bash
git clone https://github.com/<你的用户名>/telegram-r2-worker.git
cd telegram-r2-worker
# 改 worker.js 或 admin.html ...
git add -A
git commit -m "描述改动"
git push
```
push 后 1-2 分钟自动上线。不会本地部署时，用 GitHub 网页编辑器直接改文件 → commit → 同样触发自动部署。

## 应急手动部署

Dashboard → Workers → `telegram-r2-bot` → 编辑代码 → 粘贴 `worker.js` → Save and Deploy。
⚠️ 手动部署后务必把改动同步回仓库并 push，避免两边不一致。

## 注意

- `index.js`、`handlers/`、`services/`、`utils/` 是**废弃的实验版**，实际运行的是 `worker.js` + 正式模块目录 `src/`（util.js/db.js/notify.js/backup.js/ratelimit.js），忽略废弃目录。
- 手动部署时**必须**同时粘贴 `worker.js` 和 `src/` 下所有文件（Worker 代码编辑器支持多文件）或在编辑器新建对应文件。
- `TG_BOT_TOKEN`、`API_KEY`、`TG_SECRET` 是机密，**禁止**写进代码或提交到仓库。
