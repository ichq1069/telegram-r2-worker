# Telegram R2 Worker 部署脚本
# 在 Cloudflare Workers 控制台设置环境变量后运行此脚本

# 1. 安装 wrangler（如果没有）
# npm install -g wrangler

# 2. 登录 Cloudflare
# wrangler login

# 3. 部署 Worker
wrangler deploy

# 4. 设置环境变量（也可以在控制台设置）
# wrangler secret put TG_BOT_TOKEN
# wrangler secret put R2_ACCESS_KEY_ID
# wrangler secret put R2_SECRET_ACCESS_KEY
# wrangler secret put R2_ACCOUNT_ID
# wrangler secret put R2_BUCKET_NAME
# wrangler secret put R2_PUBLIC_URL
# wrangler secret put BACKEND_API_URL

# 5. 设置 Telegram Webhook
# curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://telegram-r2-bot.<你的CF用户名>.workers.dev"
