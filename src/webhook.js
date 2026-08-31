// ==================== WEBHOOK ====================
// Telegram webhook 入口：消息路由、分享链接解析（抖音/小红书/B站/微博等）、大文件流式转存、进度更新、命令分发、回调查询。
import { json, fmtSize, genHash, log, invalidateStatsCache } from "./util.js";
import { ensureTablesOnce } from "./db.js";
import { notifyAdmin, genThumb } from "./notify.js";
import { cnTodayStr, guessExt, fileExtOf } from "./core.js";
import { OFFICIAL_API, tgApiBases, dlFileStream, dlFileLarger, dlFileStreamLarger, lastUploadError, putR2, putR2Stream, computeMd5, stripExifIfJpeg, countCompleted, replyText, getMainMenuCfg, replyTextWithKeyboard, COLD_STORAGE_MIN, COLD_STORAGE_CLASS, MAIN_BUTTONS } from "./telegram.js";
import { getMenuCtx, execMenuAction, getAIConfig, isAIReplyText, callAIManage, handleBotCommand, handleCountCommand, handlePendingCommand, handleRetryCommand, handleHealthCommand, handleImgCommand, handleInlineQuery, DEFAULT_COMMANDS } from "./commands.js";
import { recordKnownChat, recordUserInteraction } from "./public.js";
import { getBotUsername, getProxyMode } from "./api.js";
import { allocTgRef, getFileRef, scheduleBatchRef, refreshGroupReceipt, handleDeletedMsg } from "./batch.js";
import { fireWebhook } from "./events.js";
// ==================== WEBHOOK ====================

// 记录 webhook 投递日志（成功/失败），供后台「最近10次」弹窗查看
export async function recordWebhookLog(env, ok, error, source) {
  if (!env.D1_DB) return;
  try {
    await env.D1_DB.prepare('INSERT INTO webhook_logs (status,ok,source,error,created_at) VALUES (?,?,?,?,?)')
      .bind(ok ? 200 : 500, ok ? 1 : 0, source || 'webhook', String(error || '').slice(0, 300), new Date().toISOString()).run();
  } catch (e) { log.error('recordWebhookLog:', e.message); }
}

export async function handleWebhook(request, env, ctx) {
  try {
    if (env.D1_DB) await ensureTablesOnce(env.D1_DB);
    const body = await request.text();
    const update = JSON.parse(body);
    const st = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    // TG_SECRET 校验放宽：只拒绝「带了 secret token 头但值不匹配」的请求。
    // 旧版本 setWebhook 未带 secret_token（Telegram 不会发该头），若严格校验会把所有
    // webhook 请求 403 拒收导致消息积压。不带头的请求一律放行，靠 url 白名单兜底。
    if (env.TG_SECRET && st && st !== env.TG_SECRET) return json({ error: 'Forbidden' }, 403);
    // 注意：waitUntil 是 ctx 的方法，不是 request 的（曾误用 request.waitUntil 导致
    // 每个 webhook 消息 500 拒收、消息积压的严重 bug）
    // 投递成功日志（异步落库，不阻塞响应）
    try { if (env.D1_DB && ctx && ctx.waitUntil) ctx.waitUntil(recordWebhookLog(env, true, '', 'webhook')); } catch (e) {}
    const r = await processUpdateCore(update, env, function(p) { return ctx.waitUntil(p); });
    return json(r);
  } catch (e) {
    // 投递失败日志（异步落库）
    try { if (env.D1_DB && ctx && ctx.waitUntil) ctx.waitUntil(recordWebhookLog(env, false, e.message, 'webhook')); } catch (e2) {}
    return json({ ok: false, error: e.message }, 500);
  }
}

// 最近 webhook 投递日志：正常最近 5 条 + 错误最近 5 条
export async function handleAdminWebhookLogs(env) {
  try {
    if (!env.D1_DB) return json({ ok: true, data: { ok_items: [], error_items: [] } });
    const ok = await env.D1_DB.prepare("SELECT id,status,ok,source,error,created_at FROM webhook_logs WHERE ok=1 ORDER BY id DESC LIMIT 5").all();
    const err = await env.D1_DB.prepare("SELECT id,status,ok,source,error,created_at FROM webhook_logs WHERE ok=0 ORDER BY id DESC LIMIT 5").all();
    return json({ ok: true, data: { ok_items: ok.results || [], error_items: err.results || [] } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 防止 webhook 丢失（曾发生 webhook 被清空导致 164 条消息积压）：cron 每次检查并自动恢复
export async function ensureWebhook(env, ctx) {
  if (!env.TG_BOT_TOKEN) return;
  const url = 'https://telegram-r2-bot.wo58.cn/webhook';
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getWebhookInfo', { method: 'POST' });
    const j = await r.json();
    if (j && j.ok && j.result && j.result.url === url) return;
    const body = { url: url };
    if (env.TG_SECRET) body.secret_token = env.TG_SECRET;
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/setWebhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    log.info('ensureWebhook: set webhook (secret_token=' + (env.TG_SECRET ? 'on' : 'off') + ')');
  } catch (e) { log.error('ensureWebhook:', e.message); }
}

// Webhook 状态检查：返回 Telegram getWebhookInfo 关键字段 + 本机配置对比
export async function handleAdminWebhookStatus(env) {
  try {
    if (!env.TG_BOT_TOKEN) return json({ ok: true, data: { has_token: false, msg: 'TG_BOT_TOKEN 未配置' } });
    const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getWebhookInfo', { method: 'POST' });
    const j = await r.json();
    const res = (j && j.result) || {};
    const expectUrl = 'https://telegram-r2-bot.wo58.cn/webhook';
    // 最近错误若已超过 5 分钟未更新（且无积压），视为已恢复（Telegram 成功后不再更新 last_error）
    const errAge = res.last_error_date ? (Math.floor(Date.now() / 1000) - res.last_error_date) : 0;
    const healthy = j.ok && res.url === expectUrl && (!res.last_error_message || errAge > 300);
    return json({ ok: true, data: {
      has_token: true,
      healthy: healthy ? 1 : 0,
      url: res.url || '',
      expect_url: expectUrl,
      url_match: res.url === expectUrl ? 1 : 0,
      pending: res.pending_update_count || 0,
      last_error: res.last_error_message || '',
      last_error_age: errAge,
      last_error_date: res.last_error_date || 0,
      max_connections: res.max_connections || 40,
      ip_address: res.ip_address || '',
      has_secret_token_configured: !!env.TG_SECRET,
      api_error: j.description || ''
    } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 一键修复 webhook：重新 setWebhook（url + secret_token，不丢弃积压）
export async function handleAdminWebhookFix(request, env) {
  try {
    if (!env.TG_BOT_TOKEN) return json({ ok: false, error: 'TG_BOT_TOKEN 未配置' }, 400);
    const url = 'https://telegram-r2-bot.wo58.cn/webhook';
    const b = await request.json().catch(() => ({}));
    const drop = b.drop_pending_updates ? true : false; // 默认 false：保留积压让 Telegram 自动重投
    const body = { url: url, drop_pending_updates: drop };
    if (env.TG_SECRET) body.secret_token = env.TG_SECRET;
    const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/setWebhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    return json({ ok: !!j.ok, data: j.result || {}, description: j.description || '', secret_token: env.TG_SECRET ? 'on' : 'off' });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// Shared: handle one update from webhook or getUpdates polling
export async function processUpdateCore(update, env, waitFn) {
  // 用户聊天交互统计（fire-and-forget，不阻塞主流程）
  if (env.D1_DB) {
    try {
      const p = recordUserInteraction(update, env);
      if (waitFn) waitFn(p); else p;
    } catch (e) {}
  }
  // 记录已知会话（广播快捷键盘 / 后续通知用；私聊 + 群 + 频道都记，广播只挑 private）
  if (env.D1_DB) {
    try {
      const p = recordKnownChat(update, env);
      if (waitFn) waitFn(p); else p;
    } catch (e) {}
  }
  // 点击按钮回调（inline keyboard）
  if (update.callback_query) {
    return await handleCallbackQuery(update.callback_query, env);
  }
  // Inline 模式：任意聊天输入 @<bot> 关键词 触发，从共享库搜图返回
  if (update.inline_query) {
    return await handleInlineQuery(update.inline_query, env);
  }
  const msg = update.message || update.channel_post;
  // 用户撤销（unsend）已入库消息：Telegram 会补发一条"空内容"的 message 更新，
  // 据此把对应入库记录移入回收站，并清理批量回执（无内容且无任何媒体/服务字段才视为撤销）
  if (msg && !msg.text && !msg.caption && !msg.photo && !msg.document && !msg.video && !msg.audio && !msg.voice && !msg.sticker && !msg.animation && !msg.video_note && !msg.contact && !msg.location && !msg.poll && !msg.dice && !msg.game && !msg.entities && !msg.new_chat_members && !msg.new_chat_member && !msg.left_chat_member && !msg.pinned_message && !msg.delete_chat_photo && !msg.group_chat_created && !msg.supergroup_chat_created && !msg.channel_chat_created && msg.message_id && env.D1_DB) {
    return await handleDeletedMsg(msg, env);
  }
  if (msg && !msg.text?.startsWith('/')) {
    const fi = extractFileInfo(msg);
    if (fi) {
      // 20MB limit: official Bot API cannot download files >20MB.
      // Without a Local Bot API (TG_API_BASE/TG_API_BASE_2), reply with a notice and skip.
      if (!(env.TG_API_BASE || env.TG_API_BASE_2) && (fi.fileSize || 0) > OFFICIAL_MAX) {
        if (env.TG_BOT_TOKEN) {
          try {
            await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: String(msg.chat.id), text: '❌ 文件超过 20MB（Telegram 官方 Bot API 限制），超出大小未存入' })
            });
          } catch (e) {}
        }
        return { ok: true, skipped: true };
      }
      // Create pending record immediately (dedup by chat_id + message_id)
      const chatId = String(msg.chat.id);
      const msgId = String(msg.message_id);
      const from = msg.from || {};
      const chat = msg.chat || {};
      if (env.D1_DB) {
        try {
          const dup = await env.D1_DB.prepare('SELECT id FROM files WHERE chat_id=? AND message_id=? AND deleted_at IS NULL LIMIT 1').bind(chatId, msgId).first();
          if (dup) return { ok: true, duplicate: true };
        } catch (e) {}
      }
      const date = msg.date ? new Date(msg.date * 1000) : new Date();
      const dp = date.getFullYear() + '/' + String(date.getMonth() + 1).padStart(2, '0');
      const tempKey = dp + '/pending_' + genHash() + '.' + guessExt('', fi.fileName);
      // 编号延迟到"这一批"确定后统一分配（scheduleBatchRef，批次号 = 本次转发总数）
      const ref = '';
      let rid = null;
      if (env.D1_DB) {
        // INSERT 重试：D1 并发写入可能超时，短暂延迟后重试一次
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const r = await env.D1_DB.prepare(
              'INSERT INTO files (storage_key,r2_url,md5_hash,processing_state,chat_id,chat_title,chat_type,chat_username,user_id,username,full_name,telegram_file_id,file_name,file_size,file_type,mime_type,width,height,caption,message_id,created_at,group_ref,media_group_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
            ).bind(tempKey, '', '', 'downloading', chatId, chat.title || chat.username || chatId, chat.type || '', chat.username || '', from.id || 0, from.username || '', [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown', fi.fileId, fi.fileName, fi.fileSize, fi.type, '', fi.width, fi.height, msg.caption || '', msgId, date.toISOString(), ref, msg.media_group_id || '').run();
            rid = r.meta?.last_row_id;
            break;
          } catch (e) {
            log.error('D1 pending INSERT attempt ' + (attempt + 1) + ':', e.message);
            if (attempt === 0) await new Promise(function(r) { setTimeout(r, 200); });
          }
        }
      }
      // INSERT 失败时通知用户并中断流程
      if (!rid) {
        log.error('D1 INSERT failed after retries, chat:', chatId, 'file:', fi.fileName);
        if (env.TG_BOT_TOKEN && msg && msg.chat) {
          try {
            await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: String(msg.chat.id),
                text: '❌ 文件入库失败（数据库写入异常），请稍后重试'
              })
            });
          } catch (e2) { log.error('send error msg:', e2.message); }
        }
        return { ok: false, error: 'db_insert_failed' };
      }
      // 代理模式：≤20MB 不转存 R2，r2_url 存 /file/tg/<id>，访问时 worker 实时拉 TG 直链（省 R2 存储）
      if (rid && (await getProxyMode(env)) === 1 && (fi.fileSize || 0) <= 20 * 1024 * 1024) {
        try {
          // 代理 URL 带后缀名（如 /file/tg/123.jpg），方便识别类型/下载文件名
          await env.D1_DB.prepare("UPDATE files SET r2_url=?, storage_key='', processing_state='completed', progress_bytes=0, total_bytes=? WHERE id=?").bind('/file/tg/' + rid + '.' + fileExtOf(fi.fileName, fi.type), fi.fileSize || 0, rid).run();
        } catch (e) { log.error('proxy mark:', e.message); }
        scheduleBatchRef(env, chatId, rid, waitFn);
        return { ok: true, queued: true, fileId: rid, proxied: true };
      }
      // 延迟批量编号：3 秒后按"本次总数 N"统一编号并确认回复（与转存并行）
      if (rid) scheduleBatchRef(env, chatId, rid, waitFn);
      // Process via Queue (reliable, 15min limit) or fallback to waitUntil
      const task = {
        dbId: rid, fi: fi, chatId: chatId, msgId: msgId, ref: ref || '',
        chat: { title: chat.title, username: chat.username, type: chat.type },
        from: { id: from.id, username: from.username, first_name: from.first_name, last_name: from.last_name },
        date: date.toISOString()
      };
      if (env.FILE_QUEUE) {
        try {
          await env.FILE_QUEUE.send(task);
          return { ok: true, queued: true, fileId: rid };
        } catch (e) { log.error('queue send:', e.message); }
      }
      const p = processFileAsync(rid, fi, chatId, msgId, chat, from, date, env, ref || '').catch(e => log.error('async:', e.message));
      if (waitFn) waitFn(p); else p;
      return { ok: true, queued: true, fileId: rid };
    }
  }

  // X (Twitter) status links: parse via public syndication API, download media from twimg CDN
  if (msg && msg.text && isXLink(msg.text)) {
    const xlink = extractXStatus(msg.text);
    if (xlink) {
      const chatId = String(msg.chat.id);
      const msgId = String(msg.message_id);
      const date = msg.date ? new Date(msg.date * 1000) : new Date();
      const p = handleXStatusAsync(xlink, chatId, msgId, date, env).catch(e => log.error('x async:', e.message));
      if (waitFn) waitFn(p); else p;
      return { ok: true, queued: true, xlink: true };
    }
  }

  // Short-video share links (douyin/kuaishou/redbook/bilibili...): parse via parse-video service, then download & store
  if (msg && msg.text && isShareLink(msg.text)) {
    const shareLink = extractShareLink(msg.text);
    if (shareLink) {
      const chatId = String(msg.chat.id);
      const msgId = String(msg.message_id);
      const from = msg.from || {};
      const chat = msg.chat || {};
      const date = msg.date ? new Date(msg.date * 1000) : new Date();
      let rid = null;
      if (env.D1_DB) {
        try {
          const r = await env.D1_DB.prepare(
            'INSERT INTO files (storage_key,r2_url,md5_hash,processing_state,chat_id,chat_title,chat_type,chat_username,user_id,username,full_name,telegram_file_id,file_name,file_size,file_type,mime_type,width,height,caption,message_id,created_at,group_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
          ).bind('', '', '', 'parsing', chatId, chat.title || chat.username || chatId, chat.type || '', chat.username || '', from.id || 0, from.username || '', [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown', '', 'video_' + genHash() + '.mp4', 0, 'video', '', 0, 0, msg.text || '', msgId, date.toISOString(), await allocTgRef(env)).run();
          rid = r.meta?.last_row_id;
        } catch (e) { log.error('D1 share pending:', e.message); }
      }
      const task = {
        dbId: rid, link: shareLink, chatId: chatId, msgId: msgId,
        chat: { title: chat.title, username: chat.username, type: chat.type },
        from: { id: from.id, username: from.username, first_name: from.first_name, last_name: from.last_name },
        date: date.toISOString()
      };
      if (env.FILE_QUEUE) {
        try {
          await env.FILE_QUEUE.send(task);
          return { ok: true, queued: true, fileId: rid };
        } catch (e) { log.error('queue send (share):', e.message); }
      }
      const p = processShareLinkAsync(rid, shareLink, chatId, msgId, chat, from, date, env).catch(e => log.error('share async:', e.message));
      if (waitFn) waitFn(p); else p;
      return { ok: true, queued: true, fileId: rid };
    }
  }

  // Non-file messages: process synchronously
  return await processUpdate(update, env, waitFn);
}

// Poll getUpdates from the configured Bot API (must be Local Bot API to get Local file_ids)
export async function handlePollUpdates(env, ctx) {
  if (!env.D1_DB) return;
  try { await ensureTablesOnce(env.D1_DB); } catch (e) {}
  const bases = tgApiBases(env);
  let lastErr = '';
  for (var i = 0; i < bases.length; i++) {
    const base = bases[i];
    try {
      let offset = 0;
      try { const s = await env.D1_DB.prepare('SELECT value FROM settings WHERE key=?').bind('tg_update_offset').first(); if (s) offset = parseInt(s.value) || 0; } catch (e) { log.debug('poll offset read:', e.message); }
      const r = await fetch(base + '/bot' + env.TG_BOT_TOKEN + '/getUpdates?timeout=2&limit=10&offset=' + offset);
      const j = await r.json();
          if (!j.ok) { lastErr = 'getUpdates: ' + (j.description || 'fail') + ' @' + base; log.warn('poll getUpdates fail @' + base + ':', JSON.stringify(j).slice(0, 150)); continue; }
      if (j.result && j.result.length) {
        let maxId = offset;
        let lastOk = offset;
        for (const u of j.result) {
          if (u.update_id > maxId) maxId = u.update_id;
          try { await processUpdateCore(u, env, ctx ? function(p) { return ctx.waitUntil(p); } : null); lastOk = u.update_id; }
          catch (e) { log.error('poll update:', e.message); break; } // do not advance past a failed update; Telegram will re-deliver
        }
        try { await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES ('tg_update_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(lastOk)).run(); } catch (e) {}
      }
      return;
    } catch (e) { lastErr = e.message; log.error('poll error @' + base + ':', e.message); }
  }
  if (lastErr) log.warn('handlePollUpdates all failed:', lastErr);
}

// Manual /admin/api/poll endpoint
export async function handlePollEndpoint(env) {
  try {
    await handlePollUpdates(env, { waitUntil: function(p) { return p; } });
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// Async file processing with progress tracking
var LARGE_FILE_THRESHOLD = 50 * 1024 * 1024; // 50MB: stream instead of buffer
var OFFICIAL_MAX = 20 * 1024 * 1024; // official Bot API getFile/download limit: 20MB

// Global concurrency limiter for transfers: 100+ parallel downloads will
// swamp Telegram's bandwidth and hit Cloudflare subrequest limits, making
// every file slower. Cap active transfers so the queue drains steadily.
var MAX_CONCURRENT_TRANSFERS = 6;
var activeTransfers = 0;
var transferWaiters = [];
export function acquireTransferSlot() {
  if (activeTransfers < MAX_CONCURRENT_TRANSFERS) {
    activeTransfers++;
    return Promise.resolve();
  }
  return new Promise(function(res) { transferWaiters.push(res); });
}
export function releaseTransferSlot() {
  activeTransfers--;
  var next = transferWaiters.shift();
  if (next) next();
}

// ---- Short-video share link support (parse-video service) ----
// Matches share links of common short-video platforms (douyin/kuaishou/redbook/bilibili/weibo/qq...)
var SHARE_DOMAIN_RE = /(?:^|[^a-z0-9])(https?:\/\/[a-z0-9.-]+\.(?:douyin\.com|kuaishou\.com|gifshow\.com|xhslink\.com|xiaohongshu\.com|b23\.tv|bilibili\.com|weibo\.com|weibo\.cn|qq\.com|ixigua\.com|pipix\.com|huoshan\.com|pearvideo\.com|sohu\.com|163\.com|youku\.com|meipai\.com|6\.cn)[^\s'"<>]*)/i;

export function isShareLink(text) {
  return SHARE_DOMAIN_RE.test(text || '');
}

export function extractShareLink(text) {
  var m = SHARE_DOMAIN_RE.exec(text || '');
  if (m) log.debug('share link detected:', m[1]);
  return m ? m[1] : '';
}

// ---- X (Twitter) status link support ----
// Parses via Twitter's public syndication endpoint (no auth, CORS-friendly), then downloads
// media straight from twimg CDN. Unlike Telegram's Bot API there is NO 20MB limit here.
var X_STATUS_RE = /(?:^|[^a-z0-9])(https?:\/\/(?:x\.com|twitter\.com)\/[^\s'"<>]*?\/status\/\d+[^\s'"<>]*)/i;

export function isXLink(text) {
  return X_STATUS_RE.test(text || '');
}

export function extractXStatus(text) {
  var m = X_STATUS_RE.exec(text || '');
  return m ? m[1] : '';
}

export function xTweetId(link) {
  var m = /status\/(\d+)/.exec(link || '');
  return m ? m[1] : '';
}

export async function handleXStatusAsync(link, chatId, msgId, date, env) {
  var tid = xTweetId(link);
  if (!tid) return;
  function xreply(t) {
    if (!env.TG_BOT_TOKEN) return Promise.resolve();
    return fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: t })
    }).catch(function(){});
  }
  try {
    var r = await fetch('https://cdn.syndication.twimg.com/tweet-result?id=' + tid + '&lang=zh');
    if (!r.ok) { await xreply('❌ X 解析失败（HTTP ' + r.status + '）'); return; }
    var j = await r.json();
    var media = [];
    // Video: pick the highest-bitrate mp4 variant
    if (j && j.video && j.video.variants && j.video.variants.length) {
      var best = null;
      for (var i = 0; i < j.video.variants.length; i++) {
        var v = j.video.variants[i];
        if (v.content_type === 'video/mp4' && (!best || (v.bitrate || 0) > (best.bitrate || 0))) best = v;
      }
      if (best && best.url) media.push({ type: 'video', url: best.url, name: 'xvideo_' + tid + '.mp4' });
    }
    // Photos
    if (j && j.photos && j.photos.length) {
      for (var p = 0; p < j.photos.length; p++) {
        var pu = j.photos[p].url;
        if (pu) media.push({ type: 'photo', url: pu, name: 'ximg_' + tid + '_' + (p + 1) + '.jpg' });
      }
    }
    if (!media.length) { await xreply('❌ 该 X 推文没有可下载的媒体（可能已删除或受限）'); return; }
    var saved = [];
    var ts = new Date().toISOString();
    var dp = ts.slice(0, 7).replace('-', '/');
    for (var m = 0; m < media.length; m++) {
      var item = media[m];
      try {
        var dl = await fetch(item.url);
        if (!dl.ok) continue;
        var ct = item.type === 'video' ? 'video/mp4' : (dl.headers.get('content-type') || 'image/jpeg');
        var ext = guessExt(ct, item.name);
        var key = dp + '/' + genHash() + '.' + ext;
        var url = await putR2Stream(key, dl.body, ct, env, '');
        if (!url) continue;
        saved.push(url);
        // 入库（direct completed，不经 Telegram 下载）
        if (env.D1_DB) {
          try {
            await env.D1_DB.prepare(
              'INSERT INTO files (storage_key,r2_url,md5_hash,processing_state,chat_id,chat_title,chat_type,chat_username,user_id,username,full_name,telegram_file_id,file_name,file_size,file_type,mime_type,width,height,caption,message_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
            ).bind(key, url, '', 'completed', chatId, 'X', 'private', '', 0, '', '', '', item.name, 0, item.type, ct, 0, 0, '', msgId, ts).run();
          } catch (e) { log.error('x d1 insert fail:', e.message); }
        }
      } catch (e) { log.error('x media save fail:', e.message); }
    }
    if (saved.length) {
      await xreply('✅ X 内容已保存（' + saved.length + ' 个）\n' + saved.join('\n'));
    } else {
      await xreply('❌ X 内容下载失败');
    }
  } catch (e) {
    log.error('handleXStatusAsync:', e.message);
    try { await xreply('❌ X 解析失败：' + String(e.message).slice(0, 100)); } catch (e2) {}
  }
}

// Parse a share link via the self-hosted parse-video service, download the watermarked-off video to R2
export async function processShareLinkAsync(dbId, link, chatId, msgId, chat, from, date, env) {
  async function updateState(state, err) {
    if (env.D1_DB && dbId) {
      try { await env.D1_DB.prepare('UPDATE files SET processing_state=?, error_msg=? WHERE id=?').bind(state, err || '', dbId).run(); } catch (e) {}
    }
    if (state === 'failed' && err) {
      var f = null;
      try { f = await env.D1_DB.prepare('SELECT file_name, chat_title FROM files WHERE id=?').bind(dbId).first(); } catch (e) {}
      notifyAdmin(env, '转存失败: ' + ((f && f.file_name) || dbId) + ((f && f.chat_title) ? ' | ' + f.chat_title : '') + '\n' + String(err).slice(0, 300));
    }
  }
  await acquireTransferSlot();
  try {
    if (!env.PARSE_VIDEO_API) { await updateState('failed', 'parse_video_not_configured'); return; }
    await updateState('parsing');
    // 1) ask parse-video for the real video URL
    var api = env.PARSE_VIDEO_API.replace(/\/+$/, '') + '/api/v1/parse?url=' + encodeURIComponent(link);
    var auth = 'Basic ' + btoa((env.PARSE_VIDEO_USER || '') + ':' + (env.PARSE_VIDEO_PASS || ''));
    var pr = await fetch(api, { headers: { 'Authorization': auth } });
    var pj = await pr.json().catch(function() { return null; });
    var info = pj && pj.status === 'success' ? (pj.data || {}) : null;
    var videoUrl = info ? (info.video_url || '') : '';
    if (!videoUrl) {
      var em = (pj && pj.error && pj.error.message) || 'parse_failed';
      await updateState('failed', 'parse_failed: ' + em);
      log.debug('share parse fail:', link, em);
      return;
    }
    // 2) Preferred: permanent proxy direct-link (real-time parse on every request => never expires)
    var proxyBase = (env.PROXY_URL || '').replace(/\/+$/, '');
    var proxyToken = env.PROXY_TOKEN || '';
    if (proxyBase && proxyToken) {
      await updateState('saving');
      var proxyUrl = proxyBase + '/p?k=' + encodeURIComponent(proxyToken) + '&url=' + encodeURIComponent(link);
      var titleP = (info.title || '').replace(/[\r\n]+/g, ' ').trim() || 'video_' + genHash() + '.mp4';
      if (env.D1_DB && dbId) {
        try {
          await env.D1_DB.prepare(
            "UPDATE files SET storage_key='', r2_url=?, md5_hash='', mime_type='video/mp4', processing_state='completed', file_name=?, tg_file_url=?, thumb_url='', quick_hash='' WHERE id=?"
          ).bind(proxyUrl, titleP, videoUrl, dbId).run();
        } catch (e) { log.error('D1 share update:', e.message); }
      }
      try {
        var replyTextP = '\uD83D\uDCF9 \u89C6\u9891\u76F4\u94FE\u5DF2\u751F\u6210\uff08\u6BCF\u6B21\u8BBF\u95EE\u5B9E\u65F6\u89E3\u6790\uff0C\u6C38\u4E0D\u8FC7\u671F\uff09\n' + titleP + '\n' + proxyUrl + '\n\u2192 \u70B9\u51FB\u64AD\u653E\uff1B\u76F4\u63A5\u4E0B\u8F7D\u53EF\u52A0\uff1a&mode=proxy';
        await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: replyTextP, disable_web_page_preview: false })
        });
      } catch (e) { log.error('share reply:', e.message); }
      return;
    }
    // 2b) Fallback (no proxy configured): download video stream and upload to R2
    await updateState('downloading');
    var fr = await fetch(videoUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.douyin.com/' } });
    if (!fr.ok) { await updateState('failed', 'download_http_' + fr.status); return; }
    await updateState('uploading');
    var ct = fr.headers.get('content-type') || 'video/mp4';
    var ext = guessExt(ct, 'mp4');
    var dp = date.getFullYear() + '/' + String(date.getMonth() + 1).padStart(2, '0');
    var key = dp + '/' + genHash() + '.' + ext;
    var url = await putR2Stream(key, fr.body, ct, env, COLD_STORAGE_CLASS);
    if (!url) {
      try {
        var fr2 = await fetch(videoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (fr2.ok) url = await putR2Stream(key, fr2.body, ct, env, COLD_STORAGE_CLASS);
      } catch (e) { log.warn('share retry fail:', e.message); }
    }
    if (!url) { await updateState('failed', 'r2_upload_failed' + (lastUploadError ? ' (' + lastUploadError + ')' : '')); return; }
    // 3) cover as thumbnail (best effort)
    var thumbUrl = '';
    if (info.cover_url) {
      try {
        var cf = await fetch(info.cover_url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.douyin.com/' } });
        if (cf.ok) {
          var tkey = key.replace(/\.[^.]+$/, '') + '_thumb.jpg';
          thumbUrl = await putR2(tkey, await cf.arrayBuffer(), 'image/jpeg', env) || '';
        }
      } catch (e) {}
    }
    // 4) finalize D1 + notify
    var title = (info.title || '').replace(/[\r\n]+/g, ' ').trim() || 'video_' + genHash() + '.mp4';
    if (env.D1_DB && dbId) {
      try {
        await env.D1_DB.prepare(
          'UPDATE files SET storage_key=?, r2_url=?, md5_hash=?, mime_type=?, processing_state=?, file_name=?, tg_file_url=?, thumb_url=?, quick_hash=? WHERE id=?'
        ).bind(key, url, '', ct, 'completed', title, videoUrl, thumbUrl, '', dbId).run();
          } catch (e) { log.error('D1 share update:', e.message); }
    }
    try {
      var replyText = '\uD83D\uDCF9 视频已保存\n' + title + '\n' + url;
      await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: replyText, disable_web_page_preview: false })
      });
      } catch (e) { log.error('share reply:', e.message); }
  } catch (e) {
    log.error('processShareLinkAsync:', e.message);
    await updateState('failed', e.message);
  } finally {
    releaseTransferSlot();
  }
}

export async function processFileAsync(dbId, fi, chatId, msgId, chat, from, date, env, ref) {
  // 前置检查：dbId 为 null 时中断处理，避免幽灵转存
  if (!dbId) {
    log.error('processFileAsync called with null dbId, file:', fi.fileName);
    return;
  }
  async function updateState(state, err) {
    if (env.D1_DB && dbId) {
      try { await env.D1_DB.prepare('UPDATE files SET processing_state=?, error_msg=? WHERE id=?').bind(state, err || '', dbId).run(); } catch(e) {}
    }
    if (state === 'failed' && err) {
      var f = null;
      try { f = await env.D1_DB.prepare('SELECT file_name, chat_title FROM files WHERE id=?').bind(dbId).first(); } catch (e) {}
      notifyAdmin(env, '转存失败: ' + ((f && f.file_name) || dbId) + ((f && f.chat_title) ? ' | ' + f.chat_title : '') + '\n' + String(err).slice(0, 300));
      fireWebhook(env, 'file_failed', { id: dbId, file_name: (f && f.file_name) || '', chat_title: (f && f.chat_title) || '', error: String(err).slice(0, 300) }).catch(function(){});
      // 通知原聊天：已入库但转存失败，可在后台「未转存」页手动重试，或等待定时任务自动重试
      if (chatId && env.TG_BOT_TOKEN) {
        try {
          await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: '⚠️ #' + dbId + ' 已入库但转存失败：' + String(err).slice(0, 120) + '\n可在后台「未转存」页重试' })
          });
        } catch (e) {}
      }
    }
  }
  async function updateProgress(state, bytes, total) {
    if (env.D1_DB && dbId) {
      try { await env.D1_DB.prepare('UPDATE files SET processing_state=?, progress_bytes=?, total_bytes=? WHERE id=?').bind(state, bytes, total, dbId).run(); } catch(e) {}
    }
  }
  await acquireTransferSlot();
  try {
    var dbIdNum = parseInt(dbId) || 0;
    // Dedup pre-check #1: same Telegram file_id already stored? (covers re-forwarded files)
    if (env.D1_DB && dbIdNum && fi.fileId) {
      try {
        const dup = await env.D1_DB.prepare("SELECT storage_key, r2_url, thumb_url, md5_hash, mime_type FROM files WHERE telegram_file_id=? AND processing_state='completed' AND id!=? LIMIT 1").bind(fi.fileId, dbIdNum).first();
        if (dup && dup.r2_url) {
          await env.D1_DB.prepare("UPDATE files SET storage_key=?, r2_url=?, md5_hash=?, mime_type=?, processing_state='completed', file_name=?, tg_file_url=?, thumb_url=?, progress_bytes=?, total_bytes=?, quick_hash=? WHERE id=?")
            .bind(dup.storage_key, dup.r2_url, dup.md5_hash || '', dup.mime_type || '', fi.fileName, '', dup.thumb_url || '', fi.fileSize || 0, fi.fileSize || 0, '', dbIdNum).run();
          const rr1 = await getFileRef(env, dbIdNum);
          await replyMsg(chatId, parseInt(msgId), fi, dup.r2_url, env, rr1 || ref || String(dbIdNum), dbIdNum);
          return;
        }
      } catch (e) { log.debug('file_id dedup check fail:', e.message); }
    }

    var isLarge = (fi.fileSize || 0) > LARGE_FILE_THRESHOLD;
    var key = null, url = null, md5 = '', ct = '', tgUrl = '', thumbUrl = '', quickHash = '';
    var uploadedNew = false;

    if (isLarge) {
      // Large file: stream from Telegram directly to R2 (no memory buffering, no MD5 dedup)
      await updateProgress('downloading', 0, fi.fileSize || 0);
      log.info('large file queue: id=' + dbId + ' fileId=' + fi.fileId + ' size=' + fi.fileSize);
      const fd = await dlFileStream(fi.fileId, env.TG_BOT_TOKEN, tgApiBases(env));
      if (!fd || fd.error) { log.warn('large file download failed, dbId=' + dbId + (fd && fd.error ? ' err=' + fd.error : '')); await updateState('failed', (fd && fd.error) || 'download_failed'); return; }
      tgUrl = fd.tgUrl || '';
      ct = fd.ct;
      await updateState('uploading');
      const ext = guessExt(ct, fi.fileName);
      const dp = date.getFullYear() + '/' + String(date.getMonth() + 1).padStart(2, '0');
      key = dp + '/' + genHash() + '.' + ext;
      // Count streamed bytes for progress (download+upload happen in the same pipe)
      var counted = 0, lastRep = 0;
      const counter = new TransformStream({
        transform(chunk, controller) {
          counted += (chunk && chunk.byteLength) || (chunk && chunk.length) || 0;
          controller.enqueue(chunk);
          var now = Date.now();
          if (now - lastRep > 2500) { lastRep = now; updateProgress('uploading', counted, fi.fileSize || 0).catch(function(){}); }
        }
      });
      url = await putR2Stream(key, fd.stream.pipeThrough(counter), ct, env, COLD_STORAGE_CLASS);
      if (!url) {
        // R2 streams can't be replayed: retry once with a fresh download
        try {
          const fd2 = await dlFileStream(fi.fileId, env.TG_BOT_TOKEN, tgApiBases(env));
          if (fd2 && !fd2.error) { url = await putR2Stream(key, fd2.stream, ct, env, COLD_STORAGE_CLASS); }
        } catch (e2) { log.warn('large retry fail:', e2.message); }
      }
      if (!url) { await updateState('failed', 'r2_upload_failed' + (lastUploadError ? ' (' + lastUploadError + ')' : '')); return; }
      await updateProgress('uploading', fi.fileSize || 0, fi.fileSize || 0).catch(function(){});
      uploadedNew = true;
      md5 = ''; // skip MD5 for large files
    } else {
      // <=20MB: prefer official API (saves server bandwidth); 20-50MB: official fails (20MB limit), go Local API first
      var bases;
      if ((fi.fileSize || 0) <= OFFICIAL_MAX) {
        bases = [OFFICIAL_API];
        tgApiBases(env).forEach(function(b) { if (bases.indexOf(b) === -1) bases.push(b); });
      } else {
        bases = tgApiBases(env);
      }
      if (fi.type === 'photo') {
        // Photos: stream straight into R2 (pipelined, no full buffering).
        // Dedup via Telegram file_id pre-check (above) + head/tail sample hash (below).
        await updateProgress('downloading', 0, fi.fileSize || 0);
        const fd = await dlFileStreamLarger(fi.fileId, env.TG_BOT_TOKEN, bases);
        if (!fd || fd.error) { log.warn('photo download failed, dbId=' + dbId + (fd && fd.error ? ' err=' + fd.error : '')); await updateState('failed', (fd && fd.error) || 'download_failed'); return; }
        tgUrl = fd.tgUrl || '';
        ct = fd.ct;
        await updateState('uploading');
        const ext = guessExt(ct, fi.fileName);
        const dp = date.getFullYear() + '/' + String(date.getMonth() + 1).padStart(2, '0');
        key = dp + '/' + genHash() + '.' + ext;
        var counted2 = 0, lastRep2 = 0;
        var first64k = null, last64k = null, totalBytes = 0;
        const counter2 = new TransformStream({
          transform(chunk, controller) {
            var bytes = (chunk instanceof Uint8Array) ? chunk : new Uint8Array(chunk);
            totalBytes += bytes.byteLength;
            // sample: first 64KB
            if (!first64k) first64k = bytes.slice(0, Math.min(65536, bytes.byteLength));
            else if (first64k.byteLength < 65536) {
              var need = Math.min(65536 - first64k.byteLength, bytes.byteLength);
              var tmp = new Uint8Array(first64k.byteLength + need);
              tmp.set(first64k); tmp.set(bytes.subarray(0, need), first64k.byteLength);
              first64k = tmp;
            }
            // sample: sliding window of the last 64KB
            var tail = bytes.byteLength > 65536 ? bytes.subarray(bytes.byteLength - 65536) : bytes;
            if (!last64k) last64k = tail;
            else if (last64k.byteLength + tail.byteLength <= 65536) {
              var t2 = new Uint8Array(last64k.byteLength + tail.byteLength);
              t2.set(last64k); t2.set(tail, last64k.byteLength);
              last64k = t2;
            } else {
              var drop = last64k.byteLength + tail.byteLength - 65536;
              var t3 = new Uint8Array(65536);
              var keep = last64k.byteLength - drop;
              if (keep > 0) t3.set(last64k.subarray(drop), 0);
              t3.set(tail, keep);
              last64k = t3;
            }
            counted2 += bytes.byteLength;
            controller.enqueue(chunk);
            var now = Date.now();
            if (now - lastRep2 > 2500) { lastRep2 = now; updateProgress('uploading', counted2, fi.fileSize || 0).catch(function(){}); }
          }
        });
        url = await putR2Stream(key, fd.stream.pipeThrough(counter2), ct, env, COLD_STORAGE_CLASS);
        if (!url) {
          // R2 streams can't be replayed: retry once with a fresh download
          first64k = null; last64k = null; totalBytes = 0; // invalidate partial samples
          try {
            const fd2 = await dlFileStreamLarger(fi.fileId, env.TG_BOT_TOKEN, bases);
            if (fd2 && !fd2.error) { url = await putR2Stream(key, fd2.stream, ct, env, COLD_STORAGE_CLASS); }
          } catch (e2) { log.warn('photo retry fail:', e2.message); }
        }
        if (!url) { await updateState('failed', 'r2_upload_failed' + (lastUploadError ? ' (' + lastUploadError + ')' : '')); return; }
        await updateProgress('uploading', fi.fileSize || 0, fi.fileSize || 0).catch(function(){});
        uploadedNew = true;
        md5 = ''; // photos skip full MD5 for speed
        // Dedup check #2: head+tail sample hash (content-level, near-zero false positive)
        if (env.D1_DB && dbIdNum && first64k && first64k.byteLength > 0) {
          try {
            var head = first64k;
            var tail2 = (last64k && last64k.byteLength > 0) ? last64k : first64k;
            var parts = new Uint8Array(head.byteLength + tail2.byteLength + 8);
            parts.set(head, 0);
            parts.set(tail2, head.byteLength);
            new DataView(parts.buffer).setBigUint64(head.byteLength + tail2.byteLength, BigInt(totalBytes), false);
            var hb = await crypto.subtle.digest('SHA-1', parts);
            quickHash = Array.from(new Uint8Array(hb)).map(function(b){ return b.toString(16).padStart(2, '0'); }).join('');
            const dup2 = await env.D1_DB.prepare("SELECT storage_key, r2_url, thumb_url FROM files WHERE quick_hash=? AND processing_state='completed' AND id!=? LIMIT 1").bind(quickHash, dbIdNum).first();
            if (dup2 && dup2.r2_url) {
              try { await env.R2_BUCKET.delete(key); } catch (e) {}
              key = dup2.storage_key; url = dup2.r2_url; thumbUrl = dup2.thumb_url || '';
              quickHash = ''; // keep the existing record's hash
              uploadedNew = false; // already exists: skip thumb generation
            }
          } catch (e) { log.debug('quickhash dedup fail:', e.message); }
        }
      } else {
        // Other types (document/audio/video <=50MB): buffer + MD5 dedup
        await updateProgress('downloading', 0, fi.fileSize || 0);
        const fd = await dlFileLarger(fi.fileId, fi.fileSize, env.TG_BOT_TOKEN, bases, function(bytes) {
          updateProgress('downloading', bytes, fi.fileSize || 0).catch(function(){});
        });
        if (!fd || fd.error) { log.warn('medium file download failed, dbId=' + dbId + (fd && fd.error ? ' err=' + fd.error : '')); await updateState('failed', (fd && fd.error) || 'download_failed'); return; }
        tgUrl = fd.tgUrl || '';
        ct = fd.ct;
        await updateState('hashing');
        // 隐私与体积：document 上传的原图剥掉 EXIF/GPS 元数据（photo 由 TG 自行压缩已去除；document 保留原始信息）
        var storeBuf = fd.buf;
        if (storeBuf && /image\/jpeg/i.test(ct || '')) {
          const sb = stripExifIfJpeg(storeBuf, ct);
          if (sb !== storeBuf) storeBuf = sb;
        }
        md5 = await computeMd5(storeBuf);
        if (env.D1_DB) {
          try {
            const dup = await env.D1_DB.prepare('SELECT storage_key, r2_url, thumb_url FROM files WHERE md5_hash=? AND processing_state=\'completed\' LIMIT 1').bind(md5).first();
            if (dup) { key = dup.storage_key; url = dup.r2_url; thumbUrl = dup.thumb_url || ''; }
          } catch (e) {}
        }
        if (!key) {
          await updateState('uploading');
          const ext = guessExt(ct, fi.fileName);
          const dp = date.getFullYear() + '/' + String(date.getMonth() + 1).padStart(2, '0');
          key = dp + '/' + genHash() + '.' + ext;
          url = await putR2(key, storeBuf, ct, env, (fi.fileSize || 0) >= COLD_STORAGE_MIN ? COLD_STORAGE_CLASS : null);
          if (!url) {
            // buf is replayable: simple retry
            url = await putR2(key, storeBuf, ct, env, (fi.fileSize || 0) >= COLD_STORAGE_MIN ? COLD_STORAGE_CLASS : null);
          }
          if (!url) { await updateState('failed', 'r2_upload_failed' + (lastUploadError ? ' (' + lastUploadError + ')' : '')); return; }
          uploadedNew = true;
        }
      }
    }

    // Generate thumbnail (best effort): Telegram-provided thumbnail first, then Image Resizing WebP
    if (uploadedNew && !thumbUrl) {
      if (fi.thumb) {
        try {
          const tfd = await dlFileLarger(fi.thumb, 0, env.TG_BOT_TOKEN, [OFFICIAL_API].concat(tgApiBases(env)));
          if (tfd && !tfd.error && tfd.buf && tfd.buf.byteLength > 0) {
            const tkey = key.replace(/\.[^.]+$/, '') + '_thumb.jpg';
            const tu = await putR2(tkey, tfd.buf, 'image/jpeg', env);
            if (tu) thumbUrl = tu;
          }
        } catch (e) { log.warn('thumb gen fail dbId=' + dbId + ':', e.message); }
      }
      if (!thumbUrl && fi.type === 'photo' && url) {
        thumbUrl = await genThumb(env, url, key);
      }
    }

    await updateState('saving');
    if (env.D1_DB && dbId) {
      try {
        await env.D1_DB.prepare(
          'UPDATE files SET storage_key=?, r2_url=?, md5_hash=?, mime_type=?, processing_state=?, file_name=?, tg_file_url=?, thumb_url=?, progress_bytes=?, total_bytes=?, quick_hash=? WHERE id=?'
        ).bind(key, url, md5, ct, 'completed', fi.fileName, tgUrl, thumbUrl, fi.fileSize || 0, fi.fileSize || 0, quickHash, dbId).run();
      } catch (e) { log.error('D1 update:', e.message); }
    }
    await updateProgress('completed', fi.fileSize || 0, fi.fileSize || 0).catch(function(){});
    // 用最终编号（延迟批量编号已分配，如 3-001）；历史/重试文件兜底用原 ref 或文件 id
    const rr2 = await getFileRef(env, dbId);
    await replyMsg(chatId, parseInt(msgId), fi, url, env, rr2 || ref || String(dbId), dbId);
    fireWebhook(env, 'file_imported', { id: dbIdNum, url: url, file_name: fi.fileName, file_type: fi.type, file_size: fi.fileSize || 0, chat_id: chatId, source: 'tg' }).catch(function(){});
    invalidateStatsCache();
  } catch (e) {
    log.error('processFileAsync:', e.message);
    await updateState('failed', e.message);
  } finally {
    releaseTransferSlot();
  }
}

export async function processUpdate(update, env, waitFn) {
  const msg = update.message || update.channel_post;
  if (!msg) return { ok: true, skip: true };

  const chatId = String(msg.chat.id);
  const msgId = String(msg.message_id);
  const text = msg.text || '';
  const from = msg.from || {};
  const chat = msg.chat || {};
  const date = msg.date ? new Date(msg.date * 1000) : new Date();

  // Handle bot commands
  if (text.startsWith('/')) {
    return await handleBotCommand(parseInt(chatId), parseInt(msgId), text, env, waitFn);
  }

  // Handle file messages
  const fi = extractFileInfo(msg);
  if (!fi) {
    // 数字菜单选择：用户直接回复 1/2/3 时执行对应菜单动作
    const digits = String(text).trim();
    if (/^\d{1,2}$/.test(digits)) {
      const ctx = await getMenuCtx(env, chatId);
      if (ctx && ctx.items && ctx.items.length) {
        const n = parseInt(digits, 10);
        let it = null;
        for (let i = 0; i < ctx.items.length; i++) if (ctx.items[i].n === n) { it = ctx.items[i]; break; }
        if (it) { await execMenuAction(it.action, chatId, env, parseInt(msgId)); return { ok: true, menu: true }; }
        await replyText(chatId, parseInt(msgId), '❌ 没有选项 ' + n, env);
        return { ok: true, menu: true };
      }
    }
    // 快捷回复键盘按钮：点"查看图库"=查询现有数量，点"帮助"=展示帮助（在 AI 分支之前处理，避免被 AI 接管）
    if (env.D1_DB && !fi) {
      const mm = await getMainMenuCfg(env);
      if (mm && mm.enabled && text && text.trim() === mm.text) {
        return await handleCountCommand(chatId, env);
      }
      if (mm && mm.enabled && text && text.trim() === mm.help) {
        await replyTextWithKeyboard(chatId, DEFAULT_COMMANDS['/help'], MAIN_BUTTONS, env);
        return { ok: true, quick: true };
      }
    }
    // @bot 找图：群里 @机器人 并含"图/来一张/随机"等意图时，直接走共享库索图（不依赖 AI 开启）
    if (env.D1_DB && !fi && !(msg.photo || msg.document || msg.video || msg.audio || msg.voice || msg.sticker || msg.animation || msg.video_note || msg.contact || msg.location || msg.poll)) {
      const botUser = await getBotUsername(env);
      const atBot = botUser && new RegExp('@' + botUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text);
      if (atBot && /(找图|来图|来一张|随机|图$|图片|看看图)/.test(text)) {
        // 去除 @bot 与指令词，剩余的作为标签
        const clean = String(text).replace(new RegExp('@' + botUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '').replace(/(找图|来图|来一张|随机|图片|看看图)/g, '').trim();
        return await handleImgCommand(chatId, parseInt(msgId), clean, env);
      }
    }
    // AI 管理：开启 AI 后，仅当消息为纯文本且呈明显提问/请求意图时才交给大模型（function calling 查询/重试/搜索）。
    // 纯媒体消息（图片/视频/文档/语音/贴纸等）一律不触发，避免群内刷图反复触发 AI 导致服务商 429 限流
    if (env.D1_DB && !(msg.photo || msg.document || msg.video || msg.audio || msg.voice || msg.sticker || msg.animation || msg.video_note || msg.contact || msg.location || msg.poll)) {
      const cfg = await getAIConfig(env);
      if (cfg.enabled === 1 && cfg.key && isAIReplyText(text)) {
        const p = callAIManage(chatId, parseInt(msgId), text, env).catch(function(e) { log.error('ai manage:', e.message); });
        if (waitFn) waitFn(p); else p;
        return { ok: true, ai: true };
      }
    }
    return { ok: true, skip: true, reason: 'unsupported' };
  }

  log.debug('file:', fi.type, chat.title || chat.username);

  // Try to download file - <=20MB prefers official API, larger goes through Local Bot API
  let bases;
  if ((fi.fileSize || 0) <= OFFICIAL_MAX) {
    bases = [OFFICIAL_API];
    tgApiBases(env).forEach(function(b) { if (bases.indexOf(b) === -1) bases.push(b); });
  } else {
    bases = tgApiBases(env);
  }
  const fd = await dlFileLarger(fi.fileId, fi.fileSize, env.TG_BOT_TOKEN, bases);
  if (!fd) return { ok: false, error: 'download_failed' };
  const tgUrl = fd.tgUrl || '';

  // Compute MD5 for deduplication
  const md5 = await computeMd5(fd.buf);

  // Check for duplicate file in D1
  let key, url;
  if (env.D1_DB) {
    try {
      const dup = await env.D1_DB.prepare('SELECT storage_key, r2_url FROM files WHERE md5_hash=? LIMIT 1').bind(md5).first();
      if (dup) {
        key = dup.storage_key;
        url = dup.r2_url;
        log.debug('dedup hit:', md5, '->', key);
      }
    } catch (e) {}
  }

  // Upload to R2 if no duplicate found
  if (!key) {
    const ext = guessExt(fd.ct, fi.fileName);
    const dp = date.getFullYear() + '/' + String(date.getMonth() + 1).padStart(2, '0');
    key = dp + '/' + genHash() + '.' + ext;
    url = await putR2(key, fd.buf, fd.ct, env, (fi.fileSize || 0) >= COLD_STORAGE_MIN ? COLD_STORAGE_CLASS : null);
    if (!url) return { ok: false, error: 'r2_failed' };
  }

  let rid = null, ref2 = '';
  if (env.D1_DB) {
    try {
      ref2 = await allocTgRef(env);
      const r = await env.D1_DB.prepare(
        'INSERT INTO files (storage_key,r2_url,md5_hash,processing_state,chat_id,chat_title,chat_type,chat_username,user_id,username,full_name,telegram_file_id,file_name,file_size,file_type,mime_type,width,height,caption,message_id,created_at,tg_file_url,group_ref,media_group_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(key, url, md5, 'completed', chatId, chat.title || chat.username || chatId, chat.type || '', chat.username || '', from.id || 0, from.username || '', [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown', fi.fileId, fi.fileName, fi.fileSize, fi.type, fd.ct, fi.width, fi.height, msg.caption || '', msgId, date.toISOString(), tgUrl, ref2, msg.media_group_id || '').run();
      rid = r.meta?.last_row_id;
    } catch (e) { log.error('D1:', e.message); }
  }

  log.debug('url:', url);
  await replyMsg(chatId, parseInt(msgId), fi, url, env, ref2 || '', rid);
  fireWebhook(env, 'file_imported', { id: rid, url: url, file_name: fi.fileName, file_type: fi.type, file_size: fi.fileSize || 0, chat_id: chatId, source: 'tg' }).catch(function(){});
  return { ok: true, url, fileId: rid, type: fi.type };
}

export function extractFileInfo(msg) {
  if (msg.photo) { const p = msg.photo[msg.photo.length - 1]; return { type: 'photo', fileId: p.file_id, fileName: 'photo_' + genHash() + '.jpg', fileSize: p.file_size, width: p.width, height: p.height }; }
  if (msg.document) return { type: 'document', fileId: msg.document.file_id, fileName: msg.document.file_name || 'doc_' + genHash(), fileSize: msg.document.file_size, width: 0, height: 0, thumb: (msg.document.thumbnail || msg.document.thumb || {}).file_id || '' };
  if (msg.video) return { type: 'video', fileId: msg.video.file_id, fileName: msg.video.file_name || 'video_' + genHash() + '.mp4', fileSize: msg.video.file_size, width: msg.video.width || 0, height: msg.video.height || 0, thumb: (msg.video.thumbnail || msg.video.thumb || {}).file_id || '' };
  if (msg.audio) return { type: 'audio', fileId: msg.audio.file_id, fileName: msg.audio.file_name || 'audio_' + genHash() + '.mp3', fileSize: msg.audio.file_size, width: 0, height: 0 };
  if (msg.voice) return { type: 'voice', fileId: msg.voice.file_id, fileName: 'voice_' + genHash() + '.ogg', fileSize: msg.voice.file_size, width: 0, height: 0 };
  if (msg.sticker) return { type: 'photo', fileId: msg.sticker.file_id, fileName: 'sticker_' + genHash() + '.webp', fileSize: msg.sticker.file_size, width: msg.sticker.width || 0, height: msg.sticker.height || 0 };
  if (msg.animation) return { type: 'photo', fileId: msg.animation.file_id, fileName: msg.animation.file_name || 'gif_' + genHash() + '.gif', fileSize: msg.animation.file_size, width: msg.animation.width || 0, height: msg.animation.height || 0, thumb: (msg.animation.thumbnail || msg.animation.thumb || {}).file_id || '' };
  return null;
}

export async function replyMsg(chatId, replyId, fi, url, env, ref, dbId) {
  const ic = { photo: '🖼', document: '📄', video: '🎬', audio: '🎵', voice: '🎤' };
  const lb = { photo: 'Photo', document: 'File', video: 'Video', audio: 'Audio', voice: 'Voice' };
  const pre = ref ? '#' + ref + ' ' : '';
  // 附带入库数量：总数/已完成（已完成数 = 总数 - 未转存数），让用户一眼看到本次转存后的数据规模
  const cnt = await countCompleted(env);
  const cntStr = cnt ? '\n📊 已完成: ' + cnt.completed + ' / ' + cnt.total + ' 条' : '';
  const t = fi.type === 'photo' ? pre + '🖼 Saved\n' + url + cntStr : pre + ic[fi.type] + ' ' + lb[fi.type] + ' Saved\n' + fi.fileName + ' (' + fmtSize(fi.fileSize) + ')\n' + url + cntStr;
  // 转存完成：若该文件已有批量回执，原地编辑更新为直链（相册更新整条合并回执），避免刷屏
  if (dbId && env.D1_DB) {
    try {
      const f = await env.D1_DB.prepare('SELECT media_group_id, receipt_msg_id FROM files WHERE id=?').bind(dbId).first();
      if (f && f.media_group_id && f.receipt_msg_id) {
        await refreshGroupReceipt(env, chatId, f.media_group_id);
        return;
      }
      if (f && f.receipt_msg_id) {
        await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/editMessageText', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: f.receipt_msg_id, text: String(t).slice(0, 1024) }) }).catch(function(e) { log.warn('replyMsg edit fail:', e.message); });
        return;
      }
    } catch (e) { log.debug('replyMsg receipt lookup:', e.message); }
  }
  try { await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: t }) }); } catch (e) { }
}

export async function handleCallbackQuery(cq, env) {
  const msg = cq.message || {};
  const chatId = String(msg.chat ? msg.chat.id : '');
  const data = cq.data || '';
  function answerCb(text) {
    if (!env.TG_BOT_TOKEN) return Promise.resolve();
    return fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/answerCallbackQuery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cq.id, text: text || '' })
    }).catch(function(){});
  }
  if (data === 'cmd:count') { await answerCb('正在查询数量...'); return await handleCountCommand(chatId, env); }
  if (data === 'cmd:pending') { await answerCb('正在查询未转存...'); return await handlePendingCommand(chatId, env); }
  if (data === 'cmd:retry') { await answerCb('正在触发转存...'); return await handleRetryCommand(chatId, env); }
  if (data === 'cmd:health') { await answerCb('正在检查服务...'); return await handleHealthCommand(chatId, env); }
  // 数字菜单按钮：menu:n:<序号> → 读该聊天的菜单上下文执行对应动作
  if (data.indexOf('menu:n:') === 0) {
    const n = parseInt(data.slice(7));
    const ctx = await getMenuCtx(env, chatId);
    if (ctx && ctx.items && ctx.items.length) {
      let it = null;
      for (let i = 0; i < ctx.items.length; i++) if (ctx.items[i].n === n) { it = ctx.items[i]; break; }
      if (it) {
        await answerCb('正在执行: ' + it.label);
        await execMenuAction(it.action, chatId, env, 0);
        return { ok: true, menu: true };
      }
    }
    await answerCb('菜单已过期，请重新发送指令');
    return { ok: true, menu: true };
  }
  await answerCb('未知操作');
  return { ok: true, handled: 'callback' };
}

