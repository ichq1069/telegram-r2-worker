# Requirements Document

## Introduction

为 Telegram R2 Bot Worker 增加内容分级体系:图片/文件按 pt/vip/svip/vvip 四级分级,API 密钥同样对应四级并实现「级别对等」访问控制——低级别密钥不得获取高级别内容,避免输出超出密钥价格对应的内容。原「随机库」更名为「共享库」并支持分级;新增「私密库」,私密内容等同最高级 vvip,且私密图片不得进入共享库。

## Glossary

- **级别(Level)**: 内容与密钥共用的分级枚举,按权限从低到高为 `pt < vip < svip < vvip`。pt 为最低级(默认),vvip 为最高级。
- **级别对等(Level Parity)**: 访问控制规则——请求方密钥级别大于等于内容级别时,该内容才可被访问输出。
- **共享库(Shared Pool)**: 原「随机库」(`random_pool` 表)更名后的展示名称,提供随机/公开浏览能力。
- **私密库(Private Pool)**: 新增内容库,存放私密内容,私密内容级别等同 vvip,不参与共享库与公开输出。
- **tele 图片**: 从 Telegram 渠道接收并转存的图片文件。
- **API 密钥**: 第三方程序调用公开 JSON API(`/api/v1/*`)所用的凭据,存于 `api_keys` 表。

## Requirements

### Requirement 1: 内容分级字段

**User Story:** AS 管理员, I want 对图片和文件设置级别, SO THAT 不同付费等级的用户只看到对应等级内容。

#### Acceptance Criteria

1. WHEN 内容(图片或文件)创建或转存, 系统 SHALL 为内容记录级别, 取值属于 `{pt, vip, svip, vvip}`。
2. WHILE 内容未显式设置级别, 系统 SHALL 按 `pt` 处理该内容, 使存量数据保持可见。
3. WHEN 管理员修改内容级别, 系统 SHALL 持久化新级别并立即生效于后续访问。
4. WHEN 内容被转存进共享库, 系统 SHALL 保留内容自身级别。

### Requirement 2: 随机库更名共享库

**User Story:** AS 管理员, I want 将「随机库」更名为「共享库」, SO THAT 表达其共享浏览的定位。

#### Acceptance Criteria

1. WHEN 管理后台展示随机库入口或标题, 系统 SHALL 使用「共享库」名称。
2. WHEN 管理后台展示共享库内图片, 系统 SHALL 显示每张图片的级别(pt/vip/svip/vvip)。
3. WHEN 管理员在共享库新增或导入图片, 系统 SHALL 提供级别设置能力(默认 pt)。

### Requirement 3: API 密钥分级与级别对等

**User Story:** AS 平台运营, I want API 密钥绑定级别并对等访问, SO THAT 低价格密钥无法获取超出其价格范围的高级别内容。

#### Acceptance Criteria

1. WHEN 创建或修改 API 密钥, 系统 SHALL 记录密钥级别, 取值属于 `{pt, vip, svip, vvip}`, 默认 `pt`。
2. WHEN 公开 API 收到携带密钥的请求, 系统 SHALL 校验密钥级别与请求内容级别对等, 仅返回级别不大于密钥级别的内容。
3. IF 请求内容级别大于密钥级别, 系统 SHALL 从返回结果中排除该内容。
4. WHILE 请求来源未提供密钥(匿名访问), 系统 SHALL 按最低级 `pt` 过滤输出内容。
5. WHEN 密钥级别提升或降低, 系统 SHALL 在后续请求中立即应用新对等规则。

### Requirement 4: 私密库

**User Story:** AS 平台运营, I want 私密图片存放在独立私密库且仅最高级可见, SO THAT 私密内容不被低等级用户或共享库泄露。

#### Acceptance Criteria

1. WHEN 内容被标记为私密, 系统 SHALL 将该内容归入私密库, 级别等同 `vvip`。
2. WHEN 内容属于私密库, 系统 SHALL 禁止该内容进入共享库。
3. WHEN 公开 API 或共享库输出内容, 系统 SHALL 排除所有私密库内容。
4. WHEN 请求方密钥级别为 `vvip`, 系统 SHALL 允许访问私密库内容。
5. WHEN 请求方密钥级别低于 `vvip`, 系统 SHALL 拒绝返回私密库内容。
6. WHEN tele 图片被转存, 系统 SHALL 允许管理员将其加入私密库。

### Requirement 5: 分级范围覆盖全部文件类型

**User Story:** AS 平台运营, I want 图片、视频、文档、音频等全部文件类型均可分级, SO THAT 分级体系覆盖完整内容库。

#### Acceptance Criteria

1. WHEN 任何文件类型(图片/视频/文档/音频)入库, 系统 SHALL 记录其级别。
2. WHEN 查询输出任何文件类型内容, 系统 SHALL 按级别对等规则过滤。

## Non-Functional Requirements

1. 存量数据兼容:已存在的内容与密钥在无级别字段时按 `pt` 处理, 现有访问行为不因升级而中断。
2. 级别过滤在数据库查询层完成, 避免将全量数据拉取到 Worker 内存后再过滤。
