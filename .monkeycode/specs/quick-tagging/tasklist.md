# Tasklist

## Phase 1: 后端公共导入与自动入共享库

- [ ] worker.js:抽出 `importFileToPool(f, opts, env)` 公共函数(以 `tg_file_id` 去重,支持 level/is_private 覆盖)
- [ ] worker.js:`handleAdminPoolFromTg` / `handleAdminPrivatePoolFromTg` 改用 `importFileToPool`,行为不变
- [ ] worker.js:新增 `GET /admin/api/settings/auto-pool-tags`(读 settings JSON,缓存 30s)
- [ ] worker.js:新增 `POST /admin/api/settings/auto-pool-tags`(覆盖保存)
- [ ] worker.js:`handleSetFileTags` 增加联动:按 mode 计算实际新增标签,与 auto_pool_tags 求交集,命中则 `importFileToPool`(不重复、不入私密)

## Phase 2: 前端快速打标页面

- [ ] admin.html:导航新增「快速打标」tab + `panel-quicktag`(三列布局 quick-tag-grid)
- [ ] admin.html:队列加载逻辑(复用 /admin/api/files,page_size=5,不足时翻页续载)
- [ ] admin.html:中间主预览 + 左右半显渲染(photo/video/文档/音频类型处理)
- [ ] admin.html:标签区渲染(已有标签 chips / 候选标签 chips / 自定义标签输入)
- [ ] admin.html:打标交互(点击候选=append 并高亮,点击已有=remove,自定义=append 入候选列表)
- [ ] admin.html:操作栏(已打标·下一张 / 跳过 / 上一张 / 转入私密库),私密转入后移出队列
- [ ] admin.html:队列刷新(处理完移除,不足续载;auto-pool 转入后从后续队列消失)

## Phase 3: 前端标签管理开关

- [ ] admin.html:标签库页「全部已用标签」每项渲染「自动入共享库」开关,切换时保存 settings

## Phase 4: 校验与交付

- [ ] `node --check worker.js` + admin.html 内联 JS 语法校验
- [ ] commit + push main 触发部署
