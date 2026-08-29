# 管理后台 admin.html

纯静态管理后台(原生 HTML/JS,无框架、无构建),约 3700 行。部署时上传到 R2 `bot-telegram/admin.html`,`GET /admin` 返回该文件(Worker 直接读 R2)。所有数据操作通过 `/admin/api/*`(需 `?api_key=` 或 `X-API-Key` = `env.API_KEY`)。

## 功能 Tab(共 14 个)

定义见 `admin.html:907`:

| Tab | 名称 | 功能 |
|---|---|---|
| `stats` | 概览 | 统计卡片、用量、趋势 |
| `files` | Tele文件 | 文件列表(grid/表格视图)、级别/私密徽章、标签、入池、设置级别、删除 |
| `trash` | 回收站 | 软删列表、恢复、R2 清理 |
| `unsaved` | 未转存 | 未转存列表 + 批量重试 |
| `pool` | 共享库 | 共享库条目管理、导入(上传/Telegram/展示页/Postimages)、批量设置级别、标签、启停、删除 |
| `private` | 私密库 | 私密库列表、从 Telegram 导入(级别固定 vvip) |
| `tags` | 标签库 | 标签预设管理 |
| `gen` | 接口生成 | 生成 API 调用示例/代码片段 |
| `keys` | 密钥 | API 密钥 CRUD、级别(pt灰/vip蓝/svip紫/vvip金)、启用/停用、到期时间 |
| `users` | 用户 | 用户统计 |
| `show` | 轮播 | 展示页配置、节目组管理、定时换图 |
| `cmds` | 命令 | 自定义 Bot 命令 CRUD、数字菜单 |
| `api` | Bot API | Bot API 代理调用调试 |
| `ops` | 运维 | webhook 状态/修复、备份、AI 配置/测试、R2/Worker 用量、配额、限流配置、通知配置 |

## 关键交互

- **Tab 切换**:`init()` 渲染 tab 栏与 panel,点击 `data-tab` 切换(`admin.html:905-924`);切到 `files` 且页面可见时自动刷新(`admin.html:1458`)
- **级别徽章**:文件页与密钥列表按 `level` 显示彩色徽章(pt灰/vip蓝/svip紫/vvip金)
- **共享库导入弹窗**:`showPoolImportModal` 支持选择级别 + 「加入私密库」按钮(私有化导入)
- **批量操作**:共享库批量「设置级别」(`btnPoolLevelSel` / `setPoolLevelModal`),支持多选后统一改级别
- **Toast 提示**:`toast(msg, ok)` 3 秒自动消失(`admin.html:896`)

## 版本管理

- 部署流水线用 `bump-version.js` 注入 `APP_VERSION = v1.0.<run#>`
- R2 上传时 `Cache-Control: public, max-age=300`,改版后需强刷(`Cmd+Shift+R`)或等 5 分钟
- 页面自身从 URL 取 `api_key` 并注入后续请求头,凭据不落 localStorage

## 约定

- 更名类调整只改文案(如「共享库」),不碰 API 路径与表名
- 新增 tab:在 `tabData` 数组加一项 + 增加对应 panel + 后台对应 `/admin/api/*` handler
