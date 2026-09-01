// ==================== ADMIN API ====================
// 重试/未入库列表/去重/压缩/日报/定时维护/命令管理。
import { json, fmtSize } from "./util.js";
import { ensureTablesOnce } from "./db.js";
import { cnShift, cnTodayStr, cnDayIso, clampInt, fileExtOf } from "./core.js";
import { computeMd5, fileTok } from "./telegram.js";
import { processFileAsync } from "./webhook.js";
// ==================== ADMIN API ====================

// Retry a failed/stuck file record
export async function handleRetry(request, env, ctx) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const u = new URL(request.url);
    const id = u.searchParams.get('id');
    if (!id) return json({ ok: false, error: 'missing id' }, 400);
    const f = await env.D1_DB.prepare('SELECT * FROM files WHERE id=? AND deleted_at IS NULL').bind(id).first();
    if (!f) return json({ ok: false, error: 'not found' }, 404);
    const fi = { type: f.file_type, fileId: f.telegram_file_id, fileName: f.file_name || 'file_' + id, fileSize: f.file_size || 0, width: f.width || 0, height: f.height || 0 };
    const date = new Date(f.created_at || Date.now());
    // Reset state + progress for the retry
    await env.D1_DB.prepare("UPDATE files SET processing_state='downloading', progress_bytes=0, total_bytes=?, error_msg='' WHERE id=?").bind(f.file_size || 0, id).run();
    const task = {
      dbId: parseInt(id), fi: fi, chatId: f.chat_id || '', msgId: f.message_id || '',
      chat: { title: f.chat_title, username: f.chat_username, type: f.chat_type },
      from: { id: f.user_id, username: f.username, first_name: '', last_name: '' },
      date: date.toISOString()
    };
    if (env.FILE_QUEUE) {
      await env.FILE_QUEUE.send(task);
      return json({ ok: true, queued: true, id: parseInt(id) });
    }
    // No queue: run inline (best effort)
    const p = processFileAsync(parseInt(id), fi, f.chat_id || '', f.message_id || '', task.chat, task.from, date, env).catch(e => console.error('retry async:', e.message));
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
    return json({ ok: true, id: parseInt(id) });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// 未转存列表：已入库但 processing_state 不是 completed 的记录（pending/downloading/uploading/failed）
export async function handleUnsavedList(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const u = new URL(request.url);
    const pg = clampInt(u.searchParams.get('page') || '1', 1, 1);
    const ps = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100);
    const off = (pg - 1) * ps;
    // 卡住超 30 分钟的记录标记为 failed（crashed waitUntil/queue 任务）
    try { await env.D1_DB.prepare("UPDATE files SET processing_state='failed' WHERE processing_state IN ('downloading','hashing','uploading','saving') AND deleted_at IS NULL AND julianday(created_at) < julianday('now','-30 minutes')").run(); } catch (e) {}
    const t = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND processing_state != 'completed'").first();
    const d = await env.D1_DB.prepare("SELECT * FROM files WHERE deleted_at IS NULL AND processing_state != 'completed' ORDER BY id DESC LIMIT ? OFFSET ?").bind(ps, off).all();
    // 为每条记录生成代理 URL，即使没有 R2 直链也能通过 Telegram file_id 访问
    const origin = u.origin;
    const items = await Promise.all((d.results || []).map(async function(f) {
      // 复用 decorateLinks 逻辑生成 proxy_url
      const tok = await fileTok(f.id, env);
      const ext = fileExtOf(f.file_name, f.file_type);
      f.proxy_url = origin + '/file/tg/' + tok + '/' + f.id + '.' + ext;
      f.display_url = f.r2_url && f.r2_url.length > 0 && f.r2_url.indexOf('/file/tg/') !== 0 ? f.r2_url : f.proxy_url;
      return f;
    }));
    return json({ ok: true, data: { total: t?.c || 0, page: pg, page_size: ps, total_pages: Math.ceil((t?.c || 0) / ps), items: items } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// 批量重试未转存：body { ids:[...] } 或 { all:true }（默认最多 5 条 pending/failed/downloading）
export async function handleUnsavedRetry(request, env, ctx) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const b = await request.json().catch(function(){ return null; });
    let rows = [];
    if (b && Array.isArray(b.ids) && b.ids.length) {
      const arr = b.ids.slice(0, 50);
      const marks = arr.map(function(){ return '?'; }).join(',');
      // 用展开运算符而非 bind.apply（D1 对 apply(null,...) 会报 dbSession null 错误）
      rows = (await env.D1_DB.prepare('SELECT * FROM files WHERE id IN (' + marks + ') AND deleted_at IS NULL').bind(...arr).all()).results || [];
    } else {
      // 免费版单调用最多 50 个子请求（每条转存约占 5-8 个），默认批 8 条最安全；limit 可指定
      // all=true（重试全部）时上限放宽到 50（配合 FILE_QUEUE 每条仅 1 个 subrequest 入队）
      // 包含 downloading 状态：卡住的任务需要重试
      const raw = parseInt(b && b.limit, 10);
      const lim = Math.max(1, Math.min(Number.isFinite(raw) ? raw : (b && b.all ? 50 : 8), b && b.all ? 50 : 10));
      rows = (await env.D1_DB.prepare("SELECT * FROM files WHERE deleted_at IS NULL AND processing_state IN ('pending','failed','downloading') ORDER BY id ASC LIMIT ?").bind(lim).all()).results || [];
    }
    let started = 0;
    for (const f of rows) {
      const fi = { type: f.file_type, fileId: f.telegram_file_id, fileName: f.file_name || 'file_' + f.id, fileSize: f.file_size || 0, width: f.width || 0, height: f.height || 0 };
      const date = new Date(f.created_at || Date.now());
      await env.D1_DB.prepare("UPDATE files SET processing_state='downloading', progress_bytes=0, total_bytes=?, error_msg='' WHERE id=?").bind(f.file_size || 0, f.id).run();
      const task = { dbId: f.id, fi: fi, chatId: f.chat_id || '', msgId: f.message_id || '', chat: { title: f.chat_title, username: f.chat_username, type: f.chat_type }, from: { id: f.user_id, username: f.username, first_name: '', last_name: '' }, date: date.toISOString() };
      if (env.FILE_QUEUE) {
        try { await env.FILE_QUEUE.send(task); started++; } catch (e) {}
      } else {
        const p = processFileAsync(f.id, fi, f.chat_id || '', f.message_id || '', task.chat, task.from, date, env).catch(function(e){ console.error('unsaved retry:', e.message); });
        if (ctx && ctx.waitUntil) ctx.waitUntil(p);
        started++;
      }
    }
    return json({ ok: true, started: started, total: rows.length });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// Cron 兜底转存：每次最多 2 条 pending/failed/downloading（scheduled 与 webhook 自愈、查重叠加，子请求预算 ~30）
export async function retryUnsavedCron(env, ctx) {
  if (!env.D1_DB) return;
  try {
    // 包含 downloading 状态：卡住的任务需要重试
    const d = await env.D1_DB.prepare("SELECT id FROM files WHERE deleted_at IS NULL AND processing_state IN ('pending','failed','downloading') ORDER BY id ASC LIMIT 2").all();
    for (const row of d.results || []) {
      const f = await env.D1_DB.prepare('SELECT * FROM files WHERE id=?').bind(row.id).first();
      if (!f) continue;
      const fi = { type: f.file_type, fileId: f.telegram_file_id, fileName: f.file_name || 'file_' + f.id, fileSize: f.file_size || 0, width: f.width || 0, height: f.height || 0 };
      const date = new Date(f.created_at || Date.now());
      const task = { dbId: f.id, fi: fi, chatId: f.chat_id || '', msgId: f.message_id || '', chat: { title: f.chat_title, username: f.chat_username, type: f.chat_type }, from: { id: f.user_id, username: f.username, first_name: '', last_name: '' }, date: date.toISOString() };
      await env.D1_DB.prepare("UPDATE files SET processing_state='downloading', progress_bytes=0, total_bytes=?, error_msg='' WHERE id=?").bind(f.file_size || 0, f.id).run();
      if (env.FILE_QUEUE) {
        try { await env.FILE_QUEUE.send(task); } catch (e) {}
      } else {
        const p = processFileAsync(f.id, fi, f.chat_id || '', f.message_id || '', task.chat, task.from, date, env).catch(function(e){ console.error('cron retry:', e.message); });
        if (ctx && ctx.waitUntil) ctx.waitUntil(p);
        // 每条最多等 10s，避免整批超 scheduled 30s 限制
        await Promise.race([p, new Promise(function(res){ setTimeout(res, 10000); })]);
      }
    }
  } catch (e) { console.error('retryUnsavedCron:', e.message); }
}

// Processing status
export async function handleProcessingStatus(env) {
  if (!env.D1_DB) return json({ ok: true, data: [] });
  try {
    try { await ensureTablesOnce(env.D1_DB); } catch (e) { console.error('ensureTables:', e.message); }
    // Mark records stuck for >30 min as failed (crashed waitUntil/queue tasks)
    // Note: created_at is ISO (2026-08-26T10:00:00.000Z), so use julianday() not string compare
    try {
      await env.D1_DB.prepare("UPDATE files SET processing_state='failed' WHERE processing_state IN ('downloading','hashing','uploading','saving') AND julianday(created_at) < julianday('now','-30 minutes')").run();
    } catch (e) {}
    const r = await env.D1_DB.prepare('SELECT id, file_name, file_type, file_size, processing_state, chat_title, created_at, error_msg, progress_bytes, total_bytes FROM files WHERE processing_state!=\'completed\' AND deleted_at IS NULL ORDER BY id DESC LIMIT 20').all();
    return json({ ok: true, data: r.results || [] });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// Dedup stats
export async function handleDedupStats(env) {
  if (!env.D1_DB) return json({ ok: true, data: { total: 0, with_md5: 0, unique: 0, duplicates: 0 } });
  try {
    const [t, w, u] = await Promise.all([
      env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first(),
      env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND md5_hash!=''").first(),
      env.D1_DB.prepare('SELECT COUNT(DISTINCT md5_hash) as c FROM files WHERE deleted_at IS NULL AND md5_hash!=""').first()
    ]);
    const total = t?.c || 0;
    const withMd5 = w?.c || 0;
    const unique = u?.c || 0;
    return json({ ok: true, data: { total, with_md5: withMd5, unique, duplicates: withMd5 - unique } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// Dedup groups preview: show every duplicate group with its members and the
// keeper that would survive a cleanup, so admins can verify before purging.
// 已优化：原来每组 2 次 D1 查询（N+1，最多 100 次往返 → 慢），改为 3~4 次总查询。
export async function handleDedupGroups(env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    await ensureTablesOnce(env.D1_DB);
    const dupRows = await env.D1_DB.prepare(
      'SELECT md5_hash, COUNT(*) as cnt FROM files WHERE deleted_at IS NULL AND md5_hash!="" GROUP BY md5_hash HAVING COUNT(*)>1 ORDER BY cnt DESC LIMIT 50'
    ).all();
    const dups = dupRows.results || [];
    if (!dups.length) return json({ ok: true, data: { total_groups: 0, groups: [] } });
    // 1) 一次性取所有组成员（md5 IN 分批，SQLite 单条变量上限 999）
    const allRows = [];
    const md5List = dups.map(function(d) { return d.md5_hash; });
    for (let i = 0; i < md5List.length; i += 200) {
      const chunk = md5List.slice(i, i + 200);
      const ph = chunk.map(function() { return '?'; }).join(',');
      const rr = await env.D1_DB.prepare(
        'SELECT id, file_name, file_type, file_size, created_at, storage_key, r2_url, pool_status, tags, md5_hash FROM files WHERE deleted_at IS NULL AND md5_hash IN (' + ph + ')'
      ).bind(...chunk).all();
      (rr.results || []).forEach(function(x) { allRows.push(x); });
    }
    // 2) 收集所有成员 id，统一查一次随机库引用（分批防超限）
    const allIds = allRows.map(function(x) { return x.id; });
    const poolRefs = await poolRefIds(env, allIds);
    // 3) 组内排序（与清理时一致：池导入 > 有标签 > 已完成 > 其他）并分组
    const byMd5 = {};
    allRows.forEach(function(f) { (byMd5[f.md5_hash] = byMd5[f.md5_hash] || []).push(f); });
    const groups = [];
    for (const d of dups) {
      const res = (byMd5[d.md5_hash] || []).sort(function(a, b) {
        const ka = a.pool_status === 'imported' ? 0 : (a.tags ? 1 : 2);
        const kb = b.pool_status === 'imported' ? 0 : (b.tags ? 1 : 2);
        return ka - kb || a.id - b.id;
      }).slice(0, 20);
      if (!res.length) continue;
      groups.push({
        md5: d.md5_hash,
        count: d.cnt,
        keeper_id: res[0].id,
        files: res.map(function(f) { return { id: f.id, file_name: f.file_name, file_type: f.file_type, file_size: f.file_size, created_at: f.created_at, r2_url: f.r2_url || '', pool_ref: poolRefs.has(String(f.id)) }; })
      });
    }
    return json({ ok: true, data: { total_groups: groups.length, groups: groups } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 随机库引用 id 集合（分批查，避免 SQLite IN 变量超限）
export async function poolRefIds(env, ids) {
  const set = new Set();
  for (let i = 0; i < ids.length; i += 800) {
    const chunk = ids.slice(i, i + 800);
    if (!chunk.length) continue;
    const pr = await env.D1_DB.prepare('SELECT tg_file_id FROM random_pool WHERE tg_file_id IN (' + chunk.join(',') + ')').all();
    (pr.results || []).forEach(function(x) { set.add(String(x.tg_file_id)); });
  }
  return set;
}

// 按行清理/保留：keep = 保留该 id 并清理同组其他；del = 只清理该 id。
// 默认软删（移入回收站），purge=1 硬删（含 R2 对象）。池引用文件自动跳过。
export async function handleDedupRow(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const body = await request.json().catch(function() { return {}; });
    const md5 = String(body.md5 || '').trim();
    const id = Number(body.id) || 0;
    const action = body.action;
    const purge = body.purge === 1 || body.purge === '1';
    if (!md5 || !id || (action !== 'keep' && action !== 'del')) return json({ ok: false, error: '参数错误：需要 md5 / id / action(keep|del)' });
    const rows = await env.D1_DB.prepare("SELECT id, storage_key FROM files WHERE md5_hash=? AND deleted_at IS NULL").bind(md5).all();
    const res = rows.results || [];
    const poolRefs = await poolRefIds(env, res.map(function(x) { return x.id; }));
    let targets = [];
    if (action === 'keep') {
      targets = res.filter(function(r) { return r.id !== id && !poolRefs.has(String(r.id)); });
    } else {
      targets = res.filter(function(r) { return r.id === id && !poolRefs.has(String(r.id)); });
    }
    const cleaned = await purgeFileRows(env, targets, purge);
    const mode = purge ? '硬删除' : '移入回收站';
    const kept = action === 'keep' ? '（保留 id=' + id + '）' : '';
    return json({ ok: true, data: { cleaned: cleaned, message: (action === 'keep' ? '保留并清理同组' : '清理') + ' ' + cleaned + ' 个文件，已' + mode + kept + '。池引用文件已自动跳过。' } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// 批量清理选中的文件行（复选框多选）
export async function handleDedupRows(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const body = await request.json().catch(function() { return {}; });
    const ids = (body.ids || []).map(Number).filter(Boolean);
    const purge = body.purge === 1 || body.purge === '1';
    if (!ids.length) return json({ ok: false, error: '未选择文件' });
    const ph = ids.map(function() { return '?'; }).join(',');
    const rows = await env.D1_DB.prepare("SELECT id, storage_key FROM files WHERE deleted_at IS NULL AND id IN (" + ph + ")").bind(...ids).all();
    const res = rows.results || [];
    const poolRefs = await poolRefIds(env, res.map(function(x) { return x.id; }));
    const targets = res.filter(function(r) { return !poolRefs.has(String(r.id)); });
    const cleaned = await purgeFileRows(env, targets, purge);
    const mode = purge ? '硬删除' : '移入回收站';
    return json({ ok: true, data: { cleaned: cleaned, skipped: res.length - targets.length, message: '已清理 ' + cleaned + ' 个文件（' + mode + '）' + (res.length - targets.length ? '，跳过池引用 ' + (res.length - targets.length) + ' 个。' : '。') } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// 批量软删/硬删（含 R2 对象，最后引用才删），返回实际清理数
export async function purgeFileRows(env, targets, purge) {
  const now = new Date().toISOString();
  let cleaned = 0;
  for (const f of targets) {
    try {
      if (purge) {
        if (f.storage_key) {
          const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=?').bind(f.storage_key).first();
          if (!ref || (ref.c || 0) <= 1) { try { await env.R2_BUCKET.delete(f.storage_key); } catch (e) {} }
        }
        const r = await env.D1_DB.prepare('DELETE FROM files WHERE id=?').bind(f.id).run();
        if (r.meta && r.meta.changes) cleaned++;
      } else {
        const r = await env.D1_DB.prepare('UPDATE files SET deleted_at=? WHERE id=? AND deleted_at IS NULL').bind(now, f.id).run();
        if (r.meta && r.meta.changes) cleaned++;
      }
    } catch (e) {}
  }
  return cleaned;
}

// 后台 WebP 压缩：每 5 分钟最多 2 张（与手动 run 共享逻辑，限时 20s 防挤占 scheduled 预算）
export async function compressCronBatch(env) {
  if (!env.D1_DB || !env.R2_BUCKET || !env.R2_PUBLIC_URL) return;
  try {
    const last = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='last_compress_cron'").first();
    if (last && last.value && (Date.now() - (parseInt(last.value, 10) || 0)) < 300000) return;
    const startT = Date.now();
    const rows = await env.D1_DB.prepare("SELECT id, storage_key, file_size FROM files WHERE deleted_at IS NULL AND storage_key!='' AND processing_state='completed' AND file_type='photo' AND (mime_type='' OR mime_type IN ('image/jpeg','image/png')) AND (storage_key LIKE '%.jpg' OR storage_key LIKE '%.jpeg' OR storage_key LIKE '%.png') ORDER BY file_size DESC LIMIT 2").all();
    let done = 0;
    for (const f of rows.results || []) {
      if (Date.now() - startT > 20000) break;
      try {
        const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=?').bind(f.storage_key).first();
        if (!ref || (ref.c || 0) > 1) continue;
        const res = await fetch(env.R2_PUBLIC_URL + '/' + f.storage_key, { cf: { image: { format: 'webp', quality: 80, fit: 'scale-down' } } });
        if (!res.ok) continue;
        const ct = res.headers.get('content-type') || '';
        if (ct.indexOf('webp') === -1) continue;
        const wbuf = await res.arrayBuffer();
        if (!wbuf.byteLength || wbuf.byteLength >= (f.file_size || 0)) continue;
        await env.R2_BUCKET.put(f.storage_key, wbuf, { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000' } });
        await env.D1_DB.prepare("UPDATE files SET mime_type='image/webp', file_size=?, md5_hash='', quick_hash='' WHERE id=?").bind(wbuf.byteLength, f.id).run();
        done++;
      } catch (e) {}
    }
    if (done) console.log('compress cron batch done:', done);
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('last_compress_cron', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(Date.now())).run();
  } catch (e) { console.error('compressCronBatch:', e.message); }
}

// 日报：cron "0 1 * * *"（UTC 01:00 = 北京 09:00）推送昨日转存汇总到管理员
export async function sendDailyReport(env) {
  if (!env.D1_DB || !env.TG_BOT_TOKEN) return;
  try {
    let chatId = '';
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'admin_chat_id'").first();
    if (s && s.value) chatId = String(s.value).trim();
    if (!chatId && env.ADMIN_CHAT_ID) chatId = String(env.ADMIN_CHAT_ID).trim();
    if (!chatId) return;
    const dayStart = cnDayIso(cnShift(new Date(Date.now() - 86400000)).toISOString().slice(0, 10));
    const dayEnd = cnDayIso(cnTodayStr());
    const yNew = await env.D1_DB.prepare('SELECT COUNT(*) as c, COALESCE(SUM(file_size),0) as s FROM files WHERE created_at>=? AND created_at<?').bind(dayStart, dayEnd).first();
    const total = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first();
    const trash = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NOT NULL').first();
    let storageTxt = '';
    try {
      const ru = await handleAdminR2Usage(env);
      const rj = (ru instanceof Response) ? await ru.json() : ru;
      if (rj && rj.ok && rj.data) {
        storageTxt = 'R2 存储 ' + (rj.data.storage_bytes / 1073741824).toFixed(2) + ' GB / 10 GB（' + (rj.data.storage_pct !== null && rj.data.storage_pct !== undefined ? rj.data.storage_pct + '%' : '—') + '）';
      }
    } catch (e) {}
    const dayStr = cnTodayStr();
    const reqs = await env.D1_DB.prepare('SELECT COALESCE(SUM(requests),0) as r FROM worker_stats WHERE day=?').bind(dayStr).first();
    const text = '\uD83D\uDCC5 图库日报\n\u2022 昨日新增：' + ((yNew && yNew.c) || 0) + ' 个 / ' + fmtSize((yNew && yNew.s) || 0) + '\n\u2022 文件总数：' + ((total && total.c) || 0) + ' 个\n\u2022 回收站待清：' + ((trash && trash.c) || 0) + ' 个（>30 天自动硬清）\n\u2022 ' + storageTxt + '\n\u2022 今日请求（本地计数）：' + ((reqs && reqs.r) || 0) + ' 次';
    // 发送并置顶日报：pinChatMessage 置顶（bot 需在群里有置顶权限），下次发新日报前先解pin旧的避免堆积
    try {
      const sr = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true })
      });
      const sj = await sr.json();
      const mid = sj && sj.ok && sj.result && sj.result.message_id;
      if (mid) {
        const old = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='pinned_report_msg_id'").first();
        if (old && old.value && old.value !== String(mid)) {
          try {
            await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/unpinChatMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: parseInt(old.value, 10) }) });
          } catch (e) {}
        }
        try {
          await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/pinChatMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: mid, disable_notification: true }) });
        } catch (e) { console.log('pin fail:', e.message); }
        await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES ('pinned_report_msg_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(mid)).run();
      }
    } catch (e) { console.error('sendDailyReport send:', e.message); }
  } catch (e) { console.error('sendDailyReport:', e.message); }
}

// 回收站自动清理：deleted_at 超过 30 天的文件硬删（含 R2 对象），24 小时最多执行一次。
// 与手动"清空回收站"不同，这里是兜底，防止软删文件无限占 R2 存储。
export async function storageMaintenanceCron(env) {
  if (!env.D1_DB || !env.R2_BUCKET) return;
  try {
    const last = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='last_storage_maintenance'").first();
    if (last && last.value && (Date.now() - (parseInt(last.value, 10) || 0)) < 86400000) return;
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const rows = await env.D1_DB.prepare('SELECT id, storage_key FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 500').bind(cutoff).all();
    let purged = 0;
    for (const f of rows.results || []) {
      try {
        if (f.storage_key) {
          const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=? AND deleted_at IS NULL').bind(f.storage_key).first();
          if (!ref || (ref.c || 0) <= 0) { try { await env.R2_BUCKET.delete(f.storage_key); } catch (e) {} }
        }
        const r = await env.D1_DB.prepare('DELETE FROM files WHERE id=?').bind(f.id).run();
        if (r.meta && r.meta.changes) purged++;
      } catch (e) {}
    }
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('last_storage_maintenance', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(Date.now())).run();
    if (purged) console.log('storage maintenance purged:', purged);
  } catch (e) { console.error('storageMaintenanceCron:', e.message); }
}

// 存储压缩：photo (JPEG/PNG) → WebP 覆盖写回，省 50~70% 存储。
// 依赖 Cloudflare Image Resizing（cf.image 参数），账号未启用时明确报错。
// 分批执行（每批 3 张，限时），只处理 storage_key 唯一引用的文件，避免破坏去重。
export async function handleCompressStats(env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const r = await env.D1_DB.prepare("SELECT COUNT(*) as c, COALESCE(SUM(file_size),0) as s FROM files WHERE deleted_at IS NULL AND storage_key!='' AND processing_state='completed' AND file_type='photo' AND (mime_type='' OR mime_type IN ('image/jpeg','image/png')) AND (storage_key LIKE '%.jpg' OR storage_key LIKE '%.jpeg' OR storage_key LIKE '%.png')").first();
    return json({ ok: true, data: { files: r?.c || 0, bytes: r?.s || 0, note: '统计转存且为 JPEG/PNG 的图片，压缩为 WebP 预计可省 50~70%。需账号启用 Cloudflare Image Resizing（Pro 或按量开通），未启用时运行会明确提示。' } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

export async function handleCompressRun(request, env) {
  if (!env.D1_DB || !env.R2_BUCKET || !env.R2_PUBLIC_URL) return json({ ok: false, error: 'D1/R2 未配置' });
  try {
    var n = parseInt((request && new URL(request.url).searchParams.get('n')) || '10', 10);
    if (!(n > 0)) n = 10;
    if (n > 20) n = 20;
    const startT = Date.now();
    const rows = await env.D1_DB.prepare("SELECT id, storage_key, file_size FROM files WHERE deleted_at IS NULL AND storage_key!='' AND processing_state='completed' AND file_type='photo' AND (mime_type='' OR mime_type IN ('image/jpeg','image/png')) AND (storage_key LIKE '%.jpg' OR storage_key LIKE '%.jpeg' OR storage_key LIKE '%.png') ORDER BY file_size DESC LIMIT ?").bind(n).all();
    if (!(rows.results || []).length) return json({ ok: true, data: { done: 0, skipped: 0, not_available: false, message: '没有可压缩的图片了（已全部转 WebP）。' } });
    let done = 0, skipped = 0, webpFail = 0;
    for (const f of rows.results) {
      if (Date.now() - startT > 50000) break;
      try {
        const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=?').bind(f.storage_key).first();
        if (!ref || (ref.c || 0) > 1) { skipped++; continue; }
        const url = env.R2_PUBLIC_URL + '/' + f.storage_key;
        const res = await fetch(url, { cf: { image: { format: 'webp', quality: 80, fit: 'scale-down' } } });
        if (!res.ok) { skipped++; continue; }
        const ct = res.headers.get('content-type') || '';
        if (ct.indexOf('webp') === -1) { webpFail++; skipped++; continue; } // 该文件未转成 webp（如超大图超限）
        const wbuf = await res.arrayBuffer();
        if (!wbuf.byteLength || wbuf.byteLength >= (f.file_size || 0)) { skipped++; continue; } // 未变小不覆盖
        await env.R2_BUCKET.put(f.storage_key, wbuf, { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000' } });
        await env.D1_DB.prepare("UPDATE files SET mime_type='image/webp', file_size=?, md5_hash='', quick_hash='' WHERE id=?").bind(wbuf.byteLength, f.id).run();
        done++;
      } catch (e) { console.log('compress item fail:', e.message); }
    }
    const notAvailable = (webpFail > 0 && done === 0);
    const msg = notAvailable
      ? 'Cloudflare Image Resizing 未生效（需账号启用，通常为 Pro 套餐或按量开通）。可通过 fetch 加 cf.image 转换的 Worker 验证；未启用时无法转 WebP，可先用回收站清理/去重释放空间。'
      : ('本轮压缩 ' + done + ' 张为 WebP' + (skipped ? '，跳过 ' + skipped + ' 张（被多行引用/未变小/超大图超限）' : '') + '。分批执行（每批 ' + n + ' 张），可重复点击或 cron 自动加速。');
    return json({ ok: true, data: { done, skipped, not_available: notAvailable, message: msg } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// 查重分批执行（手动/定时共用）：算 N 个缺失 MD5，再清理 G 个重复组。
// 免费版单调用 50 子请求 + 30s 墙钟：手动 N=15/G=3/限时25s，定时 N=5/G=1/限时12s。
export async function runDedupBatch(env, computeN, cleanGroups, timeLimitMs, purge) {
  if (!env.D1_DB) return { computed: 0, cleaned: 0, groups: 0 };
  const startT = Date.now();
  const deadline = timeLimitMs || 25000;
  function timedOut() { return Date.now() - startT > deadline; }
  // 1) 算缺失 MD5（每个 R2 读取限时，避免大文件拖垮整批）
  let computed = 0;
  const missing = await env.D1_DB.prepare("SELECT id, storage_key FROM files WHERE deleted_at IS NULL AND (md5_hash='' OR md5_hash IS NULL) LIMIT ?").bind(computeN).all();
  for (const f of (missing.results || [])) {
    if (timedOut()) break;
    try {
      const obj = await Promise.race([env.R2_BUCKET.get(f.storage_key), new Promise(function(res){ setTimeout(function(){ res(null); }, 4000); })]);
      if (!obj) continue;
      const buf = await Promise.race([obj.arrayBuffer(), new Promise(function(res){ setTimeout(function(){ res(null); }, 8000); })]);
      if (!buf) continue;
      const md5 = await computeMd5(buf);
      await env.D1_DB.prepare('UPDATE files SET md5_hash=? WHERE id=?').bind(md5, f.id).run();
      computed++;
    } catch (e) { console.log('dedup compute error:', e.message); }
  }
  // 2) 清理 G 个重复组（每组 1 个查询 + poolRefs + 逐行软删/硬删）
  let cleaned = 0, groups = 0;
  const dups = await env.D1_DB.prepare('SELECT md5_hash FROM files WHERE deleted_at IS NULL AND md5_hash!="" GROUP BY md5_hash HAVING COUNT(*)>1 LIMIT ?').bind(cleanGroups).all();
  const now = new Date().toISOString();
  for (const d of (dups.results || [])) {
    if (timedOut()) break;
    groups++;
    try {
      const rows = await env.D1_DB.prepare(
        "SELECT id, storage_key FROM files WHERE md5_hash=? AND deleted_at IS NULL ORDER BY CASE WHEN pool_status='imported' THEN 0 WHEN tags!='' THEN 1 WHEN processing_state='completed' THEN 2 ELSE 3 END, id ASC LIMIT 200"
      ).bind(d.md5_hash).all();
      const res = rows.results || [];
      if (res.length < 2) continue;
      // Rows still referenced by random_pool are NEVER cleaned (avoid dangling refs)
      const poolRefs = new Set();
      try {
        const pr = await env.D1_DB.prepare('SELECT tg_file_id FROM random_pool WHERE tg_file_id IN (' + res.map(function(x){ return x.id; }).join(',') + ')').all();
        (pr.results || []).forEach(function(x){ poolRefs.add(String(x.tg_file_id)); });
      } catch (e) {}
      for (let i = 1; i < res.length; i++) {
        if (timedOut()) break;
        const f = res[i];
        if (poolRefs.has(String(f.id))) continue;
        try {
          if (purge) {
            // Hard delete: remove R2 object (last reference only) then the row
            if (f?.storage_key) {
              const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=?').bind(f.storage_key).first();
              if (!ref || (ref.c || 0) <= 1) { try { await env.R2_BUCKET.delete(f.storage_key); } catch (e) {} }
            }
            const r = await env.D1_DB.prepare('DELETE FROM files WHERE id=?').bind(f.id).run();
            if (r.meta && r.meta.changes) cleaned++;
          } else {
            const r = await env.D1_DB.prepare('UPDATE files SET deleted_at=? WHERE id=? AND deleted_at IS NULL').bind(now, f.id).run();
            if (r.meta && r.meta.changes) cleaned++;
          }
        } catch (e) {}
      }
    } catch (e) {}
  }
  return { computed, cleaned, groups };
}

// Dedup existing files: compute missing MD5s, then clean duplicates.
// 已后台化：手动点击只跑一批（15 MD5 + 3 组），剩余由 cron 每 5 分钟自动分批完成。
export async function handleDedup(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    await ensureTablesOnce(env.D1_DB);
    const purge = new URL(request.url).searchParams.get('purge') === '1';
    const r = await runDedupBatch(env, 15, 3, 25000, purge);
    const mode = purge ? '硬删除' : '移入回收站';
    return json({ ok: true, data: { computed: r.computed, duplicate_groups: r.groups, cleaned: r.cleaned, purge, message: '本轮计算 MD5 ' + r.computed + ' 个、清理重复 ' + r.cleaned + ' 个（' + mode + '）。剩余由定时任务每 5 分钟自动分批完成，可再次点击加速。' } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

export async function handleAdminCommands(env) {
  if (!env.D1_DB) return json({ ok: true, data: [] });
  try {
    await ensureTablesOnce(env.D1_DB);
    const d = await env.D1_DB.prepare('SELECT * FROM bot_commands ORDER BY id ASC').all();
    return json({ ok: true, data: d.results || [] });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminAddCommand(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not configured' });
  try {
    await ensureTablesOnce(env.D1_DB);
    const in2 = await request.json();
    const cmd = (in2.command || '').trim().toLowerCase();
    const resp = (in2.response || '').trim();
    const desc = (in2.description || '').trim();
    const menu = (in2.menu || '').trim();
    if (!cmd || !resp) return json({ ok: false, error: 'command and response required' });
    await env.D1_DB.prepare('INSERT OR REPLACE INTO bot_commands (command, response, description, enabled, menu) VALUES (?, ?, ?, ?, ?)').bind(cmd, resp, desc, in2.enabled !== false ? 1 : 0, menu).run();
    return json({ ok: true, message: 'Command added' });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminUpdateCommand(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not configured' });
  try {
    const in2 = await request.json();
    if (!in2.id) return json({ ok: false, error: 'id required' });
    const fields = [];
    const vals = [];
    if (in2.command !== undefined) { fields.push('command = ?'); vals.push(in2.command.trim().toLowerCase()); }
    if (in2.response !== undefined) {
      fields.push('response = ?'); vals.push(in2.response.trim());
      // 编辑内置命令的响应内容后视为用户自定义（脱离内置占位），不再走代码内置逻辑
      if (String(in2.response).trim() !== '__BUILTIN__') { fields.push('builtin = 0'); }
    }
    if (in2.description !== undefined) { fields.push('description = ?'); vals.push(in2.description.trim()); }
    if (in2.menu !== undefined) { fields.push('menu = ?'); vals.push(String(in2.menu).trim()); }
    if (in2.enabled !== undefined) { fields.push('enabled = ?'); vals.push(in2.enabled ? 1 : 0); }
    if (fields.length === 0) return json({ ok: false, error: 'nothing to update' });
    vals.push(in2.id);
    await env.D1_DB.prepare('UPDATE bot_commands SET ' + fields.join(', ') + ' WHERE id = ?').bind(...vals).run();
    return json({ ok: true, message: 'Updated' });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminDeleteCommand(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not configured' });
  try {
    const u = new URL(request.url);
    const id = u.searchParams.get('id');
    if (!id) return json({ ok: false, error: 'id required' });
    await env.D1_DB.prepare('DELETE FROM bot_commands WHERE id = ?').bind(parseInt(id)).run();
    return json({ ok: true, message: 'Deleted' });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

