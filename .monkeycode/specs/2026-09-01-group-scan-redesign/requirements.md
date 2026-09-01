# 群抓取图片地址持久化 - 需求文档

## Introduction

当前群抓取相册浏览功能在扫描阶段只存储缩略图，用户勾选导入时需要 VPS 重新从 Telegram 拉取原图。本需求要求扫描阶段将 Telegram file_id 存入 D1，导入时直接用 file_id 下载原图，避免重复扫描。

## Glossary

- **file_id**: Telegram 文件唯一标识符，可用于通过 Bot API 或 MTProto 下载原图
- **代理地址**: Worker 的 `/file/tg/{file_id}` 端点，可通过 Bot API 代理下载 Telegram 文件
- **sizes JSON**: `ubot_albums` 表中存储每张图片元数据的 JSON 数组

## Requirements

### Requirement 1: 扫描阶段存储 file_id

WHEN VPS 扫描群消息并聚合相册时, THE system SHALL 提取每条媒体消息的 Telegram file_id 并存入 `ubot_albums.sizes` JSON 数组的每个元素中。

#### Acceptance Criteria

1. WHEN `run_list_albums` 处理一条 photo 消息时, THE VPS SHALL 通过 `telethon.utils.get_file_id(msg.media)` 获取 file_id
2. WHEN `run_list_albums` 处理一条 video 消息时, THE VPS SHALL 通过 `telethon.utils.get_file_id(msg.media)` 获取 file_id
3. WHEN file_id 获取成功时, THE VPS SHALL 将其存入 sizes 元素的 `file_id` 字段
4. WHEN file_id 获取失败时, THE VPS SHALL 将 `file_id` 字段设为空字符串并继续处理
5. WHEN sizes JSON 上报到 Worker 时, THE Worker SHALL 存储包含 file_id 的完整 sizes JSON

### Requirement 2: 导入阶段使用 file_id 下载

WHEN 用户在相册浏览页面勾选图片并触发导入时, THE system SHALL 使用存储的 file_id 下载原图，无需重新扫描群消息。

#### Acceptance Criteria

1. WHEN 用户触发"抓取已选"操作时, THE VPS SHALL 从 D1 读取选中消息对应的 file_id
2. WHEN file_id 非空时, THE VPS SHALL 通过 Telethon `client.download_file(file_id)` 下载原图
3. WHEN file_id 为空时, THE VPS SHALL 回退到现有的 `client.get_messages` 方式下载
4. WHEN 原图下载成功时, THE VPS SHALL 调用 `upload_media` 上传到 Worker 并写入 D1 files 表
5. WHEN 导入完成时, THE VPS SHALL 上报执行结果（完成数/跳过数/错误数）

### Requirement 3: D1 数据结构扩展

THE system SHALL 在 `ubot_albums.sizes` JSON 中增加 `file_id` 字段，用于持久化 Telegram 文件标识。

#### Acceptance Criteria

1. THE sizes JSON 每个元素 SHALL 包含 `file_id` 字段（字符串类型）
2. THE Worker 的 `handleAdminUbotAlbumsGet` 接口 SHALL 在返回数据中包含 `file_id` 字段
3. THE 前端 SHALL 能读取并显示 file_id（可选，用于调试）

### Requirement 4: 前端导入流程优化

WHEN 用户在相册浏览页面勾选图片并点击"抓取已选"时, THE 前端 SHALL 显示导入进度并支持取消。

#### Acceptance Criteria

1. WHEN 导入开始时, THE 前端 SHALL 显示进度条和已导入数量
2. WHEN 导入进行中时, THE 前端 SHALL 每 2 秒轮询一次进度
3. WHEN 导入完成时, THE 前端 SHALL 显示成功/失败统计
4. WHEN 导入失败时, THE 前端 SHALL 显示具体错误信息

## Out of Scope

- 不改变现有缩略图浏览体验
- 不改变 R2 存储路径规则
- 不改变 files 表结构
- 不改变 random_pool 表结构
