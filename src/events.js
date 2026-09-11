// ==================== 事件 Webhook 通知 ====================
// fireWebhook 事件派发、Webhook 配置管理、Random pool 管理、按条件查询/搜索/流/删除/回收站/R2 检查/机器人管理/配置管理。
import { json, invalidateStatsCache } from "./util.js";
import { sanitizeLevel, clampInt, splitTags, cnDayIso, cnNowISO } from "./core.js";
import { bumpR2Usage, mimeForStorageKey } from "./telegram.js";
import { appendTagFilter, decoratePoolList, poolOrderSql } from "./public.js";
import { dualInsertRandomPool, dualUpdateRandomPool, dualUpdateFiles, dualInsertUserUploads, dualUpdateUserUploads } from "./mysql.js";
// ==================== 事件 Webhook 通知 ====================
// 入库/删除/失败时 POST JSON 到外部 URL（settings.webhook_cfg = { url, enabled, events: [] }）
// events 空数组 = 全部事件；支持事件：file_imported / file_deleted / file_failed
export async function getWebhookCfg(env) {
  const out = { enabled: 0, url: '', events: [] };
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'webhook_cfg'").first();
    if (s && s.value) {
      const j = JSON.parse(s.value);
      if (j) { out.enabled = j.enabled ? 1 : 0; out.url = j.url || ''; out.events = Array.isArray(j.events) ? j.events : []; }
    }
  } catch (e) {}
  return out;
}
// fire and forget：不阻塞主流程；发送失败静默跳过
export async function fireWebhook(env, event, payload) {
  try {
    if (!env.D1_DB) return;
    const c = await getWebhookCfg(env);
    if (!c.enabled || !c.url || !/^https?:\/\//i.test(c.url)) return;
    if (c.events.length && c.events.indexOf(event) === -1) return;
    const body = JSON.stringify({ event: event, ts: cnNowISO(), data: payload || {} });
    await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body }).catch(function(e) { console.log('webhook send fail:', e.message); });
  } catch (e) { console.log('fireWebhook error:', e.message); }
}
export async function handleAdminGetWebhook(env) {
  try {
    const c = await getWebhookCfg(env);
    return json({ ok: true, data: c });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
export async function handleAdminSaveWebhook(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const url = b && b.url ? String(b.url).trim().slice(0, 500) : '';
    if (url && !/^https?:\/\//i.test(url)) return json({ ok: false, error: '请输入有效的 http(s) URL' }, 400);
    const enabled = !!(b && b.enabled);
    const ALLOWED_EVENTS = ['file_imported', 'file_deleted', 'file_failed'];
    const events = Array.isArray(b && b.events) ? b.events.map(function(e){ return String(e); }).filter(function(e){ return ALLOWED_EVENTS.indexOf(e) !== -1; }) : [];
    const cfg = { enabled: enabled, url: url, events: events };
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('webhook_cfg', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(cfg)).run();
    return json({ ok: true, data: cfg });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
export async function handleAdminWebhookTest(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const url = b && b.url ? String(b.url).trim().slice(0, 500) : '';
    if (!url || !/^https?:\/\//i.test(url)) return json({ ok: false, error: '请输入有效的 http(s) URL' }, 400);
    const body = JSON.stringify({ event: 'webhook_test', ts: cnNowISO(), data: { message: 'webhook 通知测试（来自 telegram-r2-bot）', ok: true } });
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
    return json({ ok: r.ok, status: r.status, error: r.ok ? '' : ('HTTP ' + r.status + ' ' + r.statusText) });
  } catch (e) { return json({ ok: false, error: e.message }, 400); }
}

export async function handleAdminPoolTags(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.ids) || !b.ids.length) return json({ ok: false, error: 'ids required' }, 400);
    const mode = b.mode || 'set';
    if (['set', 'append', 'remove'].indexOf(mode) === -1) return json({ ok: false, error: 'mode 仅支持 set/append/remove' }, 400);
    const tags = (b.tags || []).map(String).map(function(t){ return t.trim(); }).filter(Boolean);
    let updated = 0;
    for (const id of b.ids) {
      const cur = await env.D1_DB.prepare('SELECT tags FROM random_pool WHERE id = ?').bind(id).first();
      if (!cur) continue;
      let next = '';
      if (mode === 'append') {
        const set = new Set(splitTags(cur && cur.tags));
        tags.forEach(function(t){ set.add(t); });
        next = Array.from(set).join(',');
      } else if (mode === 'remove') {
        const set = new Set(splitTags(cur && cur.tags));
        tags.forEach(function(t){ set.delete(t); });
        next = Array.from(set).join(',');
      } else {
        next = tags.join(',');
      }
      const r = await env.D1_DB.prepare('UPDATE random_pool SET tags = ? WHERE id = ?').bind(next, id).run();
      if (r && r.meta && r.meta.changes) {
        updated++;
        // 双写 MySQL
        dualUpdateRandomPool(env, id, { tags: next }).catch(e => console.error('dualUpdateRandomPool error:', e.message));
      }
    }
    return json({ ok: true, updated: updated });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminPoolBatch(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.ids) || !b.ids.length) return json({ ok: false, error: 'ids required' }, 400);
    // level/is_private/enabled 互斥，避免同时传入时后者被静默忽略
    const hasLevel = b.level !== undefined;
    const hasPrivate = b.is_private !== undefined;
    const hasEnabled = b.enabled !== undefined;
    const given = (hasLevel ? 1 : 0) + (hasPrivate ? 1 : 0) + (hasEnabled ? 1 : 0);
    if (!given) return json({ ok: false, error: '缺少要设置的参数（level/is_private/enabled）' }, 400);
    if (given > 1) return json({ ok: false, error: 'level/is_private/enabled 一次只能设置一个' }, 400);
    if (hasLevel && (b.level === null || b.level === '')) return json({ ok: false, error: 'level 不能为空' }, 400);
    const ops = [];
    for (const id of b.ids) {
      if (hasLevel) {
        ops.push(env.D1_DB.prepare('UPDATE random_pool SET level = ? WHERE id = ?').bind(sanitizeLevel(b.level), id));
      } else if (hasPrivate) {
        // 转入私密库：等同 vvip 最高级，级别联动；移出私密库降级为 svip
        if (b.is_private) {
          ops.push(env.D1_DB.prepare('UPDATE random_pool SET is_private = 1, level = ? WHERE id = ?').bind('vvip', id));
        } else {
          ops.push(env.D1_DB.prepare('UPDATE random_pool SET is_private = 0, level = ? WHERE id = ?').bind('svip', id));
        }
      } else {
        ops.push(env.D1_DB.prepare('UPDATE random_pool SET enabled = ? WHERE id = ?').bind(b.enabled ? 1 : 0, id));
      }
    }
    const res = await env.D1_DB.batch(ops);
    let updated = 0;
    for (const r of res) { if (r && r.meta && r.meta.changes) updated++; }
    return json({ ok: true, updated: updated });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminPoolBatchDelete(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.ids) || !b.ids.length) return json({ ok: false, error: 'ids required' }, 400);
    // 单次事务批量删除，部分失败不产生半生效状态
    const ops = b.ids.map(function(id) { return env.D1_DB.prepare('DELETE FROM random_pool WHERE id = ?').bind(id); });
    const res = await env.D1_DB.batch(ops);
    let deleted = 0;
    for (const r of res) { if (r && r.meta && r.meta.changes) deleted++; }
    for (const id of b.ids) {
      await fireWebhook(env, 'file_deleted', { id: id, deleted: true, source: 'pool' }).catch(function(){});
    }
    return json({ ok: true, deleted: deleted });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleSetFilePoolStatus(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.ids) || !b.ids.length) return json({ ok: false, error: 'ids required' }, 400);
    const status = b.status === 'ignored' ? 'ignored' : '';
    const ids = [];
    for (const id of b.ids) {
      const n = parseInt(id, 10);
      if (!n) return json({ ok: false, error: '非法文件 id: ' + id }, 400);
      ids.push(n);
    }
    let n = 0;
    for (const id of ids) {
      const r = await env.D1_DB.prepare('UPDATE files SET pool_status=? WHERE id=?').bind(status, id).run();
      n += (r && r.meta && r.meta.changes) || 0;
    }
    return json({ ok: true, updated: n });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminGetAutoPoolTags(env) {
  const tags = await getAutoPoolTags(env);
  return json({ ok: true, data: { tags: tags } });
}

export async function handleAdminSaveAutoPoolTags(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const tags = Array.isArray(b && b.tags)
      ? b.tags.map(String).map(function(t){ return t.trim(); }).filter(Boolean)
      : [];
    const uniq = Array.from(new Set(tags)).slice(0, 200);
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('auto_pool_tags', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(uniq)).run();
    _autoPoolTagsCache = uniq; _autoPoolTagsAt = Date.now();
    return json({ ok: true, data: { tags: uniq } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 自动入共享库标签集合（settings 键 auto_pool_tags，JSON 数组，30s 缓存）
let _autoPoolTagsCache = null, _autoPoolTagsAt = 0;
export async function getAutoPoolTags(env) {
  const now = Date.now();
  if (_autoPoolTagsCache !== null && now - _autoPoolTagsAt < 30000) return _autoPoolTagsCache;
  _autoPoolTagsCache = [];
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'auto_pool_tags'").first();
    if (s && s.value) {
      try { const v = JSON.parse(s.value); if (Array.isArray(v)) _autoPoolTagsCache = v.map(String).map(function(t){ return t.trim(); }).filter(Boolean); } catch (e) {}
    }
  } catch (e) {}
  _autoPoolTagsAt = now;
  return _autoPoolTagsCache;
}

function parsePoolImportIds(rawIds) {
  const unique = [];
  const seen = new Set();
  for (const raw of rawIds || []) {
    const n = parseInt(raw, 10);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    unique.push(n);
    if (unique.length >= 200) break;
  }
  return unique;
}

function poolImportLevel(f, opts) {
  if (opts && opts.forceLevel) return opts.forceLevel;
  if (opts && opts.level !== undefined) return opts.level;
  return sanitizeLevel(f.level);
}

async function loadFilesForPoolImport(env, unique) {
  const fileMap = new Map();
  const existSet = new Set();
  for (let i = 0; i < unique.length; i += 80) {
    const chunk = unique.slice(i, i + 80);
    const ph = chunk.map(function() { return '?'; }).join(',');
    const files = await env.D1_DB.prepare(
      "SELECT id, r2_url, thumb_url, file_name, file_type, width, height, file_size, tags, level FROM files WHERE id IN (" + ph + ") AND deleted_at IS NULL AND (pool_status IS NULL OR pool_status != 'ignored')"
    ).bind(...chunk).all();
    for (const f of (files.results || [])) fileMap.set(Number(f.id), f);
    const exist = await env.D1_DB.prepare(
      'SELECT tg_file_id FROM random_pool WHERE tg_file_id IN (' + ph + ')'
    ).bind(...chunk).all();
    for (const r of (exist.results || [])) existSet.add(Number(r.tg_file_id));
  }
  return { fileMap, existSet };
}

// 批量把 files 导入 random_pool：IN 查询 + D1.batch INSERT，避免逐条 round-trip
export async function importFilesToPoolBatch(ids, opts, env) {
  const unique = parsePoolImportIds(ids);
  if (!unique.length) return { added: 0, skipped: 0, duplicated: 0 };
  const { fileMap, existSet } = await loadFilesForPoolImport(env, unique);
  const now = cnNowISO();
  const isPrivate = (opts && opts.isPrivate) ? 1 : 0;
  const finalTags = (opts && opts.tags) || '';
  const syncFileTags = !!(opts && opts.syncFileTags && finalTags);
  const inserts = [];
  const tagUpdates = [];
  let skipped = 0, duplicated = 0, added = 0;
  for (const id of unique) {
    const f = fileMap.get(id);
    if (!f) { skipped++; continue; }
    if (existSet.has(id)) { duplicated++; continue; }
    const useTags = finalTags || f.tags || '';
    const level = poolImportLevel(f, opts);
    inserts.push(env.D1_DB.prepare(
      'INSERT INTO random_pool (url, thumb_url, title, tags, level, is_private, file_type, width, height, file_size, source, tg_file_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'tg\', ?, 1, ?)'
    ).bind(f.r2_url, f.thumb_url || f.r2_url, f.file_name || '', useTags, level, isPrivate, f.file_type || 'photo', f.width || null, f.height || null, f.file_size || null, f.id, now));
    if (syncFileTags) {
      tagUpdates.push(env.D1_DB.prepare('UPDATE files SET tags=? WHERE id=? AND deleted_at IS NULL').bind(finalTags, id));
    }
    added++;
    dualInsertRandomPool(env, {
      url: f.r2_url, thumb_url: f.thumb_url || f.r2_url, title: f.file_name || '', tags: useTags,
      file_type: f.file_type || 'photo', width: f.width || null, height: f.height || null, file_size: f.file_size || null,
      source: 'tg', tg_file_id: f.id, enabled: 1, created_at: now, level: level, is_private: isPrivate
    }).catch(e => console.error('dualInsertRandomPool error:', e.message));
  }
  const ops = inserts.concat(tagUpdates);
  for (let i = 0; i < ops.length; i += 50) {
    await env.D1_DB.batch(ops.slice(i, i + 50));
  }
  return { added: added, skipped: skipped, duplicated: duplicated };
}

// 从 files 行导入共享库/私密库：以 tg_file_id 去重；支持 level/isPrivate 覆盖
export async function importFileToPool(f, opts, env) {
  const r = await importFilesToPoolBatch([f.id], {
    tags: (opts && opts.tags) || '',
    level: opts && opts.level,
    isPrivate: opts && opts.isPrivate,
  }, env);
  return r.added > 0;
}

function poolFromTgOpts(b, extra) {
  const tagsOverride = Array.isArray(b.tags) ? b.tags.map(function(s) { return String(s).trim(); }).filter(Boolean) : [];
  const finalTags = tagsOverride.length ? Array.from(new Set(tagsOverride)).join(',') : '';
  return Object.assign({
    tags: finalTags,
    syncFileTags: !!finalTags,
    isPrivate: b.private ? 1 : 0,
    level: b.level !== undefined ? sanitizeLevel(b.level) : undefined,
    async: !!b.async,
  }, extra || {});
}

async function runPoolFromTg(ids, opts, env, ctx) {
  const run = function() { return importFilesToPoolBatch(ids, opts, env); };
  if (ctx && ctx.waitUntil && opts && opts.async && ids.length > 8) {
    ctx.waitUntil(run().catch(function(e) { console.log('pool from-tg async fail:', e.message); }));
    return json({ ok: true, data: { queued: ids.length, added: 0, skipped: 0, duplicated: 0, async: 1 } });
  }
  const r = await run();
  return json({ ok: true, data: r });
}

export async function handleAdminPoolFromTg(request, env, ctx) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.ids) || !b.ids.length) return json({ ok: false, error: 'ids required' }, 400);
    const ids = parsePoolImportIds(b.ids);
    if (!ids.length) return json({ ok: false, error: 'ids required' }, 400);
    return await runPoolFromTg(ids, poolFromTgOpts(b), env, ctx);
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminPoolDelete(request, env) {
  try {
    const u = new URL(request.url);
    const id = u.searchParams.get('id');
    if (!id) return json({ ok: false, error: 'id required' }, 400);
    
    // Get the file info before deleting
    const file = await env.D1_DB.prepare('SELECT * FROM random_pool WHERE id = ?').bind(id).first();
    if (file) {
      // 识别关联的 files.id：tg 来源走 tg_file_id；user_upload 等来源从 url(/file/tg/<id> 或签名链接)解析
      let linkId = parseInt(file.tg_file_id, 10) || 0;
      if (!linkId && file.url) {
        const m = String(file.url).match(/\/file\/tg\/(?:[0-9a-f]{16}\/)?(\d+)(?:\.\w+)?$/);
        if (m) linkId = parseInt(m[1], 10) || 0;
      }
      if (linkId) {
        // 同步软删用户上传记录（url 存相对占位 /file/tg/<id>）
        await env.D1_DB.prepare('UPDATE user_uploads SET deleted_at = ? WHERE url = ? AND deleted_at IS NULL')
          .bind(cnNowISO(), '/file/tg/' + linkId).run();
        // 同步软删 files 行，避免代理出图残留
        await env.D1_DB.prepare('UPDATE files SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
          .bind(cnNowISO(), linkId).run();
      }
    }
    
    await env.D1_DB.prepare('DELETE FROM random_pool WHERE id = ?').bind(id).run();
    await fireWebhook(env, 'file_deleted', { id: id, deleted: true, source: 'pool' }).catch(function(){});
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 私密库列表（is_private=1，等同 vvip 最高级，不进入共享库）
export async function handleAdminPrivatePoolList(request, env) {
  try {
    const u = new URL(request.url);
    const kw = u.searchParams.get('keyword') || '';
    const tagsParam = u.searchParams.get('tags') || '';
    const limit = clampInt(u.searchParams.get('limit') || '500', 500, 1, 500);
    const offset = clampInt(u.searchParams.get('offset') || '0', 0, 0);
    const orderSql = poolOrderSql(u);
    let w = 'WHERE is_private=1'; const p = [];
    if (tagsParam) { w = appendTagFilter(tagsParam, w, p); }
    if (kw) { w += ' AND (title LIKE ? OR url LIKE ?)'; p.push('%' + kw + '%', '%' + kw + '%'); }
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM random_pool ' + w).bind(...p).first();
    const d = await env.D1_DB.prepare('SELECT * FROM random_pool ' + w + orderSql + ' LIMIT ? OFFSET ?').bind(...p, limit, offset).all();
    const origin = new URL(request.url).origin;
    return json({ ok: true, data: await decoratePoolList(d.results || [], origin, env), total: t?.total || 0 });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 私密库 tele 转存：私密图片等同 vvip，仅 vvip 密钥可访问，不进入共享库
export async function handleAdminPrivatePoolFromTg(request, env, ctx) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.ids) || !b.ids.length) return json({ ok: false, error: 'ids required' }, 400);
    const ids = parsePoolImportIds(b.ids);
    if (!ids.length) return json({ ok: false, error: 'ids required' }, 400);
    return await runPoolFromTg(ids, poolFromTgOpts(b, { forceLevel: 'vvip', isPrivate: 1 }), env, ctx);
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleByChat(request, env) {
  const u = new URL(request.url); const ci = u.searchParams.get('chat_id'); const ct = u.searchParams.get('chat_title');
  const pg = clampInt(u.searchParams.get('page') || '1', 1, 1); const ps = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100); const off = (pg - 1) * ps;
  let w = 'WHERE deleted_at IS NULL'; const p = [];
  if (ci) { w += ' AND chat_id=?'; p.push(ci); } if (ct) { w += ' AND chat_title LIKE ?'; p.push('%' + ct + '%'); }
  try { const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM files ' + w).bind(...p).first(); const d = await env.D1_DB.prepare('SELECT * FROM files ' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?').bind(...p, ps, off).all(); return json({ ok: true, data: { total: t?.total || 0, page: pg, page_size: ps, items: d.results || [] } }); } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleByUser(request, env) {
  const u = new URL(request.url); const ui = u.searchParams.get('user_id'); const un = u.searchParams.get('username');
  if (ui && !/^\d+$/.test(ui)) return json({ ok: false, error: 'user_id 必须为数字' }, 400);
  const pg = clampInt(u.searchParams.get('page') || '1', 1, 1); const ps = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100); const off = (pg - 1) * ps;
  let w = 'WHERE deleted_at IS NULL'; const p = [];
  if (ui) { w += ' AND user_id=?'; p.push(parseInt(ui, 10)); } if (un) { w += ' AND username LIKE ?'; p.push('%' + un + '%'); }
  try { const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM files ' + w).bind(...p).first(); const d = await env.D1_DB.prepare('SELECT * FROM files ' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?').bind(...p, ps, off).all(); return json({ ok: true, data: { total: t?.total || 0, page: pg, page_size: ps, items: d.results || [] } }); } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleByDate(request, env) {
  const u = new URL(request.url); const d2 = u.searchParams.get('date');
  if (!d2 || !/^\d{4}-\d{2}-\d{2}$/.test(d2)) return json({ ok: false, error: 'date 格式应为 YYYY-MM-DD' });
  // created_at 存的是 UTC ISO；把用户视角的东八区日期映射为 UTC 范围 [CN 日 00:00, 次日 00:00)
  // 否则 UTC+8 凌晨上传的文件会被归入前一日，按日期查询漏数据
  const parts = d2.split('-');
  const nextDay = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10) + 1)).toISOString().slice(0, 10);
  const startUtc = cnDayIso(d2);
  const endUtc = cnDayIso(nextDay);
  const pg = clampInt(u.searchParams.get('page') || '1', 1, 1); const ps = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100); const off = (pg - 1) * ps;
  try { const t = await env.D1_DB.prepare("SELECT COUNT(*) as total FROM files WHERE created_at>=? AND created_at<? AND deleted_at IS NULL").bind(startUtc, endUtc).first(); const d = await env.D1_DB.prepare("SELECT * FROM files WHERE created_at>=? AND created_at<? AND deleted_at IS NULL ORDER BY id DESC LIMIT ? OFFSET ?").bind(startUtc, endUtc, ps, off).all(); return json({ ok: true, data: { total: t?.total || 0, date: d2, page: pg, page_size: ps, items: d.results || [] } }); } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleSearch(request, env) {
  const u = new URL(request.url); const q = u.searchParams.get('q') || '';
  if (!q) return json({ ok: false, error: 'q required' });
  const pg = clampInt(u.searchParams.get('page') || '1', 1, 1); const ps = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100); const off = (pg - 1) * ps;
  const lk = '%' + q + '%';
  try { const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM files WHERE (file_name LIKE ? OR caption LIKE ? OR chat_title LIKE ? OR username LIKE ? OR full_name LIKE ?) AND deleted_at IS NULL').bind(lk, lk, lk, lk, lk).first(); const d = await env.D1_DB.prepare('SELECT * FROM files WHERE (file_name LIKE ? OR caption LIKE ? OR chat_title LIKE ? OR username LIKE ? OR full_name LIKE ?) AND deleted_at IS NULL ORDER BY id DESC LIMIT ? OFFSET ?').bind(lk, lk, lk, lk, lk, ps, off).all(); return json({ ok: true, data: { total: t?.total || 0, keyword: q, page: pg, page_size: ps, items: d.results || [] } }); } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleLatest(request, env) {
  const u = new URL(request.url); const lm = clampInt(u.searchParams.get('limit') || '10', 10, 1, 50); const tp = u.searchParams.get('type') || '';
  let w = tp ? 'WHERE file_type=? AND deleted_at IS NULL' : 'WHERE deleted_at IS NULL'; const p = tp ? [tp, lm] : [lm];
  try { const d = await env.D1_DB.prepare('SELECT * FROM files ' + w + ' ORDER BY id DESC LIMIT ?').bind(...p).all(); return json({ ok: true, data: d.results || [] }); } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleStream(request, env) {
  const u = new URL(request.url); const id = u.searchParams.get('id');
  try { const f = await env.D1_DB.prepare('SELECT storage_key FROM files WHERE id=? AND deleted_at IS NULL').bind(id).first(); if (!f) return json({ ok: false, error: 'not found' }, 404); const o = await env.R2_BUCKET.get(f.storage_key); if (!o) return json({ ok: false, error: 'gone' }, 404); bumpR2Usage(env, 'r2_class_b'); const h = new Headers(); o.writeHttpMetadata(h); h.set('Cache-Control', 'public,max-age=31536000'); h.set('Access-Control-Allow-Origin', '*'); return new Response(o.body, { headers: h }); } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleDeleteFile(request, env) {
  // Soft delete: mark the row deleted_at and keep the R2 object in place.
  // The file lands in the trash (recoverable); R2 cleanup happens on purge.
  const u = new URL(request.url); const id = u.searchParams.get('id'); const ids = u.searchParams.get('ids');
  const purge = u.searchParams.get('purge') === '1';
  const purgeAll = purge && u.searchParams.get('all') === '1';
  if (!id && !ids && !purgeAll) return json({ ok: false, error: 'id required' });
  const now = cnNowISO();
  let deleted = 0;
  if (purgeAll) {
    // Empty the whole trash: delete objects (last reference only) then the rows
    const rows = await env.D1_DB.prepare('SELECT id, storage_key FROM files WHERE deleted_at IS NOT NULL').all();
    for (const f of (rows.results || [])) {
      try {
        if (f.storage_key) {
          const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=?').bind(f.storage_key).first();
          if (!ref || (ref.c || 0) <= 1) { try { await env.R2_BUCKET.delete(f.storage_key); } catch (e) {} }
        }
        // Also delete from random_pool and user_uploads
        await env.D1_DB.prepare('DELETE FROM random_pool WHERE url = ?').bind('/file/tg/' + f.id).run();
        await env.D1_DB.prepare('UPDATE user_uploads SET deleted_at = ? WHERE url = ?').bind(now, '/file/tg/' + f.id).run();
        const r = await env.D1_DB.prepare('DELETE FROM files WHERE id=?').bind(f.id).run();
        if (r.meta && r.meta.changes) deleted++;
      } catch (e) {}
    }
    invalidateStatsCache();
    return json({ ok: true, deleted: deleted, message: 'Purged ' + deleted + ' file(s)' });
  }
  const list = ids ? ids.split(',').map(function(s){return s.trim();}).filter(Boolean) : [id];
  for (const one of list) {
    try {
      if (purge) {
        // Hard delete from trash: remove the R2 object (last reference only) then the row
        const f = await env.D1_DB.prepare('SELECT storage_key FROM files WHERE id=?').bind(one).first();
        if (f?.storage_key) {
          const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=?').bind(f.storage_key).first();
          if (!ref || (ref.c || 0) <= 1) { try { await env.R2_BUCKET.delete(f.storage_key); } catch (e) {} }
        }
        // Also delete from random_pool and user_uploads
        await env.D1_DB.prepare('DELETE FROM random_pool WHERE url = ?').bind('/file/tg/' + one).run();
        await env.D1_DB.prepare('UPDATE user_uploads SET deleted_at = ? WHERE url = ?').bind(now, '/file/tg/' + one).run();
        const r = await env.D1_DB.prepare('DELETE FROM files WHERE id=?').bind(one).run();
        if (r.meta && r.meta.changes) deleted++;
      } else {
        // Soft delete from files
        const r = await env.D1_DB.prepare('UPDATE files SET deleted_at=? WHERE id=? AND deleted_at IS NULL').bind(now, one).run();
        if (r.meta && r.meta.changes) {
          deleted++;
          // Also soft-delete from random_pool and user_uploads
          await env.D1_DB.prepare('DELETE FROM random_pool WHERE url = ?').bind('/file/tg/' + one).run();
          await env.D1_DB.prepare('UPDATE user_uploads SET deleted_at = ? WHERE url = ?').bind(now, '/file/tg/' + one).run();
        }
      }
      // await 保证 webhook 通知在响应返回前发出（fire-and-forget 会被 Worker 冻结丢弃）
      await fireWebhook(env, 'file_deleted', { id: one, deleted: !purge, source: 'files' }).catch(function(){});
    } catch (e) {}
  }
  invalidateStatsCache();
  return json({ ok: true, deleted: deleted, message: (purge ? 'Purged ' : 'Deleted ') + deleted + ' file(s)' });
}

// Trash list: rows marked deleted_at, newest first
export async function handleTrashList(request, env) {
  const u = new URL(request.url);
  const pg = clampInt(u.searchParams.get('page') || '1', 1, 1);
  const ps = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100);
  const off = (pg - 1) * ps;
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM files WHERE deleted_at IS NOT NULL').first();
    const d = await env.D1_DB.prepare('SELECT id, file_name, file_type, file_size, chat_title, created_at, deleted_at, r2_url FROM files WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ? OFFSET ?').bind(ps, off).all();
    return json({ ok: true, data: { total: t?.total || 0, page: pg, page_size: ps, total_pages: Math.ceil((t?.total || 0) / ps), items: d.results || [] } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// Restore: clear deleted_at so the file is visible again
export async function handleTrashRestore(request, env) {
  const b = await request.json().catch(function(){ return null; });
  // 请求体缺失/无效一律 400，避免误触"恢复全部"；只有显式传 {"ids":[]} 才恢复全部
  if (!b || !Array.isArray(b.ids)) {
    return json({ ok: false, error: 'ids 必填（数组）；如需恢复全部请显式传 {"ids":[]}' }, 400);
  }
  const ids = b.ids.map(String);
  let restored = 0;
  if (!ids.length) {
    // Empty ids -> restore everything
    try {
      const r = await env.D1_DB.prepare('UPDATE files SET deleted_at=NULL WHERE deleted_at IS NOT NULL').run();
      restored = (r.meta && r.meta.changes) || 0;
    } catch (e) {}
    return json({ ok: true, restored: restored, message: 'Restored ' + restored + ' file(s)' });
  }
  for (const one of ids) {
    try {
      const r = await env.D1_DB.prepare('UPDATE files SET deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL').bind(one).run();
      if (r.meta && r.meta.changes) restored++;
    } catch (e) {}
  }
  return json({ ok: true, restored: restored, message: 'Restored ' + restored + ' file(s)' });
}

// Collect every object key that is still referenced by D1:
// - files.storage_key (including soft-deleted rows: their objects still live)
// - thumbnails referenced via files.thumb_url (stored as <public_url>/<key>)
// - the admin.html static page served from the same bucket
export async function collectReferencedKeys(db) {
  const refs = new Set(['admin.html']);
  let lastId = 0;
  while (true) {
    const rows = await db.prepare('SELECT id, storage_key, thumb_url FROM files WHERE id > ? ORDER BY id LIMIT 5000').bind(lastId).all();
    const res = rows.results || [];
    if (!res.length) break;
    for (const x of res) {
      if (x.storage_key) refs.add(x.storage_key);
      if (x.thumb_url && x.thumb_url.indexOf('/') >= 0) {
        // thumb_url 存的是 <public_url>/thumbs/xxx.webp（或相对 /thumbs/xxx.webp），
        // 需还原 R2 对象 key（thumbs/xxx.webp），否则缩略图会被误判为孤儿
        let tk = x.thumb_url.replace(/^https?:\/\/[^/]+\//, '');
        if (tk.indexOf('/') === 0) tk = tk.slice(1);
        if (tk) refs.add(tk);
      }
    }
    lastId = res[res.length - 1].id;
  }
  return refs;
}

// R2 文件浏览 / 删除（对象级管理）
// - 仅允许删除"孤儿"对象（D1 无引用且非站点静态页/备份），避免删到正被引用的文件
// - 列表数据单次 R2 list 返回，引用标注基于 D1 引用集（20s 缓存），避免每次刷新全表扫
const R2_STATIC_PAGE_KEYS = ['admin.html', 'admin-guide.html', 'user.html', 'user-manage.html', 'docs.js'];
let r2refCache = { at: 0, refs: null };

async function r2Refs(env) {
  const now = Date.now();
  if (r2refCache.refs && now - r2refCache.at < 20000) return r2refCache.refs;
  const refs = await collectReferencedKeys(env.D1_DB);
  r2refCache = { at: now, refs };
  return refs;
}

function r2KeyState(key, refs) {
  if (R2_STATIC_PAGE_KEYS.indexOf(key) !== -1) return 'page';
  if (key.indexOf('backups/') === 0) return 'backup';
  if (refs && refs.has(key)) return 'used';
  return 'orphan';
}

export async function handleR2List(request, env) {
  try {
    const u = new URL(request.url);
    const limit = clampInt(u.searchParams.get('limit') || '200', 200, 10, 1000);
    const prefix = u.searchParams.get('prefix') || '';
    const cursor = u.searchParams.get('cursor') || undefined;
    const opts = { limit: limit, prefix: prefix };
    if (cursor) opts.cursor = cursor;
    const list = await env.R2_BUCKET.list(opts);
    const refs = await r2Refs(env);
    const objects = (list.objects || []).map(function(o) {
      return {
        key: o.key,
        size: o.size,
        uploaded: o.uploaded,
        state: r2KeyState(o.key, refs),
        public_url: env.R2_PUBLIC_URL ? env.R2_PUBLIC_URL + '/' + o.key : ''
      };
    });
    return json({ ok: true, data: {
      prefix: prefix,
      truncated: !!list.truncated,
      cursor: list.truncated ? list.cursor : null,
      objects_count: objects.length,
      objects: objects,
      refs_count: refs.size,
      public_base: env.R2_PUBLIC_URL || '',
      static_pages: R2_STATIC_PAGE_KEYS
    } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleR2Delete(request, env) {
  try {
    const body = await request.json();
    const keys = Array.isArray(body && body.keys) ? body.keys.slice(0, 100) : [];
    if (!keys.length) return json({ ok: false, error: 'No keys' }, 400);
    const refs = await r2Refs(env);
    const deleted = [];
    const refused = [];
    for (const k of keys) {
      const st = r2KeyState(k, refs);
      if (st !== 'orphan') { refused.push({ key: k, state: st }); continue; }
      try { await env.R2_BUCKET.delete(k); deleted.push(k); }
      catch (e) { refused.push({ key: k, error: e.message }); }
    }
    r2refCache = { at: 0, refs: null };
    return json({ ok: true, data: { deleted: deleted, refused: refused } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// R2 orphan inspection: walk the bucket, list objects with no D1 reference.
// Read-only. max= limits how many objects are scanned per call (CPU budget).
export async function handleR2Inspect(request, env) {
  try {
    const u = new URL(request.url);
    const maxObjects = clampInt(u.searchParams.get('max') || '50000', 50000, 1000, 200000);
    const refs = await collectReferencedKeys(env.D1_DB);
    const orphans = [];
    let scanned = 0;
    let cursor = null;
    while (scanned < maxObjects) {
      const list = cursor ? await env.R2_BUCKET.list({ limit: 1000, cursor: cursor }) : await env.R2_BUCKET.list({ limit: 1000 });
      const objs = list.objects || [];
      if (!objs.length) break;
      for (const o of objs) {
        scanned++;
        if (!refs.has(o.key)) orphans.push({ key: o.key, size: o.size, uploaded: o.uploaded });
      }
      if (!list.truncated) break;
      cursor = list.cursor;
    }
    return json({ ok: true, data: { referenced: refs.size, objects_scanned: scanned, orphan_count: orphans.length, orphans: orphans.slice(0, 2000) } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// R2 orphan cleanup: idempotent re-scan + delete every unreferenced object
export async function handleR2Cleanup(env) {
  try {
    const refs = await collectReferencedKeys(env.D1_DB);
    let deleted = 0;
    let cursor = null;
    while (true) {
      const list = cursor ? await env.R2_BUCKET.list({ limit: 1000, cursor: cursor }) : await env.R2_BUCKET.list({ limit: 1000 });
      const objs = list.objects || [];
      if (!objs.length) break;
      for (const o of objs) {
        if (!refs.has(o.key)) {
          try { await env.R2_BUCKET.delete(o.key); deleted++; } catch (e) {}
        }
      }
      if (!list.truncated) break;
      cursor = list.cursor;
    }
    return json({ ok: true, data: { deleted: deleted } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 历史数据修正：早期用 Telegram 下载响应头（application/octet-stream）写入 R2，
// 导致 mp4 直链在浏览器触发下载而非内嵌播放。R2 无法原地改 metadata，
// 只能重新写入对象（body 原样、httpMetadata 用按 key 推断的正确 MIME）。
// 用法：POST /admin/api/r2/fix-mime?limit=50&before_id=xxx
//   limit      本次处理对象数上限（默认 50，防止单请求超预算）
//   before_id  断点续传（只处理 files.id < before_id 的行）
// 返回 remaining：剩余待修数量，>0 时用返回的 last_id 再调一轮。
export async function handleR2FixMime(request, env) {
  try {
    if (!env.R2_BUCKET) return json({ ok: false, error: 'no r2' }, 500);
    const u = new URL(request.url);
    const limit = clampInt(u.searchParams.get('limit') || '50', 50, 1, 200);
    const beforeId = clampInt(u.searchParams.get('before_id') || '0', 0, 0);
    // 只处理存在真实 R2 直链的视频/音频/图片记录（storage_key 非空）
    const cond = "storage_key IS NOT NULL AND storage_key != '' AND r2_url != '' AND r2_url NOT LIKE '/file/tg/%' AND deleted_at IS NULL" + (beforeId ? ' AND id < ?' : '');
    const params = beforeId ? [beforeId, limit] : [limit];
    const rows = await env.D1_DB.prepare(
      'SELECT id, storage_key, r2_url, mime_type FROM files WHERE ' + cond + ' ORDER BY id DESC LIMIT ?'
    ).bind(...params).all();
    const list = rows.results || [];
    let fixed = 0, skipped = 0, failed = 0;
    const seen = new Set();
    // 批次按 id 倒序取 limit 条；续传游标取本批最小 id，确保每轮只处理未扫过的行
    const lastId = list.length ? list[list.length - 1].id : 0;
    for (const r of list) {
      if (!r.storage_key || seen.has(r.storage_key)) { continue; }
      seen.add(r.storage_key);
      const want = mimeForStorageKey(r.storage_key, 'application/octet-stream');
      if (!want || want === 'application/octet-stream') { skipped++; continue; }
      try {
        const head = await env.R2_BUCKET.head(r.storage_key);
        if (!head) { skipped++; continue; }
        const cur = String(head.httpMetadata && head.httpMetadata.contentType || '').split(';')[0].trim().toLowerCase();
        if (cur === want.split(';')[0].trim().toLowerCase()) { skipped++; continue; }
        const obj = await env.R2_BUCKET.get(r.storage_key);
        if (!obj) { skipped++; continue; }
        await env.R2_BUCKET.put(r.storage_key, obj.body, { httpMetadata: { contentType: want, cacheControl: 'public, max-age=31536000' } });
        bumpR2Usage(env, 'r2_class_a');
        // 同步 D1 mime_type，保证 /file/tg/ 代理头与列表展示一致
        await env.D1_DB.prepare("UPDATE files SET mime_type=? WHERE storage_key=?").bind(want, r.storage_key).run().catch(function(){});
        fixed++;
      } catch (e) { failed++; console.log('r2 fix-mime fail:', r.storage_key, e.message); }
    }
    // 统计剩余待修对象数（与本次扫描同源，用于指示是否已全部处理完）
    let remaining = 0;
    try {
      const c = await env.D1_DB.prepare(
        'SELECT COUNT(DISTINCT storage_key) as c FROM files WHERE ' + cond
      ).bind(...(beforeId ? [beforeId] : [])).first();
      remaining = (c && c.c) || 0;
    } catch (e) {}
    return json({ ok: true, data: { scanned: list.length, fixed: fixed, skipped: skipped, failed: failed, last_id: lastId, remaining: remaining, done: remaining === 0 } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleListBots(env) {
  try {
    const bots = [];
    if (env.TG_BOT_TOKEN) {
      const ctrl = new AbortController();
      const timer = setTimeout(function() { ctrl.abort(); }, 10000);
      try {
        const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getMe', { signal: ctrl.signal });
        const j = await r.json();
        if (j.ok) bots.push({ username: j.result.username, name: j.result.first_name, id: j.result.id });
      } catch (e) { bots.push({ username: '(bot offline)', name: '', id: '' }); }
      finally { clearTimeout(timer); }
    }
    return json({ ok: true, data: bots });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAddBot(request, env) {
  return json({ ok: false, error: 'Bot management via env variables. Set TG_BOT_TOKEN in Worker settings.' });
}

export async function handleRemoveBot(request, env) {
  return json({ ok: false, error: 'Bot management via env variables.' });
}

export async function handleGetConfig(env) {
  const config = {
    bot_token_set: !!env.TG_BOT_TOKEN,
    api_key_set: !!env.API_KEY,
    r2_public_url: env.R2_PUBLIC_URL || '',
    tg_secret_set: !!env.TG_SECRET,
  };
  if (env.TG_BOT_TOKEN) {
    try {
      const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getMe');
      const j = await r.json();
      if (j.ok) { config.bot_username = j.result.username; config.bot_name = j.result.first_name; }
    } catch (e) {}
  }
  return json({ ok: true, data: config });
}

export async function handleSetConfig(request, env) {
  return json({ ok: false, error: 'Config is set via Worker environment variables in CF Dashboard.' });
}

export async function handleBotGetMeApi(env) {
  if (!env.TG_BOT_TOKEN) return json({ ok: false, error: 'Bot token not set' });
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getMe');
    const j = await r.json();
    return json(j);
  } catch (e) { return json({ ok: false, error: e.message }); }
}

