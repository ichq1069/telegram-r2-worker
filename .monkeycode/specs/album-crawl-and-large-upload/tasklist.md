# Tasklist

## Phase 1: 数据模型与 schema 迁移

- [x] src/db.js:SCHEMA_VERSION 5→6,`userbot_tasks` CREATE 增加 `mode/selected_msg_ids/scan_limit` 列 + ALTER 迁移
- [x] src/db.js:新增 `ubot_albums` 表(相册缓存,task_id 隔离,UNIQUE(task_id,grouped_id)) + 索引

## Phase 2: worker 接口

- [x] src/userbot.js:常量 `UPLOAD_HARD_MAX=90MB/UPLOAD_SMALL_MAX=19MB/ALBUM_SCAN_LIMIT=2000/ALBUM_MAX_PER_POST=500` + `taskToOut/parseSelectedIds` 辅助
- [x] src/userbot.js:任务 CRUD 支持新列,max_size clamp 上限收紧到 90MB;删除任务连带清 `ubot_albums`
- [x] src/userbot.js:`handleUserbotTaskConfig` 返回 `mode/selected_msg_ids/scan_limit` + 全局 `upload_small_max/upload_hard_max`
- [x] src/userbot.js:管理侧 `albums/list`(触发列表模式)/ `albums GET`(读缓存+已选态)/ `albums/select`(校验保存)/ `albums/trigger`(置 selected)
- [x] src/userbot.js:脚本侧 `POST /api/ubot/task/{id}/albums`(批量上报,先删后插,收敛 mode 回 normal)
- [x] src/public.js:`/api/v1/upload` 增加 `stream=1`(raw body 流式入 R2,>90MB 413,不写 md5)与 `cover=1`(入 album_covers/ 不写 files)分支
- [x] src/servers.js:run-report `finished` 时清空 selected 模式的 mode+选择集合
- [x] worker.js:注册 5 个新路由

## Phase 3: userbot_pull.py

- [x] 常量 `UPLOAD_SMALL_MAX/UPLOAD_HARD_MAX/ALBUM_MAX_PER_POST`;移除未用 `FloodWaitError`
- [x] `run_task_once` 按 `mode` 分派 normal/list/selected,会话打开一次复用
- [x] `upload_media`(≤19MB multipart / >19MB stream=1)与 `upload_cover`(cover=1)
- [x] `run_pull` 改用 `upload_media`,行为不变
- [x] `run_list_albums`:枚举 scan_limit 条聚合相册,传封面缩略图,分片上报
- [x] `run_selected_pull`:批量 get_messages(每批 50),仅抓所选,断点/进度上报

## Phase 4: 管理后台

- [x] admin.html:任务行「相册」按钮 + 相册管理弹窗(网格/扫描上限/浏览/轮询/勾选/保存选择/抓取已选)
- [x] admin.html:任务编辑表单加 `scan_limit`,max_size 上限标注 90

## Phase 5: 校验与交付

- [x] `node --check` 全部改动 JS + esbuild bundle worker.js 通过 + admin.html 内联脚本语法校验 + `py_compile` userbot_pull.py
- [ ] commit + push main 触发部署,确认 Actions success
- [ ] VPS 重跑一键部署拉取新版脚本(可选,待用户确认)
