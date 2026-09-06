# PicWall / 图墙 — Android App 需求文档

## Introduction

为现有 Telegram R2 Bot Worker 内容库（R2 + D1 存储，Worker 承载 API）提供原生安卓客户端「PicWall / 图墙」。一份代码、双角色：普通用户浏览/上传/管理个人图片；管理员在手机端完成统计、图片采集、回收站与仓储高频运维。登录复用现有 vk_ 密钥体系，管理员通过独立的 admin API_KEY 切换管理模式。App 与后端同仓维护，安卓文件改动仅触发安卓构建，不触发 Worker 部署。

## Glossary

- **共享库 random_pool**: 对外展示的图片库（enabled=1），经 `/gallery/data` 按密钥级别分发。
- **files 全量库**: 全部上传文件，含文档/视频/音频；普通用户仅可见与其级别匹配且未删除的内容。
- **私密库**: `is_private=1` 的内容，仅 vvip 密钥可见。
- **vk_ 密钥**: 用户密钥，配合密钥密码登录；级别 pt/vip/svip/vvip。
- **管理模式**: 管理员在 App 内填入 admin API_KEY 后进入的后台运维界面。
- **应用锁**: 指纹 / 图案解锁后才可进入 App（保护 vvip 私密内容）。
- **自动相册同步**: 指定系统相册/文件夹，新增照片自动备份上传到「我的图片库」。
- **API 服务器 / 直链域名**: API 入口 `https://telegram-r2-bot.wo58.cn`；静态直链 `https://telegramup.wo58.cn`。两者在设置中均可改，默认内置上述值。

## Requirements

### Requirement 1: 服务器地址配置与首启引导

**User Story:** AS 用户, I want 首次打开 App 配置服务器地址, SO THAT 可以指向任意兼容的 Worker 后端。

#### Acceptance Criteria

1. WHEN 用户首次启动 App, 系统 SHALL 显示引导页并要求确认服务器地址。
2. WHEN 用户输入服务器地址, 系统 SHALL 支持格式 `https://host`（可含端口/前缀）。
3. WHEN 用户保存服务器地址, 系统 SHALL 持久化到安全存储，并允许在设置页修改。
4. WHEN App 内置默认值, 系统 SHALL 提供 API=`https://telegram-r2-bot.wo58.cn` 与直链=`https://telegramup.wo58.cn`。
5. WHEN 用户未完成配置, 系统 SHALL 禁止进入首页并提示配置。

### Requirement 2: 用户登录 / 注册 / 兑换

**User Story:** AS 用户, I want 用现有账号体系登录, SO THAT 可浏览与本人级别匹配的内容。

#### Acceptance Criteria

1. WHEN 用户输入用户名与密码登录, 系统 SHALL 调用 `POST /api/user/login`（body: key 用户名、key_pass 密码）。
2. WHEN 登录成功, 系统 SHALL 保存会话，并展示用户名、级别(pt/vip/svip/vvip)、到期时间。
3. WHEN 用户注册, 系统 SHALL 支持用户名+密码+兑换码，调用 `POST /api/user/register`。
4. WHEN 注册成功返回 vk_ 密钥, 系统 SHALL 保存该密钥用于后续 API 鉴权。
5. WHEN 用户输入兑换码, 系统 SHALL 调用 `POST /api/user/redeem` 升级/续期并刷新状态。
6. WHEN 会话失效(401), 系统 SHALL 提示重新登录而不是崩溃。

### Requirement 3: 用户端底部导航「发现 / 图库 / 我的」

**User Story:** AS 用户, I want 三个主 Tab 组织核心功能, SO THAT 浏览与个人管理分离清晰。

#### Acceptance Criteria

1. WHEN 用户进入首页, 系统 SHALL 显示底部 3 Tab：发现、图库、我的。
2. WHEN 用户点击「发现」, 系统 SHALL 展示推荐内容流与随机刷图入口。
3. WHEN 用户点击「图库」, 系统 SHALL 展示双源浏览（共享库 + 按级别 files 库）。
4. WHEN 用户点击「我的」, 系统 SHALL 展示个人图片、上传、配额、收藏、历史、兑换、设置、管理模式入口。
5. WHEN 用户为管理员且开启管理模式, 系统 SHALL 切换到管理界面，底部导航变为管理端模块。

### Requirement 4: 发现页内容

**User Story:** AS 用户, I want 快速发现好看的内容, SO THAT 无需刻意搜索。

#### Acceptance Criteria

1. WHEN 用户打开发现页, 系统 SHALL 展示随机/推荐图片流（调 `/gallery/data` 无参或 shuffle）。
2. WHEN 用户点击图片, 系统 SHALL 进入全屏详情并可滑浏览。
3. WHEN 用户下拉, 系统 SHALL 刷新推荐流。
4. WHEN 用户点击图片操作菜单, 系统 SHALL 提供收藏、保存到相册、分享、复制链接。

### Requirement 5: 图库双源浏览与筛选

**User Story:** AS 用户, I want 按标签/类型/级别浏览图库, SO THAT 能检索目标内容。

#### Acceptance Criteria

1. WHEN 用户进入图库页, 系统 SHALL 提供「共享库」与「文件库」两个数据源切换。
2. WHEN 用户选择标签/类型筛选, 系统 SHALL 通过 `tags`、`type` 参数请求并刷新列表。
3. WHEN 列表滚动到底, 系统 SHALL 自动加载下一页（offset 分页），支持无限滚动。
4. WHEN 内容级别高于当前密钥级别, 系统 SHALL 不展示并在筛选处提示升级入口。
5. WHEN 无网络或加载失败, 系统 SHALL 显示错误占位与重试按钮。
6. WHEN 浏览视频/文档, 系统 SHALL 视频可在线播放/保存，文档仅列表展示并可打开直链。

### Requirement 6: 图片详情、收藏与历史

**User Story:** AS 用户, I want 在详情页对内容做保存/分享等操作, SO THAT 可离线复用与传播。

#### Acceptance Criteria

1. WHEN 用户打开详情页, 系统 SHALL 展示大图、标题、标签、级别、上传时间。
2. WHEN 用户左右滑动, 系统 SHALL 在同批结果内切换上/下一张。
3. WHEN 用户双指缩放, 系统 SHALL 支持图片缩放与拖动。
4. WHEN 用户点击保存, 系统 SHALL 请求相册权限并写入系统相册，成功后提示。
5. WHEN 用户点击分享, 系统 SHALL 分享内容直链。
6. WHEN 用户点击收藏, 系统 SHALL 写入本地收藏库（SQLite），并在「我的-收藏」可见。
7. WHEN 用户浏览图片, 系统 SHALL 自动写入本地浏览历史。

### Requirement 7: 我的页面与个人图片管理

**User Story:** AS 用户, I want 管理自己的上传图片与账号, SO THAT 可掌控个人数据。

#### Acceptance Criteria

1. WHEN 用户打开我的页, 系统 SHALL 展示头像占位、用户名、级别徽标、到期时间、配额使用。
2. WHEN 用户查看我的图片, 系统 SHALL 分页展示 `GET /api/v1/user/files`，支持搜索与删除。
3. WHEN 用户删除图片, 系统 SHALL 调用 `DELETE /api/v1/user/files/:id` 并刷新列表。
4. WHEN 用户设置标签, 系统 SHALL 调用 `POST /api/v1/user/files/:id/tags`。
5. WHEN 用户查看配额, 系统 SHALL 调用 `GET /api/v1/user/quota` 展示已用/总量。
6. WHEN 用户兑换码升级, 系统 SHALL 提供兑换输入并刷新级别。
7. WHEN 用户开启管理模式且已填 admin API_KEY, 系统 SHALL 显示「进入管理模式」按钮。

### Requirement 8: 上传（相册批量 / 拍照 / URL 入库）

**User Story:** AS 用户, I want 从手机快速把图片上传到我的图片库, SO THAT 图片集中管理。

#### Acceptance Criteria

1. WHEN 用户点击上传, 系统 SHALL 提供「相册选择」「拍照」「粘贴 URL」三种来源。
2. WHEN 用户相册多选, 系统 SHALL 支持一次选择多张（Photo Picker），显示待传队列。
3. WHEN 用户拍照, 系统 SHALL 拍照后进入待传队列。
4. WHEN 用户粘贴 URL, 系统 SHALL 解析图片直链并入队（每行一条）。
5. WHEN 用户开始上传, 系统 SHALL 逐张调用 `POST /api/v1/user/upload` 并显示总进度/单张状态。
6. WHEN 单张失败, 系统 SHALL 标记失败原因并支持单独重试。
7. WHEN 上传流量受控, 系统 SHALL 支持「仅 WiFi 上传」开关（非 WiFi 时提示或暂停）。
8. WHEN 上传成功, 系统 SHALL 在「我的图片」与配额中即时反映。

### Requirement 9: 自动相册同步（备份）

**User Story:** AS 用户, I want 指定系统相册并自动备份新增照片, SO THAT 新照片自动入我的图片库。

#### Acceptance Criteria

1. WHEN 用户开启自动同步, 系统 SHALL 引导选择一个系统相册/文件夹。
2. WHEN 用户确认开启, 系统 SHALL 授予通知权限与相册访问权限，并注册同步任务。
3. WHEN 相册出现新增照片, 系统 SHALL 自动上传到「我的图片库」，去重基于本地已同步记录。
4. WHEN 同步进行中, 系统 SHALL 显示前台通知进度（常驻服务期间）。
5. WHEN 满足仅 WiFi 且当前非 WiFi, 系统 SHALL 挂起同步并在恢复 WiFi 后继续。
6. WHEN 用户关闭开关或取消授权, 系统 SHALL 停止同步并释放后台任务。
7. WHEN 同步上传失败, 系统 SHALL 保留待传队列并在下次重试。

### Requirement 10: 应用锁（指纹 / 图案）

**User Story:** AS 用户, I want 应用解锁保护, SO THAT 私密内容不被他人查看。

#### Acceptance Criteria

1. WHEN 用户开启应用锁, 系统 SHALL 要求设置指纹或图案。
2. WHEN App 从后台恢复/冷启动, 系统 SHALL 先进入锁定页，验证通过后才进入内容。
3. WHEN 指纹验证不可用或失败超限, 系统 SHALL 回退到图案/密码验证。
4. WHEN 用户关闭应用锁, 系统 SHALL 校验一次后关闭。

### Requirement 11: 管理模式入口与统计概览

**User Story:** AS 管理员, I want 在手机上快速查看系统概览, SO THAT 掌握存储与流量大盘。

#### Acceptance Criteria

1. WHEN 用户开启管理模式并填写 admin API_KEY, 系统 SHALL 校验通过后进入管理界面。
2. WHEN 管理员打开统计页, 系统 SHALL 调用 `GET /admin/api/stats` 展示文件数/今日上传/存储用量/类型分布。
3. WHEN 管理员查看存储趋势, 系统 SHALL 调用 `GET /admin/api/r2-usage` 与 `worker-usage` 展示用量与趋势。
4. WHEN API_KEY 无效, 系统 SHALL 提示重新填写。

### Requirement 12: 管理端采集（原生重做 scrape 流程）

**User Story:** AS 管理员, I want 在手机粘贴网页/图片链接完成批量入库, SO THAT 移动端也可持续运营图库。

#### Acceptance Criteria

1. WHEN 管理员输入网页链接, 系统 SHALL 调用 `POST /admin/api/scrape/analyze`（body: url, ignore_kw, ignore_ext, must, cookie）解析候选图。
2. WHEN 解析返回候选, 系统 SHALL 以瀑布流展示候选图缩略图，标注忽略原因。
3. WHEN 管理员调整规则, 系统 SHALL 支持忽略关键词/忽略格式/单张上限MB/必带内容四类规则，规则可绑定到域名组。
4. WHEN 管理员选择图片, 系统 SHALL 默认全选候选；支持全选/全不选/仅失败重试。
5. WHEN 管理员点击入库, 系统 SHALL 逐张调用 `POST /admin/api/scrape/grab_one` 直传上传群入库。
6. WHEN 单张失败, 系统 SHALL 标记失败原因（已存在/忽略/超限/网络）并支持续传。
7. WHEN 粘贴站点 Cookie, 系统 SHALL 携带 Cookie 绕开反爬，按域名分站保存。

### Requirement 13: 管理端回收站与未入库处理

**User Story:** AS 管理员, I want 处理已删/未入库文件, SO THAT 存储干净可追踪。

#### Acceptance Criteria

1. WHEN 管理员打开回收站, 系统 SHALL 展示 `GET /admin/api/trash` 已删文件列表。
2. WHEN 管理员恢复文件, 系统 SHALL 调用回收恢复接口并刷新。
3. WHEN 管理员查看未入库/待处理, 系统 SHALL 展示 `GET /admin/api/unsaved` 并支持重试。
4. WHEN 操作完成, 系统 SHALL 给出成功/失败反馈。

### Requirement 14: 管理端仓储

**User Story:** AS 管理员, I want 掌握 R2 底层对象与用量, SO THAT 可执行存储治理。

#### Acceptance Criteria

1. WHEN 管理员打开仓储页, 系统 SHALL 展示 R2 用量监控、趋势与配额预警。
2. WHEN 管理员浏览对象, 系统 SHALL 支持 `/admin/api/r2/list` 分页浏览 R2 对象。
3. WHEN 管理员删除对象, 系统 SHALL 二次确认后调用 `/admin/api/r2/delete`，并联动回收站。
4. WHEN 管理员清理, 系统 SHALL 提供 `/admin/api/r2/cleanup` 入口并报告结果。
5. WHEN 管理员按文件检索, 系统 SHALL 支持按类型/群组/关键词检索 files 全量库。

### Requirement 15: 打包构建与交付（GitHub Actions）

**User Story:** AS 开发者, I want push 安卓目录即自动构建 APK, SO THAT 拿到可安装包。

#### Acceptance Criteria

1. WHEN 修改 `android/**` 并 push main, 系统 SHALL 触发安卓构建 workflow（不触发 Worker 部署）。
2. WHEN 构建完成, 系统 SHALL 上传 `app-release.apk`（含应用锁）为 workflow artifact 并在 Release 可用。
3. WHEN 构建使用 debug 签名, 系统 SHALL 允许用户自行下载安装；正式发布时由用户提供 keystore secret 切换到签名构建。
4. WHEN 仅修改 Worker 侧文件, 系统 SHALL 不触发安卓构建。

## Non-Functional Requirements

1. **性能**: 瀑布流列表滑动流畅；图片走缩略图(thumb_url)懒加载 + 磁盘缓存；大图仅在详情按需加载。
2. **安全**: vk_ 密钥、key_pass、admin API_KEY 仅存于 flutter_secure_storage；不写入日志/明文偏好。
3. **隐私**: 相册仅授权用户选择的目录；自动同步须明确告知用途；应用锁保护内容。
4. **兼容**: minSdk 支持 Android 8.0+（API 26），targetSdk 跟随 Flutter stable 最新。
5. **网络**: 复用系统 HTTP 栈，超时、重试、429 退避策略统一；断网可看本地缓存。
6. **可维护**: 单仓库 monorepo：安卓文件在 `android/`，Worker 代码在根；改动路径各自触发对应 CI。
