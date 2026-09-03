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
      return { ok: true, url: data.url, filename: data.filename || '', type: 'redirect' };
    }
    
    if (data.status === 'stream') {
      return { ok: true, url: data.url, filename: data.filename || '', type: 'stream' };
    }
    
    return { ok: false, error: 'unknown_response' };
  } catch (e) {
    log.error('callCobaltApi error:', e.message);
    return { ok: false, error: e.message };
  }
}

// 检测是否为图片链接（pbs.twimg.com）
function isTwitterImage(url) {
  return /pbs\.twimg\.com\/media\//i.test(url);
}

// 检测是否为视频链接（video.twimg.com）
function isTwitterVideo(url) {
  return /video\.twimg\.com\//i.test(url);
}

// 直接下载图片到 R2（不经过 cobalt）
async function downloadImageDirect(imageUrl, env, date) {
  try {
    const resp = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!resp.ok) return { ok: false, error: 'image_download_http_' + resp.status };
    
    const ct = resp.headers.get('content-type') || 'image/jpeg';
    const ext = guessExt(ct, 'image');
    const dp = date.getFullYear() + '/' + String(date.getMonth() + 1).padStart(2, '0');
    const key = dp + '/' + genHash() + '.' + ext;
    
    const url = await putR2Stream(key, resp.body, ct, env, COLD_STORAGE_CLASS);
    if (!url) return { ok: false, error: 'r2_upload_failed' };
    
    return { ok: true, url, key, contentType: ct, filename: key };
  } catch (e) {
    log.error('downloadImageDirect error:', e.message);
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
  
  // 对于 Instagram 图片，直接下载不经过 cobalt
  if (platform === 'instagram' && /instagram\.com\/p\//i.test(link)) {
    log('Instagram post detected, trying direct download:', link);
    // Instagram 帖子可能包含多张图片，先尝试 cobalt
  }
  
  // 所有平台使用 cobalt API（包括 X/Twitter）
  const result = await callCobaltApi(link, env);
  if (!result.ok) {
    return { ok: false, error: result.error, link };
  }
  
  // 下载并存储到 R2
  const stored = await downloadAndStore(result.url, result.filename, env, date);
  if (!stored.ok) {
    return { ok: false, error: stored.error, link };
  }
  
  // 入库 D1
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
  
  // 触发 webhook
  fireWebhook(env, 'file_imported', {
    id: dbId, url: stored.url, file_name: stored.filename,
    file_type: stored.contentType?.includes('video') ? 'video' : 'photo',
    file_size: 0, chat_id: chatId || '', source: 'parser'
  }).catch(() => {});
  
  return {
    ok: true, dbId, url: stored.url, filename: stored.filename,
    type: stored.contentType?.includes('video') ? 'video' : 'photo',
    platform
  };
}

// 使用 syndication API 解析 X/Twitter 链接（支持图片和视频）
async function parseXWithSyndication(link, chatId, msgId, from, env, date, options) {
  const tid = /status\/(\d+)/.exec(link)?.[1];
  if (!tid) return { ok: false, error: 'invalid_x_url', link };
  
  try {
    const r = await fetch('https://cdn.syndication.twimg.com/tweet-result?id=' + tid + '&lang=zh');
    if (!r.ok) return { ok: false, error: 'syndication_api_' + r.status, link };
    
    const j = await r.json();
    const media = [];
    
    // 视频：选择最高码率的 mp4
    if (j?.video?.variants?.length) {
      let best = null;
      for (const v of j.video.variants) {
        if (v.content_type === 'video/mp4' && (!best || (v.bitrate || 0) > (best.bitrate || 0))) best = v;
      }
      if (best?.url) media.push({ type: 'video', url: best.url, name: 'xvideo_' + tid + '.mp4' });
    }
    
    // 图片（最多 4 张，避免资源超限）
    if (j?.photos?.length) {
      const maxPhotos = Math.min(j.photos.length, 4);
      for (let p = 0; p < maxPhotos; p++) {
        const pu = j.photos[p].url;
        if (pu) media.push({ type: 'photo', url: pu, name: 'ximg_' + tid + '_' + (p + 1) + '.jpg' });
      }
    }
    
    if (!media.length) return { ok: false, error: 'no_media_found', link };
    
    // 下载并存储每个媒体文件（串行处理避免资源超限）
    const results = [];
    const dp = date.getFullYear() + '/' + String(date.getMonth() + 1).padStart(2, '0');
    
    for (const item of media) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000); // 15s 超时
        
        const dl = await fetch(item.url, { signal: controller.signal });
        clearTimeout(timeout);
        
        if (!dl.ok) continue;
        
        const ct = item.type === 'video' ? 'video/mp4' : (dl.headers.get('content-type') || 'image/jpeg');
        const ext = guessExt(ct, item.name);
        const key = dp + '/' + genHash() + '.' + ext;
        const url = await putR2Stream(key, dl.body, ct, env, COLD_STORAGE_CLASS);
        if (!url) continue;
        
        // 入库 D1
        let dbId = null;
        if (env.D1_DB) {
          try {
            const r = await env.D1_DB.prepare(
              'INSERT INTO files (storage_key,r2_url,md5_hash,processing_state,chat_id,chat_title,chat_type,chat_username,user_id,username,full_name,telegram_file_id,file_name,file_size,file_type,mime_type,width,height,caption,message_id,created_at,source_platform) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
            ).bind(
              key, url, '', 'completed',
              chatId || '', options.chatTitle || 'X', 'private', '',
              from?.id || 0, from?.username || '', from?.fullName || '',
              '', item.name, 0, item.type, ct, 0, 0, link, msgId || '', date.toISOString(),
              'twitter'
            ).run();
            dbId = r.meta?.last_row_id;
            
            // 双写 MySQL
            dualInsertFiles(env, {
              storage_key: key, r2_url: url, chat_id: chatId || '',
              chat_title: options.chatTitle || 'X', chat_type: 'private', chat_username: '',
              user_id: from?.id || 0, username: from?.username || '', full_name: from?.fullName || '',
              telegram_file_id: '', file_name: item.name, file_size: 0,
              file_type: item.type, mime_type: ct, width: 0, height: 0,
              caption: link, message_id: msgId || '', md5_hash: '',
              processing_state: 'completed', created_at: date.toISOString(),
              tags: '', group_ref: '', media_group_id: '', level: 'pt', is_private: 0, deleted_at: null
            }).catch(e => console.error('dualInsertFiles error:', e.message));
          } catch (e) {
            log.error('parseXWithSyndication D1 insert error:', e.message);
          }
        }
        
        // 触发 webhook
        fireWebhook(env, 'file_imported', {
          id: dbId, url, file_name: item.name,
          file_type: item.type, file_size: 0, chat_id: chatId || '', source: 'parser'
        }).catch(() => {});
        
        results.push({ ok: true, dbId, url, filename: item.name, type: item.type, platform: 'twitter' });
      } catch (e) {
        log.error('parseXWithSyndication media save error:', e.message);
      }
    }
    
    return results.length > 0 ? { ok: true, data: results } : { ok: false, error: 'all_media_failed', link };
  } catch (e) {
    log.error('parseXWithSyndication error:', e.message);
    return { ok: false, error: e.message, link };
  }
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
