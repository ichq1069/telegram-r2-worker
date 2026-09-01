# 逻辑正确性分析报告

- 日期：2026-09-01
- 范围：worker.js + src/ 全部 15 个模块（约 7000 行）
- 方法：逐模块通读 + 交叉核对依赖函数（sqlite 绑定、存储格式、调用链）
- 结论：主链路（webhook 消息分发 → 入库 → 队列转存 → 回执）逻辑自洽，无数据损坏级高危缺陷；但存在 **3 个必修的高严重级 bug** 与 若干中低严重级问题。

---

## 一、高严重级（必修，会造成功能失效或数据丢失）

### H1. `handleLatest` 参数绑定数恒错，接口永远返回 500
`src/events.js:291-295`

```js
const p = tp ? [lm] : [];
// tp 非空时 SQL 有 2 个占位符（file_type=? 和 LIMIT ?），但只绑 1 个值，且把 limit 绑给了 file_type；
// tp 为空时 SQL 有 1 个占位符（LIMIT ?），但 p=[] 绑 0 个
```

两种路径 D1 都抛"绑定数量不匹配"→ `/api/latest` 恒 500。

**修复**：`const p = tp ? [tp, lm] : [lm];`

### H2. R2 清理会把全部缩略图误删
`src/events.js:397-399`（collectReferencedKeys）

`genThumb`（notify.js:29-31）返回 `(R2_PUBLIC_URL || '') + '/thumbs/xxx.webp'`，实际 R2 对象 key 是 `thumbs/xxx.webp`。但 collectReferencedKeys 用：

```js
x.thumb_url.substring(x.thumb_url.lastIndexOf('/') + 1)   // 得到 xxx.webp
```

只取最后一段文件名，与真实 key `thumbs/xxx.webp` 不匹配 → 所有缩略图被误报为孤儿；`handleR2Inspect` 误报、`handleR2Cleanup` 会删除全部缩略图对象，而 D1 记录仍引用它们 → 缩略图 404。

**修复**：`const tk = x.thumb_url.replace(/^https?:\/\/[^/]+\//, '');` 或 `new URL(x.thumb_url).pathname.replace(/^\//, '')`。

### H3. `handleTrashRestore` 空 body / 无效 JSON → 全量恢复整个回收站
`src/events.js:363-373`

```js
const b = await request.json().catch(() => null);
const ids = b && Array.isArray(b.ids) ? b.ids.map(String) : [];
if (!ids.length) { /* 恢复全部 */ }
```

POST 任何非 JSON / 空 body / `{}` 都会把整个回收站全部恢复，属危险默认值。

**修复**：显式区分"请求体缺失/无效"（返回 400）与"显式传 `{ids:[]}`"（才走全量恢复）。

---

## 二、中严重级（建议修复）

### M1. 分享链接 / X 链接路径无 `chat_id+message_id` 去重
`src/webhook.js:305-340`、`:440-505`

文件消息路径（:212）INSERT 前有查重防 webhook 重投；分享链接与 X 链接路径直接 INSERT/下载，Telegram 重投同一 update 时会生成重复记录（分享路径重复解析+重复转存，X 路径重复下载入库）。

### M2. `processShareLinkAsync` 无 dbId 空值保护（幽灵转存）
`src/webhook.js:508`

`processFileAsync`（:615）有 `if (!dbId) return`，分享链接路径没有。当分享链接的 D1 INSERT 失败（:322 catch 后 rid=null），任务仍会 parse→下载→上传 R2→回复用户"视频已保存"，但 D1 无对应记录 → R2 孤儿对象。

### M3. dedup #1 在代理模式下复用 `/file/tg/<旧id>` 占位直链
`src/webhook.js:651-659`

代理模式文件 `r2_url='/file/tg/<id>.<ext>'`。dedup 命中后新记录 B 直接复用 A 的占位链接并标记 completed，B 依赖 A 记录存活（api.js:40 按 id 查 A）；A 一旦删除，B 立即 404，且 B 无 storage_key，代理模式关闭后也无法访问。

**修复**：dedup 命中时若 `dup.storage_key` 为空（代理占位），不复用，走正常转存。

### M4. 转存完成后的 final D1 UPDATE 无重试
`src/webhook.js:845-852`

R2 已上传成功但 `UPDATE ... processing_state='completed'` 失败（对比 INSERT 有 2 次重试），记录永久停留在 downloading/uploading → 后台定时任务重新下载上传（新 key），产生 R2 重复对象。

### M5. 20-50MB 非 photo 文件全量 buffer，内存峰值接近上限
`src/webhook.js:385`（LARGE_FILE_THRESHOLD=50MB）+ `src/telegram.js:113-136`

恰好 ≤50MB 的文件走 `dlFileLarger` → `readBodyWithProgress` 把所有 chunk 存数组（峰值 2 倍数据量）再合并成单一 buffer，随后 MD5 计算与 R2 put 都持有引用。50MB 文件实际占用 100MB+，逼近 128MB isolate 限制，有 OOM 风险。

**修复**：阈值下调（如 30MB），或 >30MB 统一走流式路径。

### M6. 菜单项 retry_all 与 retry_recent 完全等价
`src/commands.js:60-61` + `src/admin.js:67-82`

两者都调用 `handleRetryCommand(chatId, env, null, 8)`；`handleUnsavedRetry` 忽略 `b.all`，只认 `b.limit`（上限 10），fakeReq 里的 `all:true` 无效果。"重试全部"实际最多 8 条。

### M7. inline 查询非图片内容按 photo 返回
`src/commands.js:899-913`

`rows` 只过滤 `r.url`，`item.type` 硬编码 'photo'，`photo_url` 指向 video/document URL → Telegram 拒收或显示错误；注释声称的 article 兜底未实现。

### M8. `/img` 与 inline 查询 level 硬编码 `'pt'`
`src/commands.js:835`、`:890`

`level IN ('pt')` 写死，vip/vvip 图永远不出现在索图与 inline 结果。若是设计意图则无问题；若需按用户等级解锁更多图，此处未实现（**待确认产品意图**）。

### M9. 数字菜单 state 永不过期、执行后不清理
`src/commands.js:42-53` + `src/webhook.js:919-931`

`setMenuCtx` 无 TTL，`getMenuCtx` 不校验时间戳，`execMenuAction` 成功后也不删 ctx。用户隔天发 "2" 仍会触发旧菜单动作。

### M10. `/retry` 全局限频 60s，跨会话互相干扰
`src/commands.js:702-709`

`lastRetryCmdTs` 是模块级变量，任意群/私聊触发后 60 秒内所有会话都被拒绝。

### M11. AI 工具 limit 为负数时 `LIMIT` 变成无限制
`src/commands.js:508,519`

`Math.min(parseInt(limit) || 10, 15)` 未防负数，`LIMIT -5` 等价于不限制 → AI 传入负值拉全表。

### M12. dedup 查询未排除回收站记录
`src/webhook.js:651`、`:808`

两处 dedup `SELECT ... WHERE processing_state='completed'` 均无 `deleted_at IS NULL`，会命中软删记录并复用其 storage_key/r2_url；存在"用户已删除的内容被新记录重新引用"语义问题与竞态窗口。

### M13. X 下载路径不参与全局转存并发限制
`src/webhook.js:440-505`

`processFileAsync`/`processShareLinkAsync` 走 `acquireTransferSlot`（上限 6），X 下载完全不受限，大量 X 链接可绕过并发上限冲击带宽与 subrequest 限额。

### M14. X 链接 D1 INSERT 失败仍向用户报"已保存"
`src/webhook.js:485-499`

`saved.push(url)` 发生在 INSERT 之前；INSERT 失败（仅 log）时媒体已在 R2 但无记录，用户仍收到成功回复。

### M15. `handleFiles` 默认 `pool_state` 过滤逻辑不一致
`src/api.js:125-128`

默认（ps2 为空）过滤 `NOT EXISTS (random_pool)` → 已入库的图从默认列表消失；且默认分支缺少 pending 分支的 `pool_status != 'ignored'` 排除 → ignored 文件混入默认视图。语义上需要确认"默认只显示未入库文件"是否为预期。

### M16. `handleByUser` 参数未校验
`src/events.js:268-274`

`parseInt(ui)` 对非数字 user_id 返回 NaN 并绑定到 SQL，可能抛错或匹配异常；与 handleByChat 直接字符串绑定不一致。

### M17. `handleAdminPoolBatch` 三参数互斥且非事务
`src/events.js:86-106`

`level`/`is_private`/`enabled` 是 if/else if 链，同时传多个后者被静默忽略（`level=null` 会误把 level 强制为 'pt'）；循环逐条 UPDATE 无事务，中途失败部分生效。

### M18. `handleAdminPoolBatchDelete` / `handleAdminPoolFromTg` / `handleAdminPrivatePoolFromTg` 非事务
`src/events.js:108-118`、`:180-206`、`:237-258`

批量删除/导入循环逐条执行，中途失败部分生效不可回滚；从 tg 导入时重复跳过不计入 skipped。

### M19. `handleDeleteFile` purgeAll 分支跳过统计缓存失效
`src/events.js:311-324`

purgeAll 直接 return，跳过 :345 的 `invalidateStatsCache()`，统计缓存 5s 内不刷新。

### M20. `fireWebhook` 在删除/池操作 handler 中未挂 `ctx.waitUntil`
`src/events.js:114,214`

CF Worker 响应返回后未完成 promise 会被冻结，webhook 通知大概率丢失。

---

## 三、低严重级（可按需处理）

| # | 位置 | 问题 |
|---|------|------|
| L1 | commands.js:591-595 | `/file` 用 `isNaN` 校验，放行 `1e3`/`0x10`/`1.5`，且 `/file 12 34` 被误拒 |
| L2 | commands.js:852-861 | sendPhoto 未检查响应 `ok`，失败时用户无图也无 fallback |
| L3 | commands.js:747,771,777,780,796,802,810,818,823 | 错误字符串 mojibake 乱码（应为 ❌） |
| L4 | commands.js:24-31 | parseMenu 不校验 `m.n` 为数字，可产生 `menu:n:undefined` |
| L5 | commands.js:381-388,428-434 | AI 限流表 `AI_THROTTLE`/`AI_ASK` 键永不清除，内存持续增长；x-forwarded-for 可伪造 |
| L6 | commands.js:806 | `/search` 与 AI `search_files` 搜索字段不一致（缺 group_ref/tags） |
| L7 | commands.js:131,142 | GraphQL 拼接 env.CF_ACCOUNT_ID 未转义（来源受控，风险极低） |
| L8 | commands.js:545 | 无 chatId 白名单，任意群成员可 `/retry`（消耗转存配额） |
| L9 | webhook.js:57 | TG_SECRET 校验放宽：不带 secret_token 头的请求全部放行（为兼容旧 setWebhook，建议加严格模式开关） |
| L10 | webhook.js:212-237 | 查重与 INSERT 非原子，极端并发可双写；建议 files 加 `UNIQUE(chat_id,message_id)` |
| L11 | webhook.js:855-856 + batch.js:55-114 | 快速完成的消息出现"单条 Saved + 批次回执"双回复且编号体系不一致 |
| L12 | webhook.js:916-1022 | processUpdate 内 "Handle file messages" 分支为不可达死代码（processUpdateCore 已拦截所有文件消息） |
| L13 | webhook.js:1024-1033 | video_note 消息被静默忽略 |
| L14 | webhook.js:783-786 | quickHash dedup 命中后清空新记录 quick_hash，去重链断裂 |
| L15 | webhook.js:656-657 | dedup 命中路径不触发 fireWebhook 也不 invalidateStatsCache |
| L16 | webhook.js:571-575 | 分享链接 fallback 重试沿用首次 content-type |
| L17 | webhook.js:320 | 分享链接 file_name 硬编码 video_xxx.mp4，小红书/微博图文也被记为 video |
| L18 | webhook.js:525 | `btoa` 对中文密码抛 InvalidCharacterError |
| L19 | events.js:38-48 | handleAdminSaveWebhook 未校验 URL 为 http(s)、events 无白名单 |
| L20 | events.js:66-81 | handleAdminPoolTags `mode` 无白名单、无 exists 检查 |
| L21 | events.js:120-132 | handleSetFilePoolStatus 非数字 id 静默变 0 |
| L22 | events.js:276-281 | handleByDate 按 UTC 匹配，UTC+8 凌晨上传的文件归入前一日 |
| L23 | events.js:454-464 | handleListBots 暴露 token 前 10 位；getMe fetch 无超时 |

---

## 四、已验证正确的区域

- **SQL 注入**：全部 D1 查询均参数化绑定，包括动态 WHERE（levelFilter、appendTagFilter、IN 子句），无拼接注入点。
- **INSERT 字段完整性**：webhook 三处 INSERT（文件 24 列 / 分享 23 列 / X 21 列）占位符与 bind 参数数量全部匹配。
- **转存并发槽**：acquireTransferSlot/releaseTransferSlot 在 processFileAsync 与 processShareLinkAsync 均通过 finally 配对，无泄漏。
- **md5/quick_hash 去重算法**：photo head+tail 采样偏移计算正确、未越界；提取标签 extractTags（≤4 字符）正确。
- **回收站引用计数**：events.js 与 admin.js 的 R2 对象删除均带 storage_key 引用计数，软删行仍算引用，正常路径不会误删。
- **poll offset 推进**：失败 update 不推进 offset（:366 break），成功后按 lastOk 写入，语义正确。
- **批量命令（#开始/#结束/#批次）**：状态存 D1 settings、processUpdateCore 与 processUpdate 均有处理且前者优先拦截不会双执行。
- **checkApiKey**：正确校验 enabled=1 与 expires_at 过期，支持 sk 短别名，限流与日志正常。
- **数字菜单越界处理**：webhook 侧对不存在的 n 有反馈，callback 侧有"菜单已过期"提示。
- **fetchAI 重试**：429 不重试、5xx 退避重试 2 次，循环可终止。
- **proxy 直链签名**：checkFileTok 新格式 `/file/tg/<token>/<id>.jpg` 与旧格式 `?k=` 均正确，防递增 id 枚举。

---

## 五、建议修复优先级

1. **立刻修**：H1（/api/latest 500）、H2（缩略图被误删）、H3（空 body 全量恢复）
2. **尽快修**：M1-M5（去重/幽灵转存/占位复用/final UPDATE 重试/内存峰值）、M9-M10（菜单 state、retry 限频）
3. **顺手修**：M6-M8、M12-M20、低严重级列表
4. **需与用户确认**：M8（level 硬编码是否为产品意图）、M15（文件列表默认是否应显示已入库文件）

---

## 六、修复状态（2026-09-01）

**已修复并提交**：

| 编号 | 修复内容 |
|------|----------|
| H1 | handleLatest type 过滤缺失 tp 参数 → 修复（events.js） |
| H2 | collectReferencedKeys thumb key 保留 public_url 前缀 → 还原 R2 key |
| H3 | handleTrashRestore 空/缺失 body 一律 400，仅显式 `{"ids":[]}` 恢复全部 |
| M1 | 分享链接按 chat_id+message_id 去重，返回 duplicate |
| M2 | processShareLinkAsync null dbId 前置中断 |
| M3 | 三处 dedup 查询均加 `deleted_at IS NULL` |
| M4 | final UPDATE 3 次重试（200ms 退避） |
| M5 | LARGE_FILE_THRESHOLD 50MB→20MB，>20MB 一律流式转存防 OOM |
| M6 | retry_all（队列时≤50 条）与 retry_recent（8 条）语义区分 |
| M7 | inline 非图片项改 article 兜底，不再硬塞 photo_url |
| M8 | level 过滤提取为可配置常量 IMG_LEVEL_FILTER（默认仍 'pt'） |
| M9 | 菜单 ctx 加 30 分钟 TTL，执行后自动清理 |
| M10 | /retry 限频改为按 chatId 独立（不再跨会话互相干扰） |
| M11 | AI 工具 limit 负数防护（`LIMIT -N` 不再等效无限制） |
| M12 | dedup 排除回收站记录 + 禁止复用代理占位 r2_url |
| M13 | X 下载纳入全局转存并发槽 |
| M14 | X 媒体 D1 INSERT 成功才计 saved，不再对用户谎报成功 |
| M15 | handleFiles 默认 pool_state 改为展示全部文件（对齐前端下拉语义） |
| M16 | handleByUser user_id 非数字返回 400 |
| M17 | handleAdminPoolBatch 三参数互斥 + D1.batch 事务 |
| M18 | 池批量删除/导入 D1.batch 事务，重复导入计入 duplicated |
| M19 | purgeAll 分支补 invalidateStatsCache |
| M20 | fireWebhook 在删除/池 handler 中 await（防 waitUntil 冻结丢事件） |
| L1 | /file 校验改为 `/^\d+$/` |
| L2 | sendPhoto 检查响应 ok，失败回退发链接文本 |
| L3 | commands.js 全部 mojibake 错误串修复为 ❌ |
| L4 | parseMenu 校验并归一化 n 为整数 |
| L5 | AI_THROTTLE/AI_ASK/lastRetryCmdTs 限流表定期清理 |
| L6 | /search 补齐 group_ref/tags 搜索字段（与 AI 一致） |
| L7 | GraphQL account-id 转义双引号/反斜杠 |
| L9 | TG_SECRET 默认宽松 + WEBHOOK_STRICT=1 严格模式 |
| L11 | replyMsg 快完成/去重命中时等待批量回执再编辑，消除双回执与编号不一致 |
| L12 | processUpdate 删除不可达的文件处理死代码 |
| L13 | extractFileInfo 支持 video_note |
| L14 | quick_hash 去重命中不再清空新记录 quick_hash（去重链保持） |
| L15 | dedup 命中路径补 file_imported webhook + invalidateStatsCache |
| L16 | 分享链接重试按本次响应 content-type 重新推断后缀 |
| L17 | 分享链接兜底文件名使用实际推断扩展名 |
| L18 | 中文密码 Basic Auth 改用 utf8 base64 编码 |
| L19 | handleAdminSaveWebhook URL 校验 http(s) + events 白名单 |
| L20 | handleAdminPoolTags mode 白名单 + exists 检查 + 准确 updated |
| L21 | handleSetFilePoolStatus 非数字 id 400 |
| L22 | handleByDate 按东八区日期映射 UTC 范围（含跨日） |
| L23 | handleListBots 不再暴露 token，getMe 加 10s 超时 |

**暂缓（需产品确认/涉及迁移）**：
- L8：`/retry` 无会话白名单（需要后台配置机制，属于产品决策，未改）
- L10：files 表 `UNIQUE(chat_id, message_id)`（需要 D1 schema 迁移，单独处理）
