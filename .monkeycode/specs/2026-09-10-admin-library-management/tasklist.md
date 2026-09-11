# 任务列表：管理端三库管理

## 阶段一：数据层

- [x] 1.1 创建 `PoolItem` 模型（`lib/data/models/pool_item.dart`）
- [x] 1.2 在 `gallery_repository.dart` 新增管理端 pool API 方法

## 阶段二：UI 组件

- [x] 2.1 创建 `TagPickerDialog`（标签选择弹窗）
- [x] 2.2 创建 `LevelPickerDialog`（级别选择弹窗）
- [x] 2.3 创建 `LibraryGridView`（网格/列表视图组件）

## 阶段三：页面集成

- [x] 3.1 创建 `LibraryTab`（三库主 Tab，含 Telegram/共享库/私密库子视图）
- [x] 3.2 修改 `admin_shell.dart` 添加素材库 Tab

## 阶段四：验证

- [x] 4.1 单元测试：PoolItemfromJson 往返 + LibraryEntry 创建
- [x] 4.2 CI 验证：flutter analyze + flutter test（`25f2475` success）
