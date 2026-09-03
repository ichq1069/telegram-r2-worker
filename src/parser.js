// ==================== 社交媒体链接解析（cobalt API） ====================
// 支持 Instagram / X(Twitter) / YouTube / TikTok 等平台
// 通过自托管 cobalt API 解析链接，下载媒体并入库
import { json, genHash, log } from './util.js';
import { cnNowISO, guessExt } from './core.js';
import { putR2Stream } from './telegram.js';
import { dualInsertFiles, dualUpdateFiles } from './mysql.js';
import { fireWebhook } from './events.js';
import { COLD_STORAGE_CLASS } from './telegram.js';

// Instagram 链接正则
const IG_LINK_RE = /(?:^|[^a-z0-9])(https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv|stories|reels)\/[^\s'"<>]*)/i;

// X/Twitter 链接正则（保留原有，增强支持）
const X_LINK_RE = /(?:^|[^a-z0-9])(https?:\/\/(?:x\.com|twitter\.com)\/[^\s'"<>]*?\/status\/\d+[^\s'"<>]*)/i;

// YouTube 链接正则
const YT_LINK_RE = /(?:^|[^a-z0-9])(https?:\/\/(?:www\.)?(?:youtube\.com\/watch|youtu\.be\/)[^\s'"<>]*)/i;

// TikTok 链接正则
const TT_LINK_RE = /(?:^|[^a-z0-9])(https?:\/\/(?:www\.)?(?:tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\/[^\s'"<>]*)/i;

// 检测是否为社交媒体链接
export function isSocialLink(text) {
  return IG_LINK_RE.test(text || '') || X_LINK_RE.test(text || '') || YT_LINK_RE.test(text || '') || TT_LINK_RE.test(text || '');
}

// 提取社交媒体链接
export function extractSocialLinks(text) {
  const links = [];
  const t = text || '';
  let m;
  // Instagram
  while ((m = IG_LINK_RE.exec(t)) !== null) {
    links.push({ platform: 'instagram', url: m[1] });
  }
  // X/Twitter
  while ((m = X_LINK_RE.exec(t)) !== null) {
    links.push({ platform: 'twitter', url: m[1] });
  }
  // YouTube
  while ((m = YT_LINK_RE.exec(t)) !== null) {
    links.push({ platform: 'youtube', url: m[1] });
  }
  // TikTok
  while ((m = TT_LINK_RE.exec(t)) !== null) {
    links.push({ platform: 'tiktok', url: m[1] });
  }
  return links;
}

// 获取 cobalt API 地址
async function getCobaltUrl(env) {
  try {
    const r = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='cobalt_api_url'").first();
    if (r && r.value) return r.value.replace(/\/+$/, '');
  } catch (e) {}
  // 默认值：VPS 上部署的 cobalt
  return 'http://84.247.129.220:9002';
}

// 调用 cobalt API 解析链接
async function callCobaltApi(url, env) {
  const cobaltUrl = await getCobaltUrl(env);
  const apiEndpoint = cobaltUrl + '/';
  
  try {
    const resp = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: url,
        videoQuality: '1080',
        filenameStyle: 'pretty'
      })
    });
    
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      log.error('cobalt api error:', resp.status, errText.slice(0, 200));
      return { ok: false, error: 'cobalt_api_error_' + resp.status };
    }
    
    const data = await resp.json();
    if (data.status === 'error') {
      return { ok: false, error: data.error?.code || 'parse_failed' };
    }
    
    if (data.status === 'tunnel' || data.status === 'redirect') {
      // cobalt 返回的是重定向 URL，需要下载
      return { ok: true, url: data.url, filename: data.filename || '', type: 'redirect' };
    }
    
    if (data.status === 'stream') {
      // 流式下载
      return { ok: true, url: data.url, filename: data.filename || '', type: 'stream' };
    }
    
    return { ok: false, error: 'unknown_response' };
  } catch (e) {
    log.error('callCobaltApi error:', e.message);
    return { ok: false, error: e.message };
  }
}

// 下载文件并上传到 R2
async function downloadAndStore(mediaUrl, filename, env, date) {
  try {
    const resp = await fetch(mediaUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!resp.ok) return { ok: false, error: 'download_http_' + resp.status };
    
    const ct = resp.headers.get('content-type') || 'application/octet-stream';
    const ext = guessExt(ct, filename || 'media');
    const dp = date.getFullYear() + '/' + String(date.getMonth() + 1).padStart(2, '0');
    const key = dp + '/' + genHash() + '.' + ext;
    
    const url = await putR2Stream(key, resp.body, ct, env, COLD_STORAGE_CLASS);
    if (!url) return { ok: false, error: 'r2_upload_failed' };
    
    return { ok: true, url, key, contentType: ct, filename: filename || key };
  } catch (e) {
    log.error('downloadAndStore error:', e.message);
    return { ok: false, error: e.message };
  }
}

// 解析单个链接并入库
export async function parseAndStore(link, chatId, msgId, from, env, options = {}) {
  const date = options.date || new Date();
  const platform = options.platform || 'unknown';
  
  // 1. 调用 cobalt API
  const result = await callCobaltApi(link, env);
  if (!result.ok) {
    return { ok: false, error: result.error, link };
  }
  
  // 2. 下载并存储到 R2
  const stored = await downloadAndStore(result.url, result.filename, env, date);
  if (!stored.ok) {
    return { ok: false, error: stored.error, link };
  }
  
  // 3. 入库 D1
  let dbId = null;
  if (env.D1_DB) {
    try {
      const r = await env.D1_DB.prepare(
        'INSERT INTO files (storage_key,r2_url,md5_hash,processing_state,chat_id,chat_title,chat_type,chat_username,user_id,username,full_name,telegram_file_id,file_name,file_size,file_type,mime_type,width,height,caption,message_id,created_at,source_platform) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(
        stored.key, stored.url, '', 'completed',
        chatId || '', options.chatTitle || platform, 'private', '',
        from?.id || 0, from?.username || '', from?.fullName || '',
        '', stored.filename, 0, stored.contentType?.includes('video') ? 'video' : 'photo',
        stored.contentType || '', 0, 0, link, msgId || '', date.toISOString(),
        platform
      ).run();
      dbId = r.meta?.last_row_id;
      
      // 双写 MySQL
      dualInsertFiles(env, {
        storage_key: stored.key, r2_url: stored.url, chat_id: chatId || '',
        chat_title: options.chatTitle || platform, chat_type: 'private', chat_username: '',
        user_id: from?.id || 0, username: from?.username || '', full_name: from?.fullName || '',
        telegram_file_id: '', file_name: stored.filename, file_size: 0,
        file_type: stored.contentType?.includes('video') ? 'video' : 'photo',
        mime_type: stored.contentType || '', width: 0, height: 0,
        caption: link, message_id: msgId || '', md5_hash: '',
        processing_state: 'completed', created_at: date.toISOString(),
        tags: '', group_ref: '', media_group_id: '', level: 'pt', is_private: 0, deleted_at: null
      }).catch(e => console.error('dualInsertFiles error:', e.message));
    } catch (e) {
      log.error('parseAndStore D1 insert error:', e.message);
    }
  }
  
  // 4. 触发 webhook 通知
  fireWebhook(env, 'file_imported', {
    id: dbId, url: stored.url, file_name: stored.filename,
    file_type: stored.contentType?.includes('video') ? 'video' : 'photo',
    file_size: 0, chat_id: chatId || '', source: 'parser'
  }).catch(() => {});
  
  return {
    ok: true,
    dbId,
    url: stored.url,
    filename: stored.filename,
    type: stored.contentType?.includes('video') ? 'video' : 'photo',
    platform
  };
}

// 批量解析多个链接
export async function parseAndStoreBatch(links, chatId, msgId, from, env, options = {}) {
  const results = [];
  for (const link of links) {
    const result = await parseAndStore(link.url, chatId, msgId, from, env, {
      ...options,
      platform: link.platform
    });
    results.push(result);
  }
  return results;
}

// 解析 API 端点（供 jx.html 调用）
export async function handleParseLink(request, env) {
  try {
    const b = await request.json().catch(() => ({}));
    const url = String(b.url || '').trim();
    const chatId = String(b.chat_id || '').trim();
    
    if (!url) return json({ ok: false, error: '请输入链接' });
    
    // 检测平台
    const links = extractSocialLinks(url);
    if (links.length === 0) return json({ ok: false, error: '未识别的链接格式，支持 Instagram/X/YouTube/TikTok' });
    
    // 解析并入库
    const results = await parseAndStoreBatch(links, chatId, '', { id: 0, username: 'admin' }, env, {
      date: new Date(),
      chatTitle: '手动解析'
    });
    
    return json({ ok: true, data: results });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// 获取/设置 cobalt API 配置
export async function handleGetCobaltConfig(env) {
  try {
    let url = '';
    try {
      const r = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='cobalt_api_url'").first();
      if (r) url = r.value;
    } catch (e) {}
    return json({ ok: true, data: { url: url || 'http://84.247.129.220:9002' } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

export async function handleSaveCobaltConfig(request, env) {
  try {
    const b = await request.json().catch(() => ({}));
    const url = String(b.url || '').trim();
    if (!url) return json({ ok: false, error: '请输入 API 地址' });
    
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('cobalt_api_url', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(url).run();
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }); }
}
