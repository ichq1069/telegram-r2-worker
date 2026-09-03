// 转存失败告警 + 缩略图生成（低耦合独立功能）
import { json } from './util.js';

// 转存失败时通过 bot 发消息给管理员（settings.admin_chat_id 或 env.ADMIN_CHAT_ID，5 分钟节流防刷屏）
export async function notifyAdmin(env, text) {
  try {
    let chatId = '';
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'admin_chat_id'").first();
    if (s && s.value) chatId = String(s.value).trim();
    if (!chatId && env.ADMIN_CHAT_ID) chatId = String(env.ADMIN_CHAT_ID).trim();
    if (!chatId || !env.TG_BOT_TOKEN) return;
    const ns = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'admin_notify_last'").first();
    const last = ns && ns.value ? (parseInt(ns.value, 10) || 0) : 0;
    if (Date.now() - last < 5 * 60 * 1000) return;
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('admin_notify_last', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(Date.now())).run();
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: '\u26A0\uFE0F ' + String(text).slice(0, 1500), disable_web_page_preview: true })
    });
  } catch (e) { console.log('notifyAdmin error:', e.message); }
}

// 生成 WebP 缩略图（Cloudflare Image Resizing，需账号启用；失败静默跳过）
export async function genThumb(env, r2Url, key) {
  try {
    if (!r2Url || !key || !env.R2_BUCKET) return '';
    const res = await fetch(r2Url, { cf: { image: { width: 480, format: 'webp', quality: 80, fit: 'scale-down' } } });
    if (!res.ok || !res.body) return '';
    const thumbKey = 'thumbs/' + key.replace(/^files\//, '').replace(/\.[^.]+$/, '') + '.webp';
    await env.R2_BUCKET.put(thumbKey, res.body, { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000' } });
    return (env.R2_PUBLIC_URL || '') + '/' + thumbKey;
  } catch (e) { console.log('genThumb error:', e.message); return ''; }
}

// ==================== 告警/限流配置 Admin handlers ====================

export async function handleAdminGetNotify(env) {
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'admin_chat_id'").first();
    return json({ ok: true, data: { chat_id: s && s.value ? s.value : '' } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminSaveNotify(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const chatId = b && b.chat_id ? String(b.chat_id).trim().slice(0, 40) : '';
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('admin_chat_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(chatId).run();
    return json({ ok: true, data: { chat_id: chatId } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminNotifyTest(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const chatId = b && b.chat_id ? String(b.chat_id).trim().slice(0, 40) : '';
    if (!chatId || !env.TG_BOT_TOKEN) return json({ ok: false, error: 'chat_id 或 TG_BOT_TOKEN 未配置' }, 400);
    const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: '\u2705 告警通道测试成功（来自 telegram-r2-bot）' })
    });
    const j = await r.json().catch(() => null);
    if (j && j.ok) return json({ ok: true });
    return json({ ok: false, error: (j && j.description) || '发送失败，检查 chat_id 是否正确（先向 bot 发一条消息，再把你的用户 ID 填进来）' }, 400);
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminGetRateLimit(env) {
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'api_rate_limit'").first();
    let cfg = { 
      enabled: false, 
      limit_per_min: 60,
      public_enabled: false,
      public_limit_per_min: 30,
      ip_enabled: false,
      ip_limit_per_min: 100,
      admin_enabled: true,
      admin_limit_per_min: 200,
      user_enabled: true,
      user_limit_per_min: 120
    };
    if (s && s.value) { try { cfg = Object.assign(cfg, JSON.parse(s.value)); } catch (e) {} }
    return json({ ok: true, data: cfg });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminSaveRateLimit(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b) return json({ ok: false, error: '请求体为空' }, 400);
    
    // API Key 限流
    const enabled = !!(b.enabled);
    const limit_per_min = Math.max(1, Math.min(100000, parseInt(b.limit_per_min || 60, 10) || 60));
    
    // 公开端点限流
    const public_enabled = !!(b.public_enabled);
    const public_limit_per_min = Math.max(1, Math.min(100000, parseInt(b.public_limit_per_min || 30, 10) || 30));
    
    // IP 限流
    const ip_enabled = !!(b.ip_enabled);
    const ip_limit_per_min = Math.max(1, Math.min(100000, parseInt(b.ip_limit_per_min || 100, 10) || 100));
    
    // 管理员限流
    const admin_enabled = b.admin_enabled !== false; // 默认启用
    const admin_limit_per_min = Math.max(1, Math.min(100000, parseInt(b.admin_limit_per_min || 200, 10) || 200));
    
    // 用户门户限流
    const user_enabled = b.user_enabled !== false; // 默认启用
    const user_limit_per_min = Math.max(1, Math.min(100000, parseInt(b.user_limit_per_min || 120, 10) || 120));
    
    const cfg = { 
      enabled, 
      limit_per_min,
      public_enabled,
      public_limit_per_min,
      ip_enabled,
      ip_limit_per_min,
      admin_enabled,
      admin_limit_per_min,
      user_enabled,
      user_limit_per_min
    };
    
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('api_rate_limit', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(cfg)).run();
    return json({ ok: true, data: cfg });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

