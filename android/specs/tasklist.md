# PicWall / 图墙 — Task List

里程碑 M1–M4 递进。每阶段独立提交；安卓改动只触达 `android/**`，不影响 Worker 部署。

## M1：工程骨架 + 登录 + 浏览（核心价值）

- [ ] T1.1 初始化 `/android/picwall_app` Flutter 工程（`flutter create`，org 暂定 `com.picwall`，空壳后自定义）
- [ ] T1.2 搭建 monorepo CI：新增 `.github/workflows/build-android.yml`（`paths: android/**` + workflow_dispatch）
- [ ] T1.3 修改 `.github/workflows/deploy-worker.yml` 加 `paths-ignore: ['android/**']`
- [ ] T1.4 主题与基础库：dark theme、dio client、secure storage 封装、drift schema 初版、Riverpod 骨架
- [ ] T1.5 配置层：settingsProvider（apiBase/cdnBase 双默认）+ Onboarding 引导页（含 `/health` 检测）
- [ ] T1.6 认证：登录/注册/兑换 UI + `/api/user/*` repository + sessionProvider
- [ ] T1.7 应用壳：用户端底部 3 Tab（发现/图库/我的）+ 顶层锁 Gate 预留
- [ ] T1.8 图库：`/gallery/data` repository + masonry 瀑布 + 标签/类型筛选 + 无限滚动 + 空/错状态
- [ ] T1.9 详情页：photo_view 缩放 + 上下张滑动 + 保存相册 + 分享 + 复制链接 + 收藏/历史落库
- [ ] T1.10 发现页：推荐/随机流 + 刷新 + 搜纳入口
- [ ] T1.11 我的页：资料卡（级别/到期/配额）+ 我的图片列表（分页/搜索/删除/打标）
- [ ] T1.12 我的-收藏/历史页（读 drift）
- [ ] M1 验收：登录→浏览→详情→保存→我的图片全链路可用，APK 可装

## M2：上传与自动相册同步

- [ ] T2.1 上传三来源：相册多选（photo_manager/Photo Picker）、拍照、URL 粘贴
- [ ] T2.2 上传队列：drift `upload_queue` + 逐张 `POST /api/v1/user/upload` + 总进度/失败重试
- [ ] T2.3 仅 WiFi 上传：connectivity 监听 + 队列挂起/恢复
- [ ] T2.4 上传配额展示与上传后即时刷新（quota/files）
- [x] T2.5 自动同步设置：指定相册 + 开关 + 权限引导（通知/相册）
- [x] T2.6 同步引擎：前台服务 + workmanager 增量扫描 + `sync_state` 游标 + 去重上传 + 失败待重试
- [x] T2.7 同步状态 UI：上次同步时间、今日上传、暂停/恢复、清理待传
- [ ] M2 验收：相册新增照片自动/手动可入库；WiFi 限制生效；队列断点续传

## M3：管理端（统计 / 采集 / 回收站 / 仓储）

- [x] T3.1 管理模式开关：admin API_KEY 校验 + AdminShell 导航（复用现有用户会话鉴权约定）
- [ ] T3.2 统计概览：`/admin/api/stats` 卡片 + `/admin/api/r2-usage`、`worker-usage` 趋势
- [x] T3.3 采集-输入与解析：网页/链接输入 → `/admin/api/scrape/analyze`，携带 Cookie 与规则
- [x] T3.4 采集-规则面板：忽略关键词/忽略格式/单张上限/必带内容 + 域名规则组（拉取/保存云端组）
- [x] T3.5 采集-候选瀑布：缩略图、默认全选、全选/全不选、失败项勾选
- [x] T3.6 采集-入库：逐张 grab_one + 进度/失败原因（已存在/忽略/超限/网络）+ 续传
- [x] T3.7 回收站：trash 列表 + 恢复/彻底删除；未入库 unsaved 列表 + 重试
- [ ] T3.8 仓储：R2 用量/配额预警、`/admin/api/r2/list` 对象浏览、删除（二次确认）、cleanup
- [ ] T3.9 仓储扩展：files 全量库检索（类型/群组/关键词）
- [ ] M3 验收：管理员手机上完成一次完整采集入库 + 回收/清理闭环

## M4：应用锁、打磨与发布

- [ ] T4.1 应用锁：local_auth 指纹 + 图案 fallback + LockGate 拦截冷启动/后台恢复
- [ ] T4.2 设置页补全：主题切换、缓存清理、服务器重配、管理模式、关于/版本
- [ ] T4.3 深色细节与动效打磨、空状态/骨架屏统一、横竖屏适配
- [ ] T4.4 单元测试：规则解析、级别可见性、上传队列状态机；关键 Widget 测试
- [ ] T4.5 图标与应用名替换（占位图标 → 正式资源；`PicWall / 图墙`）
- [ ] T4.6 发布签名：keystore secrets 接入 release 构建（或先 deliver debug 包）
- [ ] T4.7 使用文档 README（安装、配置、双角色切换、常见问题）
- [ ] M4 验收：加锁后可安全使用；APK 发布包可分发；文档齐备

## 提交策略
- 每一 milestone 内的每项 task 完成后独立 commit；Android 相关统一带 `[picwall]` 前缀便于区分与回滚。
- commit message 模板：`[picwall] feat/fix: M1 图库瀑布流与无限滚动`
