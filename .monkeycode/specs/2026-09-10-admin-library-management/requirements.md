# 需求文档：管理端三库管理

## 简介

在 PicWall Android 管理端新增「三库管理」功能，提供 Telegram 文件库、共享库、私密库的统一管理界面，支持库区间转存、快速标签、分级、时间排序和网格视图。对齐 Web admin 端（admin.html）的素材库功能。

## 术语

- **Telegram 文件库（tele 库）**：`files` 表中 `processing_state=completed` 的原始 Telegram 文件记录。
- **共享库**：`random_pool` 表中 `is_private=0` 的条目，所有密钥可见。
- **私密库**：`random_pool` 表中 `is_private=1` 的条目，仅 VVIP 密钥可见。
- **库区转**：将图片条目从一个库移动到另一个库的操作。
- **快速标签**：从预设标签库中一键/多选为条目打标。
- **分级**：设置条目的内容级别（pt / vip / svip / vvip）。

## 需求

### R1 三库 Tab 导航

**用户故事**：作为管理员，我希望在管理页面看到三个独立的库 Tab，以便分别查看和管理不同库的图片。

#### 验收标准

1. WHEN 管理员进入管理页面，系统 SHALL 在底部导航栏显示「Telegram」「共享库」「私密库」三个 Tab。
2. WHEN 管理员切换 Tab，系统 SHALL 加载对应库的图片列表。
3. WHILE 某个 Tab 处于加载状态，系统 SHALL 显示加载指示器。
4. IF 某个库为空，系统 SHALL 显示空状态提示。

### R2 图片列表展示

**用户故事**：作为管理员，我希望以网格视图查看库中的图片，以便快速浏览缩略图。

#### 验收标准

1. WHEN 管理员打开任一库 Tab，系统 SHALL 以网格视图展示图片列表。
2. WHEN 管理员点击网格/列表切换按钮，系统 SHALL 在网格视图和列表视图之间切换。
3. WHILE 列表向下滚动至末尾，系统 SHALL 自动加载下一页（无限滚动分页）。
4. WHEN 每个网格项展示时，系统 SHALL 显示缩略图、序号、和状态标签（级别标签、来源标签）。

### R3 按时间排序

**用户故事**：作为管理员，我希望按时间排序查看图片，以便找到最新或最旧的条目。

#### 验收标准

1. WHEN 管理员点击排序按钮，系统 SHALL 在「最新优先」和「最旧优先」之间切换。
2. WHEN 排序切换时，系统 SHALL 重新加载列表并按 `created_at` 降序或升序排列。
3. IF 当前排序为「最新优先」，系统 SHALL 在排序按钮上显示降序图标。

### R4 多选与批量操作

**用户故事**：作为管理员，我希望可以多选图片进行批量操作，以便高效管理大量条目。

#### 验收标准

1. WHEN 管理员长按或点击选择按钮进入多选模式，系统 SHALL 显示勾选框。
2. WHILE 多选模式激活，系统 SHALL 显示已选数量和全选/反选按钮。
3. WHEN 管理员退出多选模式，系统 SHALL 清除所有选中状态。
4. IF 已选数量为 0，系统 SHALL 禁用所有批量操作按钮。

### R5 库区转（跨库移动）

**用户故事**：作为管理员，我希望将图片从一个库移动到另一个库，以便管理不同分类的图片。

#### 验收标准

1. WHEN 管理员在 Telegram 库选中文件并点击「入库共享库」，系统 SHALL 调用 `POST /admin/api/pool/from-tg` 将文件转入共享库。
2. WHEN 管理员在 Telegram 库选中文件并点击「入库私密库」，系统 SHALL 调用 `POST /admin/api/private-pool/from-tg` 将文件转入私密库（级别固定为 vvip）。
3. WHEN 管理员在共享库选中条目并点击「转入私密库」，系统 SHALL 调用 `POST /admin/api/pool/batch` 设置 `is_private=1`（级别降为 svip）。
4. WHEN 管理员在私密库选中条目并点击「转入共享库」，系统 SHALL 调用 `POST /admin/api/pool/batch` 设置 `is_private=0`。
5. IF 移动成功，系统 SHALL 从当前列表移除已移动的条目并显示成功提示。
6. IF 移动失败，系统 SHALL 保留条目并显示错误信息。

### R6 快速标签

**用户故事**：作为管理员，我希望从预设标签库中快速为图片打标，以便高效分类管理。

#### 验收标准

1. WHEN 管理员选中图片并点击「打标签」，系统 SHALL 弹出标签选择面板。
2. WHEN 标签选择面板打开时，系统 SHALL 从服务器加载预设标签库（`GET /admin/api/tags`）。
3. WHEN 管理员选择标签并确认，系统 SHALL 根据当前库调用对应 API：
   - Telegram 库：`POST /admin/api/files/tags`
   - 共享库/私密库：`POST /admin/api/pool/tags`
4. IF 标签设置成功，系统 SHALL 更新列表中对应条目的标签显示。
5. WHILE 标签选择面板加载中，系统 SHALL 显示加载状态。

### R7 分级设置

**用户故事**：作为管理员，我希望快速设置图片的内容级别（pt/vip/svip/vvip），以便控制不同密钥的访问权限。

#### 验收标准

1. WHEN 管理员在共享库/私密库选中图片并点击「分级」，系统 SHALL 弹出级别选择面板（pt / vip / svip / vvip）。
2. WHEN 管理员选择级别并确认，系统 SHALL 调用 `POST /admin/api/pool/batch` 更新条目级别。
3. IF 分级设置成功，系统 SHALL 更新列表中对应条目的级别显示。
4. IF 从私密库操作，系统 SHALL 允许设置为任意级别（但建议 vvip）。

### R8 Telegram 库入库

**用户故事**：作为管理员，我希望将 Telegram 库中的文件直接入库到共享库或私密库，以便管理未分类的 Telegram 文件。

#### 验收标准

1. WHEN 管理员在 Telegram 库选中文件并点击「入库共享库」，系统 SHALL 调用 `POST /admin/api/pool/from-tg` 将文件转入共享库。
2. WHEN 管理员在 Telegram 库选中文件并点击「入库私密库」，系统 SHALL 调用 `POST /admin/api/private-pool/from-tg` 将文件转入私密库。
3. IF 入库成功，系统 SHALL 从 Telegram 库列表移除已入库条目。
4. IF 入库失败（如文件不存在），系统 SHALL 显示错误信息。

### R9 搜索与筛选

**用户故事**：作为管理员，我希望在库中搜索和筛选图片，以便快速定位特定条目。

#### 验收标准

1. WHEN 管理员在库 Tab 中输入关键词，系统 SHALL 按标题/标签进行模糊搜索。
2. WHEN 管理员选择标签筛选，系统 SHALL 仅显示包含该标签的条目。
3. IF 搜索无结果，系统 SHALL 显示「无匹配结果」提示。
