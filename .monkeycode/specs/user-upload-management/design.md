# Technical Design Document

## Overview

为 Telegram R2 Bot Worker 前端用户增加上传管理功能,允许用户上传图片到自己的图片库,并通过 API 调用访问这些图片。

## Architecture

### 技术栈
- 前端:原生 HTML/CSS/JavaScript(用户门户)
- 后端:Cloudflare Worker (worker.js)
- 存储:R2 (图片) + D1 (元数据)

### 数据模型

#### 修改表:api_keys
```sql
-- 添加用户配额相关字段
ALTER TABLE api_keys ADD COLUMN upload_quota INTEGER DEFAULT 100;
ALTER TABLE api_keys ADD COLUMN upload_used INTEGER DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN storage_used INTEGER DEFAULT 0;
```

#### 新增表:user_uploads
```sql
CREATE TABLE user_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  thumb_url TEXT,
  file_name TEXT,
  file_size INTEGER,
  file_type TEXT,
  width INTEGER,
  height INTEGER,
  tags TEXT DEFAULT '',
  created_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (user_id) REFERENCES api_keys(id)
);
CREATE INDEX idx_user_uploads_user ON user_uploads(user_id);
CREATE INDEX idx_user_uploads_created ON user_uploads(created_at);
```

## API 设计

### 用户上传 API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/v1/user/upload` | POST | 上传图片到用户图片库 |
| `/api/v1/user/files` | GET | 获取用户图片列表 |
| `/api/v1/user/files/:id` | GET | 获取用户图片详情 |
| `/api/v1/user/files/:id` | DELETE | 删除用户图片 |
| `/api/v1/user/files/:id/tags` | POST | 设置用户图片标签 |
| `/api/v1/user/random` | GET | 获取用户随机图片 |
| `/api/v1/user/quota` | GET | 获取用户配额信息 |

### 认证方式

所有用户 API 需要携带 API Key:
- `X-API-Key: <api_key>` 或
- `?api_key=<api_key>`

## 前端设计

### 用户门户扩展

在用户门户(`user.html`)中添加以下功能:

1. **图片库标签页**:显示用户的所有图片
2. **上传按钮**:触发图片上传对话框
3. **图片网格**:显示图片缩略图和信息
4. **图片预览**:点击图片显示大图预览
5. **API 文档**:显示 API 使用说明

### 布局结构

```
┌─────────────────────────────────────────────────────────┐
│  Topbar (用户信息、API Key、退出)                        │
├─────────────────────────────────────────────────────────┤
│  Stats (调用次数、存储用量、配额)                         │
├─────────────────────────────────────────────────────────┤
│  Tabs (统计 | 图片库 | API 文档)                         │
├─────────────────────────────────────────────────────────┤
│  Content (根据选中的 Tab 显示内容)                       │
│                                                         │
│  [图片库 Tab]                                            │
│  ┌─────────────────────────────────────────────────┐   │
│  │  上传按钮 + 筛选 + 搜索                          │   │
│  ├─────────────────────────────────────────────────┤   │
│  │  图片网格 (缩略图 + 文件名 + 标签 + 操作)        │   │
│  │  □ □ □ □ □                                     │   │
│  │  □ □ □ □ □                                     │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## 实现细节

### 1. 用户上传 API

```javascript
export async function handleUserUpload(request, env) {
  // 1. 验证 API Key
  const apiKey = request.headers.get('X-API-Key') || new URL(request.url).searchParams.get('api_key');
  const user = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key = ?').bind(apiKey).first();
  if (!user) return json({ ok: false, error: 'Invalid API key' }, 401);
  
  // 2. 检查配额
  if (user.upload_used >= user.upload_quota) {
    return json({ ok: false, error: 'Upload quota exceeded' }, 403);
  }
  
  // 3. 解析上传文件
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file) return json({ ok: false, error: 'No file provided' }, 400);
  
  // 4. 上传到 R2
  const key = `user/${user.id}/${Date.now()}_${file.name}`;
  await env.R2_BUCKET.put(key, file);
  
  // 5. 写入 D1
  const url = `https://telegramup.wo58.cn/file/${key}`;
  await env.D1_DB.prepare(
    'INSERT INTO user_uploads (user_id, url, file_name, file_size, file_type, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(user.id, url, file.name, file.size, file.type, new Date().toISOString()).run();
  
  // 6. 更新配额
  await env.D1_DB.prepare('UPDATE api_keys SET upload_used = upload_used + 1, storage_used = storage_used + ? WHERE id = ?')
    .bind(file.size, user.id).run();
  
  return json({ ok: true, data: { url, id: r.meta.last_row_id } });
}
```

### 2. 用户图片列表 API

```javascript
export async function handleUserFiles(request, env) {
  // 1. 验证 API Key
  const apiKey = request.headers.get('X-API-Key') || new URL(request.url).searchParams.get('api_key');
  const user = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key = ?').bind(apiKey).first();
  if (!user) return json({ ok: false, error: 'Invalid API key' }, 401);
  
  // 2. 获取分页参数
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = parseInt(url.searchParams.get('page_size') || '20');
  const offset = (page - 1) * pageSize;
  
  // 3. 查询用户图片
  const files = await env.D1_DB.prepare(
    'SELECT * FROM user_uploads WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).bind(user.id, pageSize, offset).all();
  
  const total = await env.D1_DB.prepare(
    'SELECT COUNT(*) as total FROM user_uploads WHERE user_id = ? AND deleted_at IS NULL'
  ).bind(user.id).first();
  
  return json({ ok: true, data: files.results || [], total: total?.total || 0 });
}
```

### 3. 用户图片库前端

```javascript
// 上传功能
async function uploadFiles(files) {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }
  
  const r = await fetch('/api/v1/user/upload', {
    method: 'POST',
    headers: { 'X-API-Key': currentUser.key },
    body: formData
  });
  
  return await r.json();
}

// 图片列表
async function loadUserFiles(page = 1) {
  const r = await fetch(`/api/v1/user/files?page=${page}&page_size=20`, {
    headers: { 'X-API-Key': currentUser.key }
  });
  
  const data = await r.json();
  if (data.ok) {
    renderUserFiles(data.data);
  }
}
```

## 数据库迁移

### db.js 修改

在 `ensureTables` 函数中添加:

```javascript
// user_uploads 表
"CREATE TABLE IF NOT EXISTS user_uploads (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, url TEXT NOT NULL, thumb_url TEXT, file_name TEXT, file_size INTEGER, file_type TEXT, width INTEGER, height INTEGER, tags TEXT DEFAULT '', created_at TEXT, deleted_at TEXT);" +
"CREATE INDEX IF NOT EXISTS idx_user_uploads_user ON user_uploads(user_id);" +
"CREATE INDEX IF NOT EXISTS idx_user_uploads_created ON user_uploads(created_at);"

// api_keys 表列迁移
try {
  const ak = await db.prepare("PRAGMA table_info(api_keys)").all();
  const akn = (ak.results || []).map(function(c) { return c.name; });
  if (akn.indexOf('upload_quota') === -1) {
    await db.exec("ALTER TABLE api_keys ADD COLUMN upload_quota INTEGER DEFAULT 100");
    console.log('migrated: api_keys.upload_quota column');
  }
  if (akn.indexOf('upload_used') === -1) {
    await db.exec("ALTER TABLE api_keys ADD COLUMN upload_used INTEGER DEFAULT 0");
    console.log('migrated: api_keys.upload_used column');
  }
  if (akn.indexOf('storage_used') === -1) {
    await db.exec("ALTER TABLE api_keys ADD COLUMN storage_used INTEGER DEFAULT 0");
    console.log('migrated: api_keys.storage_used column');
  }
} catch (e) { console.error('api_keys upload quota migration:', e.message); }
```

## 安全考虑

1. **用户隔离**:用户只能访问自己的图片,通过 `user_id` 字段隔离。
2. **API Key 验证**:所有 API 请求必须携带有效的 API Key。
3. **配额限制**:防止用户滥用上传功能。
4. **文件类型验证**:只允许图片类型文件上传。
5. **文件大小限制**:单个文件不超过 30MB。

## 性能优化

1. **分页加载**:图片列表使用分页,避免一次性加载过多。
2. **缩略图**:上传时生成缩略图,加速列表显示。
3. **CDN 缓存**:R2 图片利用 CDN 缓存加速访问。
4. **懒加载**:图片列表使用懒加载,优化首屏加载。

## 部署注意事项

1. 数据库迁移会在 Worker 冷启动时自动执行。
2. 新增 API 端点需要添加到 worker.js 路由。
3. user.html 需要更新前端代码。
4. 需要更新 R2 存储桶的 CORS 配置。
