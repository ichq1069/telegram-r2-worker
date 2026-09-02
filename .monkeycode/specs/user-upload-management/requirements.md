# Requirements Document

## Introduction

为 Telegram R2 Bot Worker 前端用户增加上传管理功能,允许用户上传图片到自己的图片库,并通过 API 调用访问这些图片。该功能扩展现有的用户门户,增加图片上传、管理和 API 访问能力。

## Glossary

- **用户图片库**: 每个用户独立的图片存储空间,仅用户本人可访问。
- **用户上传**: 用户通过前端界面上传图片到 R2 存储。
- **用户 API**: 用户通过 API Key 访问自己的图片库。
- **图片管理**: 用户对自己的图片进行查看、删除、标签管理等操作。

## Requirements

### Requirement 1: 用户上传功能

**User Story:** AS 前端用户, I want 上传图片到自己的图片库, SO THAT 我可以通过 API 访问这些图片。

#### Acceptance Criteria

1. WHEN 用户登录用户门户, 系统 SHALL 显示上传入口。
2. WHEN 用户选择图片文件, 系统 SHALL 支持批量上传(最多 10 张)。
3. WHEN 用户上传图片, 系统 SHALL 将图片存储到 R2,元数据写入 D1。
4. WHEN 上传成功, 系统 SHALL 显示上传结果(成功/失败数量)。
5. WHEN 上传失败, 系统 SHALL 显示具体错误原因。

### Requirement 2: 用户图片库管理

**User Story:** AS 前端用户, I want 管理自己的图片库, SO THAT 我可以查看、删除和组织我的图片。

#### Acceptance Criteria

1. WHEN 用户打开图片库, 系统 SHALL 显示用户的所有图片列表。
2. WHEN 用户查看图片, 系统 SHALL 显示图片缩略图、文件名、上传时间、大小。
3. WHEN 用户删除图片, 系统 SHALL 软删除图片并从列表中移除。
4. WHEN 用户为图片添加标签, 系统 SHALL 支持逗号分隔的标签输入。
5. WHEN 用户筛选图片, 系统 SHALL 支持按标签、关键词筛选。

### Requirement 3: 用户 API 访问

**User Story:** AS 前端用户, I want 通过 API 访问自己的图片库, SO THAT 我可以在其他应用中使用这些图片。

#### Acceptance Criteria

1. WHEN 用户调用图片列表 API, 系统 SHALL 返回用户的图片列表(分页)。
2. WHEN 用户调用随机图片 API, 系统 SHALL 返回用户的随机图片。
3. WHEN 用户调用图片详情 API, 系统 SHALL 返回指定图片的详细信息。
4. WHEN 用户调用图片直链, 系统 SHALL 返回图片的直接访问链接。
5. WHEN API 请求携带无效的 API Key, 系统 SHALL 返回 401 错误。

### Requirement 4: 用户 API Key 管理

**User Story:** AS 前端用户, I want 查看和管理我的 API Key, SO THAT 我可以安全地使用 API。

#### Acceptance Criteria

1. WHEN 用户打开 API 管理页面, 系统 SHALL 显示用户的 API Key 信息。
2. WHEN 用户查看 API Key, 系统 SHALL 显示 Key 的部分隐藏值(安全考虑)。
3. WHEN 用户复制 API Key, 系统 SHALL 将完整 Key 复制到剪贴板。
4. WHEN 用户查看 API 使用统计, 系统 SHALL 显示调用次数、最后使用时间。

### Requirement 5: 用户配额管理

**User Story:** AS 平台运营, I want 限制用户的上传和存储配额, SO THAT 防止资源滥用。

#### Acceptance Criteria

1. WHEN 用户上传图片, 系统 SHALL 检查用户的上传配额。
2. WHEN 用户超出上传配额, 系统 SHALL 拒绝上传并提示配额已用完。
3. WHEN 用户查看配额, 系统 SHALL 显示已用/总配额。
4. WHEN 管理员设置用户配额, 系统 SHALL 在用户注册时分配默认配额。

## Non-Functional Requirements

1. 安全性:用户只能访问自己的图片,不能访问其他用户的图片。
2. 性能:图片上传响应时间不超过 5 秒(取决于文件大小)。
3. 存储:图片存储在 R2,遵循现有的生命周期策略。
4. 兼容性:支持现有 API Key 认证机制。
