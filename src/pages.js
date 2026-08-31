// ==================== 静态页面（ADMIN PAGE / DOCS / DASHBOARD） ====================
// /admin、/user、/admin/guide：从 R2 读取静态页；/docs：API 文档页；/dashboard：监控面板。
import { json, fmtSize } from "./util.js";
import { cnDayIso, cnTodayStr, hashKeyPass } from "./core.js";
// ==================== ADMIN PAGE ====================

export async function handleAdminFromR2(env) {
  try {
    const obj = await env.R2_BUCKET.get('admin.html');
    if (!obj) return new Response('admin.html not found in R2. Please upload admin.html to R2 bucket.', { status: 404 });
    // Serve the page as-is. The API key is deliberately NOT embedded here anymore:
    // the admin page reads it from ?api_key= / localStorage / the login form, so
    // anyone opening /admin can no longer scrape the key from the page source.
    const headers = new Headers();
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'no-cache');
    return new Response(obj.body, { headers });
  } catch (e) {
    return new Response('Error loading admin page: ' + e.message, { status: 500 });
  }
}

// 管理员使用手册：从 R2 读取 admin-guide.html 静态页（含部分内链图片 URL，缓存较短）
export async function handleAdminGuideFromR2(env) {
  try {
    const obj = await env.R2_BUCKET.get('admin-guide.html');
    if (!obj) return new Response('admin-guide.html not found in R2. Please upload admin-guide.html to R2 bucket.', { status: 404 });
    const headers = new Headers();
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'no-cache');
    return new Response(obj.body, { headers });
  } catch (e) {
    return new Response('Error loading admin guide: ' + e.message, { status: 500 });
  }
}

// 用户门户页：从 R2 读取 user.html（普通用户 key-pass 登录 + key 统计 + 接口生成器）
export async function handleUserFromR2(env) {
  try {
    const obj = await env.R2_BUCKET.get('user.html');
    if (!obj) return new Response('user.html not found in R2. Please upload user.html to R2 bucket.', { status: 404 });
    const headers = new Headers();
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'no-cache');
    return new Response(obj.body, { headers });
  } catch (e) {
    return new Response('Error loading user page: ' + e.message, { status: 500 });
  }
}

// 用户门户登录：支持「密钥 + key-pass」或「用户名 + 密码」两种方式，返回该密钥的统计信息（不含密码哈希）
export async function handleUserLogin(request, env) {
  try {
    if (!env.D1_DB) return json({ ok: false, error: 'DB unavailable' }, 500);
    const b = await request.json().catch(function() { return {}; });
    const username = String(b.username || '').trim();
    let key = String(b.key || b.api_key || '').trim();
    let pass = String(b.key_pass || b.password || '').trim();
    // 用户名登录：先用用户名定位密钥，再用 key-pass 校验
    if (!key && username) {
      const byName = await env.D1_DB.prepare('SELECT key FROM api_keys WHERE username=? LIMIT 1').bind(username).first();
      if (!byName) return json({ ok: false, error: '用户名或密码不正确' }, 401);
      key = byName.key;
    }
    if (!key || !pass) return json({ ok: false, error: '请填写用户名/密钥与密码' }, 400);
    const rec = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key=? AND enabled=1 AND (expires_at IS NULL OR expires_at=\'\' OR expires_at >= date(\'now\')) LIMIT 1').bind(key).first();
    if (!rec || !rec.key_pass) return json({ ok: false, error: '用户名或密码不正确' }, 401);
    const hp = await hashKeyPass(pass, key);
    if (hp !== rec.key_pass) return json({ ok: false, error: '用户名或密码不正确' }, 401);
    const today = cnTodayStr();
    const exp = rec.expires_at || '';
    rec.expired = exp ? (exp < today ? 1 : 0) : 0;
    return json({ ok: true, data: {
      id: rec.id, key: rec.key, short_key: rec.short_key || '', name: rec.name, username: rec.username || '', scopes: rec.scopes, level: rec.level,
      enabled: rec.enabled, expires_at: rec.expires_at, expired: rec.expired,
      created_at: rec.created_at, last_used_at: rec.last_used_at, usage_count: rec.usage_count
    } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}


// ==================== DOCS ====================

export function handleDocs() {
  const h = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>API Docs</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0f172a;color:#e2e8f0}.hd{background:linear-gradient(135deg,#1e3a5f,#0f172a);padding:30px;text-align:center;border-bottom:1px solid #1e293b}.hd h1{font-size:26px;margin-bottom:6px}.hd p{color:#94a3b8}.ct{max-width:880px;margin:0 auto;padding:25px 20px}.ab{background:#78350f;border:1px solid #92400e;border-radius:10px;padding:18px;margin-bottom:25px}.ab h3{color:#fbbf24;margin-bottom:8px}.ab p{color:#fcd34d;font-size:14px;margin:4px 0}.ab code{background:#92400e;padding:2px 8px;border-radius:3px;color:#fff}.sc h2{font-size:18px;color:#60a5fa;margin:25px 0 15px;padding-bottom:8px;border-bottom:1px solid #1e293b}.ac{background:#1e293b;border-radius:8px;padding:16px;border:1px solid #334155;margin-bottom:12px}.ah{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.mg{padding:3px 10px;border-radius:4px;font-size:12px;font-weight:700}.mg.g{background:#166534;color:#86efac}.mg.p{background:#1e3a5f;color:#93c5fd}.mg.r{background:#7f1d1d;color:#fca5a5}.pp{font-family:monospace;font-size:14px;color:#f1f5f9}.tg{padding:2px 8px;border-radius:4px;font-size:11px}.tp{background:#166534;color:#86efac}.ta{background:#78350f;color:#fcd34d}.ad{color:#94a3b8;font-size:13px;margin:8px 0}.pt{margin-top:8px}.pt table{width:100%;border-collapse:collapse;font-size:12px}.pt th{text-align:left;color:#94a3b8;padding:5px 8px;border-bottom:1px solid #334155}.pt td{padding:5px 8px;border-bottom:1px solid #1e293b}.pt code{background:#334155;padding:1px 5px;border-radius:3px;font-size:11px;color:#fbbf24}.cd{font-family:monospace;font-size:12px;background:#0f172a;padding:12px;border-radius:6px;margin-top:10px;overflow-x:auto;white-space:pre;line-height:1.6}.cd.g{color:#86efac}.cd.b{color:#93c5fd}.nb{background:#1e3a5f;border:1px solid #3b82f6;border-radius:10px;padding:18px;margin-bottom:25px}.nb h3{color:#60a5fa;margin-bottom:8px}.nb p{color:#93c5fd;font-size:14px;margin:4px 0}</style></head><body>';
  const e = '</body></html>';
  const auth = '<div class="ab"><h3>Auth</h3><p>Header: <code>X-API-Key: your_key</code></p><p>Or: <code>?api_key=your_key</code></p></div>';
  const note = '<div class="nb"><h3>Custom Bot API</h3><p>This Worker also provides a Telegram Bot API proxy.</p><p>Endpoint: <code>/bot/{method}</code> (POST, body = Telegram Bot API params)</p><p>Supported: sendMessage, sendPhoto, sendDocument, sendVideo, getFile, getMe, getWebhookInfo, setWebhook, getUpdates, getChat, banChatMember, deleteMessage, forwardMessage, copyMessage</p><p>Example: <code>POST /bot/sendMessage</code> with body {"chat_id":"...","text":"Hello"}</p></div>';
  const eps = [
    ['GET', '/health', 'public', 'Health check', null],
    ['GET', '/api/files', 'auth', 'File list (paginated, filtered)', [['page', 'int', 'No', 'Page, default 1'], ['page_size', 'int', 'No', 'Per page, default 20, max 100'], ['type', 'string', 'No', 'photo/document/video/audio'], ['chat_id', 'string', 'No', 'Group ID'], ['user_id', 'int', 'No', 'User ID'], ['keyword', 'string', 'No', 'Search keyword'], ['start_date', 'string', 'No', '2026-08-01'], ['end_date', 'string', 'No', '2026-08-31']]],
    ['GET', '/api/file?id=1', 'auth', 'Single file detail', [['id', 'int', 'File ID (or use url)'], ['url', 'string', 'R2 URL (or use id)']]],
    ['GET', '/api/stats', 'auth', 'Statistics (total, size, today, by type/chat)', null],
    ['GET', '/api/latest', 'auth', 'Latest files', [['limit', 'int', 'Count, default 10, max 50'], ['type', 'string', 'Filter by type']]],
    ['GET', '/api/search?q=xxx', 'auth', 'Search files', [['q', 'string', 'Yes', 'Keyword'], ['page', 'int', 'No', 'Page'], ['page_size', 'int', 'No', 'Per page']]],
    ['GET', '/api/by-chat', 'auth', 'Query by group', [['chat_id', 'string', 'Group ID'], ['chat_title', 'string', 'Name (fuzzy)'], ['page', 'int', 'Page'], ['page_size', 'int', 'Per page']]],
    ['GET', '/api/by-user', 'auth', 'Query by user', [['user_id', 'int', 'User ID'], ['username', 'string', 'Name (fuzzy)'], ['page', 'int', 'Page'], ['page_size', 'int', 'Per page']]],
    ['GET', '/api/by-date?date=2026-08-23', 'auth', 'Query by date', [['date', 'string', 'Yes', 'YYYY-MM-DD'], ['page', 'int', 'No', 'Page'], ['page_size', 'int', 'No', 'Per page']]],
    ['GET', '/api/stream?id=1', 'auth', 'File stream (binary)', null],
    ['DELETE', '/api/file?id=1', 'auth', 'Delete file', null],
    ['GET', '/api/bots', 'auth', 'List bots', null],
    ['GET', '/api/config', 'auth', 'Get config', null],
    ['POST', '/bot/*', 'public', 'Telegram Bot API proxy (see above)', null],
    ['POST', '/webhook', 'public', 'Telegram webhook', null],
    ['GET', '/dashboard', 'public', 'Monitoring dashboard', null],
    ['GET', '/docs', 'public', 'API docs (this page)', null],
  ];
  let list = '<div class="sc"><h2>Endpoints</h2>';
  for (const [method, path, auth2, desc, params] of eps) {
    const cls = method === 'GET' ? 'g' : method === 'POST' ? 'p' : 'r';
    list += '<div class="ac"><div class="ah"><span class="mg ' + cls + '">' + method + '</span><span class="pp">' + path + '</span><span class="tg t' + (auth2 === 'public' ? 'p' : 'a') + '">' + auth2 + '</span></div><div class="ad">' + desc + '</div>';
    if (params) {
      list += '<div class="pt"><table><tr><th>Param</th><th>Type</th><th>Required</th><th>Desc</th></tr>';
      for (const [n, t, r, d] of params) list += '<tr><td><code>' + n + '</code></td><td>' + t + '</td><td>' + (r || 'No') + '</td><td>' + d + '</td></tr>';
      list += '</table></div>';
    }
    list += '</div>';
  }
  list += '</div>';
  const resp = '<div class="sc"><h2>Response</h2><div class="ac"><div class="cd g">{\n  "ok": true,\n  "data": {\n    "total": 100, "page": 1, "page_size": 20,\n    "items": [{\n      "id": 1, "r2_url": "https://...",\n      "file_name": "photo.jpg", "file_type": "photo",\n      "file_size": 1024000, "chat_title": "group",\n      "username": "user123",\n      "created_at": "2026-08-23T10:30:00Z"\n    }]\n  }\n}</div></div></div>';
  const ex = '<div class="sc"><h2>Examples</h2>'
    + '<div class="ac"><h4 style="color:#94a3b8;font-size:13px;margin-bottom:8px">JavaScript</h4><div class="cd b">const res = await fetch(\n  "https://telegram-r2-bot.wo58.cn/api/latest?type=photo&amp;limit=10",\n  { headers: { "X-API-Key": "your_key" } }\n);\nconst { ok, data } = await res.json();\nif (ok) data.forEach(f =&gt; console.log(f.file_name, f.r2_url));</div></div>'
    + '<div class="ac"><h4 style="color:#94a3b8;font-size:13px;margin-bottom:8px">Python</h4><div class="cd b">import requests\nresp = requests.get(\n    "https://telegram-r2-bot.wo58.cn/api/latest",\n    headers={"X-API-Key": "your_key"},\n    params={"limit": 10, "type": "photo"}\n)\nfor f in resp.json()["data"]:\n    print(f["file_name"], f["r2_url"])</div></div>'
    + '<div class="ac"><h4 style="color:#94a3b8;font-size:13px;margin-bottom:8px">Bot API Proxy</h4><div class="cd b">// Send message via Worker\nawait fetch("https://your-worker.dev/bot/sendMessage", {\n  method: "POST",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({\n    chat_id: "-1001234567890",\n    text: "Hello from Worker!"\n  })\n});</div></div>'
    + '<div class="ac"><h4 style="color:#94a3b8;font-size:13px;margin-bottom:8px">cURL</h4><div class="cd b">curl -H "X-API-Key: your_key" \\\n  "https://telegram-r2-bot.wo58.cn/api/files?type=photo&amp;page=1"</div></div></div>';
  return new Response(h + auth + note + list + resp + ex + e, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ==================== DASHBOARD ====================

export async function handleDashboard(env) {
  let sh = '<div style="color:#64748b">loading...</div>';
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first();
    const s = await env.D1_DB.prepare('SELECT SUM(file_size) as s FROM files WHERE deleted_at IS NULL').first();
    const td = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=?').bind(cnDayIso(cnTodayStr())).first();
    const mo = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=?').bind(cnDayIso(cnTodayStr().slice(0, 8) + '01')).first();
    sh = '<div class="card"><div class="ct2">Total</div><div class="sv">' + (t?.c || 0) + '</div></div>'
      + '<div class="card"><div class="ct2">Storage</div><div class="sv">' + fmtSize(s?.s || 0) + '</div></div>'
      + '<div class="card"><div class="ct2">Today</div><div class="sv">' + (td?.c || 0) + '</div></div>'
      + '<div class="card"><div class="ct2">Month</div><div class="sv">' + (mo?.c || 0) + '</div></div>';
  } catch (e) {}
  return new Response('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0f172a;color:#e2e8f0}.hd{background:linear-gradient(135deg,#1e3a5f,#0f172a);padding:20px 30px;border-bottom:1px solid #1e293b}.hd h1{font-size:22px}.hd p{color:#94a3b8;margin-top:5px}.ct{max-width:1200px;margin:0 auto;padding:20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:15px;margin-bottom:20px}.card{background:#1e293b;border-radius:10px;padding:18px;border:1px solid #334155}.ct2{font-size:13px;color:#94a3b8;text-transform:uppercase;margin-bottom:10px}.sv{font-size:28px;font-weight:700;color:#60a5fa}.btn{background:#3b82f6;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px}.btn:hover{background:#2563eb}.sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.si{display:flex;align-items:center;gap:10px;padding:12px;background:#0f172a;border-radius:8px}.dot{width:10px;height:10px;border-radius:50%}.dot.ok{background:#22c55e}.dot.err{background:#ef4444}.dot.ld{background:#f59e0b;animation:p 1s infinite}@keyframes p{0%,100%{opacity:1}50%{opacity:.5}}.si h3{font-size:13px}.si p{font-size:11px;color:#64748b;margin-top:2px}.lg{background:#0f172a;border-radius:8px;padding:12px;max-height:200px;overflow-y:auto;font-family:monospace;font-size:11px;line-height:1.8}.le{color:#94a3b8}.le.ok{color:#22c55e}.le.err{color:#ef4444}.lt{color:#475569}</style></head><body>'
    + '<div class="hd"><h1>TG Bot Dashboard v7</h1><p>R2 + D1 + Custom Bot API</p></div>'
    + '<div class="ct"><div class="grid">' + sh + '</div>'
    + '<div class="card" style="margin-bottom:20px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h3 style="font-size:16px">Status</h3><button class="btn" onclick="go()" id="rb">Refresh</button></div>'
    + '<div class="sg"><div class="si"><div class="dot ld" id="d-h"></div><div><h3>Health</h3><p id="m-h">...</p></div></div>'
    + '<div class="si"><div class="dot ld" id="d-d"></div><div><h3>D1</h3><p id="m-d">...</p></div></div>'
    + '<div class="si"><div class="dot ld" id="d-r"></div><div><h3>R2</h3><p id="m-r">...</p></div></div>'
    + '<div class="si"><div class="dot ld" id="d-t"></div><div><h3>Telegram</h3><p id="m-t">...</p></div></div></div></div>'
    + '<div class="card"><h3 style="font-size:16px;margin-bottom:10px">Logs</h3><div class="lg" id="logs"></div></div></div>'
    + '<script>var K=localStorage.getItem("ak")||prompt("API Key:");if(K)localStorage.setItem("ak",K);var H={"X-API-Key":K},L=document.getElementById("logs");function lg(m,t){var t2=new Date().toLocaleTimeString();L.innerHTML="<div class=\\"le "+(t||"")+"\\"><span class=\\"lt\\">["+t2+"]</span> "+m+"</div>"+L.innerHTML}function sd(n,ok,m){document.getElementById("d-"+n).className="dot "+(ok?"ok":"err");document.getElementById("m-"+n).textContent=m}async function ck(n,u,okm,erm){try{var r=await fetch(u,{headers:H});var d=await r.json();var m=r.ok?okm:(d.error||"Error");sd(n,r.ok,m);lg(n+": "+m,r.ok?"ok":"err");return r.ok}catch(e){sd(n,false,e.message);lg(n+": "+e.message,"err");return false}}async function go(){document.getElementById("rb").disabled=true;await ck("h","/health","OK","Failed");await ck("d","/api/stats","D1 OK","D1 Error");await ck("r","/api/files?page_size=1","R2 OK","R2 Error");await ck("t","/health","Bot OK","Error");document.getElementById("rb").disabled=false;lg("Done","ok")}go()</script></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

