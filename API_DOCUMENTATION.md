# Telegram R2 Bot Worker API 文档

**版本**: v7  
**基础 URL**: `https://telegram-r2-bot.wo58.cn`

## 目录

1. [公开 API](#公开-api)
2. [认证 API](#认证-api)
3. [管理员 API](#管理员-api)
4. [Webhook API](#webhook-api)
5. [Bot API 代理](#bot-api-代理)
6. [错误响应格式](#错误响应格式)

---

## 公开 API

无需认证的端点，支持 IP 速率限制。

### 健康检查

```
GET /health
```

**响应**:
```json
{
  "ok": true,
  "time": "2026-08-31T10:00:00.000Z",
  "version": "v7"
}
```

### 幻灯片数据

```
GET /show/data
```

**参数**:
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| tags | string | 否 | 标签筛选（逗号分隔） |
| type | string | 否 | 文件类型筛选 |
| count | int | 否 | 返回数量（默认 20） |
| shuffle | int | 否 | 是否随机（1=是，0=否） |

**响应**:
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 1,
        "url": "https://telegramup.wo58.cn/2026/08/abc.jpg",
        "thumb_url": "https://telegramup.wo58.cn/2026/08/abc_thumb.jpg",
        "title": "图片标题",
        "tags": "风景,自然",
        "file_type": "photo"
      }
    ],
    "config": {
      "enabled": 1,
      "interval": 5,
      "showTitle": 1
    }
  }
}
```

### 画廊数据

```
GET /gallery/data
```

**参数**:
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| api_key | string | 是 | API 密钥 |
| tags | string | 否 | 标签筛选 |
| type | string | 否 | 文件类型筛选 |
| level | string | 否 | 内容级别筛选 |
| page | int | 否 | 页码（默认 1） |
| limit | int | 否 | 每页数量（默认 20） |

**响应**:
```json
{
  "ok": true,
  "data": {
    "total": 100,
    "page": 1,
    "limit": 20,
    "items": [...]
  }
}
```

---

## 认证 API

需要 API 密钥的端点，支持按密钥速率限制。

### 用户登录

```
POST /api/user/login
```

**请求体**:
```json
{
  "key": "vk_xxxxxxxxxxxxxxxx",
  "key_pass": "用户密码"
}
```

**响应**:
```json
{
  "ok": true,
  "data": {
    "id": 1,
    "name": "用户名称",
    "level": "vip",
    "expires_at": "2026-12-31"
  }
}
```

### 用户注册

```
POST /api/user/register
```

**请求体**:
```json
{
  "username": "user123",
  "password": "securepassword",
  "redeem_code": "RZ-XXXXXXXX"
}
```

**响应**:
```json
{
  "ok": true,
  "data": {
    "key": "vk_xxxxxxxxxxxxxxxx",
    "message": "注册成功"
  }
}
```

### 兑换码兑换

```
POST /api/user/redeem
```

**请求体**:
```json
{
  "key": "vk_xxxxxxxxxxxxxxxx",
  "redeem_code": "RZ-XXXXXXXX"
}
```

**响应**:
```json
{
  "ok": true,
  "data": {
    "message": "兑换成功",
    "new_level": "svip",
    "expires_at": "2027-01-01"
  }
}
```

---

## 管理员 API

需要管理员 API 密钥的端点。

### 文件列表

```
GET /admin/api/files
```

**参数**:
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| api_key | string | 是 | 管理员 API 密钥 |
| page | int | 否 | 页码（默认 1） |
| page_size | int | 否 | 每页数量（默认 20，最大 100） |
| type | string | 否 | 文件类型筛选 |
| chat_id | string | 否 | 群组 ID 筛选 |
| keyword | string | 否 | 关键词搜索 |

**响应**:
```json
{
  "ok": true,
  "data": {
    "total": 1000,
    "page": 1,
    "page_size": 20,
    "items": [
      {
        "id": 1,
        "file_name": "photo.jpg",
        "file_type": "photo",
        "file_size": 1024000,
        "r2_url": "https://telegramup.wo58.cn/2026/08/abc.jpg",
        "chat_title": "我的群组",
        "created_at": "2026-08-31T10:00:00.000Z"
      }
    ]
  }
}
```

### 统计信息

```
GET /admin/api/stats
```

**响应**:
```json
{
  "ok": true,
  "data": {
    "total_files": 1000,
    "total_size": 1073741824,
    "today_uploads": 50,
    "month_uploads": 1500,
    "by_type": [
      { "file_type": "photo", "count": 800 },
      { "file_type": "video", "count": 150 },
      { "file_type": "document", "count": 50 }
    ]
  }
}
```

### 密钥管理

```
GET /admin/api/keys
POST /admin/api/keys
PATCH /admin/api/keys
DELETE /admin/api/keys
```

**创建密钥请求体**:
```json
{
  "name": "用户名称",
  "level": "vip",
  "expires_at": "2026-12-31",
  "scopes": "files:read"
}
```

### 标签管理

```
GET /admin/api/tags
POST /admin/api/files/tags
```

**设置文件标签请求体**:
```json
{
  "file_id": 1,
  "tags": "风景,自然,高清"
}
```

### 共享库管理

```
GET /admin/api/pool
POST /admin/api/pool
DELETE /admin/api/pool
POST /admin/api/pool/import-page
POST /admin/api/pool/upload
```

### 去重管理

```
POST /admin/api/dedup
GET /admin/api/dedup/stats
GET /admin/api/dedup/groups
POST /admin/api/dedup/row
POST /admin/api/dedup/rows
```

### 存储维护

```
GET /admin/api/r2/inspect
POST /admin/api/r2/cleanup
GET /admin/api/trash
POST /admin/api/trash/restore
```

### Webhook 管理

```
GET /admin/api/webhook-status
POST /admin/api/webhook-fix
GET /admin/api/webhook-logs
```

### AI 管理

```
GET /admin/api/settings/ai
POST /admin/api/settings/ai
POST /admin/api/ai/test
POST /admin/api/ai/ask
```

**AI 配置请求体**:
```json
{
  "enabled": 1,
  "base": "https://api.deepseek.com",
  "model": "deepseek-chat",
  "api_key": "sk-xxxxxxxx",
  "prompt": "你是一个智能助手"
}
```

---

## Webhook API

### Telegram Webhook

```
POST /webhook
```

**请求头**:
- `X-Telegram-Bot-Api-Secret-Token`: Webhook 密钥（可选）

**请求体**: Telegram Update JSON

**响应**:
```json
{
  "ok": true,
  "url": "https://telegramup.wo58.cn/2026/08/abc.jpg",
  "fileId": 123,
  "fileType": "photo"
}
```

---

## Bot API 代理

代理 Telegram Bot API 请求，隐藏真实 Bot Token。

### 发送消息

```
POST /bot/sendMessage
```

**请求体**:
```json
{
  "chat_id": "chat_id",
  "text": "消息内容",
  "reply_to_message_id": 123
}
```

### 发送图片

```
POST /bot/sendPhoto
```

**请求体**:
```json
{
  "chat_id": "chat_id",
  "photo": "https://example.com/photo.jpg",
  "caption": "图片说明"
}
```

### 发送文档

```
POST /bot/sendDocument
```

### 发送视频

```
POST /bot/sendVideo
```

### 获取文件

```
POST /bot/getFile
```

### 获取 Bot 信息

```
POST /bot/getMe
```

### 获取 Webhook 信息

```
POST /bot/getWebhookInfo
```

### 设置 Webhook

```
POST /bot/setWebhook
```

---

## 错误响应格式

所有错误响应遵循统一格式：

```json
{
  "ok": false,
  "error": "错误描述",
  "code": "ERROR_CODE"
}
```

### 常见错误码

| HTTP 状态码 | 错误码 | 说明 |
|------------|--------|------|
| 400 | bad_request | 请求参数错误 |
| 401 | unauthorized | 未授权 |
| 403 | forbidden | 禁止访问 |
| 404 | not_found | 资源不存在 |
| 429 | rate_limit_exceeded | 速率限制超限 |
| 500 | internal_error | 内部服务器错误 |

---

## 速率限制

### 公开 API

- **限制**: 每分钟 30 次（可配置）
- **维度**: 按 IP 地址
- **超限响应**: HTTP 429

### 认证 API

- **限制**: 每分钟 60 次（可配置）
- **维度**: 按 API 密钥
- **超限响应**: HTTP 429

### 配置

通过管理员 API 配置速率限制：

```json
{
  "enabled": true,
  "limit_per_min": 60,
  "public_enabled": true,
  "public_limit_per_min": 30,
  "ip_enabled": true,
  "ip_limit_per_min": 100
}
```

---

## 认证方式

### API 密钥

在请求头或查询参数中传递 API 密钥：

**请求头方式**:
```
X-API-Key: vk_xxxxxxxxxxxxxxxx
```

**查询参数方式**:
```
?api_key=vk_xxxxxxxxxxxxxxxx
```

### 管理员密钥

管理员 API 使用专用的管理员密钥：

```
X-API-Key: your_admin_api_key
```

---

## 内容级别

系统支持四级内容分级：

| 级别 | 权限 | 说明 |
|------|------|------|
| pt | 最低 | 公开内容（默认） |
| vip | 中等 | VIP 用户可见 |
| svip | 较高 | SVIP 用户可见 |
| vvip | 最高 | 仅 vvip 用户可见 |

**级别对等规则**: 低级别密钥无法获取高级别内容。

---

## 文件存储

### R2 存储路径

文件按月自动分目录存储：
```
YYYY/MM/随机哈希.扩展名
```

示例：
```
2026/08/a1b2c3d4e5f6g7h8.jpg
```

### 永久直链

文件访问使用永久直链：
```
https://telegramup.wo58.cn/2026/08/a1b2c3d4e5f6g7h8.jpg
```

---

## 更新日志

### v7 (2026-08-31)
- 添加 IP 速率限制
- 优化数据库索引
- 改进日志系统

### v6 (2026-08-30)
- 添加内容分级系统
- 添加共享库和私密库
- 添加标签管理

### v5 (2026-08-29)
- 添加 AI 集成
- 添加 Bot API 代理
- 优化大文件处理