// ==================== API HANDLERS ====================
// /file/tg/<id> 302 重定向/代理、文件列表/详情/统计、代理模式与代理直链开关。
import { json, fmtSize, genHash, cacheGet, cacheSet } from "./util.js";
import { clampInt, cnDayIso, cnTodayStr, guessExt, fileExtOf } from "./core.js";
import { fileTok, putR2 } from "./telegram.js";
import { appendTagFilter } from "./public.js";


// /file/tg/<id> -> 302 redirect to official Telegram direct link (if present) else R2 URL.
// 校验 /file/tg/ 访问签名：支持两种格式
//   新格式（推荐，URL 以扩展名结尾）：/file/tg/<token>/<id>.jpg
//   旧格式兼容：/file/tg/<id>.jpg?k=<token>
export async function checkFileTok(request, id, env) {
  const u = new URL(request.url);
  let k = u.searchParams.get('k') || '';
  if (!k) {
    const rest = u.pathname.replace('/file/tg/', '');
    const segs = rest.split('/');
    if (segs.length === 2) k = segs[0];
  }
  const exp = await fileTok(id, env);
  return !!(k && exp && k === exp);
}

// Keeps the exposed URL clean (no bot token).
export async function handleTgFileRedirect(request, env, ctx) {
  if (!env.D1_DB) return json({ ok: false, error: 'no d1' }, 500);
  const u = new URL(request.url);
  // 路径格式：/file/tg/<token>/<id>.jpg（新）或 /file/tg/<id>.jpg（旧）
  const rest = u.pathname.replace('/file/tg/', '');
  const segs = rest.split('/');
  const idPart = segs.length === 2 ? segs[1] : rest;
  const id = parseInt(idPart, 10) || 0;
  if (!id) return json({ ok: false, error: 'bad id' }, 400);
  // 签名校验：防枚举遍历（改 id 数字无法访问他人图片），旧的无 token 链接一律 403
  if (!(await checkFileTok(request, id, env))) {
    return json({ ok: false, error: 'forbidden: 需要有效签名，请在后台重新复制链接' }, 403);
  }
  try {
    const f = await env.D1_DB.prepare('SELECT tg_file_url, r2_url, telegram_file_id, mime_type, file_name FROM files WHERE id=? AND deleted_at IS NULL').bind(id).first();
    if (!f) return json({ ok: false, error: 'not found' }, 404);
    // 真实 R2/外部直链：302（代理模式下 r2_url 存的是 /file/tg/<id> 自身，跳过不走 302）
    if (f.r2_url && f.r2_url.length > 0 && f.r2_url.indexOf('/file/tg/') !== 0 && f.r2_url.indexOf('//') >= 0) {
      env.D1_DB.prepare('UPDATE files SET view_count = view_count + 1 WHERE id=?').bind(id).run().catch(function(){});
      return new Response(null, { status: 302, headers: { 'Location': f.r2_url, 'Cache-Control': 'public, max-age=86400' } });
    }
    // 代理：优先官方 CDN 直链（tg_file_url，内部 fetch 透传不透出 token），否则实时 getFile 解析
    let dlUrl = (f.tg_file_url && f.tg_file_url.length > 0) ? f.tg_file_url : '';
    if (!dlUrl && f.telegram_file_id) {
      try {
        const gf = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getFile?file_id=' + encodeURIComponent(f.telegram_file_id));
        const gj = await gf.json();
        if (gj.ok && gj.result && gj.result.file_path) {
          dlUrl = 'https://api.telegram.org/file/bot' + env.TG_BOT_TOKEN + '/' + gj.result.file_path;
        }
      } catch (e) {}
    }
    if (dlUrl) {
      try {
        const origin = await fetch(dlUrl);
        if (!origin.ok) return json({ ok: false, error: 'origin http ' + origin.status }, 502);
        // 懒转存：返回给用户的同时，异步把文件落到 R2 并更新 D1 直链（之后访问直接走 R2，不再实时拉 TG）
        if (ctx && ctx.waitUntil && f.telegram_file_id) {
          ctx.waitUntil(lazyTransferToR2(env, id, f, dlUrl).catch(function(e) { console.error('lazy transfer:', e.message); }));
        }
        env.D1_DB.prepare('UPDATE files SET view_count = view_count + 1 WHERE id=?').bind(id).run().catch(function(){});
        return new Response(origin.body, { headers: {
          'Content-Type': f.mime_type || origin.headers.get('content-type') || 'application/octet-stream',
          'Cache-Control': 'public, max-age=300',
          'Access-Control-Allow-Origin': '*'
        } });
      } catch (e) { return json({ ok: false, error: 'proxy fail: ' + e.message }, 502); }
    }
    return json({ ok: false, error: 'no url' }, 404);
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 懒转存：代理模式的文件被访问过一次后，异步把文件落到 R2 并更新 D1 直链，
// 之后再访问直接 302 到 R2（秒开、永久），不再每次实时拉 Telegram
export async function lazyTransferToR2(env, id, f, dlUrl) {
  try {
    const cur = await env.D1_DB.prepare('SELECT r2_url FROM files WHERE id=? AND deleted_at IS NULL').bind(id).first();
    if (cur && cur.r2_url && cur.r2_url.length > 0 && cur.r2_url.indexOf('//') >= 0 && cur.r2_url.indexOf('/file/tg/') !== 0) return; // 已有真实 R2 直链
    const resp = await fetch(dlUrl);
    if (!resp.ok) return;
    const ct = f.mime_type || resp.headers.get('content-type') || 'application/octet-stream';
    const buf = await resp.arrayBuffer();
    if (!buf || buf.byteLength > 100 * 1024 * 1024) return; // 过大不懒转存（避免占满 worker 内存）
    const now = new Date();
    const dp = now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0');
    const key = dp + '/' + genHash() + '.' + guessExt(ct, f.file_name || '');
    const url = await putR2(key, buf, ct, env);
    if (!url) return;
    await env.D1_DB.prepare("UPDATE files SET storage_key=?, r2_url=?, processing_state='completed' WHERE id=?").bind(key, url, id).run();
  } catch (e) { console.error('lazyTransferToR2:', e.message); }
}

export async function handleFiles(request, env) {
  const u = new URL(request.url);
  const pg = clampInt(u.searchParams.get('page') || '1', 1, 1);
  const ps = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100);
  const tp = u.searchParams.get('type') || '';
  const ci = u.searchParams.get('chat_id') || '';
  const ui = u.searchParams.get('user_id') || '';
  const kw = u.searchParams.get('keyword') || '';
  const sd = u.searchParams.get('start_date') || '';
  const ed = u.searchParams.get('end_date') || '';
  const st = u.searchParams.get('state') || '';
  const tagsParam = u.searchParams.get('tags') || '';
  const ps2 = u.searchParams.get('pool_state') || '';
  const src = u.searchParams.get('source') || '';
  const off = (pg - 1) * ps;
  let w = 'WHERE f.deleted_at IS NULL'; const p = [];
  if (tp) { w += ' AND f.file_type=?'; p.push(tp); }
  if (ci) { w += ' AND f.chat_id=?'; p.push(ci); }
  if (ui) { w += ' AND f.user_id=?'; p.push(parseInt(ui)); }
  if (kw) { w += ' AND (f.file_name LIKE ? OR f.caption LIKE ? OR f.chat_title LIKE ? OR f.username LIKE ? OR f.group_ref LIKE ?)'; p.push('%' + kw + '%', '%' + kw + '%', '%' + kw + '%', '%' + kw + '%', '%' + kw + '%'); }
  if (sd) { w += ' AND f.created_at>=?'; p.push(sd); }
  if (ed) { w += ' AND f.created_at<=?'; p.push(ed + ' 23:59:59'); }
  if (st) { w += ' AND f.processing_state=?'; p.push(st); }
  if (tagsParam) { w = appendTagFilter(tagsParam, w, p, 'f.'); }
  // 来源筛选：r2=已入库 R2（storage_key 非空）；proxy=仅代理直链（未转存 R2）
  if (src === 'r2') { w += " AND f.storage_key != ''"; }
  else if (src === 'proxy') { w += " AND (f.r2_url IS NULL OR f.r2_url = '' OR f.r2_url LIKE '/file/tg/%')"; }
  if (ps2 === 'imported') { w += " AND EXISTS (SELECT 1 FROM random_pool rp WHERE rp.tg_file_id = f.id) AND (f.pool_status IS NULL OR f.pool_status != 'ignored')"; }
  else if (ps2 === 'ignored') { w += " AND f.pool_status = 'ignored'"; }
  else if (ps2 === 'pending') { w += " AND NOT EXISTS (SELECT 1 FROM random_pool rp WHERE rp.tg_file_id = f.id) AND (f.pool_status IS NULL OR f.pool_status != 'ignored')"; }
  // 未指定 pool_state：展示全部文件（含已入库/已忽略），由前端 pool_state 下拉显式筛选
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM files f ' + w).bind(...p).first();
    const d = await env.D1_DB.prepare("SELECT f.*, CASE WHEN f.pool_status='ignored' THEN 'ignored' WHEN EXISTS (SELECT 1 FROM random_pool rp WHERE rp.tg_file_id = f.id) THEN 'imported' ELSE 'pending' END AS pool_state FROM files f " + w + ' ORDER BY f.id DESC LIMIT ? OFFSET ?').bind(...p, ps, off).all();
    const origin = new URL(request.url).origin;
    const po = await getProxyOnly(env);
    const items = await Promise.all((d.results || []).map(async function(f) { return decorateLinks(f, origin, po, env); }));
    return json({ ok: true, data: { total: t?.total || 0, page: pg, page_size: ps, total_pages: Math.ceil((t?.total || 0) / ps), items: items } });
  } catch (e) {
    log.error('handleFiles error:', e.message);
    return json({ ok: false, error: '查询文件列表失败', details: e.message, hint: '请检查参数格式是否正确' }, 500);
  }
}

// 给文件记录补三类直链字段：
//   r2_url      真实 R2 直链（未转存 R2 时为空；代理占位 /file/tg/<id> 不算）
//   proxy_url   tele 代理直链（worker 拉 TG，隐藏 token，带签名防枚举，总是可用）
//   display_url 推荐直链（proxy_only=1 时一律代理链接；否则有 R2 秒开优先 R2）
//   link_type   'r2'=已有 R2（同时代理也可用）/ 'proxy'=仅代理 / 'both'=两者都给
export async function decorateLinks(f, origin, proxyOnly, env) {
  const realR2 = f.r2_url && f.r2_url.length > 0 && f.r2_url.indexOf('/file/tg/') !== 0;
  // 代理链接：签名放路径里，URL 以扩展名结尾（/file/tg/<token>/123.jpg），
  // 兼容要求 .jpg 结尾的程序；签名防止递增 id 遍历枚举
  const tok = await fileTok(f.id, env);
  const proxyUrl = origin + '/file/tg/' + tok + '/' + f.id + '.' + fileExtOf(f.file_name, f.file_type);
  if (realR2) {
    f.link_type = 'both';          // r2_url + proxy_url 都有
    f.proxy_url = proxyUrl;
    f.display_url = (proxyOnly === 1) ? proxyUrl : f.r2_url;
  } else {
    f.link_type = 'proxy';         // 仅代理直链
    f.r2_url = '';
    f.proxy_url = proxyUrl;
    f.display_url = proxyUrl;
  }
  return f;
}

export async function handleFile(request, env) {
  const u = new URL(request.url);
  const id = u.searchParams.get('id');
  const fu = u.searchParams.get('url');
  try {
    let f;
    if (id) f = await env.D1_DB.prepare('SELECT * FROM files WHERE id=? AND deleted_at IS NULL').bind(id).first();
    else if (fu) f = await env.D1_DB.prepare('SELECT * FROM files WHERE r2_url=? AND deleted_at IS NULL').bind(fu).first();
    return json({ ok: true, data: f ? await decorateLinks(f, new URL(request.url).origin, await getProxyOnly(env), env) : null });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 代理模式开关（settings 表）：1=入库不转存 R2，直链 /file/tg/<id> 由 worker 实时拉 Telegram
let _proxyMode = null, _proxyModeAt = 0;
export async function getProxyMode(env) {
  const now = Date.now();
  if (_proxyMode !== null && now - _proxyModeAt < 30000) return _proxyMode;
  _proxyMode = 0;
  try {
    const r = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='proxy_mode'").first();
    if (r && r.value) _proxyMode = (String(r.value).trim() === '1') ? 1 : 0;
  } catch (e) {}
  _proxyModeAt = now;
  return _proxyMode;
}

// bot 用户名（用于识别 @bot 提及），getMe 一次并缓存 1 小时
let _botUserCache = '', _botUserAt = 0;
export async function getBotUsername(env) {
  if (!env.TG_BOT_TOKEN) return '';
  if (_botUserCache && Date.now() - _botUserAt < 3600000) return _botUserCache;
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getMe');
    const j = await r.json();
    if (j && j.ok && j.result && j.result.username) { _botUserCache = j.result.username; _botUserAt = Date.now(); return _botUserCache; }
  } catch (e) {}
  return _botUserCache;
}
export async function handleAdminGetProxyMode(env) {
  return json({ ok: true, data: { proxy_mode: await getProxyMode(env) } });
}
export async function handleAdminSaveProxyMode(request, env) {
  try {
    const b = await request.json().catch(() => ({}));
    const v = (b.proxy_mode === 1 || b.proxy_mode === true || b.proxy_mode === '1') ? '1' : '0';
    await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES ('proxy_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(v).run();
    _proxyMode = (v === '1') ? 1 : 0; _proxyModeAt = Date.now();
    return json({ ok: true, data: { proxy_mode: _proxyMode } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 前端仅代理链接开关（settings 表）：1=API 的 display_url 与推荐直链一律给 /file/tg/<id> 代理链接，不用 R2 直链
let _proxyOnly = null, _proxyOnlyAt = 0;
export async function getProxyOnly(env) {
  const now = Date.now();
  if (_proxyOnly !== null && now - _proxyOnlyAt < 30000) return _proxyOnly;
  _proxyOnly = 0;
  try {
    const r = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='proxy_only'").first();
    if (r && r.value) _proxyOnly = (String(r.value).trim() === '1') ? 1 : 0;
  } catch (e) {}
  _proxyOnlyAt = now;
  return _proxyOnly;
}
export async function handleAdminGetProxyOnly(env) {
  return json({ ok: true, data: { proxy_only: await getProxyOnly(env) } });
}
export async function handleAdminSaveProxyOnly(request, env) {
  try {
    const b = await request.json().catch(() => ({}));
    const v = (b.proxy_only === 1 || b.proxy_only === true || b.proxy_only === '1') ? '1' : '0';
    await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES ('proxy_only',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(v).run();
    _proxyOnly = (v === '1') ? 1 : 0; _proxyOnlyAt = Date.now();
    return json({ ok: true, data: { proxy_only: _proxyOnly } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleStats(env) {
  const cacheKey = 'stats:main';
  const cached = cacheGet(cacheKey);
  if (cached) return json(cached);
  try {
    const cn0 = cnDayIso(cnTodayStr());
    const cnMonth0 = cnDayIso(cnTodayStr().slice(0, 8) + '01');
    const [t, ts, td, mo, bt, bc, pt, pe, pm, ptg, comp] = await Promise.all([
      env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first(),
      env.D1_DB.prepare('SELECT SUM(file_size) as s FROM files WHERE deleted_at IS NULL').first(),
      env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=?').bind(cn0).first(),
      env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=?').bind(cnMonth0).first(),
      env.D1_DB.prepare('SELECT file_type,COUNT(*) as c FROM files WHERE deleted_at IS NULL GROUP BY file_type').all(),
      env.D1_DB.prepare('SELECT chat_title,chat_id,COUNT(*) as c FROM files WHERE deleted_at IS NULL GROUP BY chat_title ORDER BY c DESC LIMIT 20').all(),
      // Random pool stats (curated pool separate from tg files)
      env.D1_DB.prepare('SELECT COUNT(*) as c FROM random_pool').first(),
      env.D1_DB.prepare('SELECT COUNT(*) as c FROM random_pool WHERE enabled=1').first(),
      env.D1_DB.prepare("SELECT COUNT(*) as c FROM random_pool WHERE source='manual'").first(),
      env.D1_DB.prepare("SELECT COUNT(*) as c FROM random_pool WHERE source='tg'").first(),
      env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND processing_state='completed'").first()
    ]);
    // D1 各表行数（方便排查容量/膨胀）
    let tableRows = {};
    try {
      const tables = ['files', 'random_pool', 'show_groups', 'bot_commands', 'api_keys', 'bot_config', 'settings', 'rate_limits', 'worker_stats'];
      for (const tbl of tables) {
        const rc = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM ' + tbl).first();
        tableRows[tbl] = rc?.c || 0;
      }
    } catch (e) {}
    const data = { total_files: t?.c || 0, completed_files: comp?.c || 0, unsaved_files: (t?.c || 0) - (comp?.c || 0), total_size: ts?.s || 0, total_size_formatted: fmtSize(ts?.s || 0), today_uploads: td?.c || 0, month_uploads: mo?.c || 0, by_type: bt.results || [], by_chat: bc.results || [], pool_total: pt?.c || 0, pool_enabled: pe?.c || 0, pool_manual: pm?.c || 0, pool_tg: ptg?.c || 0, table_rows: tableRows };
    cacheSet(cacheKey, data, 5000);
    return json({ ok: true, data });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// Telegram file_id 代理：相册浏览直接显示图片（不需要先导入到 files 表）
export async function handleTgFileProxy(request, env, ctx) {
  const u = new URL(request.url);
  const fileId = u.searchParams.get('file_id') || '';
  if (!fileId) return json({ ok: false, error: 'missing file_id' }, 400);
  try {
    // 用 Bot API getFile 获取文件路径
    const gf = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getFile?file_id=' + encodeURIComponent(fileId));
    const gj = await gf.json();
    if (!gj.ok || !gj.result || !gj.result.file_path) {
      return json({ ok: false, error: 'getFile failed: ' + (gj.description || 'unknown') }, 502);
    }
    const dlUrl = 'https://api.telegram.org/file/bot' + env.TG_BOT_TOKEN + '/' + gj.result.file_path;
    // 代理下载
    const resp = await fetch(dlUrl);
    if (!resp.ok) return json({ ok: false, error: 'download failed: ' + resp.status }, 502);
    // 懒转存：异步存到 R2（可选，减少后续请求）
    // 直接返回图片
    return new Response(resp.body, {
      headers: {
        'Content-Type': resp.headers.get('content-type') || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}
