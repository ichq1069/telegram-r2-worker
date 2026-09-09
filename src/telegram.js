// ==================== TELEGRAM 通信层 ====================
// Bot API 文件下载（绕过 20MB 限制）、R2 上传、回复消息、快捷键盘、Bot API 代理
import { json, fmtSize } from './util.js';
import { cnTodayStr, cnNowISO } from './core.js';

export var OFFICIAL_API = 'https://api.telegram.org'; // official cloud Bot API

// 扩展名 → 建议 MIME（Telegram 下载响应头常为 application/octet-stream，
// 用它直接写 R2 会导致浏览器把 mp4 当下载、播放器探测歧义；按存储 key 后缀纠正。）
const MIME_BY_EXT = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', mkv: 'video/x-matroska',
  webm: 'video/webm', avi: 'video/x-msvideo', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', opus: 'audio/ogg',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic', avif: 'image/avif',
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', json: 'application/json', html: 'text/html', css: 'text/css', js: 'text/javascript'
};

// 仅当上游未给出可用 MIME（octet-stream / 空）时，按 key 扩展名推断。
// 已明确的类型（image/jpeg、video/mp4 等）原样保留。
export function mimeForStorageKey(key, ct) {
  const cur = String(ct || '').split(';')[0].trim().toLowerCase();
  if (cur && cur !== 'application/octet-stream' && cur !== 'binary/octet-stream') return ct;
  const m = /\.([a-zA-Z0-9]{1,10})$/.exec(String(key || ''));
  if (!m) return ct;
  const want = MIME_BY_EXT[m[1].toLowerCase()];
  return want || ct;
}

// /file/tg/<id> 访问签名：token = HMAC-SHA256(secret, 'tgfile:<id>') 前 16 hex。
// 防止通过递增 id 拼接 URL 遍历枚举所有图片；secret 取 API_KEY/TG_SECRET（未配置时用内置兜底）。
let _tokKeyCache = null;
export async function fileTok(id, env) {
  const secret = env.API_KEY || env.TG_SECRET || 'tgfile-sign-2026';
  try {
    if (!_tokKeyCache) {
      _tokKeyCache = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    }
    const sig = await crypto.subtle.sign('HMAC', _tokKeyCache, new TextEncoder().encode('tgfile:' + id));
    const bytes = new Uint8Array(sig);
    let hex = '';
    for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  } catch (e) { return ''; }
}

// ==================== FILE DOWNLOAD (Bypass 20MB limit) ====================

// API base: try TG_API_BASE first, then TG_API_BASE_2 (failover), fall back to official API
export function tgApiBases(env) {
  var bases = [];
  if (env && env.TG_API_BASE) bases.push(env.TG_API_BASE);
  if (env && env.TG_API_BASE_2) bases.push(env.TG_API_BASE_2);
  if (bases.length === 0) bases.push('https://api.telegram.org');
  return bases;
}

// Local Bot API (--local mode) returns ABSOLUTE disk paths (e.g. /var/lib/telegram-bot-api/<token>/videos/file_1).
// Those files are served via the nginx /tgfile/ alias (bind-mounted to the Docker volume data dir).
export function fileDownloadUrl(base, botToken, filePath) {
  if (filePath.indexOf('/') === 0) {
    var rel = filePath.replace(/^\//, '');
    var idx = rel.indexOf(botToken + '/');
    if (idx >= 0) rel = rel.substring(idx);
    else { var j = rel.indexOf('/'); if (j >= 0) rel = rel.substring(j + 1); }
    return base + '/tgfile/' + rel;
  }
  return base + '/file/bot' + botToken + '/' + filePath;
}

// Large files (>50MB): stream from Telegram to R2 without buffering in memory
export async function dlFileStream(fileId, botToken, bases) {
  var lastErr = '';
  for (var i = 0; i < bases.length; i++) {
    var base = bases[i];
    try {
      const r = await fetch(base + '/bot' + botToken + '/getFile?file_id=' + encodeURIComponent(fileId));
      const j = await r.json();
      if (!j.ok || !j.result?.file_path) { lastErr = 'getFile: ' + (j.description || JSON.stringify(j).slice(0, 120)) + ' @' + base; console.log('dlFileStream getFile fail @' + base + ':', JSON.stringify(j).slice(0, 200)); continue; }
      const fr = await fetch(fileDownloadUrl(base, botToken, j.result.file_path));
      if (!fr.ok) { lastErr = 'download HTTP ' + fr.status + ' @' + base; console.log('dlFileStream download fail @' + base + ', status:', fr.status); continue; }
      return { stream: fr.body, ct: fr.headers.get('content-type') || 'application/octet-stream', tgUrl: (base === OFFICIAL_API) ? fileDownloadUrl(base, botToken, j.result.file_path) : '' };
    } catch (e) { lastErr = e.message; console.log('dlFileStream error @' + base + ':', e.message); }
  }
  return lastErr ? { error: lastErr } : null;
}

export async function dlFileLarger(fileId, fileSize, botToken, bases, onProgress) {
  var lastErr = '';
  for (var i = 0; i < bases.length; i++) {
    const base = bases[i];
    // Standard Bot API download (works up to 20MB on cloud API, unlimited on Local Bot API Server)
    try {
      const r = await fetch(base + '/bot' + botToken + '/getFile?file_id=' + encodeURIComponent(fileId));
      const j = await r.json();
      if (j.ok && j.result?.file_path) {
        const fr = await fetch(fileDownloadUrl(base, botToken, j.result.file_path));
        if (fr.ok) {
          const buf = await readBodyWithProgress(fr.body, onProgress);
          return { buf: buf, ct: fr.headers.get('content-type') || 'application/octet-stream', tgUrl: (base === OFFICIAL_API) ? fileDownloadUrl(base, botToken, j.result.file_path) : '' };
        }
        lastErr = 'download HTTP ' + fr.status + ' @' + base;
      } else {
        lastErr = 'getFile: ' + (j.description || JSON.stringify(j).slice(0, 120)) + ' @' + base;
      }
    } catch (e) { lastErr = e.message; console.log('Standard download failed @' + base + ':', e.message); }

    // For files > 20MB: try to use the file_path to construct CDN URL
    if (fileSize > 20 * 1024 * 1024) {
      try {
        const r2 = await fetch(base + '/bot' + botToken + '/getFile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_id: fileId })
        });
        const j2 = await r2.json();
        if (j2.ok && j2.result?.file_path) {
          const fp = j2.result.file_path;
          const cdnUrl = fileDownloadUrl(base, botToken, fp);
          const fr2 = await fetch(cdnUrl);
          if (fr2.ok) {
            const buf = await readBodyWithProgress(fr2.body, onProgress);
            return { buf: buf, ct: fr2.headers.get('content-type') || 'application/octet-stream', tgUrl: (base === OFFICIAL_API) ? cdnUrl : '' };
          }
        }
        console.log('Large file download failed @' + base + ', size:', fileSize);
      } catch (e) { lastErr = 'CDN ' + e.message + ' @' + base; console.log('CDN download failed @' + base + ':', e.message); }
    }
  }

  return lastErr ? { error: lastErr } : null;
}

// Read a response body into an ArrayBuffer while invoking onProgress(bytes) periodically
export async function readBodyWithProgress(body, onProgress) {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength || value.length || 0;
      if (onProgress) {
        const now = Date.now();
        if (now - last > 1500) { last = now; onProgress(total); }
      }
    }
  }
  if (onProgress) onProgress(total);
  const buf = new Uint8Array(total);
  let off = 0;
  for (let c of chunks) { buf.set(c, off); off += c.byteLength || c.length || 0; }
  return buf.buffer;
}

// Streamed download (no full buffering): returns { stream, ct, tgUrl } or { error }
export async function dlFileStreamLarger(fileId, botToken, bases) {
  var lastErr = '';
  for (var i = 0; i < bases.length; i++) {
    const base = bases[i];
    try {
      const r = await fetch(base + '/bot' + botToken + '/getFile?file_id=' + encodeURIComponent(fileId));
      const j = await r.json();
      if (j.ok && j.result?.file_path) {
        const fr = await fetch(fileDownloadUrl(base, botToken, j.result.file_path));
        if (fr.ok) {
          return { stream: fr.body, ct: fr.headers.get('content-type') || 'application/octet-stream', tgUrl: (base === OFFICIAL_API) ? fileDownloadUrl(base, botToken, j.result.file_path) : '' };
        }
        lastErr = 'download HTTP ' + fr.status + ' @' + base;
      } else {
        lastErr = 'getFile: ' + (j.description || JSON.stringify(j).slice(0, 120)) + ' @' + base;
      }
    } catch (e) { lastErr = e.message; }
  }
  return lastErr ? { error: lastErr } : null;
}

export async function dlFile(fileId, botToken, bases) {
  for (var i = 0; i < bases.length; i++) {
    const base = bases[i];
    try {
      const r = await fetch(base + '/bot' + botToken + '/getFile?file_id=' + encodeURIComponent(fileId));
      const j = await r.json();
      if (!j.ok || !j.result?.file_path) continue;
      const fr = await fetch(fileDownloadUrl(base, botToken, j.result.file_path));
      if (!fr.ok) continue;
      return { buf: await fr.arrayBuffer(), ct: fr.headers.get('content-type') || 'application/octet-stream' };
    } catch (e) { continue; }
  }
  return null;
}

// Last R2 upload error (for diagnostics in error_msg)
export var lastUploadError = '';
// Big media goes to the cheaper Infrequent Access storage class (still public + CDN-cached)
export var COLD_STORAGE_MIN = 10 * 1024 * 1024; // >=10MB
export var COLD_STORAGE_CLASS = 'Infrequent Access';
// R2 用量计数器（settings 表，异步写不阻塞主流程；A类=写操作，B类=读操作）
export function bumpR2Usage(env, key) {
  if (!env || !env.D1_DB) return;
  env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(COALESCE(value,'0') AS INTEGER)+1").bind(key).run().catch(function(){});
}

// 本地请求计数（worker_stats 表，按天累计；GraphQL 不可用时的兜底）
export function bumpWorkerStat(env) {
  if (!env || !env.D1_DB) return;
  const day = cnTodayStr();
  env.D1_DB.prepare("INSERT INTO worker_stats (day, requests, updated_at) VALUES (?, 1, ?) ON CONFLICT(day) DO UPDATE SET requests = requests + 1, updated_at = excluded.updated_at").bind(day, cnNowISO()).run().catch(function(){});
}

export async function putR2(key, buf, ct, env, storageClass) {
  try {
    const mime = mimeForStorageKey(key, ct);
    const opts = { httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000' } };
    // storageClass 暂不使用：Infrequent Access 需 R2 账号启用，未启用时 put 报 10001。
    // 先全部走 Standard 保证功能，需要省成本时再按账号能力启用。
    // if (storageClass) opts.storageClass = storageClass;
    await env.R2_BUCKET.put(key, buf, opts);
    bumpR2Usage(env, 'r2_class_a');
    return (env.R2_PUBLIC_URL || '') + '/' + key;
  } catch (e) { lastUploadError = (e && e.message) || String(e); console.log('putR2 error:', lastUploadError); return null; }
}

export async function putR2Stream(key, stream, ct, env, storageClass) {
  try {
    const mime = mimeForStorageKey(key, ct);
    const opts = { httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000' } };
    // 同上：storageClass 暂不使用（避免未启用 Infrequent Access 时 10001）
    // if (storageClass) opts.storageClass = storageClass;
    await env.R2_BUCKET.put(key, stream, opts);
    bumpR2Usage(env, 'r2_class_a');
    return (env.R2_PUBLIC_URL || '') + '/' + key;
  } catch (e) { lastUploadError = (e && e.message) || String(e); console.log('putR2Stream error:', lastUploadError); return null; }
}

export async function computeMd5(buf) {
  const hash = await crypto.subtle.digest('MD5', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// JPEG 二进制清理：剥离 EXIF(APP1) / Photoshop IPTC(APP13) 元数据段，其余字节原样保留。
// 用于 document 上传的图片（Telegram 对 photo 会自行重压缩去除 EXIF，document 原图会保留 GPS 等隐私）。
// 纯二进制处理不解析像素，出错时静默返回原 buf。
export function stripExifIfJpeg(buf, ct) {
  try {
    if (!buf || !buf.byteLength || buf.byteLength < 4) return buf;
    const t = String(ct || '').toLowerCase();
    if (t.indexOf('jpeg') === -1 && t.indexOf('jpg') === -1) return buf;
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8[0] !== 0xFF || u8[1] !== 0xD8) return buf; // 非 JPEG 头
    const out = new Uint8Array(u8.length);
    let oi = 0;
    out[oi++] = u8[0]; out[oi++] = u8[1]; // SOI
    let i = 2;
    const n = u8.length;
    let stripped = false;
    while (i + 3 < n) {
      if (u8[i] !== 0xFF) break;
      const m = u8[i + 1];
      if (m === 0xD9 || m === 0xDA) { // EOI / SOS → 剩余压缩数据原样拷贝
        out[oi++] = u8[i]; out[oi++] = u8[i + 1];
        out.set(u8.subarray(i + 2, n), oi);
        oi += n - i - 2;
        return stripped ? out.slice(0, oi) : buf;
      }
      if (m >= 0xD0 && m <= 0xD7) { out[oi++] = u8[i]; out[oi++] = u8[i + 1]; i += 2; continue; } // RSTn 无长度
      const len = (u8[i + 2] << 8) | u8[i + 3];
      const segEnd = i + 2 + len;
      if (segEnd > n) break; // 残缺段，放弃
      const isMeta = (m === 0xE1) || (m === 0xED); // APP1=EXIF, APP13=Photoshop IPTC
      if (isMeta) {
        stripped = true;
      } else {
        out.set(u8.subarray(i, segEnd), oi);
        oi += segEnd - i;
      }
      i = segEnd;
    }
    return stripped ? out.slice(0, oi) : buf;
  } catch (e) { return buf; }
}

// 已入库数量统计：总数（未删除）+ 已完成转存数
export async function countCompleted(env) {
  if (!env.D1_DB) return null;
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first();
    const c = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND processing_state='completed'").first();
    return { total: t?.c || 0, completed: c?.c || 0 };
  } catch (e) { return null; }
}

export async function replyText(chatId, replyId, text, env) {
  try {
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' })
    });
  } catch (e) { console.log('replyText error:', e.message); }
}

// 纯文本回复（无 parse_mode，AI 长回复/含特殊字符用）
export async function replyTextPlain(chatId, replyId, text, env) {
  try {
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text })
    });
  } catch (e) { console.log('replyTextPlain error:', e.message); }
}

// 主菜单按钮（inline keyboard），点按钮代替手动输命令
export var MAIN_BUTTONS = [
  [{ text: '📊 现有数量', callback_data: 'cmd:count' }, { text: '⏳ 未转存', callback_data: 'cmd:pending' }],
  [{ text: '🚀 继续转存', callback_data: 'cmd:retry' }, { text: '🛰 服务状态', callback_data: 'cmd:health' }]
];

// ==================== 快捷回复键盘（ReplyKeyboardMarkup） ====================
// 设置项 settings['main_menu']：{"enabled":1,"text":"查看图库","help":"帮助"}
// 键盘按钮为纯文本，点按钮等价于在输入框发送对应文字；随 /start 下发，可后台广播到全部聊天。
export async function getMainMenuCfg(env) {
  const def = { enabled: 1, text: '查看图库', help: '帮助' };
  if (!env.D1_DB) return def;
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='main_menu'").first();
    if (!s) return def;
    const c = JSON.parse(s.value || '{}');
    return { enabled: c.enabled !== 0 ? 1 : 0, text: (c.text || '').trim() || def.text, help: (c.help || '').trim() || def.help };
  } catch (e) { return def; }
}

export async function sendQuickReplyKeyboard(chatId, env) {
  if (!env.TG_BOT_TOKEN) return false;
  const cfg = await getMainMenuCfg(env);
  if (!cfg.enabled) return false;
  const kb = [[{ text: cfg.text }, { text: cfg.help }]];
  try {
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: '⌨️ 快捷按钮已就绪', reply_markup: { keyboard: kb, resize_keyboard: true, one_time_keyboard: false, input_field_placeholder: '点击按钮或直接发送内容' } })
    });
    return true;
  } catch (e) { console.log('quickReply kb fail:', e.message); return false; }
}

// 广播快捷回复键盘到全部私聊（键盘是聊天级状态，需逐个下发才对新旧聊天生效）
export async function broadcastQuickReplyKeyboard(env) {
  if (!env.D1_DB || !env.TG_BOT_TOKEN) return { total: 0, sent: 0, failed: 0, error: 'D1 or token missing' };
  try {
    // 私聊会话以 known_chats 为准（recordKnownChat 已在每条消息记录，含纯文本 /start /help 等）；
    // 兼容老数据：files 表里 chat_type='private' 的历史记录合并去重
    const d = await env.D1_DB.prepare("SELECT chat_id FROM known_chats WHERE chat_type='private' AND chat_id IS NOT NULL AND chat_id!='' ORDER BY last_active_at DESC").all();
    const legacy = await env.D1_DB.prepare("SELECT DISTINCT chat_id FROM files WHERE chat_type='private' AND chat_id IS NOT NULL AND chat_id!=''").all();
    const seen = {}, ids = [];
    (d.results || []).concat(legacy.results || []).forEach(function(r) {
      const c = String(r.chat_id);
      if (c && !seen[c]) { seen[c] = 1; ids.push(c); }
    });
    let sent = 0, failed = 0;
    for (const cid of ids) {
      if (sent + failed >= 100) break; // 单请求内限流，避免 worker 超时
      const ok = await sendQuickReplyKeyboard(cid, env);
      if (ok) sent++; else failed++;
    }
    return { total: ids.length, sent: sent, failed: failed };
  } catch (e) { return { total: 0, sent: 0, failed: 0, error: e.message }; }
}

export async function handleAdminGetMainMenu(env) {
  const c = await getMainMenuCfg(env);
  return json({ ok: true, data: c });
}
export async function handleAdminSaveMainMenu(request, env) {
  try {
    const in2 = await request.json();
    const cfg = { enabled: in2.enabled !== 0 ? 1 : 0, text: String(in2.text || '').trim(), help: String(in2.help || '').trim() };
    await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES ('main_menu',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(cfg)).run();
    return json({ ok: true, data: cfg });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
export async function handleAdminMainMenuBroadcast(request, env) {
  const r = await broadcastQuickReplyKeyboard(env);
  return json({ ok: true, data: r });
}

export async function replyTextWithKeyboard(chatId, text, buttons, env) {
  try {
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons || MAIN_BUTTONS } })
    });
  } catch (e) { console.log('replyTextKeyboard error:', e.message); }
}

// ==================== BOT API PROXY ====================

export async function proxyBotApi(endpoint, request, env) {
  try {
    const body = await request.text();
    const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    });
    const j = await r.json();
    return json(j);
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleBotSendMessage(request, env) { return proxyBotApi('sendMessage', request, env); }
export async function handleBotSendPhoto(request, env) { return proxyBotApi('sendPhoto', request, env); }
export async function handleBotSendDocument(request, env) { return proxyBotApi('sendDocument', request, env); }
export async function handleBotSendVideo(request, env) { return proxyBotApi('sendVideo', request, env); }
export async function handleBotGetFile(request, env) { return proxyBotApi('getFile', request, env); }
export async function handleBotGetMe(request, env) { return proxyBotApi('getMe', request, env); }
export async function handleBotGetWebhookInfo(request, env) { return proxyBotApi('getWebhookInfo', request, env); }
// setWebhook 代理：自动注入 secret_token（与本 Worker 的 TG_SECRET 校验保持一致），避免再次踩坑
export async function handleBotSetWebhook(request, env) {
  try {
    const raw = await request.text();
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
    if (!body.url) body.url = 'https://telegram-r2-bot.wo58.cn/webhook';
    if (env.TG_SECRET && !body.secret_token) body.secret_token = env.TG_SECRET;
    const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/setWebhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    return json(j);
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
export async function handleBotGetUpdates(request, env) { return proxyBotApi('getUpdates', request, env); }
export async function handleBotGetChat(request, env) { return proxyBotApi('getChat', request, env); }
export async function handleBotGetChatMemberCount(request, env) { return proxyBotApi('getChatMemberCount', request, env); }
export async function handleBotBanChatMember(request, env) { return proxyBotApi('banChatMember', request, env); }
export async function handleBotUnbanChatMember(request, env) { return proxyBotApi('unbanChatMember', request, env); }
export async function handleBotDeleteMessage(request, env) { return proxyBotApi('deleteMessage', request, env); }
export async function handleBotForwardMessage(request, env) { return proxyBotApi('forwardMessage', request, env); }
export async function handleBotCopyMessage(request, env) { return proxyBotApi('copyMessage', request, env); }
// Inline 搜图 / 相册 / 消息编辑 / 置顶 / 聊天动作 等官方 Bot API 代理
export async function handleBotAnswerInlineQuery(request, env) { return proxyBotApi('answerInlineQuery', request, env); }
export async function handleBotSendMediaGroup(request, env) { return proxyBotApi('sendMediaGroup', request, env); }
export async function handleBotEditMessageText(request, env) { return proxyBotApi('editMessageText', request, env); }
export async function handleBotEditMessageCaption(request, env) { return proxyBotApi('editMessageCaption', request, env); }
export async function handleBotPinChatMessage(request, env) { return proxyBotApi('pinChatMessage', request, env); }
export async function handleBotUnpinChatMessage(request, env) { return proxyBotApi('unpinChatMessage', request, env); }
export async function handleBotSendChatAction(request, env) { return proxyBotApi('sendChatAction', request, env); }
