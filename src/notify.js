// 转存失败告警 + 缩略图生成（低耦合独立功能）

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
