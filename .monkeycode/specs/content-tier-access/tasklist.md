# Task List: content-tier-access

## 1. 数据模型与迁移
- [x] 1.1 db.js 增加 files.level / files.is_private 列迁移
- [x] 1.2 db.js 增加 random_pool.level / random_pool.is_private 列迁移
- [x] 1.3 db.js 增加 api_keys.level 列迁移

## 2. Worker 级别对等核心
- [x] 2.1 worker.js 增加 LEVEL_RANK 常量与 levelFilter helper
- [x] 2.2 checkApiKey 返回密钥级别

## 3. 公开输出级别过滤
- [x] 3.1 handlePublicFiles 按密钥级别过滤(level<=密钥, is_private=0)
- [x] 3.2 handlePublicRandom 按密钥级别过滤
- [x] 3.3 /show/data 与节目单拉图仅返回 pt 且非私密

## 4. 管理后台接口
- [x] 4.1 共享库(pool)列表/编辑支持 level
- [x] 4.2 api_keys 创建/编辑/列表支持 level
- [x] 4.3 私密库接口(private-pool)列表与新增
- [x] 4.4 tele 图片转存支持指定 level 与私密库

## 5. admin.html UI
- [x] 5.1 「随机库」文案全局替换为「共享库」
- [x] 5.2 共享库图片级别展示与设置
- [x] 5.3 API 密钥级别展示与设置
- [x] 5.4 新增私密库管理页
- [x] 5.5 tele 转存支持级别与私密选择

## 6. 验证与部署
- [x] 6.1 语法检查与测试
- [x] 6.2 提交并推送触发部署
