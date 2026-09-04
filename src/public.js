// ==================== PUBLIC 展示层 ====================
// 幻灯片页（/show）、Show groups（节目单）、画廊瀑布流、公开 JSON API、公开上传、Random pool。
// 依赖 worker.js（fireWebhook/getAutoPoolTags/importFileToPool/extractFileInfo，循环 import，运行时调用安全）。
import { json, log, invalidateStatsCache } from "./util.js";
import { ensureTablesOnce } from "./db.js";
import { cnShift, cnTodayStr, cnNowISO, LEVEL_RANK, sanitizeLevel, levelFilter, clampInt, randHex, hashKeyPass, genApiKey, genShortKey, genRedeemCode, splitTags, fileExtOf } from "./core.js";
import { lastUploadError, putR2, putR2Stream, fileTok } from "./telegram.js";
import { fireWebhook, getAutoPoolTags, importFileToPool } from "./events.js";
import { extractFileInfo } from "./webhook.js";
import { applyRateLimit } from "./ratelimit.js";
import { isD1FaultError, noteD1Fault, d1Read } from "./dbaccess.js";
import { mysqlGet, mysqlRows, dualInsertFiles, dualInsertUserUploads, dualUpdateUserUploads, dualInsertRandomPool } from "./mysql.js";
// ==================== Public slideshow page (random pool showcase) ====================
// 30s in-memory cache so /show and /show/data skip D1 on hot requests (cold starts used to add seconds)
let _showCfg = null, _showCfgAt = 0;
export async function getShowConfig(env) {
  const now = Date.now();
  if (_showCfg && now - _showCfgAt < 30000) return _showCfg;
  const def = { enabled: 1, interval: 5, showTitle: 1, showTags: 1, showCounter: 1, tags: '', type: '', count: 20, shuffle: 1, statsCode: '', schedule: [], autoAdvance: 1 };
  let cfg = def;
  try {
    const r = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='show_config'").first();
    if (r && r.value) { try { cfg = Object.assign({}, def, JSON.parse(r.value)); } catch (e) {} }
  } catch (e) {}
  _showCfg = cfg; _showCfgAt = now;
  return cfg;
}

export async function handleShowConfigGet(env) {
  return json({ ok: true, data: await getShowConfig(env) });
}

// ==================== Show groups (image playlists for schedule programs) ====================
export async function handleShowGroupsList(env) {
  try {
    const d = await env.D1_DB.prepare('SELECT id, name, images, mode, daily_count, updated_at, created_at FROM show_groups ORDER BY id DESC').all();
    const today = cnTodayStr();
    return json({ ok: true, data: (d.results || []).map(function(g) {
      const arr = String(g.images || '').split(',').map(function(x){ return x.trim(); }).filter(Boolean);
      return { id: g.id, name: g.name, images: g.images || '', image_count: arr.length, mode: g.mode || 'fixed', daily_count: g.daily_count || 0, last_roll: g.updated_at || '', rolled_today: (g.updated_at && cnShift(new Date(g.updated_at)).toISOString().slice(0, 10) === today) ? 1 : 0, created_at: g.created_at };
    }) });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleShowGroupsSave(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !b.name) return json({ ok: false, error: 'name required' }, 400);
    const name = String(b.name).trim().slice(0, 60);
    const images = String(b.images || '').split(',').map(function(x){ return x.trim(); }).filter(Boolean).slice(0, 200).join(',');
    const mode = b.mode === 'daily_random' ? 'daily_random' : 'fixed';
    const daily_count = Math.min(Math.max(parseInt(b.daily_count) || 0, 0), 100);
    const id = parseInt(b.id, 10) || 0;
    if (id) {
      if (b.mode !== undefined) {
        // 显式提交模式（每日随机/固定）时同时更新模式与数量
        await env.D1_DB.prepare('UPDATE show_groups SET name=?, images=?, mode=?, daily_count=? WHERE id=?').bind(name, images, mode, daily_count, id).run();
      } else {
        // 仅选图/改名时不改动已配置的模式与每日数量
        await env.D1_DB.prepare('UPDATE show_groups SET name=?, images=? WHERE id=?').bind(name, images, id).run();
      }
    } else {
      await env.D1_DB.prepare('INSERT INTO show_groups (name, images, mode, daily_count, created_at) VALUES (?,?,?,?,?)').bind(name, images, mode, daily_count, cnNowISO()).run();
    }
    _showCfg = null; // schedules may reference groups
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleShowGroupsDelete(request, env) {
  try {
    const u = new URL(request.url);
    const id = parseInt(u.searchParams.get('id') || '0', 10);
    if (!id) return json({ ok: false, error: 'id required' }, 400);
    await env.D1_DB.prepare('DELETE FROM show_groups WHERE id=?').bind(id).run();
    _showCfg = null;
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 立即换图：从随机库抽 daily_count 张替换该节目组图片（返回本次结果）
export async function handleShowGroupRoll(request, env) {
  try {
    const u = new URL(request.url);
    const id = parseInt(u.searchParams.get('id') || '0', 10);
    if (!id) return json({ ok: false, error: 'id required' }, 400);
    const g = await env.D1_DB.prepare('SELECT id, mode, daily_count FROM show_groups WHERE id=?').bind(id).first();
    if (!g) return json({ ok: false, error: 'group not found' }, 404);
    const n = Math.min(Math.max(parseInt(g.daily_count) || 5, 1), 100);
    const picked = await env.D1_DB.prepare('SELECT id FROM random_pool WHERE enabled=1 AND level=\'pt\' AND is_private=0 ORDER BY RANDOM() LIMIT ?').bind(n).all();
    const ids = (picked.results || []).map(function(r) { return r.id; });
    if (!ids.length) return json({ ok: false, error: '共享库为空，无法换图（请先在共享库添加图片）' }, 400);
    await env.D1_DB.prepare('UPDATE show_groups SET images=?, updated_at=? WHERE id=?').bind(ids.join(','), cnNowISO(), id).run();
    _showCfg = null;
    return json({ ok: true, data: { image_count: ids.length } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 节目定时换图：遍历节目表，mode='daily_random' 的节目按 roll_time + weekdays 自动从随机库抽图
export async function rotateProgramImages(env) {
  if (!env.D1_DB) return 0;
  try {
    const raw = await getShowConfig(env);
    const sched = Array.isArray(raw.schedule) ? raw.schedule : [];
    if (!sched.length) return 0;
    const cnNow = cnShift(new Date());
    const today = cnNow.toISOString().slice(0, 10);
    const dow = cnNow.getUTCDay(); const dow1 = dow === 0 ? 7 : dow;
    const hm = cnNow.getUTCHours() * 60 + cnNow.getUTCMinutes();
    let rolled = 0;
    for (let i = 0; i < sched.length; i++) {
      const pg = sched[i];
      if (!pg || pg.mode !== 'daily_random') continue;
      if (!pg.daily_count || pg.daily_count <= 0) continue;
      // weekdays 检查：今天是否在允许的周期内
      if (pg.weekdays && pg.weekdays.length && pg.weekdays.indexOf(dow1) === -1) continue;
      // roll_time 检查：当前时间是否在 roll_time 的 ±2 分钟窗口内（cron 每 2 分钟触发一次）
      if (pg.roll_time) {
        const rt = parseHM(pg.roll_time);
        if (Math.abs(hm - rt) > 2) continue;
      }
      // 防重复：检查该节目的 images 是否今天已换过（用 _program_roll_dates 记忆）
      const rollKey = '_prog_roll_' + i + '_' + today;
      try {
        const seen = await env.D1_DB.prepare("SELECT value FROM settings WHERE key=?").bind(rollKey).first();
        if (seen && seen.value === '1') continue;
      } catch (e) {}
      // 抽图
      const n = Math.min(Math.max(parseInt(pg.daily_count) || 5, 1), 100);
      let pw = 'WHERE enabled=1 AND level=\'pt\' AND is_private=0'; const pp = [];
      if (pg.source === 'tg') { pw += " AND source='tg'"; }
      else if (pg.source === 'manual') { pw += " AND source='manual'"; }
      if (pg.tags) { pw = appendTagFilter(pg.tags, pw, pp); }
      if (pg.type) { pw += ' AND file_type=?'; pp.push(pg.type); }
      const picked = await env.D1_DB.prepare('SELECT id FROM random_pool ' + pw + ' ORDER BY RANDOM() LIMIT ?').bind(...pp, n).all();
      const ids = (picked.results || []).map(function(r) { return r.id; });
      if (!ids.length) continue;
      pg.images = ids.join(',');
      rolled++;
      // 标记今天已换
      try {
        await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'").bind(rollKey).run();
      } catch (e) {}
    }
    if (rolled) {
      // 回写 config
      await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('show_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(raw)).run();
      _showCfg = null;
      log.info('rotateProgramImages: rolled ' + rolled + ' program(s)');
    }
    return rolled;
  } catch (e) { log.error('rotateProgramImages:', e.message); return 0; }
}

export async function getGroup(env, id) {
  try {
    return await env.D1_DB.prepare('SELECT id, name, images FROM show_groups WHERE id=?').bind(parseInt(id, 10)).first();
  } catch (e) { return null; }
}

// Turn a group's stored images (mix of random_pool ids and raw urls) into item list
export async function groupItems(env, groupStr, limit) {
  const items = [];
  const ids = [], urls = [];
  String(groupStr || '').split(',').forEach(function(x) {
    x = x.trim();
    if (!x) return;
    if (/^\d+$/.test(x)) ids.push(parseInt(x, 10)); else urls.push(x);
  });
  if (ids.length) {
    // 公开页匿名访问：仅 pt 且非私密（私密内容仅 vvip 密钥可见）
    const stmt = env.D1_DB.prepare('SELECT id, url, thumb_url, title, tags FROM random_pool WHERE id IN (' + ids.map(function(){ return '?'; }).join(',') + ') AND level=\'pt\' AND is_private=0');
    const d = await stmt.bind(...ids).all();
    const map = {};
    (d.results || []).forEach(function(r) { map[r.id] = r; });
    ids.forEach(function(id) {
      const r = map[id];
      if (!r) return;
      items.push({ url: r.url, thumb_url: r.thumb_url || r.url, title: r.title || '', tags: splitTags(r.tags) });
    });
  }
  urls.forEach(function(u) { items.push({ url: u, thumb_url: u, title: '', tags: [] }); });
  return items.slice(0, limit);
}

export async function handleShowConfigSet(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b) return json({ ok: false, error: 'body required' }, 400);
    // 向后兼容：旧版 group 字段自动迁移到节目内 images
    const schedule = normalizeSchedule(b.schedule);
    for (const pg of schedule) {
      if (pg.group && !pg.images) {
        try {
          const g = await env.D1_DB.prepare('SELECT images FROM show_groups WHERE id=?').bind(parseInt(pg.group, 10)).first();
          if (g && g.images) pg.images = g.images;
        } catch (e) {}
        delete pg.group;
      } else if (pg.group) {
        delete pg.group; // images 优先，忽略 group
      }
    }
    const cfg = {
      enabled: b.enabled ? 1 : 0,
      interval: Math.min(Math.max(parseInt(b.interval) || 5, 1), 60),
      showTitle: b.showTitle ? 1 : 0,
      showTags: b.showTags ? 1 : 0,
      showCounter: b.showCounter ? 1 : 0,
      tags: String(b.tags || '').trim(),
      type: String(b.type || '').trim(),
      count: Math.min(Math.max(parseInt(b.count) || 20, 1), 50),
      shuffle: b.shuffle ? 1 : 0,
      schedule: schedule,
      autoAdvance: b.autoAdvance ? 1 : 0,
      statsCode: String(b.statsCode || '')
    };
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('show_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(cfg)).run();
    _showCfg = null; // invalidate cache so the change applies immediately
    return json({ ok: true, data: cfg });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleShowPage() {
  // Fully static page: no D1 query. All config comes from /show/data at runtime.
  return new Response(SHOW_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Data endpoint for the slideshow: random pool only, no api key needed (public showcase)
// Supports TV-style schedule: current time picks a program -> its tags/type apply
export async function handleShowData(request, env) {
  const raw = await getShowConfig(env);
  if (!raw.enabled) return json({ ok: false, error: '展示页已暂停' }, 404);
  // Serve a conflict-free copy of the schedule (normalize each time so old overlapping
  // configs also resolve to exactly one active program)
  const cfg = Object.assign({}, raw, { schedule: normalizeSchedule(raw.schedule) });
  const u = new URL(request.url);
  const now = new Date();
  const pg = matchProgram(cfg, now);
  const tagsParam = u.searchParams.get('tags') || (pg && pg.tags) || cfg.tags || '';
  const type = u.searchParams.get('type') || (pg && pg.type) || cfg.type || '';
  // 节目张数用 daily_count（前端字段名），兼容旧配置的 count；URL 参数优先
  const count = clampInt(u.searchParams.get('count') || String((pg && (pg.daily_count || pg.count)) || cfg.count) || '20', 20, 1, 50);
  const shuffle = u.searchParams.get('shuffle') === '1' || (u.searchParams.get('shuffle') === null && cfg.shuffle === 1);
  const pgName = pg ? (pg.name || ((pg.start || '') + '-' + (pg.end || ''))) : null;
  // 节目内嵌图片：仅固定模式使用；每日随机模式实时按 count+过滤条件抽图，
  // 避免旧 show_groups 迁移残留的 images 字段劫持导致数量错误（曾出现设置 10 张只播 5 张）
  let explicit = null;
  if (pg && pg.images && pg.mode !== 'daily_random') explicit = pg.images;
  if (explicit) {
    try {
      const items = await groupItems(env, explicit, 500);
      return json({ ok: true, data: { cfg: cfg, program: pgName ? { name: pgName } : null, items: items } });
    } catch (e) { return json({ ok: false, error: e.message }, 500); }
  }
  // 按标签/类型/来源从随机库抽图（公开页匿名访问：仅 pt 且非私密）
  let w = 'WHERE enabled=1 AND level=? AND is_private=0'; const p = ['pt'];
  if (type) { w += ' AND file_type=?'; p.push(type); }
  if (tagsParam) { w = appendTagFilter(tagsParam, w, p); }
  // 来源过滤：pg.source = 'tg' / 'manual' / ''(全部)
  if (pg && pg.source === 'tg') { w += " AND source='tg'"; }
  else if (pg && pg.source === 'manual') { w += " AND source='manual'"; }
  try {
    const d = await env.D1_DB.prepare('SELECT url, thumb_url, title, tags FROM random_pool ' + w + (shuffle ? ' ORDER BY RANDOM()' : ' ORDER BY id DESC') + ' LIMIT ?').bind(...p, count).all();
    const items = (d.results || []).map(function(r) {
      return { url: r.url, thumb_url: r.thumb_url || r.url, title: r.title || '', tags: splitTags(r.tags) };
    });
    return json({ ok: true, data: { cfg: cfg, program: pgName ? { name: pgName } : null, items: items } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== 画廊瀑布流页（带 key 鉴权） ====================
// /gallery 静态页；/gallery/data?api_key=xxx&tags=&type=&limit=&offset= 返回 JSON
// 鉴权走 api_keys 表（级别对等：key 级别决定可见内容级别；is_private=1 仅 vvip 可见）
export async function handleGalleryPage() {
  return new Response(GALLERY_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function handleGalleryData(request, env) {
  const k = await checkApiKey(request, env);
  if (!k) return json({ ok: false, error: 'Unauthorized or invalid API key' }, 401);
  if (k.limited) return json({ ok: false, error: 'Rate limit exceeded' }, 429);
  const keyLevel = (k.rec && k.rec.level) || 'pt';
  const u = new URL(request.url);
  const tagsParam = u.searchParams.get('tags') || '';
  const type = u.searchParams.get('type') || '';
  const limit = clampInt(u.searchParams.get('limit') || '60', 60, 1, 100);
  const offset = clampInt(u.searchParams.get('offset') || '0', 0, 0);
  let w = 'WHERE enabled=1'; const p = [];
  const lf = levelFilter(keyLevel);
  w += lf.sql; p.push.apply(p, lf.params);
  if (keyLevel !== 'vvip') { w += ' AND is_private=0'; }
  if (type) { w += ' AND file_type=?'; p.push(type); }
  if (tagsParam) { w = appendTagFilter(tagsParam, w, p); }
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM random_pool ' + w).bind(...p).first();
    const d = await env.D1_DB.prepare('SELECT * FROM random_pool ' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?').bind(...p, limit, offset).all();
    return json({ ok: true, data: { total: t?.total || 0, limit: limit, offset: offset, level: keyLevel, items: (d.results || []).map(poolFileJson) } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// The gallery page (fully static; data fetched from /gallery/data with api_key)
const GALLERY_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>图片画廊</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0b0f19; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; min-height:100vh; }
.head { position:sticky; top:0; z-index:20; background:rgba(11,15,25,.88); backdrop-filter:blur(8px); border-bottom:1px solid rgba(255,255,255,.1); padding:12px 16px; display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.head h1 { font-size:16px; font-weight:700; margin-right:auto; }
.head .inp { background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.14); color:#e2e8f0; border-radius:8px; padding:6px 10px; font-size:13px; outline:none; }
.head .inp:focus { border-color:#4f6ef7; }
.head .btn { background:#4f6ef7; border:none; color:#fff; border-radius:8px; padding:6px 14px; font-size:13px; cursor:pointer; }
.head .btn:disabled { opacity:.4; cursor:not-allowed; }
.head select.inp { max-width:130px; }
.hint { font-size:11px; color:#7d8db0; padding:8px 16px 0; }
.hint code { background:rgba(255,255,255,.08); padding:1px 6px; border-radius:4px; }
#grid { columns:4 240px; column-gap:10px; padding:14px 16px 40px; }
.card { break-inside:avoid; margin-bottom:10px; border-radius:10px; overflow:hidden; background:rgba(255,255,255,.05); position:relative; transition:transform .15s; }
.card:hover { transform:translateY(-2px); }
.card img { width:100%; display:block; }
.card .cap { position:absolute; inset:auto 0 0 0; padding:18px 8px 8px; background:linear-gradient(transparent,rgba(0,0,0,.78)); font-size:12px; }
.card .cap .t { font-weight:600; }
.card .cap .g { color:#a8b4cc; margin-top:2px; font-size:11px; }
#load { text-align:center; padding:20px 0 40px; }
#load .btn { font-size:13px; }
#empty { text-align:center; color:#7d8db0; padding:60px 20px; font-size:14px; }
a.card { text-decoration:none; color:inherit; }
@media (max-width:900px){ #grid { columns:2 150px; } }
</style>
</head>
<body>
<div class="head">
  <h1>🖼 图片画廊</h1>
  <input class="inp" id="kw" placeholder="标签筛选，如：风景,美女" style="width:220px">
  <select class="inp" id="type">
    <option value="">全部类型</option><option value="photo">图片</option><option value="video">视频</option>
  </select>
  <button class="btn" id="apply">筛选</button>
  <button class="btn" id="loadBtn">加载更多</button>
</div>
<div class="hint">带 key 鉴权画廊：需在 URL 或下方提供 API 密钥（级别对等，低级别不会显示高级别内容）。示例：<code>/gallery?api_key=你的密钥</code></div>
<div id="grid"></div>
<div id="empty" style="display:none">没有匹配的内容</div>
<div id="load"><button class="btn" id="loadBtn2" style="display:none">加载更多</button></div>
<script>
(function(){
  var KEY = new URLSearchParams(location.search).get('api_key') || localStorage.getItem('gal_key') || '';
  var kw = document.getElementById('kw');
  var typeEl = document.getElementById('type');
  var grid = document.getElementById('grid');
  var empty = document.getElementById('empty');
  var offset = 0, total = 0, loading = false;
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function load(reset){
    if (loading) return; loading = true;
    if (reset){ offset = 0; grid.innerHTML = ''; empty.style.display = 'none'; }
    var q = 'offset=' + offset + '&limit=60';
    if (kw.value.trim()) q += '&tags=' + encodeURIComponent(kw.value.trim());
    if (typeEl.value) q += '&type=' + encodeURIComponent(typeEl.value);
    fetch('/gallery/data?api_key=' + encodeURIComponent(KEY) + '&' + q).then(function(r){ return r.json(); }).then(function(j){
      loading = false;
      if (!j || !j.ok){ empty.style.display='block'; empty.textContent = (j && j.error) || '加载失败'; document.getElementById('loadBtn2').style.display='none'; return; }
      var items = (j.data && j.data.items) || [];
      total = (j.data && j.data.total) || 0;
      if (!items.length){ empty.style.display='block'; document.getElementById('loadBtn2').style.display='none'; return; }
      empty.style.display='none';
      items.forEach(function(it){
        var card = document.createElement('a');
        card.className = 'card';
        card.href = it.url;
        card.target = '_blank';
        var t = esc(it.title || '');
        var g = (it.tags||[]).map(function(x){ return '#'+esc(x); }).join(' ');
        card.innerHTML = '<img loading="lazy" src="' + esc(it.thumb_url || it.url) + '" alt=""><div class="cap"><div class="t">' + t + '</div><div class="g">' + g + '</div></div>';
        grid.appendChild(card);
      });
      offset += items.length;
      document.getElementById('loadBtn2').style.display = (offset < total) ? 'inline-block' : 'none';
    }).catch(function(){ loading = false; });
  }
  document.getElementById('apply').addEventListener('click', function(){ load(true); });
  document.getElementById('loadBtn').addEventListener('click', function(){ load(false); });
  document.getElementById('loadBtn2').addEventListener('click', function(){ load(false); });
  kw.addEventListener('keydown', function(e){ if (e.key === 'Enter') load(true); });
  load(true);
})();
</script>
</body>
</html>`;

// Match current time against the TV-style schedule. Returns the active program or null.
// 支持 weekdays（周几筛选，1=周一..7=周日，空=每天）
export function matchProgram(cfg, now) {
  const sched = Array.isArray(cfg.schedule) ? cfg.schedule : [];
  if (!sched.length) return null;
  const hm = now.getHours() * 60 + now.getMinutes();
  const dow = now.getDay(); // 0=Sun..6=Sat
  const dow1 = dow === 0 ? 7 : dow; // 1=Mon..7=Sun
  for (let i = 0; i < sched.length; i++) {
    const s = sched[i];
    if (!s || !s.start || !s.end) continue;
    // weekdays 过滤：空=每天，数组=[1,3,5] 表示周一三五
    if (s.weekdays && s.weekdays.length) {
      if (s.weekdays.indexOf(dow1) === -1) continue;
    }
    const st = parseHM(s.start), en = parseHM(s.end);
    if (st === en) return s; // 00:00-00:00 表示全天节目（任何时刻都匹配）
    if (st <= en) { if (hm >= st && hm < en) return s; }
    else { if (hm >= st || hm < en) return s; } // crosses midnight
  }
  return null;
}
export function parseHM(t) {
  const p = String(t || '').split(':');
  return parseInt(p[0] || '0', 10) * 60 + parseInt(p[1] || '0', 10);
}

// Resolve schedule conflicts: sort by start, clip overlapping programs so that
export function normalizeSchedule(sched) {
  const arr = (Array.isArray(sched) ? sched : []).filter(function(s) { return s && s.start && s.end; });
  arr.sort(function(a, b) { return parseHM(a.start) - parseHM(b.start); });
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const src = arr[i];
    const cur = { name: String(src.name || ((src.start || '') + '-' + (src.end || ''))), start: String(src.start).trim(), end: String(src.end).trim(), tags: String(src.tags || '').trim(), type: String(src.type || '').trim(), images: String(src.images || '').trim(), group: String(src.group || '').trim() };
    // 节目级图片规则（每日随机换图）与周期字段
    if (src.mode) cur.mode = src.mode;
    if (src.daily_count) cur.daily_count = parseInt(src.daily_count, 10) || 0;
    if (src.roll_time) cur.roll_time = String(src.roll_time).trim();
    if (src.source) cur.source = String(src.source).trim();
    if (Array.isArray(src.weekdays) && src.weekdays.length) cur.weekdays = src.weekdays.map(Number).filter(function(n){ return n >= 1 && n <= 7; });
    if (parseHM(cur.end) < parseHM(cur.start)) { // crosses midnight: keep as-is, do not clip
      out.push(cur); continue;
    }
    const prev = out[out.length - 1];
    if (prev && parseHM(cur.start) < parseHM(prev.end)) {
      cur.start = prev.end; // clip overlap: start right where the previous ends
      if (parseHM(cur.start) >= parseHM(cur.end)) continue; // fully covered, drop
    }
    out.push(cur);
  }
  return out;
}

// The slideshow page (fully static; config is fetched by the page from /show/data)
const SHOW_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>图片轮播</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
html,body { height:100%; background:#0b0f19; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
#stage { position:fixed; inset:0; }
#main { width:100%; height:100%; object-fit:contain; display:block; }
#loading { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); color:#94a3b8; font-size:14px; }
.zone { position:fixed; top:0; bottom:0; width:35%; cursor:pointer; z-index:10; }
.zone.left { left:0; }
.zone.right { right:0; }
.zone:hover::after { content:""; position:absolute; top:50%; width:0; height:0; border-top:10px solid transparent; border-bottom:10px solid transparent; opacity:.35; }
.zone.left:hover::after { left:24px; border-right:16px solid #fff; }
.zone.right:hover::after { right:24px; border-left:16px solid #fff; }
.info { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); text-align:center; color:#e2e8f0; z-index:20; width:90%; max-width:700px; }
#counter { font-size:13px; opacity:.7; margin-bottom:4px; }
#title { font-size:15px; font-weight:600; text-shadow:0 1px 8px rgba(0,0,0,.6); }
#tags { margin-top:6px; font-size:12px; }
.tag { display:inline-block; background:rgba(255,255,255,.14); padding:2px 10px; border-radius:20px; margin:2px 3px; }
#playBtn { position:fixed; bottom:20px; right:20px; z-index:30; background:rgba(255,255,255,.15); color:#fff; border:1px solid rgba(255,255,255,.25); border-radius:20px; padding:6px 16px; font-size:12px; cursor:pointer; }
#dots { position:fixed; bottom:22px; left:20px; z-index:30; display:flex; gap:6px; max-width:40%; flex-wrap:wrap; }
.dot { width:8px; height:8px; border-radius:50%; background:rgba(255,255,255,.25); }
.dot.on { background:#fff; }
#sidebar { position:fixed; top:64px; left:14px; z-index:26; width:215px; max-height:calc(100vh - 90px); overflow-y:auto; background:rgba(11,15,25,.66); backdrop-filter:blur(8px); border:1px solid rgba(255,255,255,.12); border-radius:12px; padding:12px; color:#e2e8f0; font-size:12px; }
#sidebar::-webkit-scrollbar { width:4px; }
#sidebar::-webkit-scrollbar-thumb { background:rgba(255,255,255,.2); border-radius:2px; }
.sb-title { font-size:13px; font-weight:700; margin-bottom:10px; color:#fff; }
.sb-item { display:flex; gap:6px; align-items:center; padding:7px 8px; border-radius:8px; margin-bottom:4px; background:rgba(255,255,255,.05); }
.sb-item.on { background:#4f6ef7; color:#fff; }
.sb-item .sb-time { font-variant-numeric:tabular-nums; opacity:.8; white-space:nowrap; }
.sb-item .sb-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sb-item em { font-style:normal; font-size:10px; background:rgba(255,255,255,.22); padding:1px 6px; border-radius:10px; }
.sb-empty { color:#94a3b8; font-size:12px; padding:6px 0; }
.program { position:fixed; top:18px; left:50%; transform:translateX(-50%); z-index:25; background:rgba(255,255,255,.12); color:#fff; padding:4px 16px; border-radius:20px; font-size:12px; letter-spacing:.5px; backdrop-filter:blur(4px); }
#overlay { position:fixed; inset:0; background:rgba(0,0,0,.6); backdrop-filter:blur(6px); z-index:100; display:none; align-items:center; justify-content:center; }
.ov-box { background:#111827; border:1px solid #1f2937; border-radius:16px; padding:32px 40px; text-align:center; max-width:360px; width:90%; box-shadow:0 20px 60px rgba(0,0,0,.5); }
.ov-box h2 { color:#f9fafb; font-size:18px; margin-bottom:8px; }
.ov-box p { color:#9ca3af; font-size:13px; margin-bottom:20px; }
.ov-actions { display:flex; gap:10px; justify-content:center; }
.ov-actions button { padding:9px 20px; border:none; border-radius:10px; font-size:13px; cursor:pointer; font-weight:600; }
#btnNextGroup { background:#4f6ef7; color:#fff; }
#btnNextGroup:hover { background:#3b5de7; }
#btnReplay { background:#1f2937; color:#e5e7eb; }
#btnReplay:hover { background:#374151; }
@media (max-width:640px){ .zone { width:25%; } }
</style>
</head>
<body>
<div id="stage">
  <img id="main" alt="">
  <div id="loading">加载中...</div>
  <div class="zone left" id="zLeft"></div>
  <div class="zone right" id="zRight"></div>
</div>
<button id="playBtn">暂停</button>
<div id="dots"></div>
<div id="program" class="program" style="display:none"></div>
<div id="sidebar">
  <div class="sb-title">节目单</div>
  <div id="scheduleList"></div>
</div>
<div class="info">
  <div id="counter"></div>
  <div id="title"></div>
  <div id="tags"></div>
</div>
<div id="overlay">
  <div class="ov-box">
    <h2>本组播放完毕</h2>
    <p id="ovProgram"></p>
    <div class="ov-actions">
      <button id="btnNextGroup">播放下一组</button>
      <button id="btnReplay">重新播放本组</button>
    </div>
  </div>
</div>
<script>
var items=[],idx=0,timer=null,AUTOSEC=5,paused=false,AUTOADVANCE=0;
var curProgram='';
var SHOW_TITLE=true,SHOW_TAGS=true,SHOW_COUNTER=true,statsInjected=false;
var scheduleArr=[],boundaryTimer=null;
function $(i){return document.getElementById(i);}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function p2m(t){var p=String(t||'').split(':');return (parseInt(p[0]||'0',10)||0)*60+(parseInt(p[1]||'0',10)||0);}
function renderScheduleList(){
  var box=$('scheduleList');
  if(!box) return;
  if(!scheduleArr.length){box.innerHTML='<div class="sb-empty">未配置节目单</div>';return;}
  var now=new Date(),hm=now.getHours()*60+now.getMinutes(),h='',hit=false;
  for(var i=0;i<scheduleArr.length;i++){
    var s=scheduleArr[i];
    if(!s||!s.start||!s.end) continue;
    var st=p2m(s.start),en=p2m(s.end);
    var active=(st<=en)?(hm>=st&&hm<en):(hm>=st||hm<en);
    if(active&&hit) active=false; // only highlight the first matching program
    if(active) hit=true;
    h+='<div class="sb-item'+(active?' on':'')+'"><span class="sb-time">'+esc(s.start)+'-'+esc(s.end)+'</span><span class="sb-name">'+esc(s.name||'')+'</span>'+(active?'<em>播放中</em>':'')+'</div>';
  }
  box.innerHTML=h||'<div class="sb-empty">未配置节目单</div>';
}
function planBoundary(){
  if(boundaryTimer){clearTimeout(boundaryTimer);boundaryTimer=null;}
  if(!scheduleArr.length) return;
  var now=new Date(),hm=now.getHours()*60+now.getMinutes(),next=null;
  for(var i=0;i<scheduleArr.length;i++){
    var s=scheduleArr[i];
    if(!s||!s.start||!s.end) continue;
    var st=p2m(s.start),en=p2m(s.end);
    if(st>hm&&(next===null||st<next)) next=st;
    if(en>hm&&(next===null||en<next)) next=en;
  }
  if(next!==null){
    var ms=(next-hm)*60000-now.getSeconds()*1000-now.getMilliseconds();
    boundaryTimer=setTimeout(function(){probe();planBoundary();},Math.max(ms,1000));
  }
}
// Config comes from /show/data at runtime (no server-side config lookup on page load)
function injectStats(code){
  if(statsInjected||!code) return;
  statsInjected=true;
  var div=document.createElement('div');
  div.innerHTML=code;
  var scripts=div.querySelectorAll('script');
  for(var i=0;i<scripts.length;i++){
    var s=document.createElement('script');
    if(scripts[i].src){s.src=scripts[i].src;}
    else{s.text=scripts[i].text;}
    document.body.appendChild(s);
  }
  while(div.firstChild){document.body.appendChild(div.firstChild);}
}
function applyCfg(cfg){
  cfg=cfg||{};
  AUTOSEC=parseInt(cfg.interval)||5;
  AUTOADVANCE=cfg.autoAdvance?1:0;
  SHOW_TITLE=cfg.showTitle?true:false;
  SHOW_TAGS=cfg.showTags?true:false;
  SHOW_COUNTER=cfg.showCounter?true:false;
  $('counter').style.display=SHOW_COUNTER?'block':'none';
  $('title').style.display=SHOW_TITLE?'block':'none';
  $('tags').style.display=SHOW_TAGS?'block':'none';
  scheduleArr=(cfg.schedule||[]).slice();
  renderScheduleList();
  planBoundary();
  injectStats(cfg.statsCode);
}
function load(){
  $('overlay').style.display='none';
  var done=false;
  var to=setTimeout(function(){ if(!done){ $('loading').textContent='加载超时，请刷新或稍后再试'; } },20000);
  fetch('/show/data'+location.search).then(function(r){return r.json();}).then(function(j){
    done=true;clearTimeout(to);
    if(!j||!j.ok){$('loading').textContent=(j&&j.error)?j.error:'加载失败';return;}
    applyCfg(j.data&&j.data.cfg);
    items=(j.data&&j.data.items)||[];
    curProgram=(j.data&&j.data.program&&j.data.program.name)||'';
    updateProgram();
    if(!items.length){$('loading').textContent='共享库暂无图片';return;}
    $('loading').style.display='none';
    idx=0;show();start();
  }).catch(function(){done=true;clearTimeout(to);$('loading').textContent='加载失败，请刷新重试';});
}
var errCount=0;
function updateProgram(){
  var el=$('program');
  if(el){if(curProgram){el.style.display='block';el.textContent='正在播放 · '+curProgram;}else{el.style.display='none';}}
  var ov=$('ovProgram');
  if(ov) ov.textContent=curProgram?('下一组将播放 · '+curProgram):'共享库暂无更多内容';
  renderScheduleList();
}
function show(){
  var it=items[idx];
  var img=$('main');
  if(img._t) clearTimeout(img._t);
  img.onload=function(){errCount=0;if(img._t){clearTimeout(img._t);img._t=null;}};
  img.onerror=function(){
    errCount++;
    if(errCount>=items.length){$('loading').textContent='图片全部加载失败，请检查外链';$('loading').style.display='block';stop();return;}
    $('loading').textContent='图片加载失败，自动跳过...';
    $('loading').style.display='block';
    setTimeout(function(){$('loading').style.display='none';next();},800);
  };
  img._t=setTimeout(function(){ // 15s 无响应：不卡页面，自动跳下一张
    errCount++;
    $('loading').textContent='图片加载缓慢，自动跳过...';
    $('loading').style.display='block';
    setTimeout(function(){$('loading').style.display='none';next();},800);
  },15000);
  img.src=it.url;
  $('counter').textContent=(idx+1)+' / '+items.length;
  $('title').textContent=esc(it.title||'');
  var t='';
  for(var i=0;i<it.tags.length;i++){t+='<span class="tag">#'+esc(it.tags[i])+'</span>';}
  $('tags').innerHTML=t;
  var d='';
  for(var j=0;j<items.length;j++){d+='<span class="dot'+(j===idx?' on':'')+'"></span>';}
  $('dots').innerHTML=d;
  var nx=new Image();nx.src=items[(idx+1)%items.length].url;
}
function next(){
  idx=(idx+1)%items.length;
  if(idx===0){show();groupEnd();return;}
  show();
}
function prev(){idx=(idx-1+items.length)%items.length;show();}
function groupEnd(){stop();$('overlay').style.display='flex';}
function start(){stop();timer=setInterval(next,AUTOSEC*1000);}
function stop(){if(timer){clearInterval(timer);timer=null;}}
function togglePlay(){if(timer){stop();paused=true;$('playBtn').textContent='播放';}else{start();paused=false;$('playBtn').textContent='暂停';}}
function probe(){
  fetch('/show/data?count=1').then(function(r){return r.json();}).then(function(j){
    if(!j||!j.ok) return;
    applyCfg(j.data&&j.data.cfg);
    var pg=(j.data&&j.data.program&&j.data.program.name)||'';
    if(pg!==curProgram){
      curProgram=pg;updateProgram();
      if(AUTOADVANCE) load();
    }
  }).catch(function(){});
}
$('zLeft').addEventListener('click',function(){prev();});
$('zRight').addEventListener('click',function(){next();});
$('playBtn').addEventListener('click',togglePlay);
$('btnNextGroup').addEventListener('click',function(){load();});
$('btnReplay').addEventListener('click',function(){$('overlay').style.display='none';idx=0;show();start();});
$('stage').addEventListener('mouseenter',stop);
$('stage').addEventListener('mouseleave',function(){if(!paused)start();});
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight')next();if(e.key==='ArrowLeft')prev();if(e.key===' ')togglePlay();});
setInterval(probe,30000);
load();
</script>
</body>
</html>`;

// ==================== Public JSON API (third-party programs) ====================
export async function checkApiKey(request, env) {
  if (!env.D1_DB) { log.error('checkApiKey: D1_DB unavailable'); return null; }
  const u = new URL(request.url);
  let k = u.searchParams.get('api_key') || request.headers.get('X-API-Key');
  // 支持 ?sk=短链接别名：按 short_key 匹配真实 key（便于生成短链接），api_key 优先
  if (!k) {
    const sk = u.searchParams.get('sk');
    if (sk) {
      let bySk = null;
      try {
        bySk = await env.D1_DB.prepare('SELECT key FROM api_keys WHERE short_key=? LIMIT 1').bind(String(sk).trim()).first();
      } catch (e) {
        if (isD1FaultError(e)) {
          noteD1Fault();
          try { bySk = await mysqlGet(env, 'SELECT `key` FROM api_keys WHERE short_key=? LIMIT 1', [String(sk).trim()]); } catch (e2) {}
        }
      }
      if (bySk) k = bySk.key;
    }
  }
  if (!k) return null;
  try {
    // D1 优先；D1 故障/限额自动降级 MySQL 镜像（api_keys 表已全量镜像）
    let rec = null;
    try {
      rec = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key=? AND enabled=1 AND (expires_at IS NULL OR expires_at=\'\' OR expires_at >= date(\'now\')) LIMIT 1').bind(k).first();
    } catch (e) {
      if (isD1FaultError(e)) {
        noteD1Fault();
        rec = await mysqlGet(env, "SELECT * FROM api_keys WHERE `key`=? AND enabled=1 AND (expires_at IS NULL OR expires_at='' OR expires_at >= CURDATE()) LIMIT 1", [k]);
      } else { throw e; }
    }
    log.debug('checkApiKey result:', rec ? 'FOUND id=' + rec.id : 'NULL', 'key_prefix=' + k.slice(0,8));
    if (!rec) return null;
    // usage bump (fire and forget) — D1 降级期跳过写，不影响鉴权主流程
    env.D1_DB.prepare('UPDATE api_keys SET usage_count=usage_count+1, last_used_at=? WHERE id=?').bind(cnNowISO(), rec.id).run().catch(function(){});
    // 限流：settings.api_rate_limit = {enabled, limit_per_min}
    const limited = await applyRateLimit(env, k);
    // 记录调用日志（fire and forget；路径/方法/IP 供后台查看与统计）
    logApiCall(env, rec, request).catch(function(){});
    return { rec: rec, limited: limited };
  } catch (e) { log.error('checkApiKey error:', e.message, e.stack); return null; }
}

// 记录一次密钥调用（api_call_logs）。路径保留 /api/v1/... 原始地址（含 query），IP 取 CF 头。
// api_key 参数值脱敏为 ***，避免完整密钥落入日志明文（后台展示/定位仍可用，key 已有单独 api_key 列）
export async function logApiCall(env, rec, request) {
  if (!env.D1_DB || !rec) return;
  try {
    const u = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
    const path = (u.pathname + u.search).replace(/([?&]api_key=)[^&]*/gi, '$1***');
    await env.D1_DB.prepare('INSERT INTO api_call_logs (key_id, api_key, path, method, ip, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(rec.id, rec.key, path, request.method || 'GET', String(ip).slice(0, 45), 200, cnNowISO()).run();
  } catch (e) { log.error('logApiCall:', e.message); }
}

// 公开 API 限流逻辑已移入 src/ratelimit.js（applyRateLimit），由顶部 import 引入

// 诊断端点：帮助排查 API key 问题（仅返回 key 是否存在、是否启用、是否过期，不泄露完整 key）
export async function handleDiagnoseKey(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'DB unavailable', hint: 'D1_DB binding missing' }, 500);
  const u = new URL(request.url);
  const k = u.searchParams.get('api_key') || request.headers.get('X-API-Key');
  if (!k) return json({ ok: false, error: 'No API key provided', hint: 'Pass api_key as query param or X-API-Key header' }, 400);
  try {
    // 统计总密钥数（帮助判断是否是系统性问题）
    const countResult = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM api_keys').first();
    const totalKeys = countResult ? countResult.total : 0;
    // 查找 key（不区分 enabled/过期，只看是否存在）
    const rec = await env.D1_DB.prepare('SELECT id, name, username, enabled, expires_at, level, scopes, created_at, short_key FROM api_keys WHERE key=? LIMIT 1').bind(k).first();
    if (!rec) {
      return json({ ok: false, error: 'Key not found in database', key_prefix: k.slice(0, 6) + '...', total_keys_in_db: totalKeys }, 404);
    }
    const today = cnTodayStr();
    const expired = rec.expires_at ? (rec.expires_at < today) : false;
    // 测试 checkApiKey 使用的完整查询（明确列）
    const fullRec = await env.D1_DB.prepare('SELECT id, enabled, expires_at FROM api_keys WHERE key=? AND enabled=1 AND (expires_at IS NULL OR expires_at=\'\' OR expires_at >= date(\'now\')) LIMIT 1').bind(k).first();
    // 测试 checkApiKey 实际使用的 SELECT *（复现可能的异常）
    let starRec = null, starError = null;
    try {
      starRec = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key=? AND enabled=1 AND (expires_at IS NULL OR expires_at=\'\' OR expires_at >= date(\'now\')) LIMIT 1').bind(k).first();
    } catch (se) { starError = se.message; }
    // 直接调用 checkApiKey 复现完整流程
    let chkResult = null, chkError = null;
    try {
      chkResult = await checkApiKey(request, env);
    } catch (ce) { chkError = ce.message; }
    // 逐步重放 checkApiKey 内部流程，定位返回 null 的步骤
    let step = {};
    try {
      const rk = new URL(request.url).searchParams.get('api_key') || request.headers.get('X-API-Key');
      step.k_extracted = rk;
      step.k_present = !!rk;
      if (rk) {
        const rec2 = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key=? AND enabled=1 AND (expires_at IS NULL OR expires_at=\'\' OR expires_at >= date(\'now\')) LIMIT 1').bind(rk).first();
        step.rec2_found = !!rec2;
        step.rec2_id = rec2 && rec2.id;
        if (rec2) {
          const usage = await env.D1_DB.prepare('UPDATE api_keys SET usage_count=usage_count+1, last_used_at=? WHERE id=?').bind(cnNowISO(), rec2.id).run();
          step.usage_ok = !!usage;
          const lim = await applyRateLimit(env, rk);
          step.limited = lim;
          const lg = await logApiCall(env, rec2, request);
          step.logged = !!lg;
        }
      }
    } catch (se2) { step.error = se2.message; }
    return json({
      ok: true,
      key_exists: true,
      enabled: rec.enabled === 1,
      expired: expired,
      expires_at_raw: rec.expires_at,
      expires_at_type: typeof rec.expires_at,
      expires_at_is_null: rec.expires_at === null,
      expires_at_is_empty: rec.expires_at === '',
      today: today,
      level: rec.level,
      username: rec.username || '(empty)',
      name: rec.name || '(empty)',
      scopes: rec.scopes,
      short_key: rec.short_key || '(empty)',
      total_keys_in_db: totalKeys,
      full_query_found: !!fullRec,
      select_star_found: !!starRec,
      select_star_error: starError,
      checkApiKey_result: chkResult ? { found: !!chkResult.rec, limited: chkResult.limited } : null,
      checkApiKey_error: chkError,
      replay: step
    });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export function appendTagFilter(tagsParam, w, p, prefix) {
  const q = prefix || '';
  const tags = splitTags(tagsParam);
  if (tags.length) {
    const ts = [];
    tags.forEach(function(t) {
      ts.push('(' + q + 'tags LIKE ? OR ' + q + 'tags LIKE ? OR ' + q + 'tags LIKE ? OR ' + q + 'tags = ?)');
      p.push('%,' + t + ',%', t + ',%', '%,' + t, t);
    });
    w += ' AND (' + ts.join(' OR ') + ')';
  }
  return w;
}

export function publicFileJson(f) {
  if (!f) return null;
  return {
    id: f.id, file_name: f.file_name, file_type: f.file_type, mime_type: f.mime_type,
    file_size: f.file_size, width: f.width, height: f.height,
    r2_url: f.r2_url, thumb_url: f.thumb_url,
    level: sanitizeLevel(f.level),
    tags: splitTags(f.tags),
    caption: f.caption, chat_title: f.chat_title, username: f.username,
    created_at: f.created_at
  };
}

export async function handlePublicFiles(request, env, keyLevel) {
  const u = new URL(request.url);
  const type = u.searchParams.get('type') || '';
  const tagsParam = u.searchParams.get('tags') || '';
  const kw = u.searchParams.get('keyword') || '';
  const limit = clampInt(u.searchParams.get('limit') || '20', 20, 1, 100);
  const offset = clampInt(u.searchParams.get('offset') || '0', 0, 0);
  const random = u.searchParams.get('random') === '1';
  // pool=1: query the curated random pool instead of the Telegram files table
  const fromPool = u.searchParams.get('pool') === '1' || u.searchParams.get('pool') === 'true';
  const table = fromPool ? 'random_pool' : 'files';
  let w = fromPool ? 'WHERE enabled=1' : "WHERE processing_state='completed' AND deleted_at IS NULL"; const p = [];
  // 级别对等：只返回 level <= 密钥级别 的内容；私密内容(is_private=1)仅 vvip 密钥可见
  const lf = levelFilter(keyLevel);
  w += lf.sql; p.push.apply(p, lf.params);
  if (keyLevel !== 'vvip') { w += ' AND is_private=0'; }
  if (type) { w += ' AND file_type=?'; p.push(type); }
  if (tagsParam) { w = appendTagFilter(tagsParam, w, p); }
  if (kw) {
    if (fromPool) { w += ' AND (title LIKE ? OR url LIKE ?)'; p.push('%' + kw + '%', '%' + kw + '%'); }
    else { w += ' AND (file_name LIKE ? OR caption LIKE ?)'; p.push('%' + kw + '%', '%' + kw + '%'); }
  }
  try {
    const randomOrder = (random || fromPool);
    const d1sqlCount = 'SELECT COUNT(*) as total FROM ' + table + ' ' + w;
    const d1sqlSel = randomOrder
      ? 'SELECT * FROM ' + table + ' ' + w + ' ORDER BY RANDOM() LIMIT ?'
      : 'SELECT * FROM ' + table + ' ' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?';
    const myOrder = randomOrder ? 'ORDER BY RAND() LIMIT ?' : 'ORDER BY id DESC LIMIT ? OFFSET ?';
    const countR = await d1Read(env, {
      runFirst: true,
      run: () => env.D1_DB.prepare(d1sqlCount).bind(...p).first(),
      mysqlFn: () => mysqlGet(env, 'SELECT COUNT(*) as total FROM ' + table + ' ' + w, p)
    });
    const selR = await d1Read(env, {
      run: () => env.D1_DB.prepare(d1sqlSel).bind(...(randomOrder ? p.concat([limit]) : p.concat([limit, offset]))).all(),
      mysqlFn: () => mysqlRows(env, 'SELECT * FROM ' + table + ' ' + w + ' ' + myOrder,
        randomOrder ? p.concat([limit]) : p.concat([limit, offset]))
    });
    const mapper = fromPool ? poolFileJson : publicFileJson;
    const rows = (selR.source === 'd1' || selR.source === 'mysql') ? selR.rows : [];
    return json({ ok: true, data: { total: (countR.row && countR.row.total) || 0, limit: limit, offset: offset, source: selR.source, items: rows.map(mapper) } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handlePublicRandom(request, env, keyLevel) {
  const u = new URL(request.url);
  const type = u.searchParams.get('type') || '';
  const tagsParam = u.searchParams.get('tags') || '';
  const count = clampInt(u.searchParams.get('count') || '1', 1, 1, 10);
  // mode=img: 302 to a random file's direct URL (for <img>); default json
  const mode = u.searchParams.get('mode') || 'json';
  // Always from the curated random pool (enabled=1); never falls back to the Telegram bot files
  let w = 'WHERE enabled=1'; const p = [];
  // 级别对等：只抽 level <= 密钥级别 的内容；私密内容(is_private=1)仅 vvip 密钥可见
  const lf = levelFilter(keyLevel);
  w += lf.sql; p.push.apply(p, lf.params);
  if (keyLevel !== 'vvip') { w += ' AND is_private=0'; }
  if (type) { w += ' AND file_type=?'; p.push(type); }
  if (tagsParam) { w = appendTagFilter(tagsParam, w, p); }
  try {
    const myOrder = 'ORDER BY RAND() LIMIT ?';
    const selR = await d1Read(env, {
      run: () => env.D1_DB.prepare('SELECT * FROM random_pool ' + w + ' ORDER BY RANDOM() LIMIT ?').bind(...p, mode === 'img' ? 1 : count).all(),
      mysqlFn: () => mysqlRows(env, 'SELECT * FROM random_pool ' + w + ' ' + myOrder, p.concat([mode === 'img' ? 1 : count]))
    });
    const items = (selR.rows || []).map(poolFileJson);
    if (mode === 'img') {
      if (!items.length) return json({ ok: false, error: 'No file matches' }, 404);
      return new Response('', { status: 302, headers: { Location: items[0].url } });
    }
    return json({ ok: true, data: { source: selR.source, items: items } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// Compact public JSON for a random_pool row
export function poolFileJson(r) {
  return {
    id: r.id, url: r.url, thumb_url: r.thumb_url || r.url,
    title: r.title || '', tags: splitTags(r.tags),
    level: sanitizeLevel(r.level), is_private: r.is_private || 0,
    file_type: r.file_type || 'photo', width: r.width, height: r.height, file_size: r.file_size,
    source: r.source, created_at: r.created_at
  };
}

// ==================== Public upload API ====================
// POST /api/v1/upload?api_key=xxx&pool=1&tags=风景,美女&title=xxx&level=pt&is_private=1
// Body: multipart/form-data, field "file" = 文件内容（默认进 files 表；pool=1 进共享库 random_pool）
// 级别默认 = 密钥级别（级别对等：上传内容级别不得超过密钥级别）；is_private=1 仅 vvip 密钥可用
const PUBLIC_UPLOAD_MAX = 19 * 1024 * 1024; // 19MB
const PUBLIC_UPLOAD_HARD_MAX = 90 * 1024 * 1024; // 90MB: 流式上传硬上限（>19MB 大文件，超过跳过）
const MIME_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain'
};
function classifyExt(ext) {
  const vids = ['mp4', 'mov', 'mkv', 'webm', 'avi'];
  const auds = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'];
  const imgs = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
  let fileType = 'document';
  if (vids.indexOf(ext) !== -1) fileType = 'video';
  else if (auds.indexOf(ext) !== -1) fileType = 'audio';
  else if (imgs.indexOf(ext) !== -1) fileType = 'photo';
  return { fileType: fileType, ct: MIME_MAP[ext] || 'application/octet-stream' };
}
function safeExtFromName(name) {
  return (String(name || 'file.bin').split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
}
export async function handlePublicUpload(request, env, keyLevel) {
  try {
    if (!env.R2_BUCKET) return json({ ok: false, error: 'R2 not configured' }, 500);
    const u = new URL(request.url);
    const pool = u.searchParams.get('pool') === '1' || u.searchParams.get('pool') === 'true';
    const tagsParam = u.searchParams.get('tags') || '';
    const title = String(u.searchParams.get('title') || '').slice(0, 200);
    let groupId = u.searchParams.get('group_id') || '';
    
    // If no group_id in request, get default from admin settings
    if (!groupId) {
      try {
        const setting = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'upload_group_id'").first();
        if (setting && setting.value) groupId = setting.value;
      } catch (e) { /* ignore */ }
    }
    
    // 请求级别不得超过密钥级别（级别对等）；未传 level 时默认 = 密钥级别
    const reqLvRaw = u.searchParams.get('level');
    let reqLevel = reqLvRaw ? sanitizeLevel(reqLvRaw) : keyLevel;
    if (LEVEL_RANK[reqLevel] > LEVEL_RANK[keyLevel]) reqLevel = keyLevel;
    const isPrivate = (u.searchParams.get('is_private') === '1' || u.searchParams.get('is_private') === 'true') && keyLevel === 'vvip' ? 1 : 0;
    const useLevel = isPrivate ? 'vvip' : reqLevel;
    const tags = splitTags(tagsParam).join(',');
    const stream = u.searchParams.get('stream') === '1';
    
    // Get user_id from api_key for filename prefix
    let userId = '';
    const apiKey = u.searchParams.get('api_key') || request.headers.get('X-API-Key');
    if (apiKey) {
      const keyRec = await env.D1_DB.prepare('SELECT id FROM api_keys WHERE key = ?').bind(apiKey).first();
      if (keyRec) userId = String(keyRec.id);
    }

    // 流式分支：>19MB ≤90MB 的大文件，raw body 直接流入 R2，不整块读入 worker 内存
    if (stream) {
      const cl = Number(request.headers.get('Content-Length') || 0);
      if (!cl) return json({ ok: false, error: 'Content-Length required' }, 411);
      if (cl > PUBLIC_UPLOAD_HARD_MAX) return json({ ok: false, error: 'file too large (max 90MB)' }, 413);
      if (cl <= PUBLIC_UPLOAD_MAX) return json({ ok: false, error: 'stream mode only for files >19MB; use multipart' }, 400);
      const name = String(request.headers.get('X-File-Name') || 'file.bin').replace(/[\\/:*?"<>|]/g, '_');
      const ext = safeExtFromName(name);
      const info = classifyExt(ext);
      const ct = request.headers.get('X-File-Type') || info.ct;
      const now = new Date();
      const ym = now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0');
      // Add user_id prefix to filename if available
      const fileNameWithPrefix = userId ? `${userId}_${name}` : name;
      const key = (pool ? 'pool/' : 'files/') + ym + '/' + randHex(16) + '.' + ext;
      const url = await putR2Stream(key, request.body, ct, env);
      if (!url) return json({ ok: false, error: 'R2 upload failed' }, 500);
      const iso = now.toISOString();
      if (pool) {
        await env.D1_DB.prepare('INSERT INTO random_pool (url, thumb_url, title, tags, level, is_private, file_type, file_size, source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
          .bind(url, url, title || fileNameWithPrefix, tags, useLevel, isPrivate, info.fileType, cl, 'api', iso).run();
        return json({ ok: true, data: { url: url, added: 1, pool: true, level: useLevel, is_private: isPrivate, file_type: info.fileType, file_size: cl } });
      }
      const res = await env.D1_DB.prepare('INSERT INTO files (storage_key, r2_url, file_name, file_size, file_type, mime_type, caption, tags, level, is_private, group_ref, processing_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'completed\', ?)')
        .bind(key, url, fileNameWithPrefix, cl, info.fileType, ct, title, tags, useLevel, isPrivate, groupId, iso).run();
      fireWebhook(env, 'file_imported', { source: 'api', id: res.meta?.last_row_id || null, url: url, file_name: fileNameWithPrefix, file_type: info.fileType, level: useLevel, is_private: isPrivate, file_size: cl, title: title, tags: tags, group_id: groupId }).catch(function(){});
      invalidateStatsCache();
      return json({ ok: true, data: { id: res.meta?.last_row_id || null, url: url, added: 1, pool: false, level: useLevel, is_private: isPrivate, file_type: info.fileType, file_size: cl, group_id: groupId } });
    }

    const fd = await request.formData().catch(function(){ return null; });
    if (!fd) return json({ ok: false, error: 'multipart/form-data required (field "file")' }, 400);
    const file = fd.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return json({ ok: false, error: 'file field required' }, 400);
    if (file.size > PUBLIC_UPLOAD_MAX) return json({ ok: false, error: 'file too large (max 19MB)' }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length) return json({ ok: false, error: 'empty file' }, 400);

    const name = String(file.name || 'file.bin').replace(/[\\/:*?"<>|]/g, '_');
    const ext = safeExtFromName(name);
    const info = classifyExt(ext);
    const ct = info.ct;
    const fileType = info.fileType;
    const now = new Date();
    const ym = now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0');
    // Add user_id prefix to filename if available
    const fileNameWithPrefix = userId ? `${userId}_${name}` : name;
    const key = (pool ? 'pool/' : 'files/') + ym + '/' + randHex(16) + '.' + ext;
    const url = await putR2(key, bytes, ct, env);
    if (!url) return json({ ok: false, error: 'R2 upload failed' }, 500);

    const iso = now.toISOString();
    if (pool) {
      await env.D1_DB.prepare('INSERT INTO random_pool (url, thumb_url, title, tags, level, is_private, file_type, file_size, source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
        .bind(url, url, title || fileNameWithPrefix, tags, useLevel, isPrivate, fileType, bytes.length, 'api', iso).run();
      return json({ ok: true, data: { url: url, added: 1, pool: true, level: useLevel, is_private: isPrivate, file_type: fileType, file_size: bytes.length } });
    }
    const res = await env.D1_DB.prepare('INSERT INTO files (storage_key, r2_url, file_name, file_size, file_type, mime_type, caption, tags, level, is_private, group_ref, processing_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'completed\', ?)')
      .bind(key, url, fileNameWithPrefix, bytes.length, fileType, ct, title, tags, useLevel, isPrivate, groupId, iso).run();
    fireWebhook(env, 'file_imported', { source: 'api', id: res.meta?.last_row_id || null, url: url, file_name: fileNameWithPrefix, file_type: fileType, level: useLevel, is_private: isPrivate, file_size: bytes.length, title: title, tags: tags, group_id: groupId }).catch(function(){});
    invalidateStatsCache();
    return json({ ok: true, data: { id: res.meta?.last_row_id || null, url: url, added: 1, pool: false, level: useLevel, is_private: isPrivate, file_type: fileType, file_size: bytes.length, group_id: groupId } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== Admin: tags / api keys / users ====================
export async function handleAdminTags(env) {
  try {
    const d1 = await env.D1_DB.prepare("SELECT tags FROM files WHERE processing_state='completed' AND deleted_at IS NULL AND tags IS NOT NULL AND tags != ''").all();
    const d2 = await env.D1_DB.prepare("SELECT tags FROM random_pool WHERE enabled=1 AND tags IS NOT NULL AND tags != ''").all();
    const cnt = {};
    [d1, d2].forEach(function(res) {
      (res.results || []).forEach(function(r) {
        const seen = {};
        splitTags(r.tags).forEach(function(t) {
          t = t.trim();
          if (t && !seen[t]) { seen[t] = 1; cnt[t] = (cnt[t] || 0) + 1; }  // 行内去重，防止 a,a 计两次
        });
      });
    });
    const arr = Object.keys(cnt).map(function(t) { return { tag: t, count: cnt[t] }; }).sort(function(a, b) { return b.count - a.count; });
    return json({ ok: true, data: arr });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== 标签 CRUD ====================
export async function handleAdminTagList(env) {
  try {
    // 自动迁移：扫描 files/random_pool/pool_tags_preset 中已用标签，自动写入 tags 表
    const d1 = await env.D1_DB.prepare("SELECT tags FROM files WHERE processing_state='completed' AND deleted_at IS NULL AND tags IS NOT NULL AND tags != ''").all();
    const d2 = await env.D1_DB.prepare("SELECT tags FROM random_pool WHERE enabled=1 AND tags IS NOT NULL AND tags != ''").all();
    const cnt = {};
    [d1, d2].forEach(function(res) {
      (res.results || []).forEach(function(r) {
        const seen = {};
        splitTags(r.tags).forEach(function(t) {
          t = t.trim();
          if (t && !seen[t]) { seen[t] = 1; cnt[t] = (cnt[t] || 0) + 1; }
        });
      });
    });
    // 扫描 pool_tags_preset（预设标签库）和 auto_pool_tags 设置
    try {
      const s1 = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='pool_tags_preset'").first();
      if (s1 && s1.value) {
        var arr1 = []; try { arr1 = JSON.parse(s1.value); } catch (e) { arr1 = splitTags(String(s1.value)); }
        if (Array.isArray(arr1)) arr1.forEach(function(t) { t = String(t).trim(); if (t) cnt[t] = cnt[t] || 0; });
      }
    } catch (e) {}
    try {
      const s2 = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='auto_pool_tags'").first();
      if (s2 && s2.value) {
        var arr2 = []; try { arr2 = JSON.parse(s2.value); } catch (e) { arr2 = splitTags(String(s2.value)); }
        if (Array.isArray(arr2)) arr2.forEach(function(t) { t = String(t).trim(); if (t) cnt[t] = cnt[t] || 0; });
      }
    } catch (e) {}
    // 将未入库的标签自动插入 tags 表
    const now = cnNowISO();
    for (const name of Object.keys(cnt)) {
      try {
        await env.D1_DB.prepare("INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, ?)").bind(name, now).run();
      } catch (e) { /* UNIQUE 冲突忽略 */ }
    }
    // 读取 tags 表
    const d = await env.D1_DB.prepare("SELECT * FROM tags ORDER BY sort_order ASC, name ASC").all();
    const tags = d.results || [];
    const result = tags.map(function(t) { return { id: t.id, name: t.name, color: t.color || '', category: t.category || '', sort_order: t.sort_order || 0, created_at: t.created_at || '', count: cnt[t.name] || 0 }; });
    return json({ ok: true, data: result });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminTagCreate(request, env) {
  try {
    const b = await request.json().catch(function() { return {}; });
    const name = String(b.name || '').trim();
    if (!name) return json({ ok: false, error: '标签名不能为空' });
    const color = String(b.color || '').trim();
    const category = String(b.category || '').trim();
    const sort_order = parseInt(b.sort_order) || 0;
    const now = cnNowISO();
    // 支持批量创建（逗号分隔）
    const names = name.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    const created = [];
    for (const n of names) {
      try {
        await env.D1_DB.prepare("INSERT INTO tags (name, color, category, sort_order, created_at) VALUES (?, ?, ?, ?, ?)").bind(n, color, category, sort_order, now).run();
        created.push(n);
      } catch (e) {
        // UNIQUE 冲突跳过
        if (e.message && e.message.indexOf('UNIQUE') !== -1) continue;
        throw e;
      }
    }
    return json({ ok: true, data: { created: created } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminTagUpdate(request, env) {
  try {
    const b = await request.json().catch(function() { return {}; });
    const id = parseInt(b.id);
    if (!id) return json({ ok: false, error: 'id required' });
    const set = [];
    const vals = [];
    if (b.name !== undefined) { const n = String(b.name).trim(); if (!n) return json({ ok: false, error: '标签名不能为空' }); set.push('name=?'); vals.push(n); }
    if (b.color !== undefined) { set.push('color=?'); vals.push(String(b.color).trim()); }
    if (b.category !== undefined) { set.push('category=?'); vals.push(String(b.category).trim()); }
    if (b.sort_order !== undefined) { set.push('sort_order=?'); vals.push(parseInt(b.sort_order) || 0); }
    if (!set.length) return json({ ok: true, data: { updated: false } });
    vals.push(id);
    await env.D1_DB.prepare('UPDATE tags SET ' + set.join(',') + ' WHERE id=?').bind(...vals).run();
    // 如果改了 name，同步更新 files/random_pool 里的旧标签名
    if (b.name !== undefined && b.old_name) {
      const oldName = String(b.old_name).trim();
      const newName = String(b.name).trim();
      if (oldName && newName && oldName !== newName) {
        const tables = ['files', 'random_pool'];
        for (const tbl of tables) {
          const rows = await env.D1_DB.prepare("SELECT id,tags FROM " + tbl + " WHERE tags LIKE ? OR tags LIKE ? OR tags = ?").bind('%' + oldName + '%', '%' + oldName + '%', oldName).all();
          for (const r of (rows.results || [])) {
            const tags = splitTags(r.tags).map(function(t) { return t.trim() === oldName ? newName : t; });
            await env.D1_DB.prepare("UPDATE " + tbl + " SET tags=? WHERE id=?").bind(tags.join(','), r.id).run();
          }
        }
      }
    }
    return json({ ok: true, data: { updated: true } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminTagDelete(request, env) {
  try {
    const b = await request.json().catch(function() { return {}; });
    const id = parseInt(b.id);
    if (!id) return json({ ok: false, error: 'id required' });
    // 先获取标签名，用于可选的级联清理
    const tag = await env.D1_DB.prepare("SELECT name FROM tags WHERE id=?").bind(id).first();
    await env.D1_DB.prepare("DELETE FROM tags WHERE id=?").bind(id).run();
    // 如果 b.cleanup=true，同时从 files/random_pool 中移除该标签
    if (b.cleanup && tag && tag.name) {
      const name = tag.name;
      const tables = ['files', 'random_pool'];
      for (const tbl of tables) {
        const rows = await env.D1_DB.prepare("SELECT id," + tbl + ".tags FROM " + tbl + " WHERE " + tbl + ".tags LIKE ? OR " + tbl + ".tags = ?").bind('%' + name + '%', name).all();
        for (const r of (rows.results || [])) {
          const tags = splitTags(r.tags).filter(function(t) { return t.trim() !== name; });
          await env.D1_DB.prepare("UPDATE " + tbl + " SET tags=? WHERE id=?").bind(tags.join(','), r.id).run();
        }
      }
    }
    return json({ ok: true, data: { deleted: true } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleSetFileTags(request, env) {
  try {
    const b = await request.json().catch(function() { return {}; });
    const ids = b.ids || (b.id ? [b.id] : []);
    if (!ids.length) return json({ ok: false, error: 'ids required' });
    const mode = b.mode || 'set';
    const tagsArr = (b.tags || []).map(function(s) { return String(s).trim(); }).filter(Boolean);
    const autoTags = await getAutoPoolTags(env);
    let updated = 0;
    for (const id of ids) {
      if (mode === 'set') {
        await env.D1_DB.prepare('UPDATE files SET tags=? WHERE id=? AND deleted_at IS NULL').bind(Array.from(new Set(tagsArr)).join(','), id).run();
        // set 全量语义：命中自动入共享库标签即触发（去重由 importFileToPool 保证）
        if (autoTags.length && tagsArr.some(function(t){ return autoTags.indexOf(t) !== -1; })) {
          const f = await env.D1_DB.prepare('SELECT * FROM files WHERE id=? AND deleted_at IS NULL').bind(id).first();
          if (f) await importFileToPool(f, { level: f.level, isPrivate: 0 }, env);
        }
      } else {
        const f = await env.D1_DB.prepare('SELECT * FROM files WHERE id=? AND deleted_at IS NULL').bind(id).first();
        const oldArr = (f && f.tags) ? splitTags(f.tags) : [];
        let cur = oldArr.slice();
        let hitAuto = false;
        if (mode === 'append') {
          tagsArr.forEach(function(t) { if (cur.indexOf(t) === -1) cur.push(t); });
          // 仅「本次实际新增」的标签参与自动入共享库判定
          hitAuto = autoTags.length && tagsArr.some(function(t){ return autoTags.indexOf(t) !== -1 && oldArr.indexOf(t) === -1; });
        } else if (mode === 'remove') {
          cur = cur.filter(function(t) { return tagsArr.indexOf(t) === -1; });
        }
        await env.D1_DB.prepare('UPDATE files SET tags=? WHERE id=? AND deleted_at IS NULL').bind(Array.from(new Set(cur)).join(','), id).run();
        if (f && hitAuto) await importFileToPool(f, { level: f.level, isPrivate: 0 }, env);
      }
      updated++;
    }
    return json({ ok: true, data: { updated: updated } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}


// 校验 key-pass 登录（user.html 用户门户）：key + key_pass 匹配且密钥有效
// 返回 api_keys 记录（不含 key_pass 字段），失败返回 null
export async function checkUserPortal(request, env) {
  if (!env.D1_DB) return null;
  const b = await request.json().catch(function() { return {}; });
  const key = String(b.key || b.api_key || '').trim();
  const pass = String(b.key_pass || '').trim();
  if (!key || !pass) return null;
  try {
    const rec = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key=? AND enabled=1 AND (expires_at IS NULL OR expires_at=\'\' OR expires_at >= date(\'now\')) LIMIT 1').bind(key).first();
    if (!rec || !rec.key_pass) return null;
    const hp = await hashKeyPass(pass, key);
    if (hp !== rec.key_pass) return null;
    delete rec.key_pass;
    return rec;
  } catch (e) { log.error('checkUserPortal:', e.message); return null; }
}

export async function handleAdminKeys(env) {
  try {
    const d = await env.D1_DB.prepare('SELECT id,key,short_key,name,scopes,level,enabled,expires_at,created_at,last_used_at,usage_count,key_pass,username FROM api_keys ORDER BY id DESC').all();
    const today = cnTodayStr();
    const out = (d.results || []).map(function(k) {
      const exp = k.expires_at || '';
      k.expired = exp ? (exp < today ? 1 : 0) : 0;
      k.has_pass = !!(k.key_pass);
      delete k.key_pass;
      return k;
    });
    return json({ ok: true, data: out });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminKeysCreate(request, env) {
  try {
    const b = await request.json().catch(function() { return {}; });
    const name = String(b.name || '').slice(0, 60);
    const scopes = String(b.scopes || 'files:read').slice(0, 120);
    const expires_at = String(b.expires_at || '').trim().slice(0, 10); // YYYY-MM-DD，空=永久
    const level = sanitizeLevel(b.level);
    const key = genApiKey();
    const short_key = genShortKey();
    const key_pass = String(b.key_pass || '').slice(0, 64);
    const passHash = key_pass ? await hashKeyPass(key_pass, key) : '';
    const r = await env.D1_DB.prepare('INSERT INTO api_keys (key,name,scopes,level,enabled,created_at,usage_count,expires_at,key_pass,username,short_key) VALUES (?,?,?,?,1,?,0,?,?,?,?)').bind(key, name, scopes, level, cnNowISO(), expires_at, passHash, '', short_key).run();
    return json({ ok: true, data: { id: r.meta?.last_row_id, key: key, short_key: short_key, name: name, scopes: scopes, level: level, expires_at: expires_at, has_pass: !!passHash } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 编辑密钥：改名称 / 改到期时间 / 改级别 / 设置或清除登录密码 key-pass（PATCH /admin/api/keys?id=xxx）
export async function handleAdminKeysUpdate(request, env) {
  try {
    const u = new URL(request.url);
    const id = parseInt(u.searchParams.get('id') || '0', 10);
    if (!id) return json({ ok: false, error: 'id required' });
    const b = await request.json().catch(function() { return {}; });
    const fields = [], vals = [];
    if (b.name !== undefined) { fields.push('name = ?'); vals.push(String(b.name).slice(0, 60)); }
    if (b.expires_at !== undefined) { fields.push('expires_at = ?'); vals.push(String(b.expires_at || '').trim().slice(0, 10)); }
    if (b.level !== undefined) { fields.push('level = ?'); vals.push(sanitizeLevel(b.level)); }
    if (b.scopes !== undefined) { fields.push('scopes = ?'); vals.push(String(b.scopes || 'files:read').trim().slice(0, 120)); }
    if (b.key_pass !== undefined) {
      // 需要真实 key 做加盐哈希
      const cur = await env.D1_DB.prepare('SELECT key FROM api_keys WHERE id=?').bind(id).first();
      if (cur && cur.key) {
        const kp = String(b.key_pass || '').slice(0, 64);
        fields.push('key_pass = ?');
        vals.push(kp ? await hashKeyPass(kp, cur.key) : '');
      }
    }
    if (!fields.length) return json({ ok: false, error: 'nothing to update' });
    vals.push(id);
    await env.D1_DB.prepare('UPDATE api_keys SET ' + fields.join(', ') + ' WHERE id = ?').bind(...vals).run();
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminKeysToggle(request, env) {
  try {
    const b = await request.json().catch(function() { return {}; });
    if (!b.id) return json({ ok: false, error: 'id required' });
    await env.D1_DB.prepare('UPDATE api_keys SET enabled=? WHERE id=?').bind(b.enabled ? 1 : 0, b.id).run();
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminKeysDelete(request, env) {
  try {
    const u = new URL(request.url);
    const id = u.searchParams.get('id');
    if (!id) return json({ ok: false, error: 'id required' });
    await env.D1_DB.prepare('DELETE FROM api_keys WHERE id=?').bind(id).run();
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== 密钥用户管理 ====================
// 列出注册用户（username 非空，即通过兑换码自助注册的账号），含密钥信息与调用统计
export async function handleAdminKeyUsers(env) {
  try {
    const d = await env.D1_DB.prepare(
      "SELECT a.id, a.key, a.name, a.scopes, a.level, a.enabled, a.created_at, a.last_used_at, a.usage_count, a.expires_at, a.username, a.key_pass, " +
      "(SELECT COUNT(*) FROM api_call_logs c WHERE c.key_id = a.id) AS call_count, " +
      "(SELECT COUNT(*) FROM api_call_logs c WHERE c.key_id = a.id AND c.created_at >= datetime('now', '-1 hour')) AS calls_1h " +
      "FROM api_keys a WHERE a.username IS NOT NULL AND a.username != '' ORDER BY a.id DESC").all();
    const today = cnTodayStr();
    const out = (d.results || []).map(function(k) {
      const exp = k.expires_at || '';
      k.expired = exp ? (exp < today ? 1 : 0) : 0;
      k.has_pass = !!(k.key_pass);
      delete k.key_pass;
      return k;
    });
    return json({ ok: true, data: out });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 用户名查重（注册前/后台编辑时校验）：username 已存在则返回 taken:true
export async function handleAdminUsernameCheck(request, env) {
  try {
    const b = await request.json().catch(function() { return {}; });
    const username = String(b.username || '').trim();
    if (!username) return json({ ok: true, data: { taken: false } });
    const cur = await env.D1_DB.prepare('SELECT id FROM api_keys WHERE username=? LIMIT 1').bind(username).first();
    const excludeId = parseInt(b.exclude_id || '0', 10);
    const taken = !!(cur && (!excludeId || cur.id !== excludeId));
    return json({ ok: true, data: { taken: taken } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== 兑换码管理 ====================
export async function handleAdminRedeemList(env) {
  try {
    const d = await env.D1_DB.prepare('SELECT * FROM redeem_codes ORDER BY id DESC').all();
    return json({ ok: true, data: d.results || [] });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 生成兑换码：{count, type, level, quota, note, expires_at, days, extend_days}
// type: register=注册码（默认，兑换后创建新密钥） / upgrade=权限升级码（兑换后提升已有密钥级别） / extend=延时码（兑换后延长已有密钥到期时间）
export async function handleAdminRedeemCreate(request, env) {
  try {
    const b = await request.json().catch(function() { return {}; });
    let count = parseInt(b.count || '1', 10);
    if (isNaN(count) || count < 1) count = 1;
    if (count > 200) count = 200;
    const type = ['register', 'upgrade', 'extend'].indexOf(b.type) !== -1 ? b.type : 'register';
    const level = sanitizeLevel(b.level);
    let quota = parseInt(b.quota || '1', 10);
    if (isNaN(quota) || quota < 1) quota = 1;
    const extendDays = clampInt(b.extend_days, 0, 0, 3650);
    const note = String(b.note || '').slice(0, 120);
    // 到期时间：优先取 days（从今天起），否则取明确日期
    let expires_at = String(b.expires_at || '').trim().slice(0, 10);
    const days = parseInt(b.days || '0', 10);
    if (!expires_at && days > 0) {
      const d = new Date(Date.now() + 8 * 3600 * 1000);
      d.setDate(d.getDate() + days);
      expires_at = d.toISOString().slice(0, 10);
    }
    const codes = [], now = cnNowISO();
    for (let i = 0; i < count; i++) {
      const code = genRedeemCode();
      await env.D1_DB.prepare('INSERT INTO redeem_codes (code,level,quota,used_count,note,enabled,created_at,expires_at,type,extend_days) VALUES (?,?,?,0,?,1,?,?,?,?)').bind(code, level, quota, note, now, expires_at, type, extendDays).run();
      codes.push(code);
    }
    return json({ ok: true, data: { count: codes.length, codes: codes, type: type, level: level, quota: quota, note: note, expires_at: expires_at, extend_days: extendDays } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminRedeemUpdate(request, env) {
  try {
    const u = new URL(request.url);
    const id = parseInt(u.searchParams.get('id') || '0', 10);
    if (!id) return json({ ok: false, error: 'id required' });
    const b = await request.json().catch(function() { return {}; });
    const fields = [], vals = [];
    if (b.type !== undefined) { fields.push('type = ?'); vals.push(['register', 'upgrade', 'extend'].indexOf(b.type) !== -1 ? b.type : 'register'); }
    if (b.level !== undefined) { fields.push('level = ?'); vals.push(sanitizeLevel(b.level)); }
    if (b.quota !== undefined) {
      let q = parseInt(b.quota, 10);
      if (isNaN(q) || q < 1) q = 1;
      fields.push('quota = ?'); vals.push(q);
    }
    if (b.extend_days !== undefined) { fields.push('extend_days = ?'); vals.push(clampInt(b.extend_days, 0, 0, 3650)); }
    if (b.enabled !== undefined) { fields.push('enabled = ?'); vals.push(b.enabled ? 1 : 0); }
    if (b.expires_at !== undefined) { fields.push('expires_at = ?'); vals.push(String(b.expires_at || '').trim().slice(0, 10)); }
    if (b.note !== undefined) { fields.push('note = ?'); vals.push(String(b.note || '').slice(0, 120)); }
    if (!fields.length) return json({ ok: false, error: 'nothing to update' });
    vals.push(id);
    await env.D1_DB.prepare('UPDATE redeem_codes SET ' + fields.join(', ') + ' WHERE id = ?').bind(...vals).run();
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminRedeemDelete(request, env) {
  try {
    const u = new URL(request.url);
    const id = u.searchParams.get('id');
    if (!id) return json({ ok: false, error: 'id required' });
    await env.D1_DB.prepare('DELETE FROM redeem_codes WHERE id=?').bind(id).run();
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== 调用日志 ====================
// admin：全部调用日志（分页 + 按密钥/路径筛选）
export async function handleAdminCallLogs(request, env) {
  try {
    const u = new URL(request.url);
    const page = clampInt(u.searchParams.get('page') || '1', 1, 1);
    const page_size = clampInt(u.searchParams.get('page_size') || '50', 50, 1, 200);
    const key_id = u.searchParams.get('key_id');
    const kw = u.searchParams.get('kw') || '';
    let w = 'WHERE 1=1'; const p = [];
    if (key_id) { w += ' AND key_id = ?'; p.push(parseInt(key_id, 10)); }
    if (kw) {
      w += ' AND (api_key LIKE ? OR path LIKE ? OR ip LIKE ?)';
      p.push('%' + kw + '%', '%' + kw + '%', '%' + kw + '%');
    }
    const t = await env.D1_DB.prepare('SELECT COUNT(*) AS total FROM api_call_logs ' + w).bind(...p).first();
    const d = await env.D1_DB.prepare('SELECT * FROM api_call_logs ' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?').bind(...p, page_size, (page - 1) * page_size).all();
    return json({ ok: true, data: { total: t?.total || 0, page: page, page_size: page_size, items: d.results || [] } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// admin：最近 1h/6h/24h 调用统计（总数 + 各密钥维度）
export async function handleAdminCallStats(env) {
  try {
    const now = Date.now();
    const mk = function(hours) {
      const cutoff = new Date(now - hours * 3600 * 1000).toISOString();
      return cutoff;
    };
    const total = function(cutoff) {
      return env.D1_DB.prepare("SELECT COUNT(*) AS total FROM api_call_logs WHERE created_at >= ?").bind(cutoff).first();
    };
    const byKey = function(cutoff) {
      return env.D1_DB.prepare(
        "SELECT c.key_id, a.username, a.name, a.level, COUNT(*) AS calls " +
        "FROM api_call_logs c LEFT JOIN api_keys a ON a.id = c.key_id " +
        "WHERE c.created_at >= ? GROUP BY c.key_id ORDER BY calls DESC LIMIT 20").bind(cutoff).all();
    };
    const [t1, t6, t24, k1, k6, k24] = await Promise.all([total(mk(1)), total(mk(6)), total(mk(24)), byKey(mk(1)), byKey(mk(6)), byKey(mk(24))]);
    return json({ ok: true, data: {
      h1: { total: t1?.total || 0, byKey: (k1.results || []) },
      h6: { total: t6?.total || 0, byKey: (k6.results || []) },
      h24: { total: t24?.total || 0, byKey: (k24.results || []) }
    } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== 用户门户：注册 / 调用日志 ====================
// 用户自助注册：用兑换码兑换一个新密钥（生成 username + key-pass 自动登录）
export async function handleUserRegister(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'DB unavailable' }, 500);
  try {
    const b = await request.json().catch(function() { return {}; });
    const username = String(b.username || '').trim().slice(0, 40);
    const pass = String(b.password || '').trim().slice(0, 64);
    const code = String(b.code || b.redeem_code || '').trim().toUpperCase();
    if (!username) return json({ ok: false, error: '请填写用户名' }, 400);
    if (!pass) return json({ ok: false, error: '请填写登录密码' }, 400);
    if (pass.length < 6) return json({ ok: false, error: '密码至少 6 位' }, 400);
    if (!code) return json({ ok: false, error: '请填写兑换码' }, 400);
    // 用户名唯一
    const dup = await env.D1_DB.prepare('SELECT id FROM api_keys WHERE username=? LIMIT 1').bind(username).first();
    if (dup) return json({ ok: false, error: '用户名已被占用，请换一个' }, 400);
    // 兑换码校验：存在、启用、未过期、未用完
    const rc = await env.D1_DB.prepare('SELECT * FROM redeem_codes WHERE code=? LIMIT 1').bind(code).first();
    if (!rc) return json({ ok: false, error: '兑换码不存在' }, 400);
    if (!rc.enabled) return json({ ok: false, error: '兑换码已停用' }, 400);
    if (rc.expires_at && rc.expires_at < cnTodayStr()) return json({ ok: false, error: '兑换码已过期' }, 400);
    if (rc.used_count >= rc.quota) return json({ ok: false, error: '兑换码已用完' }, 400);
    // 生成密钥并兑换
    const key = genApiKey();
    const short_key = genShortKey();
    const passHash = await hashKeyPass(pass, key);
    const now = cnNowISO();
    await env.D1_DB.prepare('INSERT INTO api_keys (key,name,scopes,level,enabled,created_at,usage_count,expires_at,key_pass,username,short_key) VALUES (?,?,?,?,1,?,0,\'\',?,?,?)')
      .bind(key, username, 'files:read', rc.level, now, passHash, username, short_key).run();
    await env.D1_DB.prepare('UPDATE redeem_codes SET used_count = used_count + 1 WHERE id = ?').bind(rc.id).run();
    return json({ ok: true, data: { username: username, key: key, short_key: short_key, level: rc.level, name: username } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 用户门户：登录后兑换升级码 / 延时码
// upgrade：提升密钥级别为目标 level（仅升不降）；extend：按 extend_days 延长密钥到期时间（在原到期基础上累加）
export async function handleUserRedeem(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'DB unavailable' }, 500);
  try {
    const b = await request.json().catch(function() { return {}; });
    const key = String(b.key || b.api_key || '').trim();
    const pass = String(b.key_pass || '').trim();
    const code = String(b.code || b.redeem_code || '').trim().toUpperCase();
    if (!key || !pass) return json({ ok: false, error: '登录状态失效，请重新登录' }, 401);
    if (!code) return json({ ok: false, error: '请填写兑换码' }, 400);
    // 校验兑换码：存在、启用、未过期、未用完
    const rc = await env.D1_DB.prepare('SELECT * FROM redeem_codes WHERE code=? LIMIT 1').bind(code).first();
    if (!rc) return json({ ok: false, error: '兑换码不存在' }, 400);
    if (!rc.enabled) return json({ ok: false, error: '兑换码已停用' }, 400);
    if (rc.expires_at && rc.expires_at < cnTodayStr()) return json({ ok: false, error: '兑换码已过期' }, 400);
    if (rc.used_count >= rc.quota) return json({ ok: false, error: '兑换码已用完' }, 400);
    const type = rc.type || 'register';
    if (type === 'register') return json({ ok: false, error: '注册码只能用于新用户注册，升级/续期请使用对应类型兑换码' }, 400);
    if (type !== 'upgrade' && type !== 'extend') return json({ ok: false, error: '未知兑换码类型' }, 400);
    // 校验当前登录密钥（仅需有效 key+key-pass，不要求未过期，便于续期到期账户）
    const rec = await env.D1_DB.prepare('SELECT id,level,expires_at,key_pass,username FROM api_keys WHERE key=? AND enabled=1 LIMIT 1').bind(key).first();
    if (!rec || !rec.key_pass) return json({ ok: false, error: '密钥不存在或已停用' }, 401);
    const hp = await hashKeyPass(pass, key);
    if (hp !== rec.key_pass) return json({ ok: false, error: '密码不正确' }, 401);
    if (type === 'upgrade') {
      const target = sanitizeLevel(rc.level);
      const curRank = LEVEL_RANK[rec.level] === undefined ? 0 : LEVEL_RANK[rec.level];
      const tgtRank = LEVEL_RANK[target] === undefined ? 0 : LEVEL_RANK[target];
      if (tgtRank <= curRank) return json({ ok: false, error: '升级码级别不高于当前级别，无需升级' }, 400);
      await env.D1_DB.prepare('UPDATE api_keys SET level=? WHERE id=?').bind(target, rec.id).run();
      await env.D1_DB.prepare('UPDATE redeem_codes SET used_count = used_count + 1 WHERE id = ?').bind(rc.id).run();
      return json({ ok: true, data: { action: 'upgrade', level: target } });
    }
    // extend：在原到期时间（或今天）基础上累加 extend_days 天
    const days = clampInt(rc.extend_days, 0, 0, 3650);
    if (days <= 0) return json({ ok: false, error: '该延时码未设置有效天数' }, 400);
    let base = cnTodayStr();
    if (rec.expires_at && rec.expires_at >= cnTodayStr() && rec.expires_at > base) base = rec.expires_at;
    const d = new Date(base + 'T00:00:00+08:00');
    d.setDate(d.getDate() + days);
    const newExpires = d.toISOString().slice(0, 10);
    await env.D1_DB.prepare('UPDATE api_keys SET expires_at=? WHERE id=?').bind(newExpires, rec.id).run();
    await env.D1_DB.prepare('UPDATE redeem_codes SET used_count = used_count + 1 WHERE id = ?').bind(rc.id).run();
    return json({ ok: true, data: { action: 'extend', expires_at: newExpires, days: days } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 用户门户：当前密钥的调用日志（最近 200 条）
export async function handleUserCallLogs(rec, env) {  try {
    const d = await env.D1_DB.prepare('SELECT id,path,method,ip,status,created_at FROM api_call_logs WHERE key_id=? ORDER BY id DESC LIMIT 200').bind(rec.id).all();
    return json({ ok: true, data: (d.results || []) });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 用户门户：当前密钥最近 1h/6h/24h 调用统计
export async function handleUserCallStats(rec, env) {
  try {
    const now = Date.now();
    const total = function(hours) {
      const cutoff = new Date(now - hours * 3600 * 1000).toISOString();
      return env.D1_DB.prepare('SELECT COUNT(*) AS total FROM api_call_logs WHERE key_id=? AND created_at >= ?').bind(rec.id, cutoff).first();
    };
    const [t1, t6, t24] = await Promise.all([total(1), total(6), total(24)]);
    return json({ ok: true, data: { h1: t1?.total || 0, h6: t6?.total || 0, h24: t24?.total || 0 } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 用户门户：密码重置（通过用户名 + 旧密码验证，设置新密码）
export async function handleUserResetPassword(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'DB unavailable' }, 500);
  try {
    const b = await request.json().catch(function() { return {}; });
    const username = String(b.username || '').trim();
    const oldPass = String(b.old_password || '').trim();
    const newPass = String(b.new_password || '').trim();
    if (!username) return json({ ok: false, error: '请填写用户名' }, 400);
    if (!oldPass) return json({ ok: false, error: '请填写旧密码' }, 400);
    if (!newPass) return json({ ok: false, error: '请填写新密码' }, 400);
    if (newPass.length < 6) return json({ ok: false, error: '新密码至少 6 位' }, 400);
    if (oldPass === newPass) return json({ ok: false, error: '新密码不能与旧密码相同' }, 400);
    // 查找用户
    const rec = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE username=? AND enabled=1 LIMIT 1').bind(username).first();
    if (!rec) return json({ ok: false, error: '用户名或密码不正确' }, 401);
    // 验证旧密码
    const hp = await hashKeyPass(oldPass, rec.key);
    if (hp !== rec.key_pass) return json({ ok: false, error: '用户名或密码不正确' }, 401);
    // 设置新密码
    const newPassHash = await hashKeyPass(newPass, rec.key);
    await env.D1_DB.prepare('UPDATE api_keys SET key_pass=? WHERE id=?').bind(newPassHash, rec.id).run();
    return json({ ok: true, message: '密码重置成功' });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 用户门户：密钥信息查询（通过用户名 + 密码获取密钥信息）
export async function handleUserGetKeyInfo(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'DB unavailable' }, 500);
  try {
    const b = await request.json().catch(function() { return {}; });
    const username = String(b.username || '').trim();
    const pass = String(b.password || '').trim();
    if (!username || !pass) return json({ ok: false, error: '请填写用户名和密码' }, 400);
    // 查找用户
    const rec = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE username=? AND enabled=1 LIMIT 1').bind(username).first();
    if (!rec) return json({ ok: false, error: '用户名或密码不正确' }, 401);
    // 验证密码
    const hp = await hashKeyPass(pass, rec.key);
    if (hp !== rec.key_pass) return json({ ok: false, error: '用户名或密码不正确' }, 401);
    // 返回密钥信息（不包含密码哈希）
    return json({ ok: true, data: {
      key: rec.key,
      short_key: rec.short_key || '',
      name: rec.name,
      username: rec.username || '',
      level: rec.level,
      expires_at: rec.expires_at || '',
      created_at: rec.created_at || '',
      last_used_at: rec.last_used_at || '',
      usage_count: rec.usage_count || 0
    } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 用户聊天交互统计：按 update 类型累加 user_stats 表（消息/命令/文件/Inline 查询/按钮回调）
// 记录已知会话（known_chats）：从各类 update 中提取 chat 并 upsert。
// 广播快捷回复键盘 / 告警通知依赖这张表（此前只从 files 表找 private，纯文本私聊没有文件记录导致广播 0 个）
export async function recordKnownChat(update, env) {
  try {
    let chat = null;
    if (update.message && update.message.chat) chat = update.message.chat;
    else if (update.channel_post && update.channel_post.chat) chat = update.channel_post.chat;
    else if (update.callback_query && update.callback_query.message && update.callback_query.message.chat) chat = update.callback_query.message.chat;
    else if (update.inline_query && update.inline_query.from) {
      // inline 查询没有 chat 对象，用 from.id 作为私聊 chat_id（@bot 搜索来自用户私聊/群，仍记一个已知用户）
      chat = { id: update.inline_query.from.id, type: 'private', title: '', username: update.inline_query.from.username || '' };
    }
    if (!chat || !chat.id) return;
    const cid = String(chat.id);
    if (!cid) return;
    const now = cnNowISO();
    await env.D1_DB.prepare(
      "INSERT INTO known_chats (chat_id, chat_type, chat_title, chat_username, last_active_at) VALUES (?,?,?,?,?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET chat_type=excluded.chat_type, chat_title=excluded.chat_title, chat_username=excluded.chat_username, last_active_at=excluded.last_active_at"
    ).bind(cid, String(chat.type || ''), String(chat.title || ''), String(chat.username || ''), now).run();
  } catch (e) { log.error('recordKnownChat:', e.message); }
}

export async function recordUserInteraction(update, env) {
  try {
    // 提取用户身份
    let user = null, type = null;
    if (update.callback_query && update.callback_query.from) {
      user = update.callback_query.from; type = 'callback_clicks';
    } else if (update.inline_query && update.inline_query.from) {
      user = update.inline_query.from; type = 'inline_queries';
    } else {
      const m = update.message || update.channel_post;
      if (m && m.from) {
        user = m.from;
        const fi = extractFileInfo(m);
        if (fi) type = 'files';
        else if (m.text && String(m.text).indexOf('/') === 0) type = 'commands';
        else type = 'messages';
      }
    }
    if (!user || !user.id || !type) return;
    const uid = parseInt(user.id, 10);
    if (!uid) return;
    const now = cnNowISO();
    const uname = String(user.username || '').slice(0, 64);
    const fname = String(user.first_name || user.last_name || '').slice(0, 128);
    const col = type === 'messages' ? 'messages' : type === 'commands' ? 'commands' : type === 'files' ? 'files' : type === 'inline_queries' ? 'inline_queries' : 'callback_clicks';
    await env.D1_DB.prepare(
      "INSERT INTO user_stats (user_id, username, full_name, " + col + ", last_active_at) VALUES (?,?,?,1,?) " +
      "ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, full_name=excluded.full_name, " + col + "=" + col + "+1, last_active_at=excluded.last_active_at"
    ).bind(uid, uname, fname, now).run();
  } catch (e) { log.error('recordUserInteraction:', e.message); }
}

export async function handleAdminUsers(env) {
  try {
    const d = await env.D1_DB.prepare("SELECT user_id, username, full_name, COUNT(*) as file_count, SUM(file_size) as total_size, MAX(created_at) as last_active FROM files WHERE deleted_at IS NULL GROUP BY user_id ORDER BY file_count DESC LIMIT 100").all();
    return json({ ok: true, data: d.results || [] });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 用户聊天交互统计：user_stats 表聚合（含总计）
export async function handleAdminUsersInteractions(env) {
  try {
    const d = await env.D1_DB.prepare("SELECT user_id, username, full_name, messages, commands, files, inline_queries, callback_clicks, last_active_at FROM user_stats ORDER BY (messages+commands+files+inline_queries+callback_clicks) DESC, last_active_at DESC LIMIT 200").all();
    const rows = d.results || [];
    const sum = function(col) { return rows.reduce(function(a, r) { return a + (parseInt(r[col]) || 0); }, 0); };
    return json({ ok: true, data: rows, total: {
      messages: sum('messages'), commands: sum('commands'), files: sum('files'),
      inline_queries: sum('inline_queries'), callback_clicks: sum('callback_clicks'),
      users: rows.length
    } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== Random pool ====================
export async function handleAdminPoolList(request, env) {
  try {
    const u = new URL(request.url);
    const source = u.searchParams.get('source') || '';
    const enabled = u.searchParams.get('enabled');
    const tagsParam = u.searchParams.get('tags') || '';
    const kw = u.searchParams.get('keyword') || '';
    const idsParam = u.searchParams.get('ids') || '';
    const levelParam = u.searchParams.get('level') || '';
    const folderIdParam = u.searchParams.get('folder_id');
    const limit = clampInt(u.searchParams.get('limit') || '500', 500, 1, 500);
    const offset = clampInt(u.searchParams.get('offset') || '0', 0, 0);
    let w = 'WHERE is_private=0'; const p = [];
    if (source) { w += ' AND source=?'; p.push(source); }
    if (enabled === '1' || enabled === '0') { w += ' AND enabled=?'; p.push(parseInt(enabled)); }
    if (levelParam) { w += ' AND level=?'; p.push(sanitizeLevel(levelParam)); }
    if (tagsParam) { w = appendTagFilter(tagsParam, w, p); }
    if (kw) { w += ' AND (title LIKE ? OR url LIKE ?)'; p.push('%' + kw + '%', '%' + kw + '%'); }
    if (idsParam) {
      const arr = idsParam.split(',').map(function(s){ return parseInt(s.trim(), 10); }).filter(function(n){ return n > 0; });
      if (arr.length) { w += ' AND id IN (' + arr.map(function(){ return '?'; }).join(',') + ')'; arr.forEach(function(a){ p.push(a); }); }
    }
    if (folderIdParam) {
      const folderId = parseInt(folderIdParam, 10);
      if (folderId > 0) { w += ' AND folder_id=?'; p.push(folderId); }
      else if (folderIdParam === '0' || folderIdParam === 'null') { w += ' AND folder_id IS NULL'; }
    }
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM random_pool ' + w).bind(...p).first();
    const d = await env.D1_DB.prepare('SELECT * FROM random_pool ' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?').bind(...p, limit, offset).all();
    return json({ ok: true, data: d.results || [], total: t?.total || 0 });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminPoolCreate(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.urls) || !b.urls.length) return json({ ok: false, error: 'urls required' }, 400);
    const tags = (b.tags || []).map(String).map(function(t){ return t.trim(); }).filter(Boolean).join(',');
    const title = String(b.title || '').slice(0, 200);
    const isPrivate = b.is_private ? 1 : 0;
    // 私密内容等同 vvip 最高级，级别固定
    const level = isPrivate ? 'vvip' : sanitizeLevel(b.level);
    const now = cnNowISO();
    let added = 0;
    const urls = b.urls.map(function(x){ return String(x).trim(); }).filter(function(x){ return /^https?:\/\//i.test(x); });
    if (!urls.length) return json({ ok: true, data: { added: 0 } });
    // Check existing URLs one by one (per-row queries avoid D1's dynamic IN
    // placeholder issue that crashes with "Cannot read properties of null
    // (reading 'dbSession')" on some D1 instances)
    const exSet = new Set();
    for (const url of urls) {
      const ex = await env.D1_DB.prepare('SELECT url FROM random_pool WHERE url = ? LIMIT 1').bind(url).first();
      if (ex) exSet.add(ex.url);
    }
    for (const url of urls) {
      if (exSet.has(url)) continue; // duplicate by original URL
      const fsize = await probeImgSize(url);
      await env.D1_DB.prepare('INSERT INTO random_pool (url, thumb_url, title, tags, level, is_private, file_type, file_size, source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, \'photo\', ?, \'manual\', 1, ?)')
        .bind(url, url, title, tags, level, isPrivate, fsize, now).run();
      added++;
    }
    return json({ ok: true, data: { added: added } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// Normalize an image URL against a base page URL (resolve relative paths)
export function normUrl(u, base) {
  u = String(u || '').trim();
  if (!u || u.charAt(0) === '#') return null;
  if (/^\/\//.test(u)) return 'https:' + u;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.charAt(0) === '/') { try { var b = new URL(base); return b.origin + u; } catch (e) { return null; } }
  try { return new URL(u, base).href; } catch (e) { return null; }
}

// Canonicalize zupimages URLs (www vs non-www are the same image)
export function canonImgUrl(u) {
  return u.replace(/^https?:\/\/zupimages\.net\//i, 'https://www.zupimages.net/');
}

// Convert a Zupimages viewer.php?id=<path> link into its direct image URL:
//   https://zupimages.net/viewer.php?id=26/35/8rfb.png
//     -> https://www.zupimages.net/up/26/35/8rfb.png
export function zupViewerToDirect(u) {
  try {
    const url = new URL(String(u));
    if (/viewer\.php$/i.test(url.pathname)) {
      const id = url.searchParams.get('id');
      if (id) return 'https://www.zupimages.net/up/' + String(id).replace(/^\/+/, '');
    }
  } catch (e) {}
  return null;
}

// Fetch one or more page URLs (e.g. a Zupimages embed/gallery/viewer page),
// extract image links from the HTML, then bulk-import them into random_pool.
export async function handleAdminPoolImportPage(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const raw = b && b.url ? String(b.url).trim() : '';
    if (!raw) return json({ ok: false, error: 'url required' }, 400);
    const pageUrls = raw.split(/\r?\n/).map(function(s){ return s.trim(); }).filter(function(s){ return /^https?:\/\//i.test(s); });
    if (!pageUrls.length) return json({ ok: false, error: 'url must be http(s)' }, 400);
    const tags = (b.tags || []).map(String).map(function(t){ return t.trim(); }).filter(Boolean).join(',');
    const title = String(b.title || '').slice(0, 200);
    const isPrivate = b.is_private ? 1 : 0;
    // 私密内容等同 vvip 最高级，级别固定
    const level = isPrivate ? 'vvip' : sanitizeLevel(b.level);
    const now = cnNowISO();
    const foundMap = {};
    let fetched = 0;
    for (const pu of pageUrls) {
      // Zupimages viewer.php link -> direct image URL (no page fetch needed)
      const direct = zupViewerToDirect(pu);
      if (direct) { foundMap[canonImgUrl(direct)] = true; fetched++; continue; }
      // Input is already a direct image link -> import as-is, no page fetch
      if (/\.(?:jpg|jpeg|png|gif|webp)(?:\?|$)/i.test(pu)) { foundMap[canonImgUrl(pu)] = true; fetched++; continue; }
      let html = '';
      try {
        const res = await fetch(pu, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PoolImporter/1.0)' } });
        if (res.ok) html = await res.text();
      } catch (e) { continue; }
      fetched++;
      // <img src / data-src / data-original / data-lazy tags (absolute or relative)
      const re1 = /<img[^>]+(?:src|data-src|data-original|data-lazy)=["']([^"']+)["']/gi;
      let m;
      while ((m = re1.exec(html))) {
        const u = normUrl(m[1], pu);
        if (u) foundMap[canonImgUrl(u)] = true;
      }
      // bare image direct links (.jpg/.jpeg/.png/.gif/.webp)
      const re2 = /https?:\/\/[^\s"'<>()]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s"'<>()]*)?/gi;
      while ((m = re2.exec(html))) {
        if (/\.(?:jpg|jpeg|png|gif|webp)(?:\?|$)/i.test(m[0])) foundMap[canonImgUrl(m[0])] = true;
      }
    }
    const urls = Object.keys(foundMap);
    if (!urls.length) return json({ ok: false, error: 'no images found on page' }, 400);
    let added = 0, skipped = 0;
    for (const url of urls) {
      const ex = await env.D1_DB.prepare('SELECT id FROM random_pool WHERE url = ? LIMIT 1').bind(url).first();
      if (ex) { skipped++; continue; }
      const fsize = await probeImgSize(url);
      await env.D1_DB.prepare('INSERT INTO random_pool (url, thumb_url, title, tags, level, is_private, file_type, file_size, source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, \'photo\', ?, \'manual\', 1, ?)')
        .bind(url, url, title, tags, level, isPrivate, fsize, now).run();
      added++;
    }
    return json({ ok: true, data: { fetched: fetched, found: urls.length, added: added, skipped: skipped } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export function b64ToBytes(b64) {
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Byte size of an image from base64 (best effort)
export function b64Size(b64) {
  const s = String(b64 || '');
  return Math.floor((s.length - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0)) * 3 / 4);
}

// Best-effort HEAD probe to get an image's Content-Length (for manual imports)
export async function probeImgSize(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PoolImporter/1.0)' } });
    if (!r.ok) return null;
    const cl = r.headers.get('Content-Length');
    return cl ? (parseInt(cl) || null) : null;
  } catch (e) { return null; }
}

// Local multi-image upload: receive base64 image, store to R2, add to random_pool.
// Body: { name: "a.jpg", data: "<base64>", tags: "a,b", title: "..." }
export async function handleAdminPoolUpload(request, env) {
  try {
    if (!env.R2_BUCKET) return json({ ok: false, error: 'R2 not configured' }, 500);
    const b = await request.json().catch(() => null);
    if (!b || !b.data) return json({ ok: false, error: 'data (base64) required' }, 400);
    if (b.data.length > 45 * 1024 * 1024) return json({ ok: false, error: 'file too large (max ~30MB)' }, 400);
    let bytes;
    try { bytes = b64ToBytes(String(b.data)); } catch (e) { return json({ ok: false, error: 'invalid base64' }, 400); }
    if (!bytes || !bytes.length) return json({ ok: false, error: 'empty file' }, 400);
    const name = String(b.name || 'image.jpg').replace(/[\\/:*?"<>|]/g, '_');
    const ext = (name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
    const ct = mimeMap[ext] || 'application/octet-stream';
    const now = new Date();
    const ym = now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0');
    const key = 'pool/' + ym + '/' + randHex(16) + '.' + ext;
    const url = await putR2(key, bytes, ct, env);
    if (!url) return json({ ok: false, error: 'R2 upload failed: ' + lastUploadError }, 500);
    const tags = (b.tags || []).map(String).map(function(t){ return t.trim(); }).filter(Boolean).join(',');
    const title = String(b.title || name).slice(0, 200);
    const isPrivate = b.is_private ? 1 : 0;
    // 私密内容等同 vvip 最高级，级别固定
    const level = isPrivate ? 'vvip' : sanitizeLevel(b.level);
    const iso = now.toISOString();
    const fsize = (b.size && Number(b.size) > 0) ? Math.round(Number(b.size)) : b64Size(b.data);
    await env.D1_DB.prepare('INSERT INTO random_pool (url, thumb_url, title, tags, level, is_private, file_type, file_size, source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, \'photo\', ?, \'upload\', 1, ?)')
      .bind(url, url, title, tags, level, isPrivate, fsize, iso).run();
    return json({ ok: true, data: { url: url, added: 1, is_private: isPrivate } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 管理员本地上传到 Tele 库（files 表）：base64 → R2 files/ → INSERT files
// Body: { name, data(base64), tags, title, size, level, is_private }
export async function handleAdminFilesUpload(request, env) {
  try {
    if (!env.R2_BUCKET) return json({ ok: false, error: 'R2 not configured' }, 500);
    const b = await request.json().catch(() => null);
    if (!b || !b.data) return json({ ok: false, error: 'data (base64) required' }, 400);
    if (b.data.length > 45 * 1024 * 1024) return json({ ok: false, error: 'file too large (max ~30MB)' }, 400);
    let bytes;
    try { bytes = b64ToBytes(String(b.data)); } catch (e) { return json({ ok: false, error: 'invalid base64' }, 400); }
    if (!bytes || !bytes.length) return json({ ok: false, error: 'empty file' }, 400);
    const name = String(b.name || 'file.bin').replace(/[\\/:*?"<>|]/g, '_');
    const ext = (name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const mimeMap = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
      mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
      pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword'
    };
    const ct = mimeMap[ext] || 'application/octet-stream';
    const typeMap = { photo: ['jpg','jpeg','png','gif','webp','bmp'], video: ['mp4','mov','mkv','webm','avi'], audio: ['mp3','wav','ogg','m4a','aac','flac'] };
    let fileType = 'document';
    for (const t of Object.keys(typeMap)) { if (typeMap[t].indexOf(ext) !== -1) { fileType = t; break; } }
    const now = new Date();
    const ym = now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0');
    const key = 'files/' + ym + '/' + randHex(16) + '.' + ext;
    const url = await putR2(key, bytes, ct, env);
    if (!url) return json({ ok: false, error: 'R2 upload failed' }, 500);
    const tags = (b.tags || []).map(String).map(function(t){ return t.trim(); }).filter(Boolean).join(',');
    const level = sanitizeLevel(b.level);
    const isPrivate = b.is_private ? 1 : 0;
    const fsize = (b.size && Number(b.size) > 0) ? Math.round(Number(b.size)) : b64Size(b.data);
    const iso = now.toISOString();
    const res = await env.D1_DB.prepare('INSERT INTO files (storage_key, r2_url, file_name, file_size, file_type, mime_type, caption, tags, level, is_private, processing_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'completed\', ?)')
      .bind(key, url, name, fsize, fileType, ct, String(b.title || '').slice(0, 200), tags, level, isPrivate, iso).run();
    return json({ ok: true, data: { id: res.meta.last_row_id, url: url, file_type: fileType } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 管理员外链导入到 Tele 库（files 表）：URL 直链入库，r2_url 指向外部地址（storage_key 占位 external）
// Body: { urls: [...], tags, title, level, is_private }
export async function handleAdminFilesImport(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.urls) || !b.urls.length) return json({ ok: false, error: 'urls required' }, 400);
    const tags = (b.tags || []).map(String).map(function(t){ return t.trim(); }).filter(Boolean).join(',');
    const title = String(b.title || '').slice(0, 200);
    const level = sanitizeLevel(b.level);
    const isPrivate = b.is_private ? 1 : 0;
    const now = cnNowISO();
    const urls = b.urls.map(function(x){ return String(x).trim(); }).filter(function(x){ return /^https?:\/\//i.test(x); });
    if (!urls.length) return json({ ok: true, data: { added: 0 } });
    const exSet = new Set();
    for (const url of urls) {
      const ex = await env.D1_DB.prepare('SELECT r2_url FROM files WHERE r2_url = ? LIMIT 1').bind(url).first();
      if (ex) exSet.add(ex.r2_url);
    }
    const vids = ['mp4','mov','mkv','webm','avi'];
    const auds = ['mp3','wav','ogg','m4a','aac','flac'];
    const imgs = ['jpg','jpeg','png','gif','webp','bmp'];
    let added = 0;
    for (const url of urls) {
      if (exSet.has(url)) continue;
      const m = url.match(/\.([a-zA-Z0-9]{1,8})(?:\?.*)?$/);
      const ext = m ? m[1].toLowerCase() : '';
      let fileType = 'document';
      if (vids.indexOf(ext) !== -1) fileType = 'video';
      else if (auds.indexOf(ext) !== -1) fileType = 'audio';
      else if (imgs.indexOf(ext) !== -1) fileType = 'photo';
      let fileName = 'external';
      try { const pu = new URL(url); const seg = pu.pathname.split('/').pop(); if (seg) fileName = decodeURIComponent(seg); } catch (e) {}
      await env.D1_DB.prepare('INSERT INTO files (storage_key, r2_url, file_name, file_size, file_type, mime_type, caption, tags, level, is_private, processing_state, created_at) VALUES (\'external\', ?, ?, NULL, ?, ?, ?, ?, ?, ?, \'completed\', ?)')
        .bind(url, String(fileName).slice(0, 255), fileType, '', title, tags, level, isPrivate, now).run();
      added++;
    }
    return json({ ok: true, data: { added: added } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== 直传群（TG 代理存储，不占 R2）====================
// 把文件作为 document 发送到「用户上传绑定群组」（settings.upload_group_id），
// 取 telegram_file_id/message_id 后写入 files 行（storage_key=tg/<fileId>，r2_url=/file/tg/<id> 占位代理）。
// 可选 to_pool=true 时再插入 random_pool（source='tg'，tg_file_id 关联），等价「共享库/私密库直传群」。

const TG_UA = 'Mozilla/5.0 (compatible; TgLibraryBot/1.0)';
const SCRAPE_MAX_BYTES = 30 * 1024 * 1024; // 单张抓取上限 ~30MB（Telegram sendDocument 云端 50MB）

function tgExtInfo(name) {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const mimeMap = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml',
    mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
    pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword'
  };
  const ct = (ext && mimeMap[ext]) ? mimeMap[ext] : 'application/octet-stream';
  const typeMap = { photo: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg'], video: ['mp4', 'mov', 'mkv', 'webm', 'avi'], audio: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] };
  let fileType = 'document';
  if (ext) { for (const t of Object.keys(typeMap)) { if (typeMap[t].indexOf(ext) !== -1) { fileType = t; break; } } }
  return { ext: ext || 'bin', ct: ct, fileType: fileType };
}

async function getUploadGroupId(env) {
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'upload_group_id'").first();
    return (s && s.value) ? String(s.value).trim() : '';
  } catch (e) { return ''; }
}

// 把字节作为 photo（小图，群里直接显示图片）或 document（大图/其他格式）发送到 upload_group_id 群
// （官方 Bot API，保证 file_id 全局可用）。photo 仅支持 Telegram 压缩前 <=10MB 的图片。
async function tgSendMediaToGroup(env, groupId, bytes, name, ct, caption, asPhoto) {
  const endpoint = asPhoto ? 'sendPhoto' : 'sendDocument';
  const field = asPhoto ? 'photo' : 'document';
  const fd = new FormData();
  fd.append('chat_id', String(groupId));
  fd.append(field, new Blob([bytes], { type: ct }), String(name).slice(0, 200));
  if (caption) fd.append('caption', String(caption).slice(0, 1024));
  const resp = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/' + endpoint, { method: 'POST', body: fd });
  const j = await resp.json().catch(() => ({ ok: false, description: 'Telegram response not JSON' }));
  if (!j.ok || !j.result) return { ok: false, error: j.description || ('Telegram ' + endpoint + ' failed') };
  const med = asPhoto ? j.result.photo : j.result.document;
  let fid = '';
  if (asPhoto && Array.isArray(med) && med.length) fid = med[med.length - 1].file_id || '';
  else if (med && med.file_id) fid = med.file_id;
  return { ok: true, fileId: fid || '', messageId: j.result.message_id || 0, chatId: j.result.chat && j.result.chat.id ? j.result.chat.id : String(groupId) };
}

// 核心：直传群 + 落库 files（proxy 代理行）。返回 { ok, id, url, fileType, fileId, messageId, error }
// opts: { name, bytes, size, tags, title, caption, level, isPrivate, toPool, origin, pageUrl, originalUrl }
async function tgProxySave(env, opts) {
  const groupId = await getUploadGroupId(env);
  if (!groupId) return { ok: false, error: '尚未配置上传群组：请到「运维 → 用户上传配置」设置默认绑定群组' };
  if (!env.TG_BOT_TOKEN) return { ok: false, error: 'TG_BOT_TOKEN 未配置' };
  const o = opts || {};
  const info = tgExtInfo(o.name);
  const caption = (o.caption != null ? o.caption : '') || (o.title || '');
  // 常见图片格式且 <10MB → 用 sendPhoto（群里直接显示为照片）；其余走 sendDocument
  const PHOTO_MAX = 10 * 1024 * 1024;
  const asPhoto = info.fileType === 'photo' && ['jpg', 'jpeg', 'png', 'webp'].indexOf(info.ext) !== -1 && o.bytes && o.bytes.byteLength <= PHOTO_MAX;
  const sent = await tgSendMediaToGroup(env, groupId, o.bytes, o.name, info.ct, caption || undefined, asPhoto);
  if (!sent.ok) return { ok: false, error: sent.error };
  if (!sent.fileId) return { ok: false, error: 'Telegram 未返回 file_id' };
  const now = cnNowISO();
  const isPrivate = o.isPrivate ? 1 : 0;
  const level = isPrivate ? 'vvip' : sanitizeLevel(o.level);
  const pageUrl = o.pageUrl ? String(o.pageUrl).slice(0, 500) : '';
  const originalUrl = o.originalUrl ? String(o.originalUrl).slice(0, 1000) : '';
  const r = await env.D1_DB.prepare('INSERT INTO files (storage_key, r2_url, file_name, file_size, file_type, mime_type, caption, tags, level, is_private, group_ref, telegram_file_id, message_id, chat_id, processing_state, created_at, page_url, original_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'completed\', ?, ?, ?)')
    .bind('tg/' + sent.fileId, '/file/tg/placeholder', String(o.name).slice(0, 255), o.size, info.fileType, info.ct, String(o.title || '').slice(0, 200), o.tags, level, isPrivate, String(sent.chatId || groupId), sent.fileId, String(sent.messageId || ''), String(sent.chatId || groupId), now, pageUrl, originalUrl).run();
  const dbId = r.meta.last_row_id;
  const proxyUrl = '/file/tg/' + dbId;
  await env.D1_DB.prepare('UPDATE files SET r2_url = ? WHERE id = ?').bind(proxyUrl, dbId).run();
  // 共享库/私密库直传群：需要同时进 random_pool，写入可访问的签名直链
  if (o.toPool && o.origin) {
    try {
      const tok = await fileTok(dbId, env);
      const ext = fileExtOf(o.name, info.fileType);
      const signed = o.origin + '/file/tg/' + tok + '/' + dbId + '.' + ext;
      const pr = await env.D1_DB.prepare('INSERT INTO random_pool (url, thumb_url, title, tags, level, is_private, file_type, file_size, source, tg_file_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'tg\', ?, 1, ?)')
        .bind(signed, signed, String(o.title || o.name).slice(0, 200), o.tags, level, isPrivate, info.fileType, o.size, dbId, now).run();
      return { ok: true, id: dbId, url: proxyUrl, poolId: pr.meta.last_row_id, signedUrl: signed, fileType: info.fileType, fileId: sent.fileId, messageId: sent.messageId };
    } catch (e) { return { ok: true, id: dbId, url: proxyUrl, fileType: info.fileType, fileId: sent.fileId, messageId: sent.messageId, poolError: e.message }; }
  }
  return { ok: true, id: dbId, url: proxyUrl, fileType: info.fileType, fileId: sent.fileId, messageId: sent.messageId };
}

// 上传到 Tele 库（files 表）直传群：Body { name, data(base64), size, tags, title, level, is_private }
export async function handleAdminFilesUploadTg(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !b.data) return json({ ok: false, error: 'data (base64) required' }, 400);
    if (b.data.length > 45 * 1024 * 1024) return json({ ok: false, error: 'file too large (max ~30MB)' }, 400);
    let bytes;
    try { bytes = b64ToBytes(String(b.data)); } catch (e) { return json({ ok: false, error: 'invalid base64' }, 400); }
    if (!bytes || !bytes.length) return json({ ok: false, error: 'empty file' }, 400);
    const name = String(b.name || 'file.bin').replace(/[\\/:*?"<>|]/g, '_');
    const tags = (b.tags || []).map(String).map(function(t) { return t.trim(); }).filter(Boolean).join(',');
    const title = String(b.title || b.caption || '').slice(0, 200);
    const fsize = (b.size && Number(b.size) > 0) ? Math.round(Number(b.size)) : bytes.byteLength;
    const res = await tgProxySave(env, { name: name, bytes: bytes, size: fsize, tags: tags, title: title, caption: b.caption, level: sanitizeLevel(b.level), isPrivate: b.is_private ? 1 : 0 });
    if (!res.ok) return json({ ok: false, error: res.error }, 502);
    return json({ ok: true, data: { id: res.id, url: res.url, file_type: res.fileType, file_id: res.fileId, message_id: res.messageId, group_id: await getUploadGroupId(env), proxy_only: true } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 上传并加入共享库/私密库（random_pool）直传群：Body { name, data(base64), size, tags, title, level, is_private }
export async function handleAdminPoolUploadTg(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !b.data) return json({ ok: false, error: 'data (base64) required' }, 400);
    if (b.data.length > 45 * 1024 * 1024) return json({ ok: false, error: 'file too large (max ~30MB)' }, 400);
    let bytes;
    try { bytes = b64ToBytes(String(b.data)); } catch (e) { return json({ ok: false, error: 'invalid base64' }, 400); }
    if (!bytes || !bytes.length) return json({ ok: false, error: 'empty file' }, 400);
    const name = String(b.name || 'image.jpg').replace(/[\\/:*?"<>|]/g, '_');
    const tags = (b.tags || []).map(String).map(function(t) { return t.trim(); }).filter(Boolean).join(',');
    const title = String(b.title || b.caption || '').slice(0, 200);
    const fsize = (b.size && Number(b.size) > 0) ? Math.round(Number(b.size)) : bytes.byteLength;
    const u = new URL(request.url);
    const res = await tgProxySave(env, { name: name, bytes: bytes, size: fsize, tags: tags, title: title, caption: b.caption, level: sanitizeLevel(b.level), isPrivate: b.is_private ? 1 : 0, toPool: true, origin: u.origin });
    if (!res.ok) return json({ ok: false, error: res.error }, 502);
    // 双写 MySQL random_pool
    if (res.signedUrl) {
      const isPrivate = b.is_private ? 1 : 0;
      const level = isPrivate ? 'vvip' : sanitizeLevel(b.level);
      dualInsertRandomPool(env, {
        url: res.signedUrl, thumb_url: res.signedUrl, title: title, tags: tags,
        file_type: res.fileType, width: null, height: null, file_size: fsize,
        source: 'tg', tg_file_id: res.id, enabled: 1, created_at: cnNowISO(), level: level, is_private: isPrivate
      }).catch(e => console.error('dualInsertRandomPool error:', e.message));
    }
    return json({ ok: true, data: { id: res.id, pool_id: res.poolId, url: res.signedUrl || res.url, file_type: res.fileType, file_id: res.fileId, message_id: res.messageId, group_id: await getUploadGroupId(env), proxy_only: true } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== 网页图片拾取（直传群入库）====================
// 抓取页面 <img>/srcset/lazy、CSS background、og:image 等，得到候选图片，供勾选后 grab 直传群。

// 从页面提取候选图片 URL（保留 HTML 顺序，去重，上限 300）
export function extractPageImages(html, baseUrl) {
  const out = [], idxByKey = new Map();
  const add = (raw) => {
    if (!raw) return;
    let v = String(raw).replace(/&amp;/g, '&').replace(/&#0*38;/gi, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&#x2f;/gi, '/').trim();
    if (/^(data:|#)/i.test(v)) return;
    const abs = normUrl(v, baseUrl);
    if (!abs) return;
    const c = canonImgUrl(abs);
    // 去重键：协议无关（http/https 同图只留一条）+ 主机名忽略大小写；路径/查询保留原文
    const key = c.replace(/^https?:\/\//i, 'https://').replace(/^(https:\/\/[^/]*)/i, function(s) { return s.toLowerCase(); });
    const ex = idxByKey.get(key);
    if (ex !== undefined) { if (/^https:\/\//i.test(c) && /^http:\/\//i.test(out[ex])) out[ex] = c; return; }
    if (out.length >= 300) return;
    idxByKey.set(key, out.length);
    out.push(c);
  };
  const pickAttr = (tag, attrs) => {
    for (const a of attrs) {
      const re = new RegExp('\\b' + a + '=["\']([^"\']+)["\']', 'i');
      const m = tag.match(re);
      if (m && m[1]) return m[1];
    }
    return '';
  };
  const tags = html.match(/<img\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const ss = pickAttr(tag, ['srcset']);
    if (ss) {
      ss.split(',').forEach(function(part) {
        const first = part.trim().split(/\s+/)[0];
        if (first) add(first);
      });
    }
    const src = pickAttr(tag, ['src', 'data-src', 'data-original', 'data-lazy', 'data-url', 'data-lazy-src']);
    if (src) add(src);
  }
  // CSS background：内联 style 与 <style> 块（url(...)）
  const cssBlocks = [];
  (html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) || []).forEach(function(b) {
    cssBlocks.push(b.replace(/^<style\b[^>]*>/i, '').replace(/<\/style>$/i, ''));
  });
  (html.match(/<[a-zA-Z][^>]*style=["'][^"']*["']/gi) || []).forEach(function(tag) {
    const m = tag.match(/style=["']([^"']*)["']/i);
    if (m && m[1]) cssBlocks.push(m[1]);
  });
  const uRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  for (const block of cssBlocks) {
    let m;
    while ((m = uRe.exec(block))) {
      const v = String(m[1]).trim();
      if (/^(data:|#)/i.test(v)) continue;
      add(v);
    }
  }
  // meta og:image / twitter:image
  (html.match(/<meta\b[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/gi) || []).forEach(function(tag) {
    const m = tag.match(/content=["']([^"']*)["']/i);
    if (m) add(m[1]);
  });
  // 兜底：HTML 中裸露的图片直链
  const re2 = /https?:\/\/[^\s"'<>()\\]+\.(?:jpg|jpeg|png|gif|webp|avif|bmp)(?:\?[^\s"'<>()\\]*)?/gi;
  let m2;
  while ((m2 = re2.exec(html))) {
    if (out.length >= 300) break;
    if (/\.(?:jpg|jpeg|png|gif|webp|avif|bmp)(?:\?|$)/i.test(m2[0])) add(m2[0]);
  }
  return out;
}

// 解析页面并返回候选图片：POST /admin/api/scrape/analyze  Body: { url, ignore_kw, ignore_ext }
// 忽略规则在解析阶段即生效（链接含关键词 / 扩展名命中时剔除，count 返回过滤后的张数）
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIEBA_WAP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

// 按图片域名推断下载时的 Referer（图床/防盗链站只认自家页面来源，页面抓取的 ref 传给它会被 403）
// 规则：图片 host 等于 key，或以 '.' + key 结尾。未知域名返回 ''（不强制加 Referer，避免误伤公开图床）
const IMG_REFERER_HINTS = [
  { key: 'xiaohongshu.com', ref: 'https://www.xiaohongshu.com/' },
  { key: 'xhscdn.com', ref: 'https://www.xiaohongshu.com/' },
  { key: 'tiebapic.baidu.com', ref: 'https://tieba.baidu.com/' },
  { key: 'baidu.com', ref: 'https://www.baidu.com/' },
  { key: 'bing.com', ref: 'https://www.bing.com/' },
  { key: 'zhihu.com', ref: 'https://www.zhihu.com/' },
  { key: 'pixiv.net', ref: 'https://www.pixiv.net/' },
  { key: 'weibo.com', ref: 'https://weibo.com/' },
  { key: 'weibo.cn', ref: 'https://weibo.cn/' },
  { key: 'douban.com', ref: 'https://www.douban.com/' },
  { key: 'zhimg.com', ref: 'https://www.zhihu.com/' },
  { key: 'sinaimg.cn', ref: 'https://weibo.com/' }
];
function refererHintForImage(imageUrl) {
  let h = '';
  try { h = String(new URL(imageUrl).hostname).toLowerCase(); } catch (e) { return ''; }
  for (const it of IMG_REFERER_HINTS) {
    if (h === it.key || h.indexOf('.' + it.key) >= 0) return it.ref;
  }
  return '';
}
// 下载图片：多级重试规避源站 403/反爬（小红书/微博等常拦 bot UA 或校验 Referer）。
// 依次尝试：①当前 UA+原 Referer → ②浏览器 UA+图床 Hint Referer → ③纯浏览器 UA → ④TG UA（兜底）。
// 仅对 !ok 且状态 403/404/4xx 或抛错时进入下一档；返回 { res, tried }（res 为最后一次响应）。
async function fetchImageWithFallbacks(imageUrl, givenReferer, cookieStr) {
  const hintRef = refererHintForImage(imageUrl);
  const givenRef = String(givenReferer || '').trim();
  const dcookie = String(cookieStr || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 8000);
  const tryList = [];
  // 1) 带 Cookie 时只有浏览器 UA+Cookie 能过（先试；失败再试不含 Cookie 档）
  if (dcookie) {
    tryList.push({ 'User-Agent': BROWSER_UA, 'Referer': hintRef || givenRef || '', 'Cookie': dcookie });
    tryList.push({ 'User-Agent': BROWSER_UA, 'Cookie': dcookie });
  }
  // 2) 调用方给的原 Referer
  if (givenRef) tryList.push({ 'User-Agent': TG_UA, 'Referer': givenRef });
  // 3) 图床 Hint Referer
  if (hintRef && hintRef !== givenRef) tryList.push({ 'User-Agent': BROWSER_UA, 'Referer': hintRef });
  if (hintRef && hintRef !== givenRef) tryList.push({ 'User-Agent': TG_UA, 'Referer': hintRef });
  // 4) 浏览器 UA
  if (givenRef) tryList.push({ 'User-Agent': BROWSER_UA, 'Referer': givenRef });
  tryList.push({ 'User-Agent': BROWSER_UA });
  // 5) TG UA 兜底
  tryList.push({ 'User-Agent': TG_UA });
  const seen = new Set();
  const attempts = [];
  for (const hd of tryList) {
    const sig = (hd['User-Agent'] || '') + '|' + (hd['Referer'] || '') + '|' + (hd['Cookie'] || '');
    if (seen.has(sig)) continue;
    seen.add(sig);
    attempts.push(hd);
    if (attempts.length >= 5) break;
  }
  let last = null;
  let lastErr = null;
  for (const hd of attempts) {
    try {
      const resp = await fetch(imageUrl, { headers: hd, redirect: 'follow' });
      last = resp;
      if (resp.ok) return { res: resp, tried: attempts };
      // 403/429/5xx 等继续试下一档；明确成功才返回
      await resp.arrayBuffer().catch(function() {});
    } catch (e) { lastErr = e; }
  }
  if (!last) throw lastErr || new Error('网络请求失败');
  return { res: last, tried: attempts };
}

function tiebaThreadKz(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname !== 'tieba.baidu.com') return '';
    const m = u.pathname.match(/^\/p\/(\d+)/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}
// 贴吧 WAP 缩略图 URL 里带 src= 参数指向原图（forum/pic/item/hash.jpg），此处还原成可直接下载的原图直链
function tiebaOriginalUrls(html) {
  const txt = String(html).replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  const re = /src=(https?%3A%2F%2F[^&"'\s<>]+)/gi;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(txt))) {
    let d = '';
    try { d = decodeURIComponent(m[1]); } catch (e) { continue; }
    let href = '';
    try {
      const u = new URL(/^http:\/\//.test(d) ? 'https://' + d.slice(7) : d);
      if (!/tiebapic\.baidu\.com$/i.test(u.hostname)) continue;
      if (!/^\/forum\/pic\/item\//i.test(u.pathname)) continue;
      href = u.href;
    } catch (e) { continue; }
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href.replace(/\/+$/, ''));
  }
  return out;
}
// 贴吧帖子页/正文对服务端抓取会回 百度安全验证；带上用户登录 Cookie 后改走 WAP 服务端渲染页抽原图
async function tryTiebaWap(raw, cookie) {
  const kz = tiebaThreadKz(raw);
  if (!kz || !cookie) return null;
  const hdrs = { 'User-Agent': TIEBA_WAP_UA, 'Referer': 'https://tieba.baidu.com/', 'Cookie': cookie };
  try {
    const res = await fetch('https://tieba.baidu.com/mo/q/m?kz=' + kz + '&pn=1', { headers: hdrs, redirect: 'follow' });
    if (!res.ok) return null;
    const html = await res.text();
    const urls = tiebaOriginalUrls(html);
    if (!urls.length) return null;
    const t = String((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [null, ''])[1]).trim();
    return { title: (t || '').slice(0, 200), urls: urls };
  } catch (e) { return null; }
}

export async function handleAdminScrapeAnalyze(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const raw = b && b.url ? String(b.url).trim() : '';
    if (!raw || !/^https?:\/\//i.test(raw)) return json({ ok: false, error: '请输入 http(s) 链接' }, 400);
    const cookie = String((b && b.cookie) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 8000);
    const ignoreKws = String((b && b.ignore_kw) || '').split(/[,，;；]/).map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);
    const ignoreExts = String((b && b.ignore_ext) || '').split(/[,，;；]/).map(function(s) { return s.trim().toLowerCase().replace(/^\./, ''); }).filter(Boolean);
    let html = '';
    let directImage = false;
    let title = '';
    let rawUrls = null;
    // 贴吧：带 Cookie 时走 WAP 服务端渲染页抽原图
    const tiebaWap = await tryTiebaWap(raw, cookie);
    if (tiebaWap) {
      title = tiebaWap.title;
      rawUrls = tiebaWap.urls;
    } else {
      try {
        const fh = { 'User-Agent': cookie ? BROWSER_UA : TG_UA };
        if (cookie) fh['Cookie'] = cookie;
        const res = await fetch(raw, { headers: fh, redirect: 'follow' });
        if (!res.ok) return json({ ok: false, error: '页面抓取失败（HTTP ' + res.status + '）' }, 502);
        const ct = String(res.headers.get('content-type') || '').split(';')[0].toLowerCase().trim();
        if (ct.indexOf('image/') === 0) {
          // 输入本身是一张图片直链：直接作为唯一候选
          html = '';
          directImage = true;
        } else {
          html = await res.text();
        }
      } catch (e) { return json({ ok: false, error: '页面抓取失败：' + e.message }, 502); }
      title = directImage ? raw : (String((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [null, ''])[1]).trim().slice(0, 200) || raw);
      rawUrls = directImage ? [raw] : extractPageImages(html, raw);
    }
    // 解析阶段过滤：链接携带的内容命中忽略关键词/格式时，直接不再返回该候选
    const kept = [];
    let ignoredN = 0;
    for (const u of rawUrls) {
      const low = String(u).toLowerCase();
      let hit = '';
      for (const kw of ignoreKws) {
        if (low.indexOf(kw) >= 0) { hit = '关键词「' + kw + '」'; break; }
      }
      if (!hit) {
        const mm = String(u).match(/\.([a-zA-Z0-9]{1,8})(?:\?.*)?$/);
        const ext = mm ? mm[1].toLowerCase() : '';
        if (ext && ignoreExts.indexOf(ext) !== -1) hit = '格式 .' + ext;
      }
      if (hit) ignoredN++;
      else kept.push(u);
    }
    return json({ ok: true, data: { url: raw, title: title, count: kept.length, total: rawUrls.length, filtered: ignoredN, images: kept } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 抓取图片的入库文件名：标题（优先）+ 原文件名主干 + 扩展名，便于在群里/列表按标题辨识
function scrapeImageName(url, mimeExt, title) {
  const clean = function(s, max) { return String(s == null ? '' : s).replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 60); };
  let stem = '';
  let ext = '';
  try {
    const seg = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    const dot = seg.lastIndexOf('.');
    if (dot > 0) { stem = seg.slice(0, dot); ext = seg.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, '').toLowerCase(); }
    else if (seg) stem = seg;
  } catch (e) {}
  if (!ext) ext = String(mimeExt || '').toLowerCase() || 'jpg';
  const base = clean(title, 60) || clean(stem, 60) || 'image';
  const parts = [base];
  if (stem && stem !== base) parts.push(clean(stem, 36));
  return parts.join('-').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 120) + '.' + ext;
}

// 抓取勾选的图片并直传群入库 files：POST /admin/api/scrape/grab
// Body: { urls:[...], title, tags, level, is_private, caption, ref, ignore_kw, ignore_ext, max_mb }
//   单个请求上限 40 张；ignore_kw=链接含关键词忽略；ignore_ext=扩展名/格式忽略；max_mb=单张上限（缺省 30）
export async function handleAdminScrapeGrab(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.urls) || !b.urls.length) return json({ ok: false, error: 'urls required' }, 400);
    const urls = b.urls.map(function(x) { return String(x).trim(); }).filter(function(x) { return /^https?:\/\//i.test(x); }).slice(0, 40);
    if (!urls.length) return json({ ok: false, error: 'url must be http(s)' }, 400);
    if (env.D1_DB) { try { await ensureTablesOnce(env.D1_DB); } catch (e) {} }
    const groupId = await getUploadGroupId(env);
    if (!groupId) return json({ ok: false, error: '尚未配置上传群组：请到「运维 → 用户上传配置」设置默认绑定群组' }, 400);
    // 容错：tags 可能是数组或逗号分隔字符串
    const tags = Array.isArray(b.tags) ? b.tags.map(String).map(function(t) { return t.trim(); }).filter(Boolean).join(',')
      : String(b.tags || '').split(/[,，;；]/).map(function(t) { return t.trim(); }).filter(Boolean).join(',');
    const title = String(b.title || '').slice(0, 200);
    const u = new URL(request.url);
    const uOrigin = u.origin;
    // vvip = 私密内容：入库级别选 vvip 即直接进私密库（random_pool is_private=1），不在 Tele 文件库默认展示
    const rawLevel = sanitizeLevel(b.level);
    const isPrivate = b.is_private ? 1 : (rawLevel === 'vvip' ? 1 : 0);
    const level = isPrivate ? 'vvip' : rawLevel;
    const toPool = isPrivate ? 1 : 0;
    const referer = b.ref ? String(b.ref).trim() : '';
    // 忽略规则
    const ignoreKws = String(b.ignore_kw || '').split(/[,，;；]/).map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);
    const ignoreExts = String(b.ignore_ext || '').split(/[,，;；]/).map(function(s) { return s.trim().toLowerCase().replace(/^\./, ''); }).filter(Boolean);
    let maxBytes = SCRAPE_MAX_BYTES;
    if (b.max_mb) { const mb = Number(b.max_mb); if (mb > 0 && mb <= 30) maxBytes = Math.round(mb * 1024 * 1024); }
    const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/tiff': 'tiff' };
    const results = [];
    let added = 0;
    let ignored = 0;
    for (const url of urls) {
      const row = { url: url, ok: false, ignored: false, error: '' };
      try {
        const low = url.toLowerCase();
        let ignoreReason = '';
        // 链接包含关键词 → 忽略（不发请求）
        for (const kw of ignoreKws) {
          if (low.indexOf(kw) >= 0) { ignoreReason = '链接含「' + kw + '」'; break; }
        }
        // 扩展名匹配 → 忽略
        if (!ignoreReason) {
          let ext = '';
          try { const seg = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); ext = seg.indexOf('.') >= 0 ? seg.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : ''; } catch (e) {}
          if (ext && ignoreExts.indexOf(ext) >= 0) ignoreReason = '已忽略格式 .' + ext;
        }
        if (ignoreReason) { row.ok = false; row.ignored = true; row.error = ignoreReason; ignored++; results.push(row); continue; }
        const dl = await fetchImageWithFallbacks(url, referer, '');
        const res = dl.res;
        if (!res.ok) { row.error = '下载失败（HTTP ' + res.status + '）'; results.push(row); continue; }
        const ct = String(res.headers.get('content-type') || '').split(';')[0].toLowerCase().trim();
        const cl = parseInt(res.headers.get('content-length') || '0', 10);
        if (cl > maxBytes) { row.ok = false; row.ignored = true; row.error = '超过单张上限 ' + Math.round(maxBytes / 1048576) + 'MB'; ignored++; results.push(row); continue; }
        // 格式校验：仅收图片
        const ctExt = MIME_EXT[ct] || '';
        if (!/^image\//.test(ct)) { row.ok = false; row.ignored = true; row.error = '非图片格式（' + (ct || '未知') + '）'; ignored++; results.push(row); continue; }
        if (ignoreExts.indexOf(ctExt) >= 0) { row.ok = false; row.ignored = true; row.error = '已忽略格式 .' + (ctExt || ct); ignored++; results.push(row); continue; }
        const buf = await res.arrayBuffer();
        if (!buf || !buf.byteLength) { row.error = '空响应'; results.push(row); continue; }
        if (buf.byteLength > maxBytes) { row.ok = false; row.ignored = true; row.error = '超过单张上限 ' + Math.round(maxBytes / 1048576) + 'MB'; ignored++; results.push(row); continue; }
        const bytes = new Uint8Array(buf);
        const name = scrapeImageName(url, MIME_EXT[ct] || '', title);
        const res2 = await tgProxySave(env, { name: name, bytes: bytes, size: bytes.byteLength, tags: tags, title: title || url, caption: b.caption, level: level, isPrivate: isPrivate, toPool: toPool, origin: uOrigin, pageUrl: referer || '', originalUrl: url });
        if (!res2.ok) { row.error = res2.error; }
        else { row.ok = true; row.id = res2.id; row.proxy_url = res2.url; row.file_id = res2.fileId; row.private = !!isPrivate; added++; }
      } catch (e) { row.error = e.message; }
      results.push(row);
    }
    return json({ ok: true, data: { added: added, failed: results.length - added - ignored, ignored: ignored, results: results } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 单张抓取直传：POST /admin/api/scrape/grab_one
// Body: { url, title, tags, level, is_private, caption, ref, ignore_kw, ignore_ext, max_mb }
// 逐张请求（前端可做进度/暂停/断点续传）。返回 data.status:
//   added=成功 / exists=库里已有(original_url 命中，跳过) / ignored=命中忽略规则 / failed=失败(reason)
// i.postimg.cc/<code>/<name>.jpg 多指压缩展示图；到 postimg.cc/<code> 详情页找 ?dl=1 原图直链（原图 code 可能与展示 code 不同）
async function resolvePostimgOriginal(url) {
  let u;
  try { u = new URL(url); } catch (e) { return url; }
  if (!/^i\.postimg\.cc$/i.test(u.hostname)) return url;
  if (u.searchParams.has('dl')) return url;
  const seg = u.pathname.split('/').filter(Boolean);
  if (!seg.length) return url;
  try {
    const r = await fetch('https://postimg.cc/' + encodeURIComponent(seg[0]), { headers: { 'User-Agent': BROWSER_UA }, redirect: 'follow' });
    if (!r.ok) return url;
    const html = await r.text();
    const re = /https?:\/\/i\.postimg\.cc\/[A-Za-z0-9]+\/[A-Za-z0-9._~%+-]+(?:\?[A-Za-z0-9=&_%.-]*)?/g;
    const picks = [];
    let m;
    while ((m = re.exec(html))) picks.push(m[0]);
    let best = '';
    for (const p of picks) { if (p.indexOf('?dl=1') >= 0) { best = p; break; } }
    if (!best) {
      for (const p of picks) {
        try { const pu = new URL(p); if ((pu.pathname.split('/').filter(Boolean)[0] || '') !== seg[0]) { best = p; break; } } catch (e) {}
      }
    }
    return best || url;
  } catch (e) { return url; }
}

export async function handleAdminScrapeGrabOne(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const url = b && b.url ? String(b.url).trim() : '';
    if (!/^https?:\/\//i.test(url)) return json({ ok: true, data: { url: url, status: 'failed', reason: 'url 必须为 http(s)' } });
    if (env.D1_DB) { try { await ensureTablesOnce(env.D1_DB); } catch (e) {} }
    const groupId = await getUploadGroupId(env);
    if (!groupId) return json({ ok: true, data: { url: url, status: 'failed', reason: '尚未配置上传群组：请到「运维 → 用户上传配置」设置' } });
    if (!env.TG_BOT_TOKEN) return json({ ok: true, data: { url: url, status: 'failed', reason: 'TG_BOT_TOKEN 未配置' } });
    const fail = (reason) => json({ ok: true, data: { url: url, status: 'failed', reason: reason } });
    // 容错：tags 可能是数组（旧接口约定）或逗号分隔字符串（scrape.html 传 job.tags）
    const tags = Array.isArray(b.tags) ? b.tags.map(String).map(function(t) { return t.trim(); }).filter(Boolean).join(',')
      : String(b.tags || '').split(/[,，;；]/).map(function(t) { return t.trim(); }).filter(Boolean).join(',');
    const title = String(b.title || '').slice(0, 200);
    const u = new URL(request.url);
    const uOrigin = u.origin;
    // vvip = 私密内容：入库级别选 vvip 即直接进私密库（random_pool is_private=1），不在 Tele 文件库默认展示
    const rawLevel = sanitizeLevel(b.level);
    const isPrivate = b.is_private ? 1 : (rawLevel === 'vvip' ? 1 : 0);
    const level = isPrivate ? 'vvip' : rawLevel;
    const toPool = isPrivate ? 1 : 0;
    const referer = b.ref ? String(b.ref).trim() : '';
    const caption = b.caption != null ? b.caption : title;
    const seq = Math.max(0, parseInt(b.seq, 10) || 0);
    const ignoreKws = String(b.ignore_kw || '').split(/[,，;；]/).map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);
    const ignoreExts = String(b.ignore_ext || '').split(/[,，;；]/).map(function(s) { return s.trim().toLowerCase().replace(/^\./, ''); }).filter(Boolean);
    let maxBytes = SCRAPE_MAX_BYTES;
    if (b.max_mb) { const mb = Number(b.max_mb); if (mb > 0 && mb <= 30) maxBytes = Math.round(mb * 1024 * 1024); }
    const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/tiff': 'tiff' };
    try {
      // 已入库去重：同一 original_url 不再重复发送
      const dup = await env.D1_DB.prepare('SELECT id FROM files WHERE original_url = ? LIMIT 1').bind(url).first();
      if (dup) return json({ ok: true, data: { url: url, status: 'exists', reason: '已存在（files #' + dup.id + '）', id: dup.id } });
      const low = url.toLowerCase();
      for (const kw of ignoreKws) {
        if (low.indexOf(kw) >= 0) return json({ ok: true, data: { url: url, status: 'ignored', reason: '链接含「' + kw + '」' } });
      }
      let ext = '';
      try { const seg = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); ext = seg.indexOf('.') >= 0 ? seg.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : ''; } catch (e) {}
      if (ext && ignoreExts.indexOf(ext) >= 0) return json({ ok: true, data: { url: url, status: 'ignored', reason: '已忽略格式 .' + ext } });
      const dcookie = String(b.cookie || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 8000);
      // i.postimg.cc 直链多为压缩展示图：自动解析详情页升级为 ?dl=1 原图（失败则回退原链）
      const fetchUrl = await resolvePostimgOriginal(url);
      // 多级请求头重试：带原 Referer / 图床 Hint / 浏览器 UA 逐档尝试，规避小红书等 403
      const dl = await fetchImageWithFallbacks(fetchUrl, referer, dcookie);
      const res = dl.res;
      if (!res.ok) return fail('下载失败（HTTP ' + res.status + '）');
      const ct = String(res.headers.get('content-type') || '').split(';')[0].toLowerCase().trim();
      const cl = parseInt(res.headers.get('content-length') || '0', 10);
      if (cl > maxBytes) return json({ ok: true, data: { url: url, status: 'ignored', reason: '超过单张上限 ' + Math.round(maxBytes / 1048576) + 'MB' } });
      const ctExt = MIME_EXT[ct] || '';
      if (!/^image\//.test(ct)) return json({ ok: true, data: { url: url, status: 'ignored', reason: '非图片格式（' + (ct || '未知') + '）' } });
      if (ignoreExts.indexOf(ctExt) >= 0) return json({ ok: true, data: { url: url, status: 'ignored', reason: '已忽略格式 .' + (ctExt || ct) } });
      const buf = await res.arrayBuffer();
      if (!buf || !buf.byteLength) return fail('空响应');
      if (buf.byteLength > maxBytes) return json({ ok: true, data: { url: url, status: 'ignored', reason: '超过单张上限 ' + Math.round(maxBytes / 1048576) + 'MB' } });
      const bytes = new Uint8Array(buf);
      // 批量直传时前端传 seq（1 起），拼成 3 位序号前缀入库文件名，避免同源多图重名互相覆盖/难辨识
      let name = scrapeImageName(url, ctExt || '', title);
      if (seq > 0) name = ('000' + seq).slice(-3) + '_' + name;
      const res2 = await tgProxySave(env, { name: name, bytes: bytes, size: bytes.byteLength, tags: tags, title: title || url, caption: caption, level: level, isPrivate: isPrivate, toPool: toPool, origin: uOrigin, pageUrl: referer, originalUrl: url });
      if (!res2.ok) return fail(res2.error);
      return json({ ok: true, data: { url: url, status: 'added', id: res2.id, reason: '#files ' + res2.id + (isPrivate ? ' → 私密库' : ''), name: name, private: !!isPrivate } });
    } catch (e) { return fail(e.message); }
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// Upload a base64 image to Postimages via its official API
// (api.postimage.org/1/upload), then resolve the direct i.postimg.cc URL
// and add it to random_pool. Body: { name, data(base64), key, gallery }
export async function handleAdminPoolUploadPostimages(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !b.data) return json({ ok: false, error: 'data (base64) required' }, 400);
    if (!b.key) return json({ ok: false, error: 'Postimages API Key required' }, 400);
    if (b.data.length > 45 * 1024 * 1024) return json({ ok: false, error: 'file too large (Postimages free limit ~24MB)' }, 400);
    const name = String(b.name || 'image.jpg').replace(/[\\/:*?"<>|]/g, '_');
    const ext = (name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const params = new URLSearchParams();
    params.set('key', String(b.key).trim());
    params.set('gallery', String(b.gallery || '').trim());
    params.set('o', '2b819584285c102318568238c7d4a4c7');
    params.set('m', '59c2ad4b46b0c1e12d5703302bff0120');
    params.set('version', '1.0.1');
    params.set('portable', '1');
    params.set('name', name.replace(/\.[^.]+$/, ''));
    params.set('type', ext);
    params.set('image', String(b.data));
    const res = await fetch('https://api.postimage.org/1/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'Mozilla/5.0 (compatible; PoolImporter/1.0)' },
      body: params.toString()
    });
    const xml = await res.text();
    const ok = /success="1"/.test(xml);
    if (!ok) {
      const err = (xml.match(/<error>([^<]*)<\/error>/) || [null, 'Postimages upload failed'])[1];
      return json({ ok: false, error: String(err).trim() }, 502);
    }
    const page = (xml.match(/<page>([^<]*)<\/page>/) || [null, ''])[1];
    if (!page) return json({ ok: false, error: 'no page url from Postimages' }, 502);
    let direct = '';
    try {
      const pr = await fetch(page, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PoolImporter/1.0)' } });
      if (pr.ok) {
        const ph = await pr.text();
        const m = ph.match(/https:\/\/i\.postimg\.cc\/\w{8}\/[^"'<>\s]+/);
        if (m) direct = m[0].replace(/\?dl=1$/, '');
      }
    } catch (e) {}
    if (!direct) direct = page;
    const tags = (b.tags || []).map(String).map(function(t){ return t.trim(); }).filter(Boolean).join(',');
    const title = String(b.title || name).slice(0, 200);
    const isPrivate = b.is_private ? 1 : 0;
    // 私密内容等同 vvip 最高级，级别固定
    const level = isPrivate ? 'vvip' : sanitizeLevel(b.level);
    const now = cnNowISO();
    const ex = await env.D1_DB.prepare('SELECT id FROM random_pool WHERE url = ? LIMIT 1').bind(direct).first();
    if (ex) return json({ ok: true, data: { url: direct, added: 0, duplicate: true } });
    const fsize = b64Size(b.data);
    await env.D1_DB.prepare('INSERT INTO random_pool (url, thumb_url, title, tags, level, is_private, file_type, file_size, source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, \'photo\', ?, \'postimages\', 1, ?)')
      .bind(direct, direct, title, tags, level, isPrivate, fsize, now).run();
    return json({ ok: true, data: { url: direct, added: 1 } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminGetPiKey(env) {
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'postimages_key'").first();
    return json({ ok: true, data: { key: s && s.value ? s.value : '' } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminSavePiKey(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const key = b && b.key ? String(b.key).trim().slice(0, 200) : '';
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('postimages_key', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key).run();
    return json({ ok: true, data: { saved: !!key } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 用户上传默认群组 ID（后台配置，上传时自动绑定）
export async function handleAdminGetUploadGroup(env) {
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'upload_group_id'").first();
    return json({ ok: true, data: { group_id: s && s.value ? s.value : '' } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminSaveUploadGroup(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const groupId = b && b.group_id ? String(b.group_id).trim().slice(0, 50) : '';
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('upload_group_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(groupId).run();
    return json({ ok: true, data: { saved: !!groupId, group_id: groupId } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 获取已知群组列表（从 known_chats 表）
export async function handleAdminGetKnownGroups(env) {
  try {
    const groups = await env.D1_DB.prepare("SELECT chat_id, chat_title, chat_username FROM known_chats WHERE chat_type IN ('group', 'supergroup') ORDER BY last_active_at DESC").all();
    return json({ ok: true, data: groups.results || [] });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 用户配额管理
export async function handleAdminGetUserQuotas(env) {
  try {
    const users = await env.D1_DB.prepare("SELECT id, key, name, username, level, upload_quota, upload_used, storage_used FROM api_keys ORDER BY id DESC").all();
    return json({ ok: true, data: users.results || [] });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminUpdateUserQuota(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !b.id) return json({ ok: false, error: 'User ID required' }, 400);
    
    const userId = parseInt(b.id, 10);
    if (!userId) return json({ ok: false, error: 'Invalid user ID' }, 400);
    
    // Build update query dynamically
    const updates = [];
    const params = [];
    
    if (b.upload_quota !== undefined) {
      updates.push('upload_quota = ?');
      params.push(parseInt(b.upload_quota, 10) || 100);
    }
    if (b.level !== undefined) {
      updates.push('level = ?');
      params.push(String(b.level).trim() || 'pt');
    }
    if (b.upload_used !== undefined) {
      updates.push('upload_used = ?');
      params.push(parseInt(b.upload_used, 10) || 0);
    }
    if (b.storage_used !== undefined) {
      updates.push('storage_used = ?');
      params.push(parseInt(b.storage_used, 10) || 0);
    }
    
    if (updates.length === 0) return json({ ok: false, error: 'No fields to update' }, 400);
    
    params.push(userId);
    await env.D1_DB.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
    
    return json({ ok: true, data: { updated: true } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 用户上传文件列表（管理后台用）
export async function handleAdminUserFiles(request, env) {
  try {
    const u = new URL(request.url);
    const page = parseInt(u.searchParams.get('page') || '1', 10);
    const pageSize = Math.min(parseInt(u.searchParams.get('page_size') || '20', 10), 100);
    const offset = (page - 1) * pageSize;
    
    const files = await env.D1_DB.prepare(
      'SELECT * FROM user_uploads WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).bind(pageSize, offset).all();
    
    const total = await env.D1_DB.prepare(
      'SELECT COUNT(*) as total FROM user_uploads WHERE deleted_at IS NULL'
    ).first();
    
    return json({ ok: true, data: files.results || [], total: total?.total || 0, page, page_size: pageSize });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 共享库备用设置
export async function handleAdminGetPoolFallback(env) {
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'pool_fallback_enabled'").first();
    return json({ ok: true, data: { enabled: s && s.value === '1' ? 1 : 0 } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminSavePoolFallback(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const enabled = b && b.enabled ? '1' : '0';
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('pool_fallback_enabled', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(enabled).run();
    return json({ ok: true, data: { enabled: enabled === '1' } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 预设标签库（后台自定义，上传时点选，保证标签统一）
export async function handleAdminGetPoolTags(env) {
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'pool_tags_preset'").first();
    let tags = [];
    if (s && s.value) {
      try { tags = JSON.parse(s.value); } catch (e) { tags = splitTags(String(s.value)); }
    }
    return json({ ok: true, data: { tags: Array.isArray(tags) ? tags : [] } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminSavePoolTags(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const tags = Array.isArray(b && b.tags)
      ? b.tags.map(String).map(function(t){ return t.trim(); }).filter(Boolean)
      : [];
    const uniq = Array.from(new Set(tags)).slice(0, 200);
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('pool_tags_preset', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(uniq)).run();
    return json({ ok: true, data: { tags: uniq } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminPoolToggle(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !b.id) return json({ ok: false, error: 'id required' }, 400);
    if (b.level !== undefined) {
      await env.D1_DB.prepare('UPDATE random_pool SET enabled = ?, level = ? WHERE id = ?').bind(b.enabled ? 1 : 0, sanitizeLevel(b.level), b.id).run();
    } else {
      await env.D1_DB.prepare('UPDATE random_pool SET enabled = ? WHERE id = ?').bind(b.enabled ? 1 : 0, b.id).run();
    }
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== Folders ====================
export async function handleAdminFoldersList(request, env) {
  try {
    const d = await env.D1_DB.prepare('SELECT * FROM folders ORDER BY parent_id NULLS FIRST, name ASC').all();
    return json({ ok: true, data: d.results || [] });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminFoldersCreate(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !b.name) return json({ ok: false, error: 'name required' }, 400);
    const name = String(b.name).trim().slice(0, 100);
    const parentId = b.parent_id ? parseInt(b.parent_id, 10) : null;
    const now = cnNowISO();
    
    // Check if folder with same name already exists in the same parent
    const existing = await env.D1_DB.prepare(
      'SELECT id FROM folders WHERE name = ? AND parent_id IS ? LIMIT 1'
    ).bind(name, parentId).first();
    if (existing) return json({ ok: false, error: 'Folder with same name already exists' }, 400);
    
    const r = await env.D1_DB.prepare(
      'INSERT INTO folders (name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).bind(name, parentId, now, now).run();
    return json({ ok: true, data: { id: r.meta.last_row_id, name, parent_id: parentId } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminFoldersRename(request, env) {
  try {
    const u = new URL(request.url);
    const pathParts = u.pathname.split('/');
    const folderId = parseInt(pathParts[pathParts.length - 2], 10);
    if (!folderId) return json({ ok: false, error: 'folder id required' }, 400);
    
    const b = await request.json().catch(() => null);
    if (!b || !b.name) return json({ ok: false, error: 'name required' }, 400);
    const name = String(b.name).trim().slice(0, 100);
    
    // Check if folder exists
    const folder = await env.D1_DB.prepare('SELECT id FROM folders WHERE id = ?').bind(folderId).first();
    if (!folder) return json({ ok: false, error: 'Folder not found' }, 404);
    
    // Check if folder with same name already exists in the same parent
    const existing = await env.D1_DB.prepare(
      'SELECT id FROM folders WHERE name = ? AND parent_id = (SELECT parent_id FROM folders WHERE id = ?) AND id != ? LIMIT 1'
    ).bind(name, folderId, folderId).first();
    if (existing) return json({ ok: false, error: 'Folder with same name already exists' }, 400);
    
    const now = cnNowISO();
    await env.D1_DB.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').bind(name, now, folderId).run();
    return json({ ok: true, data: { id: folderId, name } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminFoldersDelete(request, env) {
  try {
    const u = new URL(request.url);
    const pathParts = u.pathname.split('/');
    const folderId = parseInt(pathParts[pathParts.length - 1], 10);
    if (!folderId) return json({ ok: false, error: 'folder id required' }, 400);
    
    // Check if folder exists
    const folder = await env.D1_DB.prepare('SELECT id FROM folders WHERE id = ?').bind(folderId).first();
    if (!folder) return json({ ok: false, error: 'Folder not found' }, 404);
    
    // Move all files in this folder to root (folder_id = NULL)
    await env.D1_DB.prepare('UPDATE random_pool SET folder_id = NULL WHERE folder_id = ?').bind(folderId).run();
    
    // Move all subfolders to root (parent_id = NULL)
    await env.D1_DB.prepare('UPDATE folders SET parent_id = NULL WHERE parent_id = ?').bind(folderId).run();
    
    // Delete the folder
    await env.D1_DB.prepare('DELETE FROM folders WHERE id = ?').bind(folderId).run();
    
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminPoolMoveToFolder(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !b.ids || !Array.isArray(b.ids) || !b.ids.length) return json({ ok: false, error: 'ids required' }, 400);
    const folderId = b.folder_id ? parseInt(b.folder_id, 10) : null;
    
    // Validate folder exists if folder_id is provided
    if (folderId) {
      const folder = await env.D1_DB.prepare('SELECT id FROM folders WHERE id = ?').bind(folderId).first();
      if (!folder) return json({ ok: false, error: 'Folder not found' }, 404);
    }
    
    // Update all selected files
    const ids = b.ids.map(function(id) { return parseInt(id, 10); }).filter(function(id) { return id > 0; });
    if (!ids.length) return json({ ok: false, error: 'valid ids required' }, 400);
    
    for (const id of ids) {
      await env.D1_DB.prepare('UPDATE random_pool SET folder_id = ? WHERE id = ?').bind(folderId, id).run();
    }
    
    return json({ ok: true, data: { moved: ids.length, folder_id: folderId } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== User Upload API ====================
export async function handleUserUpload(request, env) {
  try {
    const apiKey = request.headers.get('X-API-Key') || new URL(request.url).searchParams.get('api_key');
    if (!apiKey) return json({ ok: false, error: 'API key required' }, 401);
    
    const user = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key = ?').bind(apiKey).first();
    if (!user) return json({ ok: false, error: 'Invalid API key' }, 401);
    if (!user.enabled) return json({ ok: false, error: 'API key disabled' }, 403);
    
    // Check upload quota
    if (user.upload_used >= user.upload_quota) {
      return json({ ok: false, error: 'Upload quota exceeded' }, 403);
    }
    
    // Get default group_id from admin settings
    let groupId = '';
    try {
      const setting = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'upload_group_id'").first();
      if (setting && setting.value) groupId = setting.value;
    } catch (e) { /* ignore */ }
    
    if (!groupId) return json({ ok: false, error: 'No upload group configured' }, 400);
    
    const u = new URL(request.url);
    const tags = splitTags(u.searchParams.get('tags') || '').join(',');
    const formData = await request.formData();
    const files = formData.getAll('files');
    if (!files.length) return json({ ok: false, error: 'No files provided' }, 400);
    
    const results = [];
    const now = cnNowISO();
    
    for (const file of files) {
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
        results.push({ name: file.name, error: 'Not an image/video file' });
        continue;
      }
      
      // Check quota again for each file
      if (user.upload_used >= user.upload_quota) {
        results.push({ name: file.name, error: 'Upload quota exceeded' });
        continue;
      }
      
      try {
        const isVideo = file.type.startsWith('video/');
        // Send photo/video to Telegram group
        const telegramFormData = new FormData();
        telegramFormData.append('chat_id', groupId);
        telegramFormData.append(isVideo ? 'video' : 'photo', file);
        telegramFormData.append('caption', `${user.name || user.id} - ${file.name}`);
        
        const tgResponse = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${isVideo ? 'sendVideo' : 'sendPhoto'}`, {
          method: 'POST',
          body: telegramFormData
        });
        
        const tgResult = await tgResponse.json();
        if (!tgResult.ok) {
          results.push({ name: file.name, error: `Telegram error: ${tgResult.description}` });
          continue;
        }
        
        // Get file_id from the largest photo/video size
        let fileId;
        if (isVideo) {
          fileId = tgResult.result.video && tgResult.result.video.file_id;
        } else {
          const photo = tgResult.result.photo;
          fileId = photo[photo.length - 1].file_id;
        }
        if (!fileId) {
          results.push({ name: file.name, error: 'Telegram did not return a file_id' });
          continue;
        }
        const messageId = tgResult.result.message_id;
        
        // Add user_id prefix to filename
        const fileNameWithPrefix = `${user.id}_${file.name}`;
        
        // Insert into files table (Tele库 - 代理模式)
        const filesResult = await env.D1_DB.prepare(
          'INSERT INTO files (storage_key, r2_url, file_name, file_size, file_type, mime_type, group_ref, telegram_file_id, message_id, chat_id, tags, processing_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(`tg/${fileId}`, '/file/tg/placeholder', fileNameWithPrefix, file.size, isVideo ? 'video' : 'photo', file.type, groupId, fileId, String(messageId), groupId, tags, 'completed', now).run();
        
        const dbId = filesResult.meta.last_row_id;
        
        // Update with correct proxy URL
        const proxyUrl = `/file/tg/${dbId}`;
        await env.D1_DB.prepare('UPDATE files SET r2_url = ? WHERE id = ?').bind(proxyUrl, dbId).run();
        
        // Insert into user_uploads table
        const userUploadResult = await env.D1_DB.prepare(
          'INSERT INTO user_uploads (user_id, url, file_name, file_size, file_type, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(user.id, `/file/tg/${dbId}`, file.name, file.size, isVideo ? 'video' : 'photo', tags, now).run();
        // 双写 MySQL
        dualInsertUserUploads(env, {
          user_id: user.id, url: `/file/tg/${dbId}`, thumb_url: null, file_name: file.name,
          file_size: file.size, file_type: isVideo ? 'video' : 'photo', width: null, height: null,
          tags: tags, created_at: now
        }).catch(e => console.error('dualInsertUserUploads error:', e.message));
        
        // 签名直链：公开随机/共享池返回的 url 必须可访问（/file/tg/<id> 需签名，防枚举）
        let sharedUrl = `/file/tg/${dbId}`;
        try {
          const tok = await fileTok(dbId, env);
          const ext = fileExtOf(file.name, file.type);
          sharedUrl = u.origin + '/file/tg/' + tok + '/' + dbId + '.' + ext;
        } catch (e) {}
        
        // Insert into random_pool table
        await env.D1_DB.prepare(
          'INSERT INTO random_pool (url, thumb_url, title, tags, file_type, file_size, source, enabled, created_at, level) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
        ).bind(sharedUrl, sharedUrl, fileNameWithPrefix, tags, isVideo ? 'video' : 'photo', file.size, 'user_upload', now, user.level || 'pt').run();
        
        // Update quota
        await env.D1_DB.prepare('UPDATE api_keys SET upload_used = upload_used + 1, storage_used = storage_used + ? WHERE id = ?')
          .bind(file.size, user.id).run();
        
        user.upload_used++;
        user.storage_used += file.size;
        
        results.push({ 
          id: userUploadResult.meta.last_row_id, 
          file_id: dbId,
          name: file.name, 
          url: `/file/tg/${dbId}`, 
          size: file.size, 
          group_id: groupId,
          telegram_file_id: fileId,
          message_id: messageId
        });
      } catch (e) {
        results.push({ name: file.name, error: e.message });
      }
    }
    
    return json({ ok: true, data: { results, quota: { used: user.upload_used, total: user.upload_quota } } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleUserFiles(request, env) {
  try {
    const apiKey = request.headers.get('X-API-Key') || new URL(request.url).searchParams.get('api_key');
    if (!apiKey) return json({ ok: false, error: 'API key required' }, 401);
    
    const user = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key = ?').bind(apiKey).first();
    if (!user) return json({ ok: false, error: 'Invalid API key' }, 401);
    
    const u = new URL(request.url);
    const page = clampInt(u.searchParams.get('page') || '1', 1, 1, 1000);
    const pageSize = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100);
    const offset = (page - 1) * pageSize;
    const kw = u.searchParams.get('keyword') || '';
    const tags = u.searchParams.get('tags') || '';
    const type = u.searchParams.get('type') || '';
    
    let w = 'WHERE user_id = ? AND deleted_at IS NULL';
    const p = [user.id];
    
    if (kw) { w += ' AND (file_name LIKE ? OR tags LIKE ?)'; p.push('%' + kw + '%', '%' + kw + '%'); }
    if (tags) { w = appendTagFilter(tags, w, p); }
    if (type) { w += ' AND file_type=?'; p.push(type); }
    
    const total = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM user_uploads ' + w).bind(...p).first();
    const files = await env.D1_DB.prepare('SELECT * FROM user_uploads ' + w + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(...p, pageSize, offset).all();
    const origin = new URL(request.url).origin;
    const rows = (files.results || []);
    const items = await Promise.all(rows.map(async function(row) { return decorateUserUpload(row, origin, env); }));
    
    return json({ ok: true, data: items, total: total?.total || 0, page, pageSize });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 给 user_uploads 行补签名直链：user_uploads.url 存的是 /file/tg/<files.id>（占位），
// 浏览器/图片需走 /file/tg/<token>/<id>.<ext> 签名路径才能访问，防止 403 死链
async function decorateUserUpload(row, origin, env) {
  const out = Object.assign({}, row);
  const idPart = String(row.url || '').replace('/file/tg/', '');
  const id = parseInt(idPart, 10) || 0;
  if (id) {
    try {
      const tok = await fileTok(id, env);
      const ext = fileExtOf(row.file_name, row.file_type);
      out.proxy_url = origin + '/file/tg/' + tok + '/' + id + '.' + ext;
      out.display_url = out.proxy_url;
      out.url = out.proxy_url;
    } catch (e) { /* 保持原样 */ }
  }
  return out;
}

export async function handleUserFileDetail(request, env) {
  try {
    const apiKey = request.headers.get('X-API-Key') || new URL(request.url).searchParams.get('api_key');
    if (!apiKey) return json({ ok: false, error: 'API key required' }, 401);
    
    const user = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key = ?').bind(apiKey).first();
    if (!user) return json({ ok: false, error: 'Invalid API key' }, 401);
    
    const u = new URL(request.url);
    const pathParts = u.pathname.split('/');
    const fileId = parseInt(pathParts[pathParts.length - 1], 10);
    if (!fileId) return json({ ok: false, error: 'File ID required' }, 400);
    
    const file = await env.D1_DB.prepare('SELECT * FROM user_uploads WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(fileId, user.id).first();
    if (!file) return json({ ok: false, error: 'File not found' }, 404);
    
    return json({ ok: true, data: await decorateUserUpload(file, new URL(request.url).origin, env) });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleUserFileDelete(request, env) {
  try {
    const apiKey = request.headers.get('X-API-Key') || new URL(request.url).searchParams.get('api_key');
    if (!apiKey) return json({ ok: false, error: 'API key required' }, 401);
    
    const user = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key = ?').bind(apiKey).first();
    if (!user) return json({ ok: false, error: 'Invalid API key' }, 401);
    
    const u = new URL(request.url);
    const pathParts = u.pathname.split('/');
    const fileId = parseInt(pathParts[pathParts.length - 1], 10);
    if (!fileId) return json({ ok: false, error: 'File ID required' }, 400);
    
    const file = await env.D1_DB.prepare('SELECT * FROM user_uploads WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(fileId, user.id).first();
    if (!file) return json({ ok: false, error: 'File not found' }, 404);
    
    const now = cnNowISO();
    await env.D1_DB.prepare('UPDATE user_uploads SET deleted_at = ? WHERE id = ?').bind(now, fileId).run();
    // 双写 MySQL
    dualUpdateUserUploads(env, fileId, { deleted_at: now }).catch(e => console.error('dualUpdateUserUploads error:', e.message));
    
    // 级联清理（与后台删除文件惯例一致，避免"孤儿数据"残留）：
    //   - files 行软删 → /file/tg/<id> 代理不再出图
    //   - random_pool 行删除 → 公开随机/共享池不再分发已删图片
    const linkId = parseInt(String(file.url || '').replace('/file/tg/', ''), 10) || 0;
    if (linkId) {
      await cascadeCleanUserFile(env, linkId, now);
    }
    
    // Update quota
    await env.D1_DB.prepare('UPDATE api_keys SET upload_used = upload_used - 1, storage_used = storage_used - ? WHERE id = ?')
      .bind(file.file_size || 0, user.id).run();
    
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 级联清理：软删 files 行 + 删除 random_pool 中对同一文件的引用（幂等，可复用于孤儿清理）
// random_pool 引用形态多样：tg 来源存 tg_file_id=files.id；user_upload 来源存
// 相对占位 url=/file/tg/<id> 或绝对签名 url=.../file/tg/<tok>/<id>.<ext>，统一按 files.id 命中
async function cascadeCleanUserFile(env, linkId, now) {
  try {
    await env.D1_DB.prepare('UPDATE files SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(now, linkId).run();
  } catch (e) {}
  try {
    await env.D1_DB.prepare('DELETE FROM random_pool WHERE tg_file_id = ? OR url = ? OR url LIKE ? OR url LIKE ?')
      .bind(linkId, '/file/tg/' + linkId, '%/file/tg/' + linkId + '.%', '%/file/tg/%/' + linkId + '.%').run();
  } catch (e) {}
}

// 孤儿数据清理：修复历史遗留的不一致
//   1) user_uploads 仍"可见"但 files 记录已删/已软删（断链死图）→ 软删并扣配额
//   2) user_uploads 已删记录（deleted_at 非空）残留在 files/random_pool → 级联清理后物理删除记录
export async function handleUserFilesCleanup(request, env) {
  try {
    const apiKey = request.headers.get('X-API-Key') || new URL(request.url).searchParams.get('api_key');
    if (!apiKey) return json({ ok: false, error: 'API key required' }, 401);
    
    const user = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key = ?').bind(apiKey).first();
    if (!user) return json({ ok: false, error: 'Invalid API key' }, 401);
    
    const now = cnNowISO();
    const stats = { broken: 0, cascaded: 0, purged: 0 };
    
    const all = await env.D1_DB.prepare('SELECT id, url, file_size, deleted_at FROM user_uploads WHERE user_id = ?').bind(user.id).all();
    for (const row of (all.results || [])) {
      const linkId = parseInt(String(row.url || '').replace('/file/tg/', ''), 10) || 0;
      if (!linkId) continue;
      if (row.deleted_at) {
        // 已删记录：级联清 files/random_pool 残留，然后物理删除记录
        const f = await env.D1_DB.prepare('SELECT id, deleted_at FROM files WHERE id = ?').bind(linkId).first();
        if (f) {
          await cascadeCleanUserFile(env, linkId, now);
          if (f.deleted_at) stats.cascaded++; else stats.purged++;
        } else {
          await cascadeCleanUserFile(env, linkId, now);
          stats.purged++;
        }
        await env.D1_DB.prepare('DELETE FROM user_uploads WHERE id = ?').bind(row.id).run();
      } else {
        // 可见记录：files 行不存在或已软删 = 断链死图 → 软删该记录并扣配额
        const f = await env.D1_DB.prepare('SELECT id FROM files WHERE id = ? AND deleted_at IS NULL').bind(linkId).first();
        if (!f) {
          await env.D1_DB.prepare('UPDATE user_uploads SET deleted_at = ? WHERE id = ?').bind(now, row.id).run();
          await env.D1_DB.prepare('UPDATE api_keys SET upload_used = CASE WHEN upload_used > 0 THEN upload_used - 1 ELSE 0 END, storage_used = CASE WHEN storage_used >= ? THEN storage_used - ? ELSE 0 END WHERE id = ?')
            .bind(row.file_size || 0, row.file_size || 0, user.id).run();
          stats.broken++;
        }
      }
    }
    
    return json({ ok: true, data: stats });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleUserFileTags(request, env) {
  try {
    const apiKey = request.headers.get('X-API-Key') || new URL(request.url).searchParams.get('api_key');
    if (!apiKey) return json({ ok: false, error: 'API key required' }, 401);
    
    const user = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key = ?').bind(apiKey).first();
    if (!user) return json({ ok: false, error: 'Invalid API key' }, 401);
    
    const u = new URL(request.url);
    const pathParts = u.pathname.split('/');
    const fileId = parseInt(pathParts[pathParts.length - 2], 10);
    if (!fileId) return json({ ok: false, error: 'File ID required' }, 400);
    
    const b = await request.json().catch(() => null);
    if (!b || !b.tags) return json({ ok: false, error: 'Tags required' }, 400);
    
    const tags = Array.isArray(b.tags) ? b.tags.join(',') : String(b.tags);
    
    const file = await env.D1_DB.prepare('SELECT * FROM user_uploads WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(fileId, user.id).first();
    if (!file) return json({ ok: false, error: 'File not found' }, 404);
    
    await env.D1_DB.prepare('UPDATE user_uploads SET tags = ? WHERE id = ?').bind(tags, fileId).run();
    
    return json({ ok: true, data: { id: fileId, tags } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleUserRandom(request, env) {
  try {
    const apiKey = request.headers.get('X-API-Key') || new URL(request.url).searchParams.get('api_key');
    if (!apiKey) return json({ ok: false, error: 'API key required' }, 401);
    
    const user = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key = ?').bind(apiKey).first();
    if (!user) return json({ ok: false, error: 'Invalid API key' }, 401);
    
    const u = new URL(request.url);
    const count = clampInt(u.searchParams.get('count') || '1', 1, 1, 10);
    const tags = u.searchParams.get('tags') || '';
    
    let w = 'WHERE user_id = ? AND deleted_at IS NULL';
    const p = [user.id];
    
    if (tags) { w = appendTagFilter(tags, w, p); }
    
    const files = await env.D1_DB.prepare('SELECT * FROM user_uploads ' + w + ' ORDER BY RANDOM() LIMIT ?').bind(...p, count).all();
    let results = files.results || [];
    
    // 如果启用共享库备用且用户文件不足，从共享库补充
    if (results.length < count) {
      const fallbackSetting = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'pool_fallback_enabled'").first();
      if (fallbackSetting && fallbackSetting.value === '1') {
        const need = count - results.length;
        let fallbackW = 'WHERE pool = 1 AND deleted_at IS NULL';
        const fallbackP = [];
        if (tags) { fallbackW = appendTagFilter(tags, fallbackW, fallbackP); }
        
        const fallbackFiles = await env.D1_DB.prepare('SELECT * FROM random_pool ' + fallbackW + ' ORDER BY RANDOM() LIMIT ?').bind(...fallbackP, need).all();
        if (fallbackFiles.results && fallbackFiles.results.length > 0) {
          // 转换共享库文件格式以匹配用户上传格式
          const converted = fallbackFiles.results.map(f => ({
            id: f.id,
            file_id: f.file_id,
            file_type: f.file_type,
            file_name: f.file_name,
            title: f.title || f.file_name,
            tags: f.tags,
            url: f.url,
            thumb_url: f.thumb_url,
            pool: 1,
            created_at: f.created_at,
            _source: 'shared_pool'
          }));
          results = results.concat(converted);
        }
      }
    }
    
    return json({ ok: true, data: results });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleUserQuota(request, env) {
  try {
    const apiKey = request.headers.get('X-API-Key') || new URL(request.url).searchParams.get('api_key');
    if (!apiKey) return json({ ok: false, error: 'API key required' }, 401);
    
    const user = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key = ?').bind(apiKey).first();
    if (!user) return json({ ok: false, error: 'Invalid API key' }, 401);
    
    // 统计以 user_uploads 活跃行实时聚合为准（api_keys.upload_used/storage_used
    // 只是配额追踪器，历史软删/清理后可能与真实数据不一致）
    const agg = await env.D1_DB.prepare(
      "SELECT COUNT(*) AS files, COALESCE(SUM(CASE WHEN file_type='photo' THEN 1 ELSE 0 END),0) AS photos, COALESCE(SUM(CASE WHEN file_type='video' THEN 1 ELSE 0 END),0) AS videos, COALESCE(SUM(file_size),0) AS storage_used FROM user_uploads WHERE user_id = ? AND deleted_at IS NULL"
    ).bind(user.id).first();
    
    const files = Number(agg?.files || 0);
    return json({ ok: true, data: {
      upload_quota: user.upload_quota,
      upload_used: user.upload_used,
      storage_used: Number(agg?.storage_used || 0),
      files,
      photos: Number(agg?.photos || 0),
      videos: Number(agg?.videos || 0),
      quota_left: Math.max((user.upload_quota || 0) - files, 0)
    }});
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== scrape 忽略规则组云端同步（D1 settings，全局共享） ====================
// 存储键：scrape_rule_groups = JSON 数组 [{key,name,kw,ext,mb}]。
// 规则组含「默认（*）」时 key='*'；保存前兜底确保存在。用于让 scrape 页在不同浏览器/设备共享同一套忽略规则。
const SCRAPE_RULE_GROUPS_KEY = 'scrape_rule_groups';
function cleanRuleGroupList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const g of list) {
    if (!g || typeof g !== 'object') continue;
    const key = String(g.key || '').trim().slice(0, 200);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key: key,
      name: String(g.name != null && g.name !== '' ? g.name : (key === '*' ? '默认（所有页面）' : key)).trim().slice(0, 200),
      kw: String(g.kw || '').trim().slice(0, 4000),
      ext: String(g.ext != null ? g.ext : 'svg').trim().slice(0, 500),
      mb: clampInt(g.mb, 10, 1, 30)
    });
  }
  return out;
}
// GET /admin/api/scrape/rule-groups → { ok, data: { groups, ts } }
export async function handleAdminScrapeRuleGroupsGet(env) {
  try {
    let groups = [];
    if (env.D1_DB) {
      try {
        const r = await env.D1_DB.prepare("SELECT value FROM settings WHERE key=?").bind(SCRAPE_RULE_GROUPS_KEY).first();
        if (r && r.value) { const p = JSON.parse(r.value); if (Array.isArray(p)) groups = p; }
      } catch (e) {}
    }
    return json({ ok: true, data: { groups: cleanRuleGroupList(groups) } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
// POST /admin/api/scrape/rule-groups  Body: { groups:[...] } → 全量覆盖保存
export async function handleAdminScrapeRuleGroupsSave(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const groups = cleanRuleGroupList(b && b.groups);
    if (!env.D1_DB) return json({ ok: false, error: 'D1 不可用' }, 500);
    // 确保至少存在默认组兜底
    if (!groups.some(function(g) { return g.key === '*'; })) {
      groups.unshift({ key: '*', name: '默认（所有页面）', kw: '', ext: 'svg', mb: 10 });
    }
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(SCRAPE_RULE_GROUPS_KEY, JSON.stringify(groups)).run();
    return json({ ok: true, data: { groups: groups } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
