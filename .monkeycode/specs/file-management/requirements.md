# Requirements Document

## Introduction

为 Telegram R2 Bot Worker 管理后台增强文件管理能力,实现类似 mifun-storage 的 Finder 风格文件管理体验。核心功能包括:文件夹目录树、拖拽上传、网格/列表视图切换、文件预览模态框、骨架屏加载动画。

## Glossary

- **文件夹目录树**: 左侧边栏展示的树形文件夹结构,支持展开/折叠、新建、重命名、删除操作。
- **拖拽上传**: 将文件从本地拖拽到管理后台界面触发上传的功能。
- **网格/列表视图**: 文件展示的两种布局模式,网格模式显示缩略图卡片,列表模式显示详细信息行。
- **文件预览模态框**: 点击文件后弹出的全屏预览窗口,支持图片/视频/文档预览,支持前后切换。
- **骨架屏加载**: 数据加载时显示的占位动画,提升用户感知性能。

## Requirements

### Requirement 1: 文件夹目录树

**User Story:** AS 管理员, I want 在左侧边栏看到文件夹目录树, SO THAT 我可以按文件夹组织和浏览文件。

#### Acceptance Criteria

1. WHEN 管理员进入文件管理页面, 系统 SHALL 在左侧边栏显示文件夹目录树。
2. WHEN 文件夹包含子文件夹, 系统 SHALL 支持展开/折叠子文件夹。
3. WHEN 管理员点击文件夹, 系统 SHALL 在右侧显示该文件夹下的文件列表。
4. WHEN 管理员右键点击文件夹, 系统 SHALL 显示上下文菜单(新建子文件夹、重命名、删除)。
5. WHEN 管理员新建文件夹, 系统 SHALL 在当前选中文件夹下创建子文件夹。
6. WHEN 管理员重命名文件夹, 系统 SHALL 更新文件夹名称并刷新目录树。
7. WHEN 管理员删除文件夹, 系统 SHALL 删除该文件夹及其所有内容,并刷新目录树。
8. WHEN 文件夹为空, 系统 SHALL 显示空文件夹图标。

### Requirement 2: 拖拽上传

**User Story:** AS 管理员, I want 将文件从本地拖拽到管理后台上传,SO THAT 我无需点击上传按钮即可快速上传文件。

#### Acceptance Criteria

1. WHEN 管理员将文件拖拽到文件列表区域, 系统 SHALL 显示拖拽指示器(高亮边框+提示文字)。
2. WHEN 管理员释放文件, 系统 SHALL 开始上传这些文件到当前选中的文件夹。
3. WHEN 上传进行中, 系统 SHALL 显示上传进度(文件名+进度条)。
4. WHEN 单个文件上传完成, 系统 SHALL 在文件列表中显示新上传的文件。
5. WHEN 所有文件上传完成, 系统 SHALL 显示成功提示并刷新文件列表。
6. WHEN 上传失败, 系统 SHALL 显示错误提示并允许重试。
7. WHEN 管理员拖拽文件夹, 系统 SHALL 递归上传文件夹内的所有文件。

### Requirement 3: 网格/列表视图切换

**User Story:** AS 管理员, I want 在网格视图和列表视图之间切换,SO THAT 我可以根据需要选择最合适的浏览方式。

#### Acceptance Criteria

1. WHEN 管理员打开文件管理页面, 系统 SHALL 默认显示网格视图。
2. WHEN 管理员点击视图切换按钮, 系统 SHALL 在网格视图和列表视图之间切换。
3. WHEN 系统处于网格视图, 系统 SHALL 以卡片形式显示文件缩略图。
4. WHEN 系统处于列表视图, 系统 SHALL 以表格形式显示文件详细信息(文件名、大小、类型、修改时间)。
5. WHEN 管理员切换视图, 系统 SHALL 保持当前文件夹和选中状态。
6. WHEN 视图切换, 系统 SHALL 使用平滑动画过渡。

### Requirement 4: 文件预览模态框

**User Story:** AS 管理员, I want 点击文件后弹出全屏预览窗口,SO THAT 我可以详细查看文件内容而无需下载。

#### Acceptance Criteria

1. WHEN 管理员点击文件缩略图或文件名, 系统 SHALL 打开文件预览模态框。
2. WHEN 预览模态框打开, 系统 SHALL 显示文件完整内容(图片全屏、视频播放器、文档阅读器)。
3. WHEN 预览模态框打开, 系统 SHALL 显示文件信息(文件名、大小、类型、标签)。
4. WHEN 管理员点击上一张/下一张按钮, 系统 SHALL 切换到前一个/后一个文件。
5. WHEN 管理员使用键盘左右箭头, 系统 SHALL 切换到前一个/后一个文件。
6. WHEN 管理员按下 Escape 键, 系统 SHALL 关闭预览模态框。
7. WHEN 管理员点击下载按钮, 系统 SHALL 下载当前预览的文件。
8. WHEN 预览模态框打开, 系统 SHALL 禁止背景滚动。

### Requirement 5: 骨架屏加载

**User Story:** AS 管理员, I want 在数据加载时看到骨架屏动画,SO THAT 我知道系统正在加载而不是卡住。

#### Acceptance Criteria

1. WHEN 系统正在加载文件列表, 系统 SHALL 显示骨架屏占位符。
2. WHEN 系统正在加载文件夹目录树, 系统 SHALL 显示骨架屏占位符。
3. WHEN 骨架屏显示, 系统 SHALL 使用动画效果(如渐变或脉冲)表示加载中。
4. WHEN 数据加载完成, 系统 SHALL 平滑过渡到实际内容。
5. WHEN 加载失败, 系统 SHALL 显示错误提示并提供重试按钮。

## Non-Functional Requirements

1. 性能:文件列表加载时间不超过 2 秒,骨架屏应在 100ms 内显示。
2. 兼容性:支持 Chrome、Firefox、Safari 最新版本。
3. 响应式:在桌面和移动设备上均可正常使用。
4. 无障碍:支持键盘导航和屏幕阅读器。
