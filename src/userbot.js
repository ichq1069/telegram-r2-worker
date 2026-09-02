// MTProto 群历史抓取：全局配置 + 每群任务 CRUD + 脚本侧拉配置/回写断点
// 设计：worker 当「控制面」（配置/断点/图片入库全存 Cloudflare），Telethon 脚本在
// 本地/VPS/Containers 上跑，但参数全部从后台拉取，换机无感。
// 相册数据走 Hyperdrive MySQL（VPS），settings/tasks 走 D1。
import { json } from './util.js';
import { sanitizeLevel, clampInt } from './core.js';
import {
  mysqlTaskGetById, mysqlTaskGetAll, mysqlTaskCreate, mysqlTaskUpdate, mysqlTaskDelete,
  mysqlAlbumsGetByTask, mysqlAlbumsGetGroupedIds, mysqlAlbumsGetSizes, mysqlAlbumsDeleteByTask,
  mysqlAlbumsInsertBatch, mysqlAlbumsSelectMsgIds
} from './mysql.js';

// 相册模式 / 选择抓取 / 大文件流式上传 的常量与辅助
export const UPLOAD_HARD_MAX = 90 * 1024 * 1024;      // 流式上传硬上限（与 public.js 一致）
export const UPLOAD_SMALL_MAX = 19 * 1024 * 1024;      // 既有 multipart 路径上限（与 public.js 一致）
export const ALBUM_SCAN_LIMIT = 2000;                  // 列表模式默认枚举消息条数
export const ALBUM_MAX_PER_POST = 500;                 // 单次相册上报上限（超出分片）

function taskToOut(t) {
  return {
    id: t.id, chat_id: t.chat_id, title: t.title, tags: t.tags, pool: t.pool, level: t.level,
    max_size: t.max_size, limit: t.limit, enabled: t.enabled, last_id: t.last_id,
    done: t.done, skipped: t.skipped, note: t.note,
    mode: t.mode || 'normal', selected_msg_ids: t.selected_msg_ids || '', scan_limit: t.scan_limit || ALBUM_SCAN_LIMIT, album_cursor: Number(t.album_cursor) || 0, scan_progress: t.scan_progress || ''
  };
}

function parseSelectedIds(str, max) {
  const arr = String(str || '').split(',').map(function(x) { return x.trim(); }).filter(function(x) { return /^\d+$/.test(x); });
  const uniq = [];
  const seen = {};
  arr.forEach(function(x) { if (!seen[x]) { seen[x] = 1; uniq.push(x); } });
  if (max) uniq.length = Math.min(uniq.length, max);
  return uniq;
}

// ---------------- 全局配置（settings 表，admin 可读写） ----------------
const CFG_KEYS = ['ub_api_id', 'ub_api_hash', 'ub_session', 'ub_token', 'ub_api_key'];

export async function handleAdminUserbotConfig(env) {
  try {
    const d = await env.D1_DB.prepare('SELECT key,value FROM settings WHERE key IN (?,?,?,?,?)').bind(...CFG_KEYS).all();
    const out = { api_id: '', api_hash: '', session: '', token: '', api_key: '' };
    (d.results || []).forEach(function(r) {
      if (r.key === 'ub_api_id') out.api_id = r.value || '';
      else if (r.key === 'ub_api_hash') out.api_hash = r.value || '';
      else if (r.key === 'ub_session') out.session = r.value || '';
      else if (r.key === 'ub_token') out.token = r.value || '';
      else if (r.key === 'ub_api_key') out.api_key = r.value || '';
    });
    return json({ ok: true, data: out });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminUserbotConfigSave(request, env) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const set = function(k, v) {
      return env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(k, v).run();
    };
    if (b.api_id !== undefined) await set('ub_api_id', String(b.api_id).trim());
    if (b.api_hash !== undefined && String(b.api_hash).trim()) await set('ub_api_hash', String(b.api_hash).trim());
    if (b.session !== undefined && String(b.session).trim()) await set('ub_session', String(b.session).trim());
    if (b.api_key !== undefined && String(b.api_key).trim()) await set('ub_api_key', String(b.api_key).trim());
    if (b.reset_token) {
      const tok = genUserbotToken();
      await set('ub_token', tok);
      return json({ ok: true, data: { saved: true, new_token: tok } });
    }
    return json({ ok: true, data: { saved: true } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

function genUserbotToken() {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  for (let i = 0; i < b.length; i++) r += c[b[i] % c.length];
  return 'ub_' + r;
}

// ---------------- 每群任务 CRUD（admin） ----------------
export async function handleAdminUserbotTasks(env) {
  try {
    const d = await env.D1_DB.prepare('SELECT * FROM userbot_tasks ORDER BY id DESC').all();
    return json({ ok: true, data: (d.results || []).map(taskToOut) });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminUserbotTaskCreate(request, env) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const chatId = String(b.chat_id || '').trim();
    if (!chatId) return json({ ok: false, error: 'chat_id 必填' }, 400);
    const now = new Date().toISOString();
    const r = await env.D1_DB.prepare('INSERT INTO userbot_tasks (chat_id,title,tags,pool,level,max_size,"limit",enabled,last_id,note,mode,selected_msg_ids,scan_limit,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(chatId, String(b.title || '').slice(0, 200), String(b.tags || '').slice(0, 500), b.pool ? 1 : 0, sanitizeLevel(b.level), clampInt(b.max_size, 0, 0, UPLOAD_HARD_MAX), clampInt(b.limit, 0, 0, 1000000), b.enabled === undefined || b.enabled ? 1 : 0, clampInt(b.last_id, 0, 0, 9000000000000000000), String(b.note || '').slice(0, 500), 'normal', '', clampInt(b.scan_limit, 0, 100, 100000) || ALBUM_SCAN_LIMIT, now, now).run();
    return json({ ok: true, data: { id: r.meta?.last_row_id || 0 } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminUserbotTaskUpdate(request, env, id) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const set = [];
    const vals = [];
    const col = function(k, v) { set.push(k + '=?'); vals.push(v); };
    if (b.chat_id !== undefined) col('chat_id', String(b.chat_id).trim());
    if (b.title !== undefined) col('title', String(b.title).slice(0, 200));
    if (b.tags !== undefined) col('tags', String(b.tags).slice(0, 500));
    if (b.pool !== undefined) col('pool', b.pool ? 1 : 0);
    if (b.level !== undefined) col('level', sanitizeLevel(b.level));
    if (b.max_size !== undefined) col('max_size', clampInt(b.max_size, 0, 0, UPLOAD_HARD_MAX));
    if (b.limit !== undefined) col('"limit"', clampInt(b.limit, 0, 0, 1000000));
    if (b.enabled !== undefined) col('enabled', b.enabled ? 1 : 0);
    if (b.last_id !== undefined) col('last_id', clampInt(b.last_id, 0, 0, 9000000000000000000));
    if (b.note !== undefined) col('note', String(b.note).slice(0, 500));
    if (b.scan_limit !== undefined) col('scan_limit', clampInt(b.scan_limit, 0, 100, 100000));
    if (b.mode !== undefined) col('mode', ['normal', 'list', 'selected'].indexOf(b.mode) !== -1 ? b.mode : 'normal');
    if (b.selected_msg_ids !== undefined) col('selected_msg_ids', parseSelectedIds(b.selected_msg_ids, 5000).join(','));
    if (set.length === 0) return json({ ok: true, data: { updated: false } });
    set.push('updated_at=?');
    vals.push(new Date().toISOString());
    await env.D1_DB.prepare('UPDATE userbot_tasks SET ' + set.join(',') + ' WHERE id=?').bind(...vals, id).run();
    return json({ ok: true, data: { updated: true } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminUserbotTaskDelete(env, id) {
  try {
    await env.D1_DB.prepare('DELETE FROM userbot_tasks WHERE id=?').bind(id).run();
    try { await mysqlAlbumsDeleteByTask(env, id); } catch (e) { /* MySQL 可能未配置 */ }
    return json({ ok: true, data: { deleted: true } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ---------------- 脚本侧：拉任务配置 + 回写断点（ub_token 鉴权） ----------------
// 供 Telethon 脚本在 VPS/Containers 上调用：拿到该任务的完整参数 + 全局 api_id/api_hash/session。
// 用专用 ub_token（存 settings）鉴权，避免脚本持有 admin API_KEY。
export async function handleUserbotTaskConfig(request, env, id) {
  try {
    const u = new URL(request.url);
    const tok = u.searchParams.get('token') || request.headers.get('X-Ub-Token') || '';
    const cfg = await env.D1_DB.prepare('SELECT value FROM settings WHERE key=?').bind('ub_token').first();
    if (!tok || !cfg || !cfg.value || tok !== cfg.value) return json({ ok: false, error: 'Unauthorized' }, 401);
    const g = await env.D1_DB.prepare('SELECT key,value FROM settings WHERE key IN (?,?,?,?)').bind('ub_api_id', 'ub_api_hash', 'ub_session', 'ub_api_key').all();
    const gcfg = { api_id: '', api_hash: '', session: '', api_key: '' };
    (g.results || []).forEach(function(r) {
      if (r.key === 'ub_api_id') gcfg.api_id = r.value || '';
      else if (r.key === 'ub_api_hash') gcfg.api_hash = r.value || '';
      else if (r.key === 'ub_session') gcfg.session = r.value || '';
      else if (r.key === 'ub_api_key') gcfg.api_key = r.value || '';
    });
    const t = await env.D1_DB.prepare('SELECT * FROM userbot_tasks WHERE id=?').bind(id).first();
    if (!t) return json({ ok: false, error: 'task not found' }, 404);
    return json({ ok: true, data: {
      task: taskToOut(t),
      global: Object.assign(gcfg, { upload_small_max: UPLOAD_SMALL_MAX, upload_hard_max: UPLOAD_HARD_MAX, album_scan_limit: ALBUM_SCAN_LIMIT })
    } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 脚本每处理完一批，回写断点（last_id 向更早翻，取当前任务已处理的最小 id）
export async function handleUserbotTaskProgress(request, env, id) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const u = new URL(request.url);
    const tok = u.searchParams.get('token') || request.headers.get('X-Ub-Token') || '';
    const cfg = await env.D1_DB.prepare('SELECT value FROM settings WHERE key=?').bind('ub_token').first();
    if (!tok || !cfg || !cfg.value || tok !== cfg.value) return json({ ok: false, error: 'Unauthorized' }, 401);
    const lastId = clampInt(b.last_id, 0, 0, 9000000000000000000);
    const done = clampInt(b.done, 0, 0, 1000000000);
    const skipped = clampInt(b.skipped, 0, 0, 1000000000);
    const scanProgress = b.scan_progress !== undefined ? String(b.scan_progress).slice(0, 1000) : undefined;
    const sets = ['last_id=?', 'done=?', 'skipped=?', 'updated_at=?'];
    const vals = [lastId, done, skipped, new Date().toISOString()];
    if (scanProgress !== undefined) { sets.push('scan_progress=?'); vals.push(scanProgress); }
    // scan_progress phase=done 时把 mode 从 list 改回 normal，让前端停止轮询并加载相册数据
    if (scanProgress && scanProgress.indexOf('"done"') !== -1) {
      sets.push("mode='normal'");
    }
    vals.push(id);
    await env.D1_DB.prepare('UPDATE userbot_tasks SET ' + sets.join(', ') + ' WHERE id=?').bind(...vals).run();
    return json({ ok: true, data: { saved: true } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== 相册管理（D1 主 + MySQL 备，双写双读） ====================
// 写：D1 必写（主），MySQL 尽力同步（备）——数据实时同步
// 读：D1 优先；D1 异常（限额/故障）自动回退 MySQL——任一端不可用时另一端仍可读

// 规范化 sizes 数组（补全 thumb_url，file_id 截断）
function normSizes(sizes) {
  return (Array.isArray(sizes) ? sizes : []).map(function(s) {
    const fid = String(s.file_id || '').slice(0, 200);
    return {
      id: Number(s.id) || 0, size: Number(s.size) || 0, w: Number(s.w) || 0, h: Number(s.h) || 0,
      thumb_url: String(s.thumb_url || '').slice(0, 500) || (fid ? '/api/tg-proxy?file_id=' + fid : ''),
      type: String(s.type || 'photo'), duration: Number(s.duration) || 0, file_id: fid
    };
  }).slice(0, 500);
}

// 规范化上报的相册行（D1 + MySQL 共用）
function buildAlbumRows(albums, taskId) {
  const out = [];
  for (const a of (albums || [])) {
    const gid = String(a.grouped_id || '').slice(0, 64);
    if (!gid) continue;
    const msgIds = (Array.isArray(a.msg_ids) ? a.msg_ids : []).filter(function(x) { return /^\d+$/.test(String(x)); }).slice(0, 500);
    if (!msgIds.length) continue;
    out.push({
      task_id: Number(taskId) || 0,
      grouped_id: gid,
      msg_ids: msgIds,
      msg_ids_str: msgIds.join(','),
      mcount: msgIds.length,
      sizes: JSON.stringify(normSizes(a.sizes)),
      cover_url: String(a.cover_url || '').slice(0, 500),
      first_ts: Number(a.first_ts) || 0,
      has_oversize: a.has_oversize ? 1 : 0
    });
  }
  return out;
}

// 写 D1（主）：INSERT OR IGNORE 避免重复浪费额度
async function d1WriteAlbums(env, id, rows, append) {
  if (!rows.length) return 0;
  if (!append) await env.D1_DB.prepare('DELETE FROM ubot_albums WHERE task_id=?').bind(id).run();
  const now = new Date().toISOString();
  const stmt = env.D1_DB.prepare('INSERT OR IGNORE INTO ubot_albums (task_id, grouped_id, msg_ids, count, sizes, cover_url, first_ts, has_oversize, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
  const batch = rows.map(function(r) {
    return stmt.bind(id, r.grouped_id, r.msg_ids_str, r.mcount, r.sizes, r.cover_url, r.first_ts, r.has_oversize, now);
  });
  if (batch.length) await env.D1_DB.batch(batch);
  return batch.length;
}

// 写 MySQL（备）：尽力而为，失败静默（不阻塞主写入）
async function mysqlWriteAlbums(env, id, rows, append) {
  try {
    if (!append) await mysqlAlbumsDeleteByTask(env, id);
    const r = await mysqlAlbumsInsertBatch(env, rows);
    return r.stored;
  } catch (e) { return 0; }
}

// 读相册：D1 优先，失败回退 MySQL
async function readAlbums(env, id) {
  try {
    const d = await env.D1_DB.prepare('SELECT * FROM ubot_albums WHERE task_id=? ORDER BY first_ts DESC, id ASC').bind(id).all();
    return { source: 'd1', rows: (d.results || []) };
  } catch (e) {
    try { return { source: 'mysql', rows: await mysqlAlbumsGetByTask(env, id) }; }
    catch (e2) { return { source: 'none', rows: [] }; }
  }
}

// 读 grouped_ids：D1 优先，失败回退 MySQL（去重用）
async function readGroupedIds(env, id) {
  try {
    const d = await env.D1_DB.prepare('SELECT grouped_id FROM ubot_albums WHERE task_id=? LIMIT 50000').bind(id).all();
    return (d.results || []).map(function(r) { return r.grouped_id; });
  } catch (e) {
    try { return await mysqlAlbumsGetGroupedIds(env, id); } catch (e2) { return []; }
  }
}

// 读 sizes 全表：D1 优先，失败回退 MySQL（file-id-map 用）
async function readSizesRows(env, id) {
  try {
    const d = await env.D1_DB.prepare('SELECT sizes FROM ubot_albums WHERE task_id=?').bind(id).all();
    return (d.results || []);
  } catch (e) {
    try { return await mysqlAlbumsGetSizes(env, id); } catch (e2) { return []; }
  }
}

// 读 allowed msg_ids：D1 优先，失败回退 MySQL（select 校验用）
async function readAllowedMsgIds(env, id) {
  try {
    const d = await env.D1_DB.prepare('SELECT msg_ids FROM ubot_albums WHERE task_id=?').bind(id).all();
    const allowed = {};
    (d.results || []).forEach(function(a) {
      String(a.msg_ids || '').split(',').filter(Boolean).forEach(function(m) { allowed[m] = 1; });
    });
    return allowed;
  } catch (e) {
    try { return await mysqlAlbumsSelectMsgIds(env, id); } catch (e2) { return {}; }
  }
}

// 清空相册：D1 + MySQL 都删
async function clearAlbumsBoth(env, id) {
  try { await env.D1_DB.prepare('DELETE FROM ubot_albums WHERE task_id=?').bind(id).run(); } catch (e) {}
  try { await mysqlAlbumsDeleteByTask(env, id); } catch (e) {}
}

// 管理侧：浏览相册触发列表模式 / 读缓存 / 保存勾选 / 触发选择抓取
export async function handleAdminUbotAlbumListAction(request, env, id) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const t = await env.D1_DB.prepare('SELECT * FROM userbot_tasks WHERE id=?').bind(id).first();
    if (!t) return json({ ok: false, error: 'task not found' }, 404);
    const scan = b.scan_limit ? clampInt(b.scan_limit, 100, 100000) : (t.scan_limit || ALBUM_SCAN_LIMIT);
    const before_id = parseInt(b.before_id || '0', 10);
    if (b.clear) await clearAlbumsBoth(env, id);
    if (!isNaN(before_id) && before_id > 0) {
      await env.D1_DB.prepare("UPDATE userbot_tasks SET mode='list', scan_limit=?, album_cursor=?, scan_progress='', updated_at=? WHERE id=?")
        .bind(scan, before_id, new Date().toISOString(), id).run();
    } else {
      await env.D1_DB.prepare("UPDATE userbot_tasks SET mode='list', scan_limit=?, album_cursor=0, scan_progress='', updated_at=? WHERE id=?")
        .bind(scan, new Date().toISOString(), id).run();
    }
    return json({ ok: true, data: { triggered: true, scan_limit: scan, before_id: before_id || 0, cleared: !!b.clear } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminUbotAlbumsGet(env, id) {
  try {
    let t = null;
    try { t = await env.D1_DB.prepare('SELECT * FROM userbot_tasks WHERE id=?').bind(id).first(); } catch (e) { /* D1 异常回退 */ }
    const res = await readAlbums(env, id);
    // D1 正常且任务不存在才 404；D1 异常时用 MySQL 数据继续服务
    if (!t && res.source !== 'mysql') return json({ ok: false, error: 'task not found' }, 404);
    const selected = new Set(parseSelectedIds(t ? t.selected_msg_ids : '', 5000));
    const albums = res.rows.map(function(a) {
      let sizes = [];
      try { sizes = JSON.parse(a.sizes || '[]'); } catch (e) { sizes = []; }
      return { id: a.id, grouped_id: a.grouped_id, msg_ids: (a.msg_ids || '').split(',').filter(Boolean), count: a.mcount || a.count || 0, sizes: sizes.map(function(s) { return { id: Number(s.id) || 0, size: Number(s.size) || 0, w: Number(s.w) || 0, h: Number(s.h) || 0, thumb_url: s.thumb_url || (s.file_id ? '/api/tg-proxy?file_id=' + s.file_id : ''), sel: selected.has(String(s.id)), type: s.type || 'photo', duration: Number(s.duration) || 0, file_id: s.file_id || '' }; }), cover_url: a.cover_url || (sizes[0] && sizes[0].file_id ? '/api/tg-proxy?file_id=' + sizes[0].file_id : ''), first_ts: a.first_ts, has_oversize: a.has_oversize, selected: sizes.filter(function(s){ return selected.has(String(s.id)); }).length > 0 };
    });
    return json({ ok: true, data: { task: t ? taskToOut(t) : { id: Number(id) }, albums: albums, source: res.source } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 脚本侧：获取已有相册的 grouped_id 列表（用于去重，避免重复写入浪费额度）
export async function handleUbotAlbumsExisting(request, env, id) {
  try {
    const u = new URL(request.url);
    const tok = u.searchParams.get('token') || '';
    const cfg = await env.D1_DB.prepare('SELECT value FROM settings WHERE key=?').bind('ub_token').first();
    if (!tok || !cfg || !cfg.value || tok !== cfg.value) return json({ ok: false, error: 'Unauthorized' }, 401);
    const gids = await readGroupedIds(env, id);
    return json({ ok: true, data: { grouped_ids: gids, total: gids.length } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminUbotAlbumsSelect(request, env, id) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const t = await env.D1_DB.prepare('SELECT * FROM userbot_tasks WHERE id=?').bind(id).first();
    if (!t) return json({ ok: false, error: 'task not found' }, 404);
    const allowed = await readAllowedMsgIds(env, id);
    const want = parseSelectedIds(b.msg_ids, 5000);
    const valid = Object.keys(allowed).length ? want.filter(function(m) { return allowed[m]; }) : want;
    await env.D1_DB.prepare('UPDATE userbot_tasks SET selected_msg_ids=?, updated_at=? WHERE id=?')
      .bind(valid.join(','), new Date().toISOString(), id).run();
    return json({ ok: true, data: { saved: valid.length, invalid: want.length - valid.length } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminUbotAlbumsTrigger(request, env, id) {
  try {
    const t = await env.D1_DB.prepare('SELECT * FROM userbot_tasks WHERE id=?').bind(id).first();
    if (!t) return json({ ok: false, error: 'task not found' }, 404);
    const ids = parseSelectedIds(t.selected_msg_ids, 5000);
    if (!ids.length) return json({ ok: false, error: '选择集合为空：请先在相册列表中勾选并保存' }, 400);
    await env.D1_DB.prepare("UPDATE userbot_tasks SET mode='selected', updated_at=? WHERE id=?")
      .bind(new Date().toISOString(), id).run();
    return json({ ok: true, data: { triggered: true, selected: ids.length } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 脚本侧：批量上报相册元数据（ub_token 鉴权）；D1 主写 + MySQL 备写；完成后任务 mode 回到 normal
export async function handleUbotAlbumsReport(request, env, id) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const u = new URL(request.url);
    const tok = u.searchParams.get('token') || request.headers.get('X-Ub-Token') || '';
    const cfg = await env.D1_DB.prepare('SELECT value FROM settings WHERE key=?').bind('ub_token').first();
    if (!tok || !cfg || !cfg.value || tok !== cfg.value) return json({ ok: false, error: 'Unauthorized' }, 401);
    const t = await env.D1_DB.prepare('SELECT * FROM userbot_tasks WHERE id=?').bind(id).first();
    if (!t) return json({ ok: false, error: 'task not found' }, 404);
    const albums = Array.isArray(b.albums) ? b.albums : [];
    const append = b.append === 1 || b.append === '1';
    const cursor = parseInt(b.cursor || '0', 10);
    const rows = buildAlbumRows(albums, id);
    let d1Stored = 0, mysqlStored = 0;
    if (rows.length) {
      // 主：D1 必写（失败则本次上报整体失败，脚本重试）
      d1Stored = await d1WriteAlbums(env, id, rows, append);
      // 备：MySQL 尽力同步，失败不影响主写入
      mysqlStored = await mysqlWriteAlbums(env, id, rows, append);
    }
    await env.D1_DB.prepare("UPDATE userbot_tasks SET mode='normal', album_cursor=?, updated_at=? WHERE id=? AND mode='list'")
      .bind(cursor, new Date().toISOString(), id).run();
    return json({ ok: true, data: { stored: albums.length, d1: d1Stored, mysql: mysqlStored, mode: 'normal', cursor: cursor } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 脚本侧：获取选中消息的 file_id 映射（用于 selected 模式直接下载，避免重新扫描消息）
export async function handleUbotTaskFileIdMap(request, env, id) {
  try {
    const u = new URL(request.url);
    const tok = u.searchParams.get('token') || request.headers.get('X-Ub-Token') || '';
    const cfg = await env.D1_DB.prepare('SELECT value FROM settings WHERE key=?').bind('ub_token').first();
    if (!tok || !cfg || !cfg.value || tok !== cfg.value) return json({ ok: false, error: 'Unauthorized' }, 401);
    const t = await env.D1_DB.prepare('SELECT selected_msg_ids FROM userbot_tasks WHERE id=?').bind(id).first();
    if (!t) return json({ ok: false, error: 'task not found' }, 404);
    const selected = new Set(parseSelectedIds(t.selected_msg_ids, 5000));
    if (!selected.size) return json({ ok: true, data: {} });
    const rows = await readSizesRows(env, id);
    const fileIdMap = {};
    rows.forEach(function(a) {
      try {
        JSON.parse(a.sizes || '[]').forEach(function(s) {
          if (selected.has(String(s.id)) && s.file_id) {
            fileIdMap[s.id] = s.file_id;
          }
        });
      } catch (e) { /* ignore */ }
    });
    return json({ ok: true, data: fileIdMap });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
