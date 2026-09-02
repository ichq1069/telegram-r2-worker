# Technical Design Document

## Overview

为 Telegram R2 Bot Worker 管理后台实现 Finder 风格文件管理功能,包括文件夹目录树、拖拽上传、网格/列表视图切换、文件预览模态框、骨架屏加载动画。

## Architecture

### 技术栈
- 前端:原生 HTML/CSS/JavaScript(无框架依赖)
- 后端:Cloudflare Worker (worker.js)
- 存储:R2 (文件) + D1 (元数据)

### 数据模型

#### 新增表:folders
```sql
CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER DEFAULT NULL,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (parent_id) REFERENCES folders(id)
);
```

#### 修改表:random_pool
```sql
ALTER TABLE random_pool ADD COLUMN folder_id INTEGER DEFAULT NULL;
ALTER TABLE random_pool ADD FOREIGN KEY (folder_id) REFERENCES folders(id);
```

## API 设计

### 文件夹 API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/folders` | GET | 获取文件夹树 |
| `/admin/api/folders` | POST | 创建文件夹 |
| `/admin/api/folders/:id` | PATCH | 更新文件夹(重命名) |
| `/admin/api/folders/:id` | DELETE | 删除文件夹 |
| `/admin/api/folders/:id/files` | GET | 获取文件夹下的文件 |

### 文件 API 扩展

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api/pool` | GET | 扩展支持 `folder_id` 参数 |
| `/admin/api/pool/move` | POST | 移动文件到指定文件夹 |

## 前端设计

### 布局结构

```
┌─────────────────────────────────────────────────────────┐
│  Topbar (搜索、视图切换、上传按钮)                        │
├──────────────┬──────────────────────────────────────────┤
│  文件夹目录树  │  文件列表区域                              │
│  (左侧边栏)   │  (网格/列表视图)                          │
│              │                                          │
│              │                                          │
│              │                                          │
│              │                                          │
└──────────────┴──────────────────────────────────────────┘
```

### 组件设计

#### 1. 文件夹目录树 (FolderTree)
- 递归渲染文件夹结构
- 支持展开/折叠
- 右键上下文菜单
- 拖拽支持(移动文件到文件夹)

#### 2. 文件列表 (FileList)
- 网格视图:CSS Grid 布局,卡片显示缩略图
- 列表视图:表格布局,显示详细信息
- 拖拽上传区域
- 选择状态管理

#### 3. 文件预览模态框 (PreviewModal)
- 全屏覆盖层
- 图片/视频/文档预览
- 前后切换导航
- 文件信息面板
- 键盘快捷键支持

#### 4. 骨架屏 (Skeleton)
- 占位符组件
- 动画效果
- 响应式布局

### 状态管理

```javascript
const state = {
  currentFolder: null,        // 当前选中的文件夹
  folders: [],                // 文件夹树结构
  files: [],                  // 当前文件夹下的文件
  viewMode: 'grid',           // 'grid' | 'list'
  selectedFiles: new Set(),   // 选中的文件 ID
  previewFile: null,          // 当前预览的文件
  loading: false,             // 加载状态
  dragOver: false             // 拖拽状态
};
```

## 实现细节

### 1. 文件夹目录树

使用递归组件渲染文件夹结构,每个文件夹节点包含:
- 展开/折叠图标
- 文件夹名称
- 子文件夹列表(可折叠)

```javascript
function renderFolderTree(folders, parentId = null, level = 0) {
  return folders
    .filter(f => f.parent_id === parentId)
    .map(folder => `
      <div class="folder-item" data-id="${folder.id}" style="padding-left: ${level * 20}px">
        <span class="folder-toggle">${hasChildren(folder.id) ? '▶' : ''}</span>
        <span class="folder-icon">📁</span>
        <span class="folder-name">${folder.name}</span>
      </div>
      <div class="folder-children" style="display: none">
        ${renderFolderTree(folders, folder.id, level + 1)}
      </div>
    `).join('');
}
```

### 2. 拖拽上传

使用 HTML5 Drag and Drop API:

```javascript
// 拖拽进入
fileList.addEventListener('dragenter', (e) => {
  e.preventDefault();
  state.dragOver = true;
  renderDropIndicator();
});

// 拖拽离开
fileList.addEventListener('dragleave', (e) => {
  if (!fileList.contains(e.relatedTarget)) {
    state.dragOver = false;
    renderDropIndicator();
  }
});

// 释放文件
fileList.addEventListener('drop', async (e) => {
  e.preventDefault();
  state.dragOver = false;
  const files = Array.from(e.dataTransfer.files);
  await uploadFiles(files, state.currentFolder);
});
```

### 3. 网格/列表视图切换

使用 CSS 类切换布局:

```css
.file-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.file-list .file-item {
  display: grid;
  grid-template-columns: 40px 1fr 100px 120px 100px;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
```

### 4. 文件预览模态框

```javascript
function openPreview(file) {
  state.previewFile = file;
  document.body.style.overflow = 'hidden';
  
  const modal = document.createElement('div');
  modal.className = 'preview-modal';
  modal.innerHTML = `
    <div class="preview-backdrop"></div>
    <div class="preview-content">
      <button class="preview-close">&times;</button>
      <button class="preview-prev">&lt;</button>
      <button class="preview-next">&gt;</button>
      <div class="preview-file"></div>
      <div class="preview-info"></div>
    </div>
  `;
  
  document.body.appendChild(modal);
  renderPreviewContent(file);
}
```

### 5. 骨架屏

```css
.skeleton {
  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: skeleton-loading 1.5s infinite;
}

@keyframes skeleton-loading {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.skeleton-card {
  height: 200px;
  border-radius: 8px;
}

.skeleton-text {
  height: 16px;
  margin: 8px 0;
  border-radius: 4px;
}
```

## 数据库迁移

### db.js 修改

在 `ensureTables` 函数中添加:

```javascript
// folders 表
"CREATE TABLE IF NOT EXISTS folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_id INTEGER DEFAULT NULL, created_at TEXT, updated_at TEXT);" +
"CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);"

// random_pool.folder_id 列迁移
try {
  const rp = await db.prepare("PRAGMA table_info(random_pool)").all();
  const rpn = (rp.results || []).map(function(c) { return c.name; });
  if (rpn.indexOf('folder_id') === -1) {
    await db.exec("ALTER TABLE random_pool ADD COLUMN folder_id INTEGER DEFAULT NULL");
    console.log('migrated: random_pool.folder_id column');
  }
} catch (e) { console.error('random_pool.folder_id migration:', e.message); }
```

## 部署注意事项

1. 数据库迁移会在 Worker 冷启动时自动执行
2. 新增 API 端点需要添加到 worker.js 路由
3. admin.html 需要更新前端代码
4. 建议先在测试环境验证迁移脚本

## 性能优化

1. 文件夹树使用懒加载,只展开时加载子文件夹
2. 文件列表使用分页加载,避免一次性加载过多
3. 骨架屏在 100ms 延迟后显示,避免闪烁
4. 图片缩略图使用 R2 直接链接,减少 Worker 负载

## 安全考虑

1. 文件夹操作需要管理员权限
2. 文件上传需要验证文件类型和大小
3. 文件删除需要确认对话框
4. 所有 API 端点需要 CSRF 保护
