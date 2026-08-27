# Telegram R2 Bot Worker

Telegram Bot + Cloudflare R2 + D1 永久存储方案

## 功能

- 支持所有文件类型：图片、视频、文档（zip/pdf/txt/docx等）、音频、语音
- 自动回复永久直链到 Telegram 聊天
- D1 数据库存储元数据，支持查询
- 对外 API 接口，方便第三方对接
- 按月自动分目录存储

## 架构

```
Telegram 群组/频道
       ↓
Cloudflare Worker (webhook)
       ↓
  ┌────┴────┐
  ↓         ↓
 R2 存储   D1 数据库
 (文件)    (元数据)
  ↓         ↓
永久直链   API 查询
```

## 目录结构

```
telegram-r2-worker/
├── index.js              # 入口，路由分发
├── handlers/
│   ├── webhook.js        # Telegram Webhook 处理
│   └── api.js            # API 接口处理
├── services/
│   ├── r2.js             # R2 存储服务
│   ├── d1.js             # D1 数据库服务
│   └── telegram.js       # Telegram API 服务
├── utils/
│   ├── response.js       # 响应工具
│   └── helpers.js        # 通用工具函数
├── wrangler.toml         # Worker 配置
└── README.md             # 说明文档
```

## 部署步骤

### 1. 创建 D1 数据库
```bash
wrangler d1 create telegram-files
```
记录输出的 `database_id`，填入 `wrangler.toml`

### 2. 设置环境变量（CF 控制台 Worker → Settings → Variables）

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `TG_BOT_TOKEN` | Bot Token | `8727712730:AAG_...` |
| `TG_SECRET` | Webhook 密钥（可选） | `your_secret` |
| `R2_PUBLIC_URL` | R2 公开访问地址 | `https://telegramup.wo58.cn` |
| `BACKEND_API_URL` | 后端回调地址 | `http://xxx/admin_api.php?route=telegram/webhook-callback` |
| `API_KEY` | 对外 API 密钥 | `随机生成的密钥` |

### 3. 部署 Worker
```bash
wrangler deploy
```

### 4. 设置 Telegram Webhook
```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<worker-name>.<user>.workers.dev/webhook
```

## API 接口

### 认证
```
请求头：X-API-Key: <your-api-key>
或参数：?api_key=<your-api-key>
```

### 接口列表

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/files` | GET | 文件列表（分页、筛选） |
| `/api/file?id=123` | GET | 文件详情 |
| `/api/stats` | GET | 统计信息 |
| `/api/latest` | GET | 最新文件 |
| `/api/search?q=xxx` | GET | 搜索 |
| `/api/by-chat` | GET | 按群组查询 |
| `/api/by-user` | GET | 按用户查询 |
| `/api/by-date` | GET | 按日期查询 |
| `/api/stream?id=123` | GET | 文件流 |
| `/webhook` | POST | Telegram 回调 |
| `/health` | GET | 健康检查 |

### 参数说明

**/api/files**
| 参数 | 类型 | 说明 |
|------|------|------|
| page | int | 页码，默认 1 |
| page_size | int | 每页数量，默认 20，最大 100 |
| type | string | 文件类型：photo/document/video/audio |
| chat_id | string | 群组 ID |
| user_id | int | 用户 ID |
| keyword | string | 搜索关键词 |
| start_date | string | 开始日期：2026-08-01 |
| end_date | string | 结束日期：2026-08-31 |

**/api/by-chat**
| 参数 | 说明 |
|------|------|
| chat_id | 群组 ID |
| chat_title | 群组名称（模糊匹配） |

**/api/by-user**
| 参数 | 说明 |
|------|------|
| user_id | 用户 ID |
| username | 用户名（模糊匹配） |

**/api/by-date**
| 参数 | 说明 |
|------|------|
| date | 日期：2026-08-23 |

### 调用示例

```bash
# 获取最新 10 个图片
curl -H "X-API-Key: your_key" \
  "https://worker.xxx.workers.dev/api/latest?type=photo&limit=10"

# 按日期查询
curl -H "X-API-Key: your_key" \
  "https://worker.xxx.workers.dev/api/by-date?date=2026-08-23"

# 搜索文件
curl -H "X-API-Key: your_key" \
  "https://worker.xxx.workers.dev/api/search?q=风景"

# 分页查询
curl -H "X-API-Key: your_key" \
  "https://worker.xxx.workers.dev/api/files?page=2&page_size=50&type=document"
```

### 返回格式
```json
{
  "ok": true,
  "data": {
    "total": 100,
    "page": 1,
    "page_size": 20,
    "total_pages": 5,
    "items": [
      {
        "id": 1,
        "r2_url": "https://telegramup.wo58.cn/2026/08/abc.jpg",
        "file_name": "photo.jpg",
        "file_type": "photo",
        "file_size": 1024000,
        "chat_title": "我的群组",
        "username": "user123",
        "created_at": "2026-08-23T10:30:00.000Z"
      }
    ]
  }
}
```

## D1 数据库表结构

```sql
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storage_key TEXT NOT NULL,       -- R2 存储路径
  r2_url TEXT NOT NULL,            -- 永久直链
  chat_id TEXT,                    -- 群组 ID
  chat_title TEXT,                 -- 群组名称
  chat_type TEXT,                  -- 类型
  chat_username TEXT,              -- 群组用户名
  user_id INTEGER,                 -- 用户 ID
  username TEXT,                   -- 用户名
  full_name TEXT,                  -- 完整姓名
  telegram_file_id TEXT,           -- Telegram 文件 ID
  file_name TEXT,                  -- 文件名
  file_size INTEGER,               -- 文件大小
  file_type TEXT,                  -- 类型
  mime_type TEXT,                  -- MIME 类型
  width INTEGER,                   -- 图片宽度
  height INTEGER,                  -- 图片高度
  caption TEXT,                    -- 说明文字
  message_id TEXT,                 -- 消息 ID
  created_at TEXT                  -- 上传时间
);
```
