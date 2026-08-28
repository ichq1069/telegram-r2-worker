/**
 * Telegram Bot → R2 + D1 Worker v6
 * Features: Bot commands, Custom API, Webhook, Dashboard, Large file support
 * 拆模块：工具/db/告警/备份/限流在 src/ 目录，主体逻辑仍在本文件
 */
import { json, cors, fmtSize, genHash } from './src/util.js';
import { ensureTablesOnce } from './src/db.js';
import { notifyAdmin, genThumb } from './src/notify.js';
import { dumpAllTables, handleAdminBackup, handleAdminBackupSave, handleAdminBackupList, handleAdminBackupDelete } from './src/backup.js';
import { applyRateLimit } from './src/ratelimit.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return cors(null, 204);
    // Ensure tables exist (only once per isolate, avoiding per-request D1 overhead)
    if (env.D1_DB) { try { await ensureTablesOnce(env.D1_DB); } catch (e) {} }
    // 本地请求计数（兜底统计，异步不阻塞；主统计走 Cloudflare GraphQL）
    bumpWorkerStat(env);
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    if (m === 'GET' && p === '/health') return json({ ok: true, time: new Date().toISOString(), version: 'v6' });
    if (m === 'POST' && p === '/webhook') return handleWebhook(request, env);
    if (m === 'GET' && p === '/dashboard') return handleDashboard(env);
    if (m === 'GET' && p === '/docs') return handleDocs();
    if (m === 'GET' && p === '/show') return handleShowPage();
    if (m === 'GET' && p === '/show/data') return handleShowData(request, env);
    if (m === 'GET' && p === '/admin') return handleAdminFromR2(env);
    if (m === 'GET' && p === '/favicon.ico') return new Response(null, { status: 204 });
    // File proxy: /file/tg/<id> -> 302 to official Telegram direct link (clean URL, no token exposed)
    if (m === 'GET' && p.indexOf('/file/tg/') === 0) return handleTgFileRedirect(p, env, ctx);
    // Admin API (auth via query param or header)
    const adminKey = url.searchParams.get('api_key') || request.headers.get('X-API-Key');
    const isAdmin = adminKey && adminKey === env.API_KEY;
    if (m === 'GET' && p === '/admin/api/commands') return isAdmin ? handleAdminCommands(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/commands') return isAdmin ? handleAdminAddCommand(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'PATCH' && p === '/admin/api/commands') return isAdmin ? handleAdminUpdateCommand(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/commands') return isAdmin ? handleAdminDeleteCommand(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/files') return isAdmin ? handleFiles(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/files') return isAdmin ? handleDeleteFile(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/stats') return isAdmin ? handleStats(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/bot-info') return isAdmin ? handleBotGetMeApi(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/dedup') return isAdmin ? handleDedup(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/dedup/stats') return isAdmin ? handleDedupStats(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/dedup/groups') return isAdmin ? handleDedupGroups(env) : json({ok:false,error:'Unauthorized'},401);
    // 去重行级操作：单文件清理 / 设为保留（keep 保留该行并清理同组其他）
    if (m === 'POST' && p === '/admin/api/dedup/row') return isAdmin ? handleDedupRow(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/dedup/rows') return isAdmin ? handleDedupRows(request, env) : json({ok:false,error:'Unauthorized'},401);
    // 存储压缩：photo 转 WebP 省存储（需账号开通 Image Resizing）
    if (m === 'GET' && p === '/admin/api/compress/stats') return isAdmin ? handleCompressStats(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/compress/run') return isAdmin ? handleCompressRun(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/processing') return isAdmin ? handleProcessingStatus(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/retry') return isAdmin ? handleRetry(request, env, ctx) : json({ok:false,error:'Unauthorized'},401);
    // 未转存列表（已入库但未完成）+ 批量重试
    if (m === 'GET' && p === '/admin/api/unsaved') return isAdmin ? handleUnsavedList(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/unsaved/retry') return isAdmin ? handleUnsavedRetry(request, env, ctx) : json({ok:false,error:'Unauthorized'},401);
    // Trash (soft-deleted files) + R2 storage maintenance
    if (m === 'GET' && p === '/admin/api/trash') return isAdmin ? handleTrashList(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/trash/restore') return isAdmin ? handleTrashRestore(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/r2/inspect') return isAdmin ? handleR2Inspect(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/r2/cleanup') return isAdmin ? handleR2Cleanup(env) : json({ok:false,error:'Unauthorized'},401);
    // Manual poll trigger (fallback while cron is being set up)
    if (m === 'GET' && p === '/admin/api/poll') return isAdmin ? handlePollEndpoint(env) : json({ok:false,error:'Unauthorized'},401);
    // Tag management
    if (m === 'GET' && p === '/admin/api/tags') return isAdmin ? handleAdminTags(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/files/tags') return isAdmin ? handleSetFileTags(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/files/pool-status') return isAdmin ? handleSetFilePoolStatus(request, env) : json({ok:false,error:'Unauthorized'},401);
    // API key management (for third-party programs)
    if (m === 'GET' && p === '/admin/api/keys') return isAdmin ? handleAdminKeys(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/keys') return isAdmin ? handleAdminKeysCreate(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/keys/toggle') return isAdmin ? handleAdminKeysToggle(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/keys') return isAdmin ? handleAdminKeysDelete(request, env) : json({ok:false,error:'Unauthorized'},401);
    // User stats
    if (m === 'GET' && p === '/admin/api/users') return isAdmin ? handleAdminUsers(env) : json({ok:false,error:'Unauthorized'},401);
    // Slideshow page config
    if (m === 'GET' && p === '/admin/api/show-config') return isAdmin ? handleShowConfigGet(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/show-config') return isAdmin ? handleShowConfigSet(request, env) : json({ok:false,error:'Unauthorized'},401);
    // Random pool management
    if (m === 'GET' && p === '/admin/api/pool') return isAdmin ? handleAdminPoolList(request, env) : json({ok:false,error:'Unauthorized'},401);
    // Show groups (image playlists bound to schedule programs)
    if (m === 'GET' && p === '/admin/api/show-groups') return isAdmin ? handleShowGroupsList(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/show-groups') return isAdmin ? handleShowGroupsSave(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/show-groups') return isAdmin ? handleShowGroupsDelete(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool') return isAdmin ? handleAdminPoolCreate(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/import-page') return isAdmin ? handleAdminPoolImportPage(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/upload') return isAdmin ? handleAdminPoolUpload(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/upload-postimages') return isAdmin ? handleAdminPoolUploadPostimages(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/toggle') return isAdmin ? handleAdminPoolToggle(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/batch') return isAdmin ? handleAdminPoolBatch(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/batch-delete') return isAdmin ? handleAdminPoolBatchDelete(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/tags') return isAdmin ? handleAdminPoolTags(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/from-tg') return isAdmin ? handleAdminPoolFromTg(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/pool') return isAdmin ? handleAdminPoolDelete(request, env) : json({ok:false,error:'Unauthorized'},401);
    // Postimages API key stored in D1 settings (shared across browsers/devices)
    if (m === 'GET' && p === '/admin/api/settings/pi-key') return isAdmin ? handleAdminGetPiKey(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/pi-key') return isAdmin ? handleAdminSavePiKey(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/settings/pool-tags') return isAdmin ? handleAdminGetPoolTags(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/pool-tags') return isAdmin ? handleAdminSavePoolTags(request, env) : json({ok:false,error:'Unauthorized'},401);
    // 代理模式：1=入库不转存 R2，直链 /file/tg/<id> 由 worker 实时拉 Telegram（省 R2 存储）
    if (m === 'GET' && p === '/admin/api/settings/proxy-mode') return isAdmin ? handleAdminGetProxyMode(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/proxy-mode') return isAdmin ? handleAdminSaveProxyMode(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/settings/proxy-only') return isAdmin ? handleAdminGetProxyOnly(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/proxy-only') return isAdmin ? handleAdminSaveProxyOnly(request, env) : json({ok:false,error:'Unauthorized'},401);
    // AI 管理配置（enabled/base/model/api_key/prompt）
    if (m === 'GET' && p === '/admin/api/settings/ai') return isAdmin ? handleAdminGetAI(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/ai') return isAdmin ? handleAdminSaveAI(request, env) : json({ok:false,error:'Unauthorized'},401);
    // AI 测试（往指定 chat 发测试消息）/ AI 浮窗问答
    if (m === 'POST' && p === '/admin/api/ai/test') return isAdmin ? handleAdminTestAI(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/ai/ask') return isAdmin ? handleAdminAskAI(request, env) : json({ok:false,error:'Unauthorized'},401);
    // R2 用量概览 / 套餐配额配置
    if (m === 'GET' && p === '/admin/api/r2-usage') return isAdmin ? handleAdminR2Usage(env) : json({ok:false,error:'Unauthorized'},401);
    // Worker 用量统计（请求数/CPU/错误，GraphQL 官方 + 本地兜底）
    if (m === 'GET' && p === '/admin/api/worker-usage') return isAdmin ? handleAdminWorkerUsage(env) : json({ok:false,error:'Unauthorized'},401);
    // 用量预测 + 趋势（请求/存储）
    if (m === 'GET' && p === '/admin/api/usage-forecast') return isAdmin ? handleUsageForecast(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/settings/r2-quota') return isAdmin ? handleAdminGetR2Quota(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/r2-quota') return isAdmin ? handleAdminSaveR2Quota(request, env) : json({ok:false,error:'Unauthorized'},401);
    // D1 备份 / 失败告警配置 / API 限流配置
    if (m === 'GET' && p === '/admin/api/backup') return isAdmin ? handleAdminBackup(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/backup') return isAdmin ? handleAdminBackupSave(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/backup/list') return isAdmin ? handleAdminBackupList(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/backup') return isAdmin ? handleAdminBackupDelete(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/settings/notify') return isAdmin ? handleAdminGetNotify(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/notify') return isAdmin ? handleAdminSaveNotify(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/settings/rate-limit') return isAdmin ? handleAdminGetRateLimit(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/rate-limit') return isAdmin ? handleAdminSaveRateLimit(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/notify-test') return isAdmin ? handleAdminNotifyTest(request, env) : json({ok:false,error:'Unauthorized'},401);

    // Bot API routes (no auth needed, verified by Telegram)
    if (m === 'POST' && p === '/bot/sendMessage') return handleBotSendMessage(request, env);
    if (m === 'POST' && p === '/bot/sendPhoto') return handleBotSendPhoto(request, env);
    if (m === 'POST' && p === '/bot/sendDocument') return handleBotSendDocument(request, env);
    if (m === 'POST' && p === '/bot/sendVideo') return handleBotSendVideo(request, env);
    if (m === 'POST' && p === '/bot/getFile') return handleBotGetFile(request, env);
    if (m === 'POST' && p === '/bot/getMe') return handleBotGetMe(request, env);
    if (m === 'POST' && p === '/bot/getWebhookInfo') return handleBotGetWebhookInfo(request, env);
    if (m === 'POST' && p === '/bot/setWebhook') return handleBotSetWebhook(request, env);
    if (m === 'POST' && p === '/bot/getUpdates') return handleBotGetUpdates(request, env);
    if (m === 'POST' && p === '/bot/getChat') return handleBotGetChat(request, env);
    if (m === 'POST' && p === '/bot/getChatMemberCount') return handleBotGetChatMemberCount(request, env);
    if (m === 'POST' && p === '/bot/banChatMember') return handleBotBanChatMember(request, env);
    if (m === 'POST' && p === '/bot/unbanChatMember') return handleBotUnbanChatMember(request, env);
    if (m === 'POST' && p === '/bot/deleteMessage') return handleBotDeleteMessage(request, env);
    if (m === 'POST' && p === '/bot/forwardMessage') return handleBotForwardMessage(request, env);
    if (m === 'POST' && p === '/bot/copyMessage') return handleBotCopyMessage(request, env);

    // Public JSON API for third-party programs (auth via api_keys table)
    if (m === 'GET' && (p === '/api/v1/files' || p === '/api/v1/random')) {
      const k = await checkApiKey(request, env);
      if (!k) return json({ ok: false, error: 'Unauthorized or invalid API key' }, 401);
      if (k.limited) return json({ ok: false, error: 'Rate limit exceeded' }, 429);
      if (p === '/api/v1/random') return handlePublicRandom(request, env);
      return handlePublicFiles(request, env);
    }

    // API routes (require auth)
    const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('api_key');
    if (!apiKey || apiKey !== env.API_KEY) return json({ ok: false, error: 'Unauthorized' }, 401);

    if (m === 'GET' && p === '/api/files') return handleFiles(request, env);
    if (m === 'GET' && p === '/api/file') return handleFile(request, env);
    if (m === 'GET' && p === '/api/stats') return handleStats(env);
    if (m === 'GET' && p === '/api/by-chat') return handleByChat(request, env);
    if (m === 'GET' && p === '/api/by-user') return handleByUser(request, env);
    if (m === 'GET' && p === '/api/by-date') return handleByDate(request, env);
    if (m === 'GET' && p === '/api/search') return handleSearch(request, env);
    if (m === 'GET' && p === '/api/latest') return handleLatest(request, env);
    if (m === 'GET' && p === '/api/stream') return handleStream(request, env);
    if (m === 'DELETE' && p === '/api/file') return handleDeleteFile(request, env);
    if (m === 'GET' && p === '/api/bots') return handleListBots(env);
    if (m === 'POST' && p === '/api/bots') return handleAddBot(request, env);
    if (m === 'DELETE' && p === '/api/bots') return handleRemoveBot(request, env);
    if (m === 'GET' && p === '/api/config') return handleGetConfig(env);
    if (m === 'POST' && p === '/api/config') return handleSetConfig(request, env);
    if (m === 'GET' && p === '/api/bot-info') return handleBotGetMeApi(env);

    return json({ ok: false, error: 'Not Found' }, 404);
  },

  // Queue consumer: handles file processing in background (up to 15 min)
  async queue(batch, env) {
    if (env.D1_DB) { try { await ensureTablesOnce(env.D1_DB); } catch (e) {} }
    for (const msg of batch.messages) {
      try {
        await handleQueueMessage(msg.body, env);
      } catch (e) {
        console.error('queue message error:', e.message);
      }
    }
  },

  // Cron trigger: poll getUpdates from Local Bot API (Local file_id, bypasses 20MB limit)
  async scheduled(event, env, ctx) {
    // 日报：UTC 01:00（北京 09:00）推送昨日汇总
    if (event.cron === '0 1 * * *') {
      try { await sendDailyReport(env); } catch (e) { console.error('scheduled daily:', e.message); }
    }
    // webhook 自愈：每 5 分钟确认 webhook 还在，丢了自动恢复
    try {
      await ensureWebhook(env, ctx);
    } catch (e) {
      console.error('scheduled ensureWebhook:', e.message);
    }
    try {
      await handlePollUpdates(env, ctx);
    } catch (e) {
      console.error('scheduled:', e.message);
    }
    // 兜底转存：每 5 分钟重试几条未完成记录（先入库、异步转存策略的定时触发）
    try {
      await retryUnsavedCron(env, ctx);
    } catch (e) {
      console.error('scheduled retryUnsaved:', e.message);
    }
    // 查重后台化：每 5 分钟算 3 个缺失 MD5（scheduled 子请求预算有限，不清理留给手动/后台）
    try {
      await runDedupBatch(env, 3, 0, 10000, false);
    } catch (e) {
      console.error('scheduled dedup:', e.message);
    }
    // 存储维护：回收站超期文件自动硬清（24h 一次，含 R2 对象）
    try {
      await storageMaintenanceCron(env);
    } catch (e) {
      console.error('scheduled storage:', e.message);
    }
    // WebP 压缩后台化：每 5 分钟自动压 2 张（scheduled 预算有限，大头留给手动点击）
    try {
      await compressCronBatch(env);
    } catch (e) {
      console.error('scheduled compress:', e.message);
    }
  },
};

async function handleQueueMessage(body, env) {
  const d = typeof body === 'string' ? JSON.parse(body) : body;
  console.log('queue msg received, body keys:', d ? Object.keys(d).join(',') : 'null');
  if (!d) return;
  const date = new Date(d.date);
  // Share-link task (parse-video service)
  if (d.link) {
    await processShareLinkAsync(d.dbId, d.link, d.chatId, d.msgId, d.chat || {}, d.from || {}, date, env);
    return;
  }
  if (!d.fi) { console.log('queue msg missing fi:', JSON.stringify(d).slice(0, 200)); return; }
  await processFileAsync(d.dbId, d.fi, d.chatId, d.msgId, d.chat || {}, d.from || {}, date, env, d.ref || '');
}

// ==================== 群资源编号（批次-序号，如 440-001） ====================
// 每条入库消息分配唯一编号 group_ref：批内第 1 条以「下一条预计 id」为批次基准，
// 之后批内递增。距上一条消息超过 5 分钟视为新批次。编号同时写入 bot 回复与后台，
// 用户转发大量消息后对照回复即可发现哪条未入库。
var TG_REF_GAP_MS = 300 * 1000;
async function allocTgRef(env) {
  if (!env.D1_DB) return '';
  var base = 0, seq = 0, lastAt = 0;
  try {
    const s = await env.D1_DB.prepare("SELECT key, value FROM settings WHERE key IN ('tg_ref_base','tg_ref_seq','tg_ref_last_at')").all();
    (s.results || []).forEach(function(r) {
      if (r.key === 'tg_ref_base') base = parseInt(r.value, 10) || 0;
      else if (r.key === 'tg_ref_seq') seq = parseInt(r.value, 10) || 0;
      else if (r.key === 'tg_ref_last_at') lastAt = parseInt(r.value, 10) || 0;
    });
  } catch (e) {}
  var now = Date.now();
  var nbase = base, nseq;
  if (seq === 0 || now - lastAt > TG_REF_GAP_MS) {
    // 新批次：基准 = 预计下一条入库的 files.id（并发极低，worker 串行处理消息）
    var m = 0;
    try { const mx = await env.D1_DB.prepare('SELECT MAX(id) AS m FROM files').first(); m = (mx && mx.m) || 0; } catch (e) {}
    nbase = m + 1;
    nseq = 1;
  } else {
    nseq = seq + 1;
  }
  var ref = nbase + '-' + String(nseq).padStart(3, '0');
  try {
    await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES ('tg_ref_base',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(nbase)).run();
    await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES ('tg_ref_seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(nseq)).run();
    await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES ('tg_ref_last_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(now)).run();
  } catch (e) {}
  return ref;
}

// ==================== 批量编号（批次号 = 本次转发总数 N，如 3-001 ~ 3-003） ====================
// 同一 chat 3 秒内到达的文件消息视为一批；批确定后统一编号再回复。
// 编号规则：批内第 k 个文件 = N-00k（N = 批内文件总数），用户一眼可看出本次共转发几个。
async function getFileRef(env, dbId) {
  if (!env.D1_DB || !dbId) return '';
  try {
    const r = await env.D1_DB.prepare('SELECT group_ref FROM files WHERE id=?').bind(dbId).first();
    return (r && r.group_ref) || '';
  } catch (e) { return ''; }
}
async function scheduleBatchRef(env, chatId, dbId, waitFn) {
  if (!env.D1_DB || !chatId || !dbId) return;
  const p = (async () => {
    try {
      // 等 3 秒让"这一批"的其余消息到齐（TG 批量转发/相册消息间隔 <1s）
      await new Promise(function(res) { setTimeout(res, 3000); });
      const win = new Date(Date.now() - 6000).toISOString();
      const rows = await env.D1_DB.prepare('SELECT id, message_id, file_name FROM files WHERE chat_id=? AND deleted_at IS NULL AND created_at>=? ORDER BY id ASC').bind(chatId, win).all();
      const list = (rows.results || []).filter(function(r) { return r.id; });
      if (!list.length) return;
      const N = list.length;
      // 统一编号：批次号 = 本次总数 N，序号 = 批内位置（可重复执行，值稳定）
      for (var i = 0; i < list.length; i++) {
        const ref = N + '-' + String(i + 1).padStart(3, '0');
        try { await env.D1_DB.prepare('UPDATE files SET group_ref=? WHERE id=?').bind(ref, list[i].id).run(); } catch (e) {}
      }
      // 由批内最后一条统一回复（最后唤醒者拿到最终批号，避免中途编号变化/重复回复）
      if (list[list.length - 1].id !== dbId || !env.TG_BOT_TOKEN) return;
      for (var k = 0; k < list.length; k++) {
        const ref = N + '-' + String(k + 1).padStart(3, '0');
        const nm = String(list[k].file_name || '').slice(0, 40);
        try {
          await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, reply_to_message_id: parseInt(list[k].message_id, 10) || undefined, text: '📥 已入库 #' + ref + (nm ? ' · ' + nm : '') })
          });
        } catch (e) {}
      }
    } catch (e) { console.error('batchRef:', e.message); }
  })();
  if (waitFn) waitFn(p); else p;
}

// ==================== DB ====================

// Run ensureTables only once per isolate (cold start), then reuse. Avoids multi-second
// D1 setup overhead on every request (previously made /show etc. take 3s+).
// （表结构与迁移逻辑已移入 src/db.js，由顶部 import 引入）

// ==================== BOT COMMANDS ====================

const DEFAULT_COMMANDS = {
  '/start': '👋 欢迎！发送任意文件即可自动入库并转存到云端存储。\n\n常用命令:\n/count - 查询现有数量\n/pending - 查询未转存数量\n/retry - 继续完成未转存入库\n/health - 查询服务状态\n/stats - 完整统计\n/file <id> - 按 ID 获取文件\n/search <关键词> - 搜索文件',
  '/help': '📖 可用命令:\n\n/count - 查询现有数量\n/pending - 查询未转存数量\n/retry - 继续完成未转存入库\n/health - 查询服务状态\n/stats - 完整统计\n/file <id> - 按 ID 获取文件\n/search <关键词> - 搜索文件\n\n直接发送文件（图片/视频/文档/音频）即可自动保存！',
  '/stats': '__STATS__',
  '/file': 'Usage: /file <id>\nExample: /file 123',
  '/search': 'Usage: /search <keyword>\nExample: /search cat',
};

// ==================== 数字菜单交互（1/2/3 选择） ====================
// 命令的 menu 字段：JSON 数组 [{"n":1,"label":"重试全部未转存","action":"retry_all"},...]
// action 支持内置操作（retry_all/retry_recent/unsaved_count/count/stats/health/help/pending）或 text:xxx 直接回复
function parseMenu(menuStr) {
  if (!menuStr) return [];
  try {
    const arr = JSON.parse(menuStr);
    if (!Array.isArray(arr)) return [];
    return arr.filter(function(m) { return m && m.label; });
  } catch (e) { return []; }
}
function menuButtons(items) {
  var row = [];
  for (var i = 0; i < items.length; i++) row.push({ text: items[i].label, callback_data: 'menu:n:' + items[i].n });
  return [row];
}
function menuText(items) {
  var s = '';
  for (var i = 0; i < items.length; i++) s += items[i].n + '. ' + items[i].label + '\n';
  return s;
}
async function setMenuCtx(env, chatId, cmd, items) {
  try {
    await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind('menu_ctx_' + chatId, JSON.stringify({ cmd: cmd, items: items })).run();
  } catch (e) {}
}
async function getMenuCtx(env, chatId) {
  try {
    const r = await env.D1_DB.prepare("SELECT value FROM settings WHERE key=?").bind('menu_ctx_' + chatId).first();
    if (r && r.value) { const j = JSON.parse(r.value); if (j && Array.isArray(j.items)) return j; }
  } catch (e) {}
  return null;
}
async function execMenuAction(action, chatId, env, msgId) {
  if (!action) { await replyText(chatId, msgId || 0, '❌ 无效选项', env); return; }
  if (action.indexOf('text:') === 0) {
    await replyTextWithKeyboard(chatId, action.slice(5), MAIN_BUTTONS, env);
    return;
  }
  if (action === 'retry_all') return await handleRetryCommand(chatId, env, null, 8);
  if (action === 'retry_recent') return await handleRetryCommand(chatId, env, null, 8);
  if (action === 'unsaved_count' || action === 'pending') return await handlePendingCommand(chatId, env);
  if (action === 'count') return await handleCountCommand(chatId, env);
  if (action === 'stats') return await handleStatsCommand(chatId, env);
  if (action === 'health') return await handleHealthCommand(chatId, env);
  if (action === 'help') { await replyTextWithKeyboard(chatId, DEFAULT_COMMANDS['/help'], MAIN_BUTTONS, env); return; }
  await replyTextWithKeyboard(chatId, '❌ 未知操作：' + action, MAIN_BUTTONS, env);
}
async function replyCommandMenu(chatId, msgId, cmd, resp, items, env) {
  const txt = (resp || ('📋 ' + cmd + ' 菜单')) + '\n\n' + menuText(items) + '\n（回复数字或点击按钮）';
  await replyTextWithKeyboard(chatId, txt, menuButtons(items), env);
  await setMenuCtx(env, chatId, cmd, items);
}

// ==================== AI 管理（function calling） ====================
let _aiCfgCache = null, _aiCfgAt = 0;
async function getAIConfig(env) {
  const now = Date.now();
  if (_aiCfgCache && now - _aiCfgAt < 30000) return _aiCfgCache;
  const out = { enabled: 0, base: 'https://api.deepseek.com', model: 'deepseek-chat', key: '', prompt: '' };
  try {
    const s = await env.D1_DB.prepare("SELECT key, value FROM settings WHERE key IN ('ai_enabled','ai_base','ai_model','ai_api_key','ai_prompt')").all();
    (s.results || []).forEach(function(r) {
      if (r.key === 'ai_enabled') out.enabled = (String(r.value).trim() === '1') ? 1 : 0;
      else if (r.key === 'ai_base') out.base = r.value || out.base;
      else if (r.key === 'ai_model') out.model = r.value || out.model;
      else if (r.key === 'ai_api_key') out.key = r.value || '';
      else if (r.key === 'ai_prompt') out.prompt = r.value || '';
    });
  } catch (e) {}
  _aiCfgCache = out; _aiCfgAt = now;
  return out;
}
async function handleAdminGetAI(env) {
  const c = await getAIConfig(env);
  return json({ ok: true, data: { enabled: c.enabled, base: c.base, model: c.model, api_key: c.key ? String(c.key).slice(0, 4) + '****' : '', has_key: !!c.key, prompt: c.prompt } });
}
async function handleAdminSaveAI(request, env) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const set = function(k, v) {
      return env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(k, v).run();
    };
    if (b.enabled !== undefined) await set('ai_enabled', b.enabled ? '1' : '0');
    if (b.base && String(b.base).trim()) await set('ai_base', String(b.base).trim());
    if (b.model && String(b.model).trim()) await set('ai_model', String(b.model).trim());
    if (b.api_key && String(b.api_key).trim() && String(b.api_key).indexOf('****') === -1) await set('ai_api_key', String(b.api_key).trim());
    if (b.prompt !== undefined) await set('ai_prompt', String(b.prompt).trim());
    _aiCfgCache = null;
    return json({ ok: true, data: { saved: true } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== R2 用量与套餐配额 ====================
// 官方用量：Cloudflare GraphQL Analytics API（r2BucketStorage/r2BucketOperations）
// 需要 secret CF_API_TOKEN（权限：Account.R2 Storage:Read）与 var CF_ACCOUNT_ID
async function cfR2Usage(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return { _err: 'no CF_API_TOKEN or CF_ACCOUNT_ID' };
  const gql = function(q) {
    return fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.CF_API_TOKEN },
      body: JSON.stringify({ query: q })
    }).then(function(r) { return r.json(); });
  };
  const acct = env.CF_ACCOUNT_ID;
  try {
    const endDate = new Date().toISOString();
    const startDate = new Date(Date.now() - 86400000).toISOString();
    // 存储用量（最近 24h 最新一条，payloadSize = 真实存储字节数，与 R2 Dashboard 同源）
    const q1 = 'query { viewer { accounts(filter:{accountTag:"' + acct + '"}) { r2StorageAdaptiveGroups(limit:1, filter:{datetime_geq:"' + startDate + '", datetime_leq:"' + endDate + '", bucketName:"bot-telegram"}) { max { objectCount payloadSize metadataSize uploadCount } } } } }';
    const j1 = await gql(q1);
    if (j1.errors) return { _err: 'storage errors: ' + JSON.stringify(j1.errors).slice(0, 200) };
    const a1 = j1.data && j1.data.viewer && j1.data.viewer.accounts && j1.data.viewer.accounts[0];
    const s = a1 && a1.r2StorageAdaptiveGroups && a1.r2StorageAdaptiveGroups[0];
    const max = s && s.max;
    if (!max || max.payloadSize === undefined) return { _err: 'storage empty: ' + JSON.stringify(j1).slice(0, 200) };
    const out = { storage_bytes: max.payloadSize || 0, object_count: max.objectCount || 0, source: 'cf', ds: 'r2StorageAdaptiveGroups' };
    // 操作数（近 30 天，按 actionType 归入 A/B 类）
    try {
      const s30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const q2 = 'query { viewer { accounts(filter:{accountTag:"' + acct + '"}) { r2OperationsAdaptiveGroups(limit:10000, filter:{datetime_geq:"' + s30 + '", datetime_leq:"' + endDate + '", bucketName:"bot-telegram"}) { sum { requests } dimensions { actionType } } } } }';
      const j2 = await gql(q2);
      const a2 = j2 && j2.data && j2.data.viewer && j2.data.viewer.accounts && j2.data.viewer.accounts[0];
      const groups = (a2 && a2.r2OperationsAdaptiveGroups) || [];
      const classA = ['ListBuckets','PutBucket','ListObjects','PutObject','CopyObject','CompleteMultipartUpload','CreateMultipartUpload','LifecycleStorageTierTransition','ListMultipartUploads','UploadPart','UploadPartCopy','ListParts','PutBucketEncryption','PutBucketCors','PutBucketLifecycleConfiguration'];
      const classB = ['HeadBucket','HeadObject','GetObject','UsageSummary','GetBucketEncryption','GetBucketLocation','GetBucketCors','GetBucketLifecycleConfiguration'];
      let ca = 0, cb = 0;
      for (const g of groups) {
        const act = g.dimensions && g.dimensions.actionType;
        const n = (g.sum && g.sum.requests) || 0;
        if (classA.indexOf(act) >= 0) ca += n;
        else if (classB.indexOf(act) >= 0) cb += n;
      }
      out.class_a = ca; out.class_b = cb;
    } catch (e) {}
    return out;
  } catch (e) { return { _err: 'exception: ' + e.message }; }
}

// 用量预测：今日请求与全天预估、预计达每日配额天数、今日新增文件字节、R2 存储按增速达满预测、14 天请求趋势
async function handleUsageForecast(env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    await ensureTablesOnce(env.D1_DB);
    const dayStr = new Date().toISOString().slice(0, 10);
    const hourNow = new Date().getUTCHours() + 1; // 已过小时数（1-24）
    const t = await env.D1_DB.prepare('SELECT COALESCE(SUM(requests),0) as r FROM worker_stats WHERE day=?').bind(dayStr).first();
    const today = (t && t.r) || 0;
    const quota = 100000;
    const projected = hourNow > 0 ? Math.round(today / hourNow * 24) : today;
    const daysToQuota = projected > 0 ? Math.max(1, Math.floor(quota / projected)) : null;
    const todayStart = dayStr + 'T00:00:00Z';
    const nw = await env.D1_DB.prepare('SELECT COUNT(*) as c, COALESCE(SUM(file_size),0) as s FROM files WHERE deleted_at IS NULL AND created_at>=?').bind(todayStart).first();
    const newFiles = (nw && nw.c) || 0;
    const newBytes = (nw && nw.s) || 0;
    const cap = 10 * 1024 * 1024 * 1024;
    let storageBytes = null, storageRemaining = null;
    try {
      const ru = await handleAdminR2Usage(env);
      const rj = (ru instanceof Response) ? await ru.json() : ru;
      if (rj && rj.ok && rj.data && rj.data.storage_bytes !== undefined) { storageBytes = rj.data.storage_bytes; storageRemaining = rj.data.storage_remaining; }
    } catch (e) {}
    let daysToFull = null;
    if (storageBytes !== null && storageBytes < cap && newBytes > 0) {
      daysToFull = Math.floor((cap - storageBytes) / newBytes);
    }
    const dStart = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
    const hist = await env.D1_DB.prepare('SELECT day, requests FROM worker_stats WHERE day>=? ORDER BY day').bind(dStart).all();
    const map = {};
    (hist.results || []).forEach(function(r) { map[r.day] = r.requests; });
    const trend = [];
    for (let i = 13; i >= 0; i--) {
      const dd = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      trend.push({ day: dd.slice(5), requests: map[dd] || 0 });
    }
    return json({ ok: true, data: { today_requests: today, today_projected: projected, quota: quota, days_to_quota: daysToQuota, new_files: newFiles, new_bytes: newBytes, storage_bytes: storageBytes, storage_remaining: storageRemaining, capacity: cap, days_to_full: daysToFull, trend: trend } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// 官方 Worker 用量：Cloudflare GraphQL Analytics（workersInvocationsAdaptiveGroups）
// 需要 secret CF_API_TOKEN（权限：Account.Workers Analytics:Read）+ var CF_ACCOUNT_ID
async function cfWorkerUsage(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return { _err: 'no CF_API_TOKEN or CF_ACCOUNT_ID' };
  const acct = env.CF_ACCOUNT_ID;
  const gql = function(q) {
    return fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.CF_API_TOKEN },
      body: JSON.stringify({ query: q })
    }).then(function(r) { return r.json(); });
  };
  try {
    const dayStr = new Date().toISOString().slice(0, 10);
    const todayStart = dayStr + 'T00:00:00Z';
    const nowIso = new Date().toISOString();
    const monthStart = dayStr.slice(0, 8) + '01T00:00:00Z';
    const q1 = 'query { viewer { accounts(filter:{accountTag:"' + acct + '"}) { workersInvocationsAdaptiveGroups(limit:1, filter:{datetime_geq:"' + todayStart + '", datetime_leq:"' + nowIso + '"}) { sum { requests errors } quantiles { cpuTime p50 cpuTime p90 } } } } }';
    const j1 = await gql(q1);
    if (j1.errors) return { _err: 'worker errors: ' + JSON.stringify(j1.errors).slice(0, 300) };
    const a1 = j1.data && j1.data.viewer && j1.data.viewer.accounts && j1.data.viewer.accounts[0];
    const g1 = a1 && a1.workersInvocationsAdaptiveGroups && a1.workersInvocationsAdaptiveGroups[0];
    const s1 = g1 && g1.sum;
    if (!s1 || s1.requests === undefined) return { _err: 'worker empty: ' + JSON.stringify(j1).slice(0, 300) };
    const out = {
      today_requests: s1.requests || 0,
      errors_today: s1.errors || 0,
      cpu_p50: g1.quantiles && g1.quantiles.cpuTime ? g1.quantiles.cpuTime.p50 : null,
      cpu_p90: g1.quantiles && g1.quantiles.cpuTime ? g1.quantiles.cpuTime.p90 : null,
      source: 'cf'
    };
    // 本月请求
    try {
      const q2 = 'query { viewer { accounts(filter:{accountTag:"' + acct + '"}) { workersInvocationsAdaptiveGroups(limit:1, filter:{datetime_geq:"' + monthStart + '", datetime_leq:"' + nowIso + '"}) { sum { requests } } } } }';
      const j2 = await gql(q2);
      const a2 = j2.data && j2.data.viewer && j2.data.viewer.accounts && j2.data.viewer.accounts[0];
      const g2 = a2 && a2.workersInvocationsAdaptiveGroups && a2.workersInvocationsAdaptiveGroups[0];
      out.month_requests = (g2 && g2.sum && g2.sum.requests) || 0;
    } catch (e) {}
    return out;
  } catch (e) { return { _err: 'exception: ' + e.message }; }
}

async function handleAdminWorkerUsage(env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const dayStr = new Date().toISOString().slice(0, 10);
    const mStart = dayStr.slice(0, 8) + '01';
    const lt = await env.D1_DB.prepare('SELECT COALESCE(SUM(requests),0) as r FROM worker_stats WHERE day=?').bind(dayStr).first();
    const lm = await env.D1_DB.prepare('SELECT COALESCE(SUM(requests),0) as r FROM worker_stats WHERE day>=?').bind(mStart).first();
    const out = { today_quota: 100000, obs_quota: 200000, local_today: (lt && lt.r) || 0, local_month: (lm && lm.r) || 0 };
    const cf = await cfWorkerUsage(env);
    if (cf && !cf._err && cf.today_requests !== undefined) {
      out.today_requests = cf.today_requests;
      out.month_requests = cf.month_requests !== undefined ? cf.month_requests : out.local_month;
      out.errors_today = cf.errors_today || 0;
      out.cpu_p50 = cf.cpu_p50; out.cpu_p90 = cf.cpu_p90;
      out.source = 'cf';
      out.today_pct = Math.round(cf.today_requests / 100000 * 1000) / 10;
    } else {
      out.today_requests = out.local_today;
      out.month_requests = out.local_month;
      out.source = 'local';
      out.today_pct = Math.round(out.local_today / 100000 * 1000) / 10;
      out.cf_error = cf ? (cf._err || 'cf unavailable') : 'cf unavailable';
    }
    return json({ ok: true, data: out });
  } catch (e) { return json({ ok: false, error: e.message }); }
}
async function handleAdminR2Usage(env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    await ensureTablesOnce(env.D1_DB);
    const s = await env.D1_DB.prepare('SELECT COALESCE(SUM(file_size),0) as s FROM files WHERE deleted_at IS NULL').first();
    const map = {};
    const q = await env.D1_DB.prepare("SELECT key, value FROM settings WHERE key IN ('r2_class_a','r2_class_b','r2_plan')").all();
    (q.results || []).forEach(function(r) { map[r.key] = r.value; });
    const estBytes = (s && s.s) || 0;
    // 拆解估算：代理文件（不入 R2，仅存直链）与去重可省（同 storage_key 多引用）
    const estProxy = await env.D1_DB.prepare("SELECT COUNT(*) as c, COALESCE(SUM(file_size),0) as s FROM files WHERE deleted_at IS NULL AND r2_url LIKE '/file/tg/%'").first();
    const estR2 = await env.D1_DB.prepare("SELECT COUNT(*) as c, COALESCE(SUM(file_size),0) as s FROM files WHERE deleted_at IS NULL AND storage_key!='' AND processing_state='completed'").first();
    const dupRows = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM (SELECT storage_key FROM files WHERE deleted_at IS NULL AND storage_key!='' AND processing_state='completed' GROUP BY storage_key HAVING COUNT(*)>1)").all();
    const dupFileN = (dupRows && dupRows.results && dupRows.results[0]) ? dupRows.results[0].c : 0;
    const localA = parseInt(map.r2_class_a) || 0;
    const localB = parseInt(map.r2_class_b) || 0;
    // 套餐决定配额：free=CF 免费版（10GB 存储 / 100 万 A 类 / 1000 万 B 类）；paid=付费版（不限，0 表示不限）
    const plan = map.r2_plan === 'paid' ? 'paid' : 'free';
    const capacityBytes = plan === 'paid' ? 0 : 10 * 1024 * 1024 * 1024;
    const quotaA = plan === 'paid' ? 0 : 1000000;
    const quotaB = plan === 'paid' ? 0 : 10000000;
    // 优先官方用量，失败回退本地估算（cf_error 保留原因供排查）
    const cf = await cfR2Usage(env);
    const cfOk = cf && !cf._err && cf.storage_bytes !== undefined;
    const storageBytes = cfOk ? cf.storage_bytes : estBytes;
    const classA = (cfOk && cf.class_a !== undefined) ? cf.class_a : localA;
    const classB = (cfOk && cf.class_b !== undefined) ? cf.class_b : localB;
    return json({ ok: true, data: {
      plan: plan,
      storage_bytes: storageBytes,
      storage_estimate: estBytes,
      est_proxy_bytes: (estProxy && estProxy.s) || 0,
      est_proxy_files: (estProxy && estProxy.c) || 0,
      est_r2_files: (estR2 && estR2.c) || 0,
      dup_files: dupFileN,
      object_count: cfOk && cf.object_count !== undefined ? cf.object_count : null,
      storage_source: cfOk ? 'cf' : 'estimate',
      cf_error: cfOk ? '' : ((cf && cf._err) || 'cf unavailable'),
      capacity_bytes: capacityBytes, // 0 = 不限
      storage_pct: capacityBytes ? Math.round(storageBytes / capacityBytes * 1000) / 10 : null,
      storage_remaining: capacityBytes ? Math.max(0, capacityBytes - storageBytes) : -1,
      class_a: classA, class_a_quota: quotaA, // 0 = 不限
      class_a_pct: quotaA ? Math.round(classA / quotaA * 1000) / 10 : null,
      class_b: classB, class_b_quota: quotaB,
      class_b_pct: quotaB ? Math.round(classB / quotaB * 1000) / 10 : null,
      ops_source: (cfOk && cf.class_a !== undefined) ? 'cf' : 'local'
    } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}
async function handleAdminGetR2Quota(env) {
  try {
    const map = {};
    const q = await env.D1_DB.prepare("SELECT key, value FROM settings WHERE key = 'r2_plan'").all();
    (q.results || []).forEach(function(r) { map[r.key] = r.value; });
    const plan = map.r2_plan === 'paid' ? 'paid' : 'free';
    return json({ ok: true, data: { plan: plan, free: { capacity_gb: 10, class_a_quota: 1000000, class_b_quota: 10000000 } } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}
async function handleAdminSaveR2Quota(request, env) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const plan = b.plan === 'paid' ? 'paid' : 'free';
    await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES ('r2_plan',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(plan).run();
    return json({ ok: true, data: { saved: true, plan: plan } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
var AI_TOOLS = [
  { type: 'function', function: { name: 'get_stats', description: '获取图库完整统计（总数、存储、今日新增、未转存、类型分布）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'count_files', description: '查询文件总数', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'unsaved_list', description: '查询未转存文件列表与数量', parameters: { type: 'object', properties: { limit: { type: 'number', description: '显示条数，默认 10' } } } } },
  { type: 'function', function: { name: 'retry_unsaved', description: '触发未转存文件重试转存（下载并上传到 R2）', parameters: { type: 'object', properties: { limit: { type: 'number', description: '重试条数，默认 8，最大 10' } } } } },
  { type: 'function', function: { name: 'search_files', description: '按关键字搜索已入库文件（文件名/标签/编号/说明）', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '搜索关键字' }, limit: { type: 'number', description: '显示条数，默认 10' } }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'get_file', description: '按 ID 查询单个文件信息（状态、大小、标签、链接）', parameters: { type: 'object', properties: { id: { type: 'number', description: '文件 id' } }, required: ['id'] } } }
];
// AI 对话（function calling 循环，最多 3 轮工具调用），返回 {ok,text} 或 {ok:false,error}
async function aiComplete(env, userText) {
  const cfg = await getAIConfig(env);
  if (cfg.enabled !== 1 || !cfg.key) return { ok: false, error: 'AI 未开启或未配置 API Key' };
  const sys = cfg.prompt || '你是 Telegram 图库管理助手。用户会用中文提问，请调用工具获取真实数据后简洁回答；需要重试/转存时调用工具并说明已触发。不要编造数据。';
  const msgs = [{ role: 'system', content: sys }, { role: 'user', content: String(userText || '').slice(0, 2000) }];
  for (let round = 0; round < 3; round++) {
    const resp = await fetchAI(cfg, msgs);
    if (!resp) return { ok: false, error: 'AI 服务调用失败，请检查后台 AI 配置（Base/Key/模型）' };
    if (resp._err) {
      let msg = 'AI 服务调用失败：' + resp._err;
      if (resp._err.indexOf('HTTP 429') === 0) msg += '（请求过于频繁被限流，请稍等 30-60 秒再试；持续出现建议更换更稳定的 AI 服务商）';
      return { ok: false, error: msg };
    }
    const choice = resp.choices && resp.choices[0];
    const m = choice && choice.message;
    if (!m) return { ok: false, error: 'AI 返回异常' };
    if (m.tool_calls && m.tool_calls.length) {
      msgs.push(m);
      for (const tc of m.tool_calls) {
        let result = '';
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          result = await aiRunTool(tc.function.name, args, env);
        } catch (e) { result = 'error: ' + e.message; }
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      continue;
    }
    return { ok: true, text: m.content || '' };
  }
  return { ok: false, error: 'AI 工具调用次数超限' };
}
// AI 消息自动响应节流：同 chat 5 秒冷却（防刷屏/连续触发导致服务商限流 429）
var AI_THROTTLE = {};
function aiThrottled(chatId) {
  const now = Date.now();
  const last = AI_THROTTLE[chatId] || 0;
  if (now - last < 5000) return true;
  AI_THROTTLE[chatId] = now;
  return false;
}
async function callAIManage(chatId, msgId, text, env) {
  if (aiThrottled(chatId)) return; // 冷却期内忽略新的自动 AI 响应（后台测试/浮窗不受影响）
  const r = await aiComplete(env, text);
  if (!r.ok) {
    await replyText(chatId, msgId, '❌ ' + r.error, env);
    return;
  }
  const finalText = r.text || '（AI 无回复，请稍后再试）';
  const parts = finalText.match(/[\s\S]{1,3800}/g) || [finalText];
  for (const pt of parts) await replyTextPlain(chatId, msgId, pt, env);
}
// 后台测试：先验证 AI 可用（具体错误直接返回前端），成功再把 AI 回复发到目标 chat
async function handleAdminTestAI(request, env) {
  try {
    const cfg = await getAIConfig(env);
    if (cfg.enabled !== 1 || !cfg.key) return json({ ok: false, error: 'AI 未开启或未配置 API Key' });
    const b = await request.json().catch(function(){ return {}; });
    const chatId = String(b.chat_id || '').trim();
    if (!chatId) return json({ ok: false, error: '缺少 chat_id（测试目标）' });
    const r = await aiComplete(env, '测试消息：请用一句话介绍你自己，并说明你可以帮管理员做什么。');
    if (!r.ok) return json({ ok: false, error: r.error }); // 透传具体错误（HTTP 状态码/模型/配额问题）
    if (env.TG_BOT_TOKEN && r.text) {
      const parts = String(r.text).match(/[\s\S]{1,3800}/g) || [r.text];
      for (const pt of parts) await replyTextPlain(chatId, 0, pt, env);
    }
    return json({ ok: true, data: { sent: true, chat_id: chatId } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
// 后台 AI 浮窗问答：返回 AI 回复文本
async function handleAdminAskAI(request, env) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const q = String(b.question || '').trim();
    if (!q) return json({ ok: false, error: '缺少问题' });
    const r = await aiComplete(env, q);
    if (!r.ok) return json({ ok: false, error: r.error });
    return json({ ok: true, data: { text: r.text } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
async function fetchAI(cfg, msgs) {
  const url = (cfg.base || 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions';
  const body = JSON.stringify({ model: cfg.model || 'deepseek-chat', messages: msgs, tools: AI_TOOLS, tool_choice: 'auto' });
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key };
  // 429（含 Cloudflare 1015 限流）/5xx：退避重试（1s、3s），应对瞬时限流
  const delays = [1000, 3000];
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: headers, body: body });
      if (!r.ok) {
        const tb = String(await r.text()).slice(0, 220);
        if ((r.status === 429 || r.status >= 500) && attempt < delays.length) {
          const d = delays[attempt];
          console.log('ai retry ' + r.status + ' in ' + d + 'ms');
          await new Promise(function(res) { setTimeout(res, d); });
          continue;
        }
        console.log('ai http:', r.status, tb);
        return { _err: 'HTTP ' + r.status + ' ' + tb };
      }
      return await r.json();
    } catch (e) {
      if (attempt < delays.length) { await new Promise(function(res) { setTimeout(res, delays[attempt]); }); continue; }
      console.log('ai fetch:', e.message);
      return { _err: '网络错误 ' + e.message };
    }
  }
}
async function aiRunTool(name, args, env) {
  if (name === 'get_stats') return await aiGetStatsText(env);
  if (name === 'count_files') return '文件总数: ' + (await aiCountFiles(env));
  if (name === 'unsaved_list') return await aiUnsavedText(env, args.limit || 10);
  if (name === 'retry_unsaved') { const n = await triggerRetryN(env, args.limit || 8); return '已触发 ' + n + ' 条未转存文件开始重试转存'; }
  if (name === 'search_files') return await aiSearchText(env, args.keyword || '', args.limit || 10);
  if (name === 'get_file') return await aiFileText(env, parseInt(args.id) || 0);
  return 'unknown tool: ' + name;
}
async function aiCountFiles(env) {
  try { const t = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first(); return t?.c || 0; } catch (e) { return 0; }
}
async function aiGetStatsText(env) {
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first();
    const s = await env.D1_DB.prepare('SELECT SUM(file_size) as s FROM files WHERE deleted_at IS NULL').first();
    const td = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=date('now')").first();
    const bt = await env.D1_DB.prepare('SELECT file_type, COUNT(*) as c FROM files WHERE deleted_at IS NULL GROUP BY file_type').all();
    const un = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND processing_state != 'completed'").first();
    let s2 = '📊 图库统计\n· 文件总数: ' + (t?.c || 0) + '\n· 占用存储: ' + fmtSize(s?.s || 0) + '\n· 今日新增: ' + (td?.c || 0) + '\n· 未转存: ' + (un?.c || 0);
    if (bt.results && bt.results.length) {
      s2 += '\n类型分布:';
      for (const r of bt.results) s2 += '\n· ' + r.file_type + ': ' + r.c;
    }
    return s2;
  } catch (e) { return '统计失败: ' + e.message; }
}
async function aiUnsavedText(env, limit) {
  try {
    await env.D1_DB.prepare("UPDATE files SET processing_state='failed' WHERE processing_state IN ('downloading','hashing','uploading','saving') AND deleted_at IS NULL AND julianday(created_at) < julianday('now','-30 minutes')").run();
  } catch (e) {}
  try {
    const n = Math.min(parseInt(limit) || 10, 15);
    const t = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND processing_state != 'completed'").first();
    const d = await env.D1_DB.prepare("SELECT id, file_name, processing_state, group_ref FROM files WHERE deleted_at IS NULL AND processing_state != 'completed' ORDER BY id DESC LIMIT ?").bind(n).all();
    if ((d.results || []).length === 0) return '未转存: 0 条，全部已完成 ✓';
    let s = '⏳ 未转存 ' + (t?.c || 0) + ' 条（显示前 ' + (d.results || []).length + ' 条）：\n';
    (d.results || []).forEach(function(r) { s += '· #' + (r.group_ref || r.id) + ' ' + (r.file_name || '') + ' [' + r.processing_state + ']\n'; });
    return s;
  } catch (e) { return '查询失败: ' + e.message; }
}
async function aiSearchText(env, kw, limit) {
  try {
    const n = Math.min(parseInt(limit) || 10, 15);
    const k = '%' + kw + '%';
    const d = await env.D1_DB.prepare("SELECT id, file_name, file_type, group_ref FROM files WHERE deleted_at IS NULL AND processing_state='completed' AND (file_name LIKE ? OR caption LIKE ? OR group_ref LIKE ? OR tags LIKE ?) ORDER BY id DESC LIMIT ?").bind(k, k, k, k, n).all();
    if (!(d.results || []).length) return '未找到「' + kw + '」相关文件';
    let s = '🔍 「' + kw + '」结果 ' + (d.results || []).length + ' 条：\n';
    (d.results || []).forEach(function(r) { s += '· #' + (r.group_ref || r.id) + ' ' + (r.file_name || '') + ' (' + r.file_type + ')\n'; });
    return s;
  } catch (e) { return '搜索失败: ' + e.message; }
}
async function aiFileText(env, id) {
  try {
    const f = await env.D1_DB.prepare("SELECT * FROM files WHERE id=? AND deleted_at IS NULL").bind(id).first();
    if (!f) return '未找到 id=' + id;
    const realR2 = f.r2_url && f.r2_url.indexOf('/file/tg/') !== 0;
    return '#' + (f.group_ref || f.id) + ' ' + (f.file_name || '') + '\n类型: ' + (f.file_type || '') + ' | 大小: ' + fmtSize(f.file_size || 0) + '\n状态: ' + (f.processing_state || '') + '\n标签: ' + (f.tags || '（无）') + '\n链接: ' + (realR2 ? f.r2_url : '（未转存，代理: https://telegram-r2-bot.wo58.cn/file/tg/' + f.id + '.' + fileExtOf(f.file_name, f.file_type) + '）');
  } catch (e) { return '查询失败: ' + e.message; }
}
async function triggerRetryN(env, n) {
  try {
    const fakeReq = { json: function() { return Promise.resolve({ all: true, limit: n }); } };
    const r = await handleUnsavedRetry(fakeReq, env);
    return (r && r.started) || 0;
  } catch (e) { return 0; }
}

async function handleBotCommand(chatId, msgId, text, env, waitFn) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  // Check custom commands in DB
  if (env.D1_DB) {
    try {
      const custom = await env.D1_DB.prepare('SELECT response, enabled, menu FROM bot_commands WHERE command = ?').bind(cmd).first();
      if (custom && custom.enabled) {
        const citems = parseMenu(custom.menu);
        if (citems.length) {
          await replyCommandMenu(chatId, msgId, cmd, custom.response, citems, env);
          return { ok: true, custom: true, menu: true };
        }
        if (custom.response === '__STATS__') {
          return await handleStatsCommand(chatId, env);
        }
        await replyText(chatId, msgId, custom.response, env);
        return { ok: true, custom: true };
      }
    } catch (e) {}
  }

  // Built-in commands
  if (cmd === '/start' || cmd === '/help') {
    const helpText = cmd === '/start' ? DEFAULT_COMMANDS['/start'] : DEFAULT_COMMANDS['/help'];
    await replyTextWithKeyboard(chatId, helpText, MAIN_BUTTONS, env);
    return { ok: true };
  }

  if (cmd === '/stats') {
    return await handleStatsCommand(chatId, env);
  }

  if (cmd === '/file') {
    if (!args || isNaN(args)) {
      await replyText(chatId, msgId, 'Usage: /file <id>\nExample: /file 123', env);
      return { ok: true };
    }
    return await handleFileCommand(chatId, msgId, parseInt(args), env);
  }

  if (cmd === '/search') {
    if (!args) {
      await replyText(chatId, msgId, 'Usage: /search <keyword>\nExample: /search cat', env);
      return { ok: true };
    }
    return await handleSearchCommand(chatId, msgId, args, env);
  }

  if (cmd === '/count') {
    return await handleCountCommand(chatId, env);
  }

  if (cmd === '/pending') {
    return await handlePendingCommand(chatId, env);
  }

  if (cmd === '/retry') {
    // 数字菜单交互：1=重试全部 2=重试最近 8 条 3=查看未转存（也可在后台自定义该命令的菜单）
    const items = [
      { n: 1, label: '🔄 重试全部未转存', action: 'retry_all' },
      { n: 2, label: '🕒 重试 8 条未转存', action: 'retry_recent' },
      { n: 3, label: '⏳ 查看未转存数量', action: 'unsaved_count' }
    ];
    await replyCommandMenu(chatId, msgId, cmd, '🔄 未转存重试，请选择：', items, env);
    return { ok: true };
  }

  if (cmd === '/health') {
    return await handleHealthCommand(chatId, env);
  }

  return null; // Not a command
}

// 命令：查询现有数量（中文版）
async function handleCountCommand(chatId, env) {
  if (!env.D1_DB) { await replyText(chatId, 0, '❌ D1 未配置', env); return { ok: true }; }
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first();
    const s = await env.D1_DB.prepare('SELECT SUM(file_size) as s FROM files WHERE deleted_at IS NULL').first();
    const td = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=date('now')").first();
    const comp = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND processing_state='completed'").first();
    const byType = await env.D1_DB.prepare('SELECT file_type, COUNT(*) as c FROM files WHERE deleted_at IS NULL GROUP BY file_type').all();
    let text = '📊 **现有数量**\n\n文件总数: **' + (t?.c || 0) + '**（含未转存）\n已转存: **' + (comp?.c || 0) + '** / ' + (t?.c || 0) + '\n未转存: ' + ((t?.c || 0) - (comp?.c || 0)) + '\n总大小: ' + fmtSize(s?.s || 0) + '\n今日新增: ' + (td?.c || 0) + '\n';
    if (byType.results && byType.results.length) {
      const names = { photo: '图片', video: '视频', document: '文档', audio: '音频', voice: '语音' };
      text += '\n类型分布:\n';
      for (const r of byType.results) text += '· ' + (names[r.file_type] || r.file_type) + ': ' + r.c + '\n';
    }
    await replyTextWithKeyboard(chatId, text, MAIN_BUTTONS, env);
    return { ok: true };
  } catch (e) { await replyText(chatId, 0, '❌ ' + e.message, env); return { ok: true }; }
}

// 命令：查询未转存数量
async function handlePendingCommand(chatId, env) {
  if (!env.D1_DB) { await replyText(chatId, 0, '❌ D1 未配置', env); return { ok: true }; }
  try {
    const t = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND processing_state != 'completed'").first();
    const byState = await env.D1_DB.prepare("SELECT processing_state, COUNT(*) as c FROM files WHERE deleted_at IS NULL AND processing_state != 'completed' GROUP BY processing_state").all();
    let text = '⏳ **未转存统计**\n\n未完成总数: **' + (t?.c || 0) + '**\n';
    if (byState.results && byState.results.length) {
      const names = { pending: '待转存', downloading: '下载中', uploading: '上传中', failed: '失败' };
      for (const r of byState.results) text += '· ' + (names[r.processing_state] || r.processing_state) + ': ' + r.c + '\n';
    }
    if ((t?.c || 0) > 0) text += '\n发送 /retry 可继续完成转存';
    await replyTextWithKeyboard(chatId, text, MAIN_BUTTONS, env);
    return { ok: true };
  } catch (e) { await replyText(chatId, 0, '❌ ' + e.message, env); return { ok: true }; }
}

// 命令：继续完成未转存入库（默认批 8 条，限频 60s；limit 由菜单选项传入）
var lastRetryCmdTs = 0;
async function handleRetryCommand(chatId, env, waitFn, limit) {
  const now = Date.now();
  if (now - lastRetryCmdTs < 60000) {
    await replyText(chatId, 0, '⏳ 60 秒内已执行过，请稍后再试（' + Math.ceil((60000 - (now - lastRetryCmdTs)) / 1000) + 's）', env);
    return { ok: true };
  }
  lastRetryCmdTs = now;
  if (!env.D1_DB) { await replyText(chatId, 0, '❌ D1 未配置', env); return { ok: true }; }
  try {
    const fakeReq = { json: function() { return Promise.resolve({ all: true, limit: limit || 8 }); } };
    const r = await handleUnsavedRetry(fakeReq, env, { waitUntil: waitFn });
    if (r && r.ok) {
      await replyTextWithKeyboard(chatId, '🚀 已开始转存 ' + (r.started || 0) + ' 条。剩余可稍后再点「继续转存」（60s 后）或在后台「未转存」页手动处理。', MAIN_BUTTONS, env);
    } else {
      await replyTextWithKeyboard(chatId, '❌ 触发失败: ' + ((r && r.error) || 'unknown'), MAIN_BUTTONS, env);
    }
  } catch (e) { await replyTextWithKeyboard(chatId, '❌ ' + e.message, MAIN_BUTTONS, env); }
  return { ok: true };
}

// 命令：服务状态
async function handleHealthCommand(chatId, env) {
  let lines = ['🛰 **服务状态**'];
  lines.push('· Worker 版本: v6');
  if (env.D1_DB) {
    try { const c = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files').first(); lines.push('· 数据库 D1: ✅ 正常（' + (c?.c || 0) + ' 条）'); }
    catch (e) { lines.push('· 数据库 D1: ❌ ' + e.message); }
  } else lines.push('· 数据库 D1: ⚠️ 未绑定');
  lines.push('· 存储 R2: ' + (env.R2_BUCKET ? '✅ 已绑定' : '⚠️ 未绑定'));
  if (env.TG_BOT_TOKEN) {
    try {
      const w = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getWebhookInfo', { method: 'POST' });
      const j = await w.json();
      const r = (j && j.result) || {};
      lines.push('· Webhook: ' + (r.url ? '✅ ' + r.url : '⚠️ 未设置') + '（积压 ' + (r.pending_update_count || 0) + ' 条）');
      if (r.last_error_message) lines.push('· 最近错误: ' + String(r.last_error_message).slice(0, 80));
    } catch (e) { lines.push('· Webhook: ❌ ' + e.message); }
  } else lines.push('· Webhook: ⚠️ 无 token');
  lines.push('· 大文件支持: ' + ((env.TG_API_BASE || env.TG_API_BASE_2) ? '✅ 本地 Bot API（无 20MB 限制）' : '⚠️ 官方 API（>20MB 无法转存）'));
  await replyTextWithKeyboard(chatId, lines.join('\n'), MAIN_BUTTONS, env);
  return { ok: true };
}

async function handleStatsCommand(chatId, env) {
  if (!env.D1_DB) { await replyText(chatId, 0, '�?D1 not configured', env); return { ok: true }; }
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first();
    const s = await env.D1_DB.prepare('SELECT SUM(file_size) as s FROM files WHERE deleted_at IS NULL').first();
    const td = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=date('now')").first();
    const byType = await env.D1_DB.prepare('SELECT file_type, COUNT(*) as c FROM files WHERE deleted_at IS NULL GROUP BY file_type').all();
    const topChat = await env.D1_DB.prepare('SELECT chat_title, COUNT(*) as c FROM files WHERE deleted_at IS NULL GROUP BY chat_title ORDER BY c DESC LIMIT 3').all();

    let text = '📊 **Statistics**\n\n';
    text += `📁 Total files: ${t?.c || 0}\n`;
    text += `💾 Storage: ${fmtSize(s?.s || 0)}\n`;
    text += `📅 Today: ${td?.c || 0}\n\n`;

    if (byType.results?.length) {
      text += '**By type:**\n';
      for (const r of byType.results) text += `  ${r.file_type}: ${r.c}\n`;
    }
    if (topChat.results?.length) {
      text += '\n**Top groups:**\n';
      for (const r of topChat.results) text += `  ${r.chat_title}: ${r.c}\n`;
    }
    await replyTextWithKeyboard(chatId, text, MAIN_BUTTONS, env);
    return { ok: true };
  } catch (e) {
    await replyText(chatId, 0, '�?Stats error: ' + e.message, env);
    return { ok: true };
  }
}

async function handleFileCommand(chatId, msgId, fileId, env) {
  if (!env.D1_DB) { await replyText(chatId, msgId, '�?D1 not configured', env); return { ok: true }; }
  try {
    const f = await env.D1_DB.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').bind(fileId).first();
    if (!f) { await replyText(chatId, msgId, '�?File not found', env); return { ok: true }; }

    const ic = { photo: '🖼', document: '📄', video: '🎬', audio: '🎵', voice: '🎤' };
    let text = `${ic[f.file_type] || '📁'} **File #${f.id}**\n\n`;
    text += `Name: ${f.file_name}\n`;
    text += `Type: ${f.file_type}\n`;
    text += `Size: ${fmtSize(f.file_size)}\n`;
    text += `Group: ${f.chat_title}\n`;
    text += `User: ${f.username || f.full_name}\n`;
    text += `Date: ${f.created_at}\n`;
    if (f.caption) text += `Caption: ${f.caption}\n`;
    text += `\n🔗 ${f.r2_url}`;

    await replyText(chatId, msgId, text, env);
    return { ok: true };
  } catch (e) {
    await replyText(chatId, msgId, '�?Error: ' + e.message, env);
    return { ok: true };
  }
}

async function handleSearchCommand(chatId, msgId, keyword, env) {
  if (!env.D1_DB) { await replyText(chatId, msgId, '�?D1 not configured', env); return { ok: true }; }
  try {
    const lk = '%' + keyword + '%';
    const d = await env.D1_DB.prepare(
      'SELECT id, file_name, file_type, file_size, chat_title, r2_url FROM files WHERE (file_name LIKE ? OR caption LIKE ? OR chat_title LIKE ?) AND deleted_at IS NULL ORDER BY id DESC LIMIT 5'
    ).bind(lk, lk, lk).all();

    if (!d.results?.length) {
      await replyText(chatId, msgId, `🔍 No results for "${keyword}"`, env);
      return { ok: true };
    }

    let text = `🔍 **Search: "${keyword}"** (${d.results.length} results)\n\n`;
    for (const f of d.results) {
      const ic = { photo: '🖼', document: '📄', video: '🎬', audio: '🎵' };
      text += `${ic[f.file_type] || '📁'} #${f.id} ${f.file_name} (${fmtSize(f.file_size)})\n`;
      text += `   ${f.chat_title} �?${f.r2_url}\n\n`;
    }
    await replyText(chatId, msgId, text, env);
    return { ok: true };
  } catch (e) {
    await replyText(chatId, msgId, '�?Error: ' + e.message, env);
    return { ok: true };
  }
}

// ==================== WEBHOOK ====================

async function handleWebhook(request, env) {
  try {
    if (env.D1_DB) await ensureTablesOnce(env.D1_DB);
    const body = await request.text();
    const update = JSON.parse(body);
    const st = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (env.TG_SECRET && st !== env.TG_SECRET) return json({ error: 'Forbidden' }, 403);
    const r = await processUpdateCore(update, env, function(p) { return request.waitUntil(p); });
    return json(r);
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 防止 webhook 丢失（曾发生 webhook 被清空导致 164 条消息积压）：cron 每次检查并自动恢复
async function ensureWebhook(env, ctx) {
  if (!env.TG_BOT_TOKEN) return;
  const url = 'https://telegram-r2-bot.wo58.cn/webhook';
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getWebhookInfo', { method: 'POST' });
    const j = await r.json();
    if (j && j.ok && j.result && j.result.url === url) return;
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/setWebhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    });
  } catch (e) { console.error('ensureWebhook:', e.message); }
}

// Shared: handle one update from webhook or getUpdates polling
async function processUpdateCore(update, env, waitFn) {
  // 点击按钮回调（inline keyboard）
  if (update.callback_query) {
    return await handleCallbackQuery(update.callback_query, env);
  }
  const msg = update.message || update.channel_post;
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
        try {
          const r = await env.D1_DB.prepare(
            'INSERT INTO files (storage_key,r2_url,md5_hash,processing_state,chat_id,chat_title,chat_type,chat_username,user_id,username,full_name,telegram_file_id,file_name,file_size,file_type,mime_type,width,height,caption,message_id,created_at,group_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
          ).bind(tempKey, '', '', 'downloading', chatId, chat.title || chat.username || chatId, chat.type || '', chat.username || '', from.id || 0, from.username || '', [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown', fi.fileId, fi.fileName, fi.fileSize, fi.type, '', fi.width, fi.height, msg.caption || '', msgId, date.toISOString(), ref).run();
          rid = r.meta?.last_row_id;
        } catch (e) { console.error('D1 pending:', e.message); }
      }
      // 代理模式：≤20MB 不转存 R2，r2_url 存 /file/tg/<id>，访问时 worker 实时拉 TG 直链（省 R2 存储）
      if (rid && (await getProxyMode(env)) === 1 && (fi.fileSize || 0) <= 20 * 1024 * 1024) {
        try {
          // 代理 URL 带后缀名（如 /file/tg/123.jpg），方便识别类型/下载文件名
          await env.D1_DB.prepare("UPDATE files SET r2_url=?, storage_key='', processing_state='completed', progress_bytes=0, total_bytes=? WHERE id=?").bind('/file/tg/' + rid + '.' + fileExtOf(fi.fileName, fi.type), fi.fileSize || 0, rid).run();
        } catch (e) { console.error('proxy mark:', e.message); }
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
        } catch (e) { console.error('queue send:', e.message); }
      }
      const p = processFileAsync(rid, fi, chatId, msgId, chat, from, date, env, ref || '').catch(e => console.error('async:', e.message));
      if (waitFn) waitFn(p); else p;
      return { ok: true, queued: true, fileId: rid };
    }
  }

  // X (Twitter) status links: parse via public syndication API, download media from twimg CDN
  if (msg.text && isXLink(msg.text)) {
    const xlink = extractXStatus(msg.text);
    if (xlink) {
      const chatId = String(msg.chat.id);
      const msgId = String(msg.message_id);
      const date = msg.date ? new Date(msg.date * 1000) : new Date();
      const p = handleXStatusAsync(xlink, chatId, msgId, date, env).catch(e => console.error('x async:', e.message));
      if (waitFn) waitFn(p); else p;
      return { ok: true, queued: true, xlink: true };
    }
  }

  // Short-video share links (douyin/kuaishou/redbook/bilibili...): parse via parse-video service, then download & store
  if (msg.text && isShareLink(msg.text)) {
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
        } catch (e) { console.error('D1 share pending:', e.message); }
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
        } catch (e) { console.error('queue send (share):', e.message); }
      }
      const p = processShareLinkAsync(rid, shareLink, chatId, msgId, chat, from, date, env).catch(e => console.error('share async:', e.message));
      if (waitFn) waitFn(p); else p;
      return { ok: true, queued: true, fileId: rid };
    }
  }

  // Non-file messages: process synchronously
  return await processUpdate(update, env, waitFn);
}

// Poll getUpdates from the configured Bot API (must be Local Bot API to get Local file_ids)
async function handlePollUpdates(env, ctx) {
  if (!env.D1_DB) return;
  try { await ensureTablesOnce(env.D1_DB); } catch (e) {}
  const bases = tgApiBases(env);
  let lastErr = '';
  for (var i = 0; i < bases.length; i++) {
    const base = bases[i];
    try {
      let offset = 0;
      try { const s = await env.D1_DB.prepare('SELECT value FROM settings WHERE key=?').bind('tg_update_offset').first(); if (s) offset = parseInt(s.value) || 0; } catch (e) {}
      const r = await fetch(base + '/bot' + env.TG_BOT_TOKEN + '/getUpdates?timeout=2&limit=10&offset=' + offset);
      const j = await r.json();
      if (!j.ok) { lastErr = 'getUpdates: ' + (j.description || 'fail') + ' @' + base; console.log('poll getUpdates fail @' + base + ':', JSON.stringify(j).slice(0, 150)); continue; }
      if (j.result && j.result.length) {
        let maxId = offset;
        let lastOk = offset;
        for (const u of j.result) {
          if (u.update_id > maxId) maxId = u.update_id;
          try { await processUpdateCore(u, env, ctx ? function(p) { return ctx.waitUntil(p); } : null); lastOk = u.update_id; }
          catch (e) { console.error('poll update:', e.message); break; } // do not advance past a failed update; Telegram will re-deliver
        }
        try { await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES ('tg_update_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(lastOk)).run(); } catch (e) {}
      }
      return;
    } catch (e) { lastErr = e.message; console.error('poll error @' + base + ':', e.message); }
  }
  if (lastErr) console.log('handlePollUpdates all failed:', lastErr);
}

// Manual /admin/api/poll endpoint
async function handlePollEndpoint(env) {
  try {
    await handlePollUpdates(env, { waitUntil: function(p) { return p; } });
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// Async file processing with progress tracking
var LARGE_FILE_THRESHOLD = 50 * 1024 * 1024; // 50MB: stream instead of buffer
var OFFICIAL_API = 'https://api.telegram.org'; // official cloud Bot API
var OFFICIAL_MAX = 20 * 1024 * 1024; // official Bot API getFile/download limit: 20MB

// Global concurrency limiter for transfers: 100+ parallel downloads will
// swamp Telegram's bandwidth and hit Cloudflare subrequest limits, making
// every file slower. Cap active transfers so the queue drains steadily.
var MAX_CONCURRENT_TRANSFERS = 6;
var activeTransfers = 0;
var transferWaiters = [];
function acquireTransferSlot() {
  if (activeTransfers < MAX_CONCURRENT_TRANSFERS) {
    activeTransfers++;
    return Promise.resolve();
  }
  return new Promise(function(res) { transferWaiters.push(res); });
}
function releaseTransferSlot() {
  activeTransfers--;
  var next = transferWaiters.shift();
  if (next) next();
}

// ---- Short-video share link support (parse-video service) ----
// Matches share links of common short-video platforms (douyin/kuaishou/redbook/bilibili/weibo/qq...)
var SHARE_DOMAIN_RE = /(?:^|[^a-z0-9])(https?:\/\/[a-z0-9.-]+\.(?:douyin\.com|kuaishou\.com|gifshow\.com|xhslink\.com|xiaohongshu\.com|b23\.tv|bilibili\.com|weibo\.com|weibo\.cn|qq\.com|ixigua\.com|pipix\.com|huoshan\.com|pearvideo\.com|sohu\.com|163\.com|youku\.com|meipai\.com|6\.cn)[^\s'"<>]*)/i;

function isShareLink(text) {
  return SHARE_DOMAIN_RE.test(text || '');
}

function extractShareLink(text) {
  var m = SHARE_DOMAIN_RE.exec(text || '');
  return m ? m[1] : '';
}

// ---- X (Twitter) status link support ----
// Parses via Twitter's public syndication endpoint (no auth, CORS-friendly), then downloads
// media straight from twimg CDN. Unlike Telegram's Bot API there is NO 20MB limit here.
var X_STATUS_RE = /(?:^|[^a-z0-9])(https?:\/\/(?:x\.com|twitter\.com)\/[^\s'"<>]*?\/status\/\d+[^\s'"<>]*)/i;

function isXLink(text) {
  return X_STATUS_RE.test(text || '');
}

function extractXStatus(text) {
  var m = X_STATUS_RE.exec(text || '');
  return m ? m[1] : '';
}

function xTweetId(link) {
  var m = /status\/(\d+)/.exec(link || '');
  return m ? m[1] : '';
}

async function handleXStatusAsync(link, chatId, msgId, date, env) {
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
          } catch (e) { console.log('x d1 insert fail:', e.message); }
        }
      } catch (e) { console.log('x media save fail:', e.message); }
    }
    if (saved.length) {
      await xreply('✅ X 内容已保存（' + saved.length + ' 个）\n' + saved.join('\n'));
    } else {
      await xreply('❌ X 内容下载失败');
    }
  } catch (e) {
    console.error('handleXStatusAsync:', e.message);
    try { await xreply('❌ X 解析失败：' + String(e.message).slice(0, 100)); } catch (e2) {}
  }
}

// Parse a share link via the self-hosted parse-video service, download the watermarked-off video to R2
async function processShareLinkAsync(dbId, link, chatId, msgId, chat, from, date, env) {
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
      console.log('share parse fail:', link, em);
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
        } catch (e) { console.error('D1 share update:', e.message); }
      }
      try {
        var replyTextP = '\uD83D\uDCF9 \u89C6\u9891\u76F4\u94FE\u5DF2\u751F\u6210\uff08\u6BCF\u6B21\u8BBF\u95EE\u5B9E\u65F6\u89E3\u6790\uff0C\u6C38\u4E0D\u8FC7\u671F\uff09\n' + titleP + '\n' + proxyUrl + '\n\u2192 \u70B9\u51FB\u64AD\u653E\uff1B\u76F4\u63A5\u4E0B\u8F7D\u53EF\u52A0\uff1a&mode=proxy';
        await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: replyTextP, disable_web_page_preview: false })
        });
      } catch (e) { console.error('share reply:', e.message); }
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
      } catch (e) { console.log('share retry fail:', e.message); }
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
      } catch (e) { console.error('D1 share update:', e.message); }
    }
    try {
      var replyText = '\uD83D\uDCF9 视频已保存\n' + title + '\n' + url;
      await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: replyText, disable_web_page_preview: false })
      });
    } catch (e) { console.error('share reply:', e.message); }
  } catch (e) {
    console.error('processShareLinkAsync:', e.message);
    await updateState('failed', e.message);
  } finally {
    releaseTransferSlot();
  }
}

async function processFileAsync(dbId, fi, chatId, msgId, chat, from, date, env, ref) {
  async function updateState(state, err) {
    if (env.D1_DB && dbId) {
      try { await env.D1_DB.prepare('UPDATE files SET processing_state=?, error_msg=? WHERE id=?').bind(state, err || '', dbId).run(); } catch(e) {}
    }
    if (state === 'failed' && err) {
      var f = null;
      try { f = await env.D1_DB.prepare('SELECT file_name, chat_title FROM files WHERE id=?').bind(dbId).first(); } catch (e) {}
      notifyAdmin(env, '转存失败: ' + ((f && f.file_name) || dbId) + ((f && f.chat_title) ? ' | ' + f.chat_title : '') + '\n' + String(err).slice(0, 300));
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
          await replyMsg(chatId, parseInt(msgId), fi, dup.r2_url, env, rr1 || ref || String(dbIdNum));
          return;
        }
      } catch (e) { console.log('file_id dedup check fail:', e.message); }
    }

    var isLarge = (fi.fileSize || 0) > LARGE_FILE_THRESHOLD;
    var key = null, url = null, md5 = '', ct = '', tgUrl = '', thumbUrl = '', quickHash = '';
    var uploadedNew = false;

    if (isLarge) {
      // Large file: stream from Telegram directly to R2 (no memory buffering, no MD5 dedup)
      await updateProgress('downloading', 0, fi.fileSize || 0);
      console.log('large file queue: id=' + dbId + ' fileId=' + fi.fileId + ' size=' + fi.fileSize);
      const fd = await dlFileStream(fi.fileId, env.TG_BOT_TOKEN, tgApiBases(env));
      if (!fd || fd.error) { console.log('large file download failed, dbId=' + dbId + (fd && fd.error ? ' err=' + fd.error : '')); await updateState('failed', (fd && fd.error) || 'download_failed'); return; }
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
        } catch (e2) { console.log('large retry fail:', e2.message); }
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
        if (!fd || fd.error) { console.log('photo download failed, dbId=' + dbId + (fd && fd.error ? ' err=' + fd.error : '')); await updateState('failed', (fd && fd.error) || 'download_failed'); return; }
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
          } catch (e2) { console.log('photo retry fail:', e2.message); }
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
          } catch (e) { console.log('quickhash dedup fail:', e.message); }
        }
      } else {
        // Other types (document/audio/video <=50MB): buffer + MD5 dedup
        await updateProgress('downloading', 0, fi.fileSize || 0);
        const fd = await dlFileLarger(fi.fileId, fi.fileSize, env.TG_BOT_TOKEN, bases, function(bytes) {
          updateProgress('downloading', bytes, fi.fileSize || 0).catch(function(){});
        });
        if (!fd || fd.error) { console.log('medium file download failed, dbId=' + dbId + (fd && fd.error ? ' err=' + fd.error : '')); await updateState('failed', (fd && fd.error) || 'download_failed'); return; }
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
        } catch (e) { console.log('thumb gen fail dbId=' + dbId + ':', e.message); }
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
      } catch (e) { console.error('D1 update:', e.message); }
    }
    await updateProgress('completed', fi.fileSize || 0, fi.fileSize || 0).catch(function(){});
    // 用最终编号（延迟批量编号已分配，如 3-001）；历史/重试文件兜底用原 ref 或文件 id
    const rr2 = await getFileRef(env, dbId);
    await replyMsg(chatId, parseInt(msgId), fi, url, env, rr2 || ref || String(dbId));
  } catch (e) {
    console.error('processFileAsync:', e.message);
    await updateState('failed', e.message);
  } finally {
    releaseTransferSlot();
  }
}

async function processUpdate(update, env, waitFn) {
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
    // AI 管理：开启 AI 后普通文本交给大模型（function calling 查询/重试/搜索）
    if (env.D1_DB) {
      const cfg = await getAIConfig(env);
      if (cfg.enabled === 1 && cfg.key && String(text).trim()) {
        const p = callAIManage(chatId, parseInt(msgId), text, env).catch(function(e) { console.error('ai manage:', e.message); });
        if (waitFn) waitFn(p); else p;
        return { ok: true, ai: true };
      }
    }
    return { ok: true, skip: true, reason: 'unsupported' };
  }

  console.log('file:', fi.type, chat.title || chat.username);

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
        console.log('dedup hit:', md5, '->', key);
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
        'INSERT INTO files (storage_key,r2_url,md5_hash,processing_state,chat_id,chat_title,chat_type,chat_username,user_id,username,full_name,telegram_file_id,file_name,file_size,file_type,mime_type,width,height,caption,message_id,created_at,tg_file_url,group_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(key, url, md5, 'completed', chatId, chat.title || chat.username || chatId, chat.type || '', chat.username || '', from.id || 0, from.username || '', [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown', fi.fileId, fi.fileName, fi.fileSize, fi.type, fd.ct, fi.width, fi.height, msg.caption || '', msgId, date.toISOString(), tgUrl, ref2).run();
      rid = r.meta?.last_row_id;
    } catch (e) { console.error('D1:', e.message); }
  }

  console.log('url:', url);
  await replyMsg(chatId, parseInt(msgId), fi, url, env, ref2 || '');
  return { ok: true, url, fileId: rid, type: fi.type };
}

function extractFileInfo(msg) {
  if (msg.photo) { const p = msg.photo[msg.photo.length - 1]; return { type: 'photo', fileId: p.file_id, fileName: 'photo_' + genHash() + '.jpg', fileSize: p.file_size, width: p.width, height: p.height }; }
  if (msg.document) return { type: 'document', fileId: msg.document.file_id, fileName: msg.document.file_name || 'doc_' + genHash(), fileSize: msg.document.file_size, width: 0, height: 0, thumb: (msg.document.thumbnail || msg.document.thumb || {}).file_id || '' };
  if (msg.video) return { type: 'video', fileId: msg.video.file_id, fileName: msg.video.file_name || 'video_' + genHash() + '.mp4', fileSize: msg.video.file_size, width: msg.video.width || 0, height: msg.video.height || 0, thumb: (msg.video.thumbnail || msg.video.thumb || {}).file_id || '' };
  if (msg.audio) return { type: 'audio', fileId: msg.audio.file_id, fileName: msg.audio.file_name || 'audio_' + genHash() + '.mp3', fileSize: msg.audio.file_size, width: 0, height: 0 };
  if (msg.voice) return { type: 'voice', fileId: msg.voice.file_id, fileName: 'voice_' + genHash() + '.ogg', fileSize: msg.voice.file_size, width: 0, height: 0 };
  if (msg.sticker) return { type: 'photo', fileId: msg.sticker.file_id, fileName: 'sticker_' + genHash() + '.webp', fileSize: msg.sticker.file_size, width: msg.sticker.width || 0, height: msg.sticker.height || 0 };
  if (msg.animation) return { type: 'photo', fileId: msg.animation.file_id, fileName: msg.animation.file_name || 'gif_' + genHash() + '.gif', fileSize: msg.animation.file_size, width: msg.animation.width || 0, height: msg.animation.height || 0, thumb: (msg.animation.thumbnail || msg.animation.thumb || {}).file_id || '' };
  return null;
}

// ==================== FILE DOWNLOAD (Bypass 20MB limit) ====================

// API base: try TG_API_BASE first, then TG_API_BASE_2 (failover), fall back to official API
function tgApiBases(env) {
  var bases = [];
  if (env && env.TG_API_BASE) bases.push(env.TG_API_BASE);
  if (env && env.TG_API_BASE_2) bases.push(env.TG_API_BASE_2);
  if (bases.length === 0) bases.push('https://api.telegram.org');
  return bases;
}

// Local Bot API (--local mode) returns ABSOLUTE disk paths (e.g. /var/lib/telegram-bot-api/<token>/videos/file_1).
// Those files are served via the nginx /tgfile/ alias (bind-mounted to the Docker volume data dir).
function fileDownloadUrl(base, botToken, filePath) {
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
async function dlFileStream(fileId, botToken, bases) {
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

async function dlFileLarger(fileId, fileSize, botToken, bases, onProgress) {
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
async function readBodyWithProgress(body, onProgress) {
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
async function dlFileStreamLarger(fileId, botToken, bases) {
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

async function dlFile(fileId, botToken, bases) {
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
var lastUploadError = '';
// Big media goes to the cheaper Infrequent Access storage class (still public + CDN-cached)
var COLD_STORAGE_MIN = 10 * 1024 * 1024; // >=10MB
var COLD_STORAGE_CLASS = 'Infrequent Access';
// R2 用量计数器（settings 表，异步写不阻塞主流程；A类=写操作，B类=读操作）
function bumpR2Usage(env, key) {
  if (!env || !env.D1_DB) return;
  env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(COALESCE(value,'0') AS INTEGER)+1").bind(key).run().catch(function(){});
}

// 本地请求计数（worker_stats 表，按天累计；GraphQL 不可用时的兜底）
function bumpWorkerStat(env) {
  if (!env || !env.D1_DB) return;
  const day = new Date().toISOString().slice(0, 10);
  env.D1_DB.prepare("INSERT INTO worker_stats (day, requests, updated_at) VALUES (?, 1, ?) ON CONFLICT(day) DO UPDATE SET requests = requests + 1, updated_at = excluded.updated_at").bind(day, new Date().toISOString()).run().catch(function(){});
}

async function putR2(key, buf, ct, env, storageClass) {
  try {
    const opts = { httpMetadata: { contentType: ct, cacheControl: 'public, max-age=31536000' } };
    // storageClass 暂不使用：Infrequent Access 需 R2 账号启用，未启用时 put 报 10001。
    // 先全部走 Standard 保证功能，需要省成本时再按账号能力启用。
    // if (storageClass) opts.storageClass = storageClass;
    await env.R2_BUCKET.put(key, buf, opts);
    bumpR2Usage(env, 'r2_class_a');
    return (env.R2_PUBLIC_URL || '') + '/' + key;
  } catch (e) { lastUploadError = (e && e.message) || String(e); console.log('putR2 error:', lastUploadError); return null; }
}

async function putR2Stream(key, stream, ct, env, storageClass) {
  try {
    const opts = { httpMetadata: { contentType: ct, cacheControl: 'public, max-age=31536000' } };
    // 同上：storageClass 暂不使用（避免未启用 Infrequent Access 时 10001）
    // if (storageClass) opts.storageClass = storageClass;
    await env.R2_BUCKET.put(key, stream, opts);
    bumpR2Usage(env, 'r2_class_a');
    return (env.R2_PUBLIC_URL || '') + '/' + key;
  } catch (e) { lastUploadError = (e && e.message) || String(e); console.log('putR2Stream error:', lastUploadError); return null; }
}

async function computeMd5(buf) {
  const hash = await crypto.subtle.digest('MD5', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// JPEG 二进制清理：剥离 EXIF(APP1) / Photoshop IPTC(APP13) 元数据段，其余字节原样保留。
// 用于 document 上传的图片（Telegram 对 photo 会自行重压缩去除 EXIF，document 原图会保留 GPS 等隐私）。
// 纯二进制处理不解析像素，出错时静默返回原 buf。
function stripExifIfJpeg(buf, ct) {
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

async function replyMsg(chatId, replyId, fi, url, env, ref) {
  const ic = { photo: '🖼', document: '📄', video: '🎬', audio: '🎵', voice: '🎤' };
  const lb = { photo: 'Photo', document: 'File', video: 'Video', audio: 'Audio', voice: 'Voice' };
  const pre = ref ? '#' + ref + ' ' : '';
  const t = fi.type === 'photo' ? pre + '🖼 Saved\n' + url : pre + ic[fi.type] + ' ' + lb[fi.type] + ' Saved\n' + fi.fileName + ' (' + fmtSize(fi.fileSize) + ')\n' + url;
  try { await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: t }) }); } catch (e) { }
}

async function replyText(chatId, replyId, text, env) {
  try {
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' })
    });
  } catch (e) { console.log('replyText error:', e.message); }
}

// 纯文本回复（无 parse_mode，AI 长回复/含特殊字符用）
async function replyTextPlain(chatId, replyId, text, env) {
  try {
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text })
    });
  } catch (e) { console.log('replyTextPlain error:', e.message); }
}

// 主菜单按钮（inline keyboard），点按钮代替手动输命令
var MAIN_BUTTONS = [
  [{ text: '📊 现有数量', callback_data: 'cmd:count' }, { text: '⏳ 未转存', callback_data: 'cmd:pending' }],
  [{ text: '🚀 继续转存', callback_data: 'cmd:retry' }, { text: '🛰 服务状态', callback_data: 'cmd:health' }]
];

async function replyTextWithKeyboard(chatId, text, buttons, env) {
  try {
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons || MAIN_BUTTONS } })
    });
  } catch (e) { console.log('replyTextKeyboard error:', e.message); }
}

// 点击按钮回调：转发到对应命令
async function handleCallbackQuery(cq, env) {
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

// ==================== BOT API PROXY ====================

async function proxyBotApi(endpoint, request, env) {
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

async function handleBotSendMessage(request, env) { return proxyBotApi('sendMessage', request, env); }
async function handleBotSendPhoto(request, env) { return proxyBotApi('sendPhoto', request, env); }
async function handleBotSendDocument(request, env) { return proxyBotApi('sendDocument', request, env); }
async function handleBotSendVideo(request, env) { return proxyBotApi('sendVideo', request, env); }
async function handleBotGetFile(request, env) { return proxyBotApi('getFile', request, env); }
async function handleBotGetMe(request, env) { return proxyBotApi('getMe', request, env); }
async function handleBotGetWebhookInfo(request, env) { return proxyBotApi('getWebhookInfo', request, env); }
async function handleBotSetWebhook(request, env) { return proxyBotApi('setWebhook', request, env); }
async function handleBotGetUpdates(request, env) { return proxyBotApi('getUpdates', request, env); }
async function handleBotGetChat(request, env) { return proxyBotApi('getChat', request, env); }
async function handleBotGetChatMemberCount(request, env) { return proxyBotApi('getChatMemberCount', request, env); }
async function handleBotBanChatMember(request, env) { return proxyBotApi('banChatMember', request, env); }
async function handleBotUnbanChatMember(request, env) { return proxyBotApi('unbanChatMember', request, env); }
async function handleBotDeleteMessage(request, env) { return proxyBotApi('deleteMessage', request, env); }
async function handleBotForwardMessage(request, env) { return proxyBotApi('forwardMessage', request, env); }
async function handleBotCopyMessage(request, env) { return proxyBotApi('copyMessage', request, env); }

// ==================== API HANDLERS ====================

// /file/tg/<id> -> 302 redirect to official Telegram direct link (if present) else R2 URL.
// Keeps the exposed URL clean (no bot token).
async function handleTgFileRedirect(p, env, ctx) {
  if (!env.D1_DB) return json({ ok: false, error: 'no d1' }, 500);
  const id = parseInt(p.replace('/file/tg/', ''), 10) || 0;
  if (!id) return json({ ok: false, error: 'bad id' }, 400);
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
async function lazyTransferToR2(env, id, f, dlUrl) {
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

async function handleFiles(request, env) {
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
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM files f ' + w).bind(...p).first();
    const d = await env.D1_DB.prepare("SELECT f.*, CASE WHEN f.pool_status='ignored' THEN 'ignored' WHEN EXISTS (SELECT 1 FROM random_pool rp WHERE rp.tg_file_id = f.id) THEN 'imported' ELSE 'pending' END AS pool_state FROM files f " + w + ' ORDER BY f.id DESC LIMIT ? OFFSET ?').bind(...p, ps, off).all();
    const origin = new URL(request.url).origin;
    const po = await getProxyOnly(env);
    const items = (d.results || []).map(function(f) { return decorateLinks(f, origin, po); });
    return json({ ok: true, data: { total: t?.total || 0, page: pg, page_size: ps, total_pages: Math.ceil((t?.total || 0) / ps), items: items } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 给文件记录补三类直链字段：
//   r2_url      真实 R2 直链（未转存 R2 时为空；代理占位 /file/tg/<id> 不算）
//   proxy_url   tele 代理直链（worker 拉 TG，隐藏 token，总是可用）
//   display_url 推荐直链（proxy_only=1 时一律代理链接；否则有 R2 秒开优先 R2）
//   link_type   'r2'=已有 R2（同时代理也可用）/ 'proxy'=仅代理 / 'both'=两者都给
function decorateLinks(f, origin, proxyOnly) {
  const realR2 = f.r2_url && f.r2_url.length > 0 && f.r2_url.indexOf('/file/tg/') !== 0;
  // 代理链接带后缀名（如 /file/tg/123.jpg），便于识别类型与下载文件名
  const proxyUrl = origin + '/file/tg/' + f.id + '.' + fileExtOf(f.file_name, f.file_type);
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

async function handleFile(request, env) {
  const u = new URL(request.url);
  const id = u.searchParams.get('id');
  const fu = u.searchParams.get('url');
  try {
    let f;
    if (id) f = await env.D1_DB.prepare('SELECT * FROM files WHERE id=? AND deleted_at IS NULL').bind(id).first();
    else if (fu) f = await env.D1_DB.prepare('SELECT * FROM files WHERE r2_url=? AND deleted_at IS NULL').bind(fu).first();
    return json({ ok: true, data: f ? decorateLinks(f, new URL(request.url).origin, await getProxyOnly(env)) : null });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 代理模式开关（settings 表）：1=入库不转存 R2，直链 /file/tg/<id> 由 worker 实时拉 Telegram
let _proxyMode = null, _proxyModeAt = 0;
async function getProxyMode(env) {
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
async function handleAdminGetProxyMode(env) {
  return json({ ok: true, data: { proxy_mode: await getProxyMode(env) } });
}
async function handleAdminSaveProxyMode(request, env) {
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
async function getProxyOnly(env) {
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
async function handleAdminGetProxyOnly(env) {
  return json({ ok: true, data: { proxy_only: await getProxyOnly(env) } });
}
async function handleAdminSaveProxyOnly(request, env) {
  try {
    const b = await request.json().catch(() => ({}));
    const v = (b.proxy_only === 1 || b.proxy_only === true || b.proxy_only === '1') ? '1' : '0';
    await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES ('proxy_only',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(v).run();
    _proxyOnly = (v === '1') ? 1 : 0; _proxyOnlyAt = Date.now();
    return json({ ok: true, data: { proxy_only: _proxyOnly } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleStats(env) {
  try {
    const [t, ts, td, mo, bt, bc, pt, pe, pm, ptg, comp] = await Promise.all([
      env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first(),
      env.D1_DB.prepare('SELECT SUM(file_size) as s FROM files WHERE deleted_at IS NULL').first(),
      env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=date('now')").first(),
      env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=date('now','start of month')").first(),
      env.D1_DB.prepare('SELECT file_type,COUNT(*) as c FROM files WHERE deleted_at IS NULL GROUP BY file_type').all(),
      env.D1_DB.prepare('SELECT chat_title,chat_id,COUNT(*) as c FROM files WHERE deleted_at IS NULL GROUP BY chat_title ORDER BY c DESC LIMIT 20').all(),
      // Random pool stats (curated pool separate from tg files)
      env.D1_DB.prepare('SELECT COUNT(*) as c FROM random_pool').first(),
      env.D1_DB.prepare('SELECT COUNT(*) as c FROM random_pool WHERE enabled=1').first(),
      env.D1_DB.prepare("SELECT COUNT(*) as c FROM random_pool WHERE source='manual'").first(),
      env.D1_DB.prepare("SELECT COUNT(*) as c FROM random_pool WHERE source='tg'").first(),
      env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND processing_state='completed'").first()
    ]);
    return json({ ok: true, data: { total_files: t?.c || 0, completed_files: comp?.c || 0, unsaved_files: (t?.c || 0) - (comp?.c || 0), total_size: ts?.s || 0, total_size_formatted: fmtSize(ts?.s || 0), today_uploads: td?.c || 0, month_uploads: mo?.c || 0, by_type: bt.results || [], by_chat: bc.results || [], pool_total: pt?.c || 0, pool_enabled: pe?.c || 0, pool_manual: pm?.c || 0, pool_tg: ptg?.c || 0 } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== Public slideshow page (random pool showcase) ====================
// 30s in-memory cache so /show and /show/data skip D1 on hot requests (cold starts used to add seconds)
let _showCfg = null, _showCfgAt = 0;
async function getShowConfig(env) {
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

async function handleShowConfigGet(env) {
  return json({ ok: true, data: await getShowConfig(env) });
}

// ==================== Show groups (image playlists for schedule programs) ====================
async function handleShowGroupsList(env) {
  try {
    const d = await env.D1_DB.prepare('SELECT id, name, images, created_at FROM show_groups ORDER BY id DESC').all();
    return json({ ok: true, data: (d.results || []).map(function(g) {
      const arr = String(g.images || '').split(',').map(function(x){ return x.trim(); }).filter(Boolean);
      return { id: g.id, name: g.name, images: g.images || '', image_count: arr.length, created_at: g.created_at };
    }) });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleShowGroupsSave(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !b.name) return json({ ok: false, error: 'name required' }, 400);
    const name = String(b.name).trim().slice(0, 60);
    const images = String(b.images || '').split(',').map(function(x){ return x.trim(); }).filter(Boolean).slice(0, 200).join(',');
    const id = parseInt(b.id, 10) || 0;
    if (id) {
      await env.D1_DB.prepare('UPDATE show_groups SET name=?, images=? WHERE id=?').bind(name, images, id).run();
    } else {
      await env.D1_DB.prepare('INSERT INTO show_groups (name, images, created_at) VALUES (?,?,?)').bind(name, images, new Date().toISOString()).run();
    }
    _showCfg = null; // schedules may reference groups
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleShowGroupsDelete(request, env) {
  try {
    const u = new URL(request.url);
    const id = parseInt(u.searchParams.get('id') || '0', 10);
    if (!id) return json({ ok: false, error: 'id required' }, 400);
    await env.D1_DB.prepare('DELETE FROM show_groups WHERE id=?').bind(id).run();
    _showCfg = null;
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function getGroup(env, id) {
  try {
    return await env.D1_DB.prepare('SELECT id, name, images FROM show_groups WHERE id=?').bind(parseInt(id, 10)).first();
  } catch (e) { return null; }
}

// Turn a group's stored images (mix of random_pool ids and raw urls) into item list
async function groupItems(env, groupStr, limit) {
  const items = [];
  const ids = [], urls = [];
  String(groupStr || '').split(',').forEach(function(x) {
    x = x.trim();
    if (!x) return;
    if (/^\d+$/.test(x)) ids.push(parseInt(x, 10)); else urls.push(x);
  });
  if (ids.length) {
    const stmt = env.D1_DB.prepare('SELECT id, url, thumb_url, title, tags FROM random_pool WHERE id IN (' + ids.map(function(){ return '?'; }).join(',') + ')');
    const d = await stmt.bind(...ids).all();
    const map = {};
    (d.results || []).forEach(function(r) { map[r.id] = r; });
    ids.forEach(function(id) {
      const r = map[id];
      if (!r) return;
      items.push({ url: r.url, thumb_url: r.thumb_url || r.url, title: r.title || '', tags: (r.tags || '').split(',').map(function(t){ return t.trim(); }).filter(Boolean) });
    });
  }
  urls.forEach(function(u) { items.push({ url: u, thumb_url: u, title: '', tags: [] }); });
  return items.slice(0, limit);
}

async function handleShowConfigSet(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b) return json({ ok: false, error: 'body required' }, 400);
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
      schedule: normalizeSchedule(b.schedule),
      autoAdvance: b.autoAdvance ? 1 : 0,
      statsCode: String(b.statsCode || '')
    };
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('show_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(cfg)).run();
    _showCfg = null; // invalidate cache so the change applies immediately
    return json({ ok: true, data: cfg });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleShowPage() {
  // Fully static page: no D1 query. All config comes from /show/data at runtime.
  return new Response(SHOW_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Data endpoint for the slideshow: random pool only, no api key needed (public showcase)
// Supports TV-style schedule: current time picks a program -> its tags/type apply
async function handleShowData(request, env) {
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
  const count = clampInt(u.searchParams.get('count') || String((pg && pg.count) || cfg.count) || '20', 20, 1, 50);
  const shuffle = u.searchParams.get('shuffle') === '1' || (u.searchParams.get('shuffle') === null && cfg.shuffle === 1);
  const pgName = pg ? (pg.name || ((pg.start || '') + '-' + (pg.end || ''))) : null;
  // Program with an explicit image list (bound show-group takes priority, then manual urls)
  let explicit = null;
  if (pg && pg.group) {
    const g = await getGroup(env, pg.group);
    if (g && g.images) explicit = g.images;
  }
  if (!explicit && pg && pg.images) explicit = pg.images;
  if (explicit) {
    try {
      // Bound group / manual urls win over the pull-count: serve ALL selected images
      const items = await groupItems(env, explicit, 500);
      return json({ ok: true, data: { cfg: cfg, program: pgName ? { name: pgName } : null, items: items } });
    } catch (e) { return json({ ok: false, error: e.message }, 500); }
  }
  let w = 'WHERE enabled=1'; const p = [];
  if (type) { w += ' AND file_type=?'; p.push(type); }
  if (tagsParam) { w = appendTagFilter(tagsParam, w, p); }
  try {
    const d = await env.D1_DB.prepare('SELECT url, thumb_url, title, tags FROM random_pool ' + w + (shuffle ? ' ORDER BY RANDOM()' : ' ORDER BY id DESC') + ' LIMIT ?').bind(...p, count).all();
    const items = (d.results || []).map(function(r) {
      return { url: r.url, thumb_url: r.thumb_url || r.url, title: r.title || '', tags: (r.tags || '').split(',').map(function(t){ return t.trim(); }).filter(Boolean) };
    });
    return json({ ok: true, data: { cfg: cfg, program: pgName ? { name: pgName } : null, items: items } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// Match current time against the TV-style schedule. Returns the active program or null.
function matchProgram(cfg, now) {
  const sched = Array.isArray(cfg.schedule) ? cfg.schedule : [];
  if (!sched.length) return null;
  const hm = now.getHours() * 60 + now.getMinutes();
  for (let i = 0; i < sched.length; i++) {
    const s = sched[i];
    if (!s || !s.start || !s.end) continue;
    const st = parseHM(s.start), en = parseHM(s.end);
    if (st <= en) { if (hm >= st && hm < en) return s; }
    else { if (hm >= st || hm < en) return s; } // crosses midnight
  }
  return null;
}
function parseHM(t) {
  const p = String(t || '').split(':');
  return parseInt(p[0] || '0', 10) * 60 + parseInt(p[1] || '0', 10);
}

// Clamp an integer query param: non-finite or out-of-range values fall back to `def`
function clampInt(v, def, min, max) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = def;
  if (min !== undefined && n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return n;
}

// Resolve schedule conflicts: sort by start, clip overlapping programs so that
// at any moment only one program is active (later rows are trimmed to fit after the previous).
function normalizeSchedule(sched) {
  const arr = (Array.isArray(sched) ? sched : []).filter(function(s) { return s && s.start && s.end; });
  arr.sort(function(a, b) { return parseHM(a.start) - parseHM(b.start); });
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const cur = { name: String(arr[i].name || ((arr[i].start || '') + '-' + (arr[i].end || ''))), start: String(arr[i].start).trim(), end: String(arr[i].end).trim(), tags: String(arr[i].tags || '').trim(), type: String(arr[i].type || '').trim(), images: String(arr[i].images || '').trim(), group: String(arr[i].group || '').trim() };
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
    if(!items.length){$('loading').textContent='随机库暂无图片';return;}
    $('loading').style.display='none';
    idx=0;show();start();
  }).catch(function(){done=true;clearTimeout(to);$('loading').textContent='加载失败，请刷新重试';});
}
var errCount=0;
function updateProgram(){
  var el=$('program');
  if(el){if(curProgram){el.style.display='block';el.textContent='正在播放 · '+curProgram;}else{el.style.display='none';}}
  var ov=$('ovProgram');
  if(ov) ov.textContent=curProgram?('下一组将播放 · '+curProgram):'随机库暂无更多内容';
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
async function checkApiKey(request, env) {
  if (!env.D1_DB) return null;
  const u = new URL(request.url);
  const k = u.searchParams.get('api_key') || request.headers.get('X-API-Key');
  if (!k) return null;
  try {
    const rec = await env.D1_DB.prepare('SELECT * FROM api_keys WHERE key=? AND enabled=1 LIMIT 1').bind(k).first();
    if (!rec) return null;
    // usage bump (fire and forget)
    env.D1_DB.prepare('UPDATE api_keys SET usage_count=usage_count+1, last_used_at=? WHERE id=?').bind(new Date().toISOString(), rec.id).run().catch(function(){});
    // 限流：settings.api_rate_limit = {enabled, limit_per_min}
    const limited = await applyRateLimit(env, k);
    return { rec: rec, limited: limited };
  } catch (e) { console.error('checkApiKey:', e.message); return null; }
}

// 公开 API 限流逻辑已移入 src/ratelimit.js（applyRateLimit），由顶部 import 引入

function appendTagFilter(tagsParam, w, p, prefix) {
  const q = prefix || '';
  const tags = (tagsParam || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
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

function publicFileJson(f) {
  if (!f) return null;
  return {
    id: f.id, file_name: f.file_name, file_type: f.file_type, mime_type: f.mime_type,
    file_size: f.file_size, width: f.width, height: f.height,
    r2_url: f.r2_url, thumb_url: f.thumb_url,
    tags: (f.tags || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean),
    caption: f.caption, chat_title: f.chat_title, username: f.username,
    created_at: f.created_at
  };
}

async function handlePublicFiles(request, env) {
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
  if (type) { w += ' AND file_type=?'; p.push(type); }
  if (tagsParam) { w = appendTagFilter(tagsParam, w, p); }
  if (kw) {
    if (fromPool) { w += ' AND (title LIKE ? OR url LIKE ?)'; p.push('%' + kw + '%', '%' + kw + '%'); }
    else { w += ' AND (file_name LIKE ? OR caption LIKE ?)'; p.push('%' + kw + '%', '%' + kw + '%'); }
  }
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM ' + table + ' ' + w).bind(...p).first();
    let d;
    if (random) {
      d = await env.D1_DB.prepare('SELECT * FROM ' + table + ' ' + w + ' ORDER BY RANDOM() LIMIT ?').bind(...p, limit).all();
    } else {
      d = await env.D1_DB.prepare('SELECT * FROM ' + table + ' ' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?').bind(...p, limit, offset).all();
    }
    const mapper = fromPool ? poolFileJson : publicFileJson;
    return json({ ok: true, data: { total: t?.total || 0, limit: limit, offset: offset, items: (d.results || []).map(mapper) } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handlePublicRandom(request, env) {
  const u = new URL(request.url);
  const type = u.searchParams.get('type') || '';
  const tagsParam = u.searchParams.get('tags') || '';
  const count = clampInt(u.searchParams.get('count') || '1', 1, 1, 10);
  // mode=img: 302 to a random file's direct URL (for <img>); default json
  const mode = u.searchParams.get('mode') || 'json';
  // Always from the curated random pool (enabled=1); never falls back to the Telegram bot files
  let w = 'WHERE enabled=1'; const p = [];
  if (type) { w += ' AND file_type=?'; p.push(type); }
  if (tagsParam) { w = appendTagFilter(tagsParam, w, p); }
  try {
    const d = await env.D1_DB.prepare('SELECT * FROM random_pool ' + w + ' ORDER BY RANDOM() LIMIT ?').bind(...p, mode === 'img' ? 1 : count).all();
    const items = (d.results || []).map(poolFileJson);
    if (mode === 'img') {
      if (!items.length) return json({ ok: false, error: 'No file matches' }, 404);
      return new Response('', { status: 302, headers: { Location: items[0].url } });
    }
    return json({ ok: true, data: { items: items } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// Compact public JSON for a random_pool row
function poolFileJson(r) {
  return {
    id: r.id, url: r.url, thumb_url: r.thumb_url || r.url,
    title: r.title || '', tags: (r.tags || '').split(',').map(function(t){ return t.trim(); }).filter(Boolean),
    file_type: r.file_type || 'photo', width: r.width, height: r.height, file_size: r.file_size,
    source: r.source, created_at: r.created_at
  };
}

// ==================== Admin: tags / api keys / users ====================
async function handleAdminTags(env) {
  try {
    const d1 = await env.D1_DB.prepare("SELECT tags FROM files WHERE processing_state='completed' AND deleted_at IS NULL AND tags IS NOT NULL AND tags != ''").all();
    // random_pool 只统计非 TG 副本（source != 'tg'），避免与 files.tags 重复计数；
    // 同一张 TG 图在 files 里计一次即可，pool 里的副本不再重复计
    const d2 = await env.D1_DB.prepare("SELECT tags FROM random_pool WHERE enabled=1 AND source != 'tg' AND tags IS NOT NULL AND tags != ''").all();
    const cnt = {};
    [d1, d2].forEach(function(res) {
      (res.results || []).forEach(function(r) {
        const seen = {};
        (r.tags || '').split(',').forEach(function(t) {
          t = t.trim();
          if (t && !seen[t]) { seen[t] = 1; cnt[t] = (cnt[t] || 0) + 1; }  // 行内去重，防止 a,a 计两次
        });
      });
    });
    const arr = Object.keys(cnt).map(function(t) { return { tag: t, count: cnt[t] }; }).sort(function(a, b) { return b.count - a.count; });
    return json({ ok: true, data: arr });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleSetFileTags(request, env) {
  try {
    const b = await request.json().catch(function() { return {}; });
    const ids = b.ids || (b.id ? [b.id] : []);
    if (!ids.length) return json({ ok: false, error: 'ids required' });
    const mode = b.mode || 'set';
    const tagsArr = (b.tags || []).map(function(s) { return String(s).trim(); }).filter(Boolean);
    let updated = 0;
    for (const id of ids) {
      if (mode === 'set') {
        await env.D1_DB.prepare('UPDATE files SET tags=? WHERE id=? AND deleted_at IS NULL').bind(Array.from(new Set(tagsArr)).join(','), id).run();
      } else {
        const f = await env.D1_DB.prepare('SELECT tags FROM files WHERE id=? AND deleted_at IS NULL').bind(id).first();
        let cur = (f && f.tags) ? f.tags.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
        if (mode === 'append') {
          tagsArr.forEach(function(t) { if (cur.indexOf(t) === -1) cur.push(t); });
        } else if (mode === 'remove') {
          cur = cur.filter(function(t) { return tagsArr.indexOf(t) === -1; });
        }
        await env.D1_DB.prepare('UPDATE files SET tags=? WHERE id=? AND deleted_at IS NULL').bind(Array.from(new Set(cur)).join(','), id).run();
      }
      updated++;
    }
    return json({ ok: true, data: { updated: updated } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

function genApiKey() {
  const arr = new Uint8Array(18);
  crypto.getRandomValues(arr);
  return 'vk_' + Array.from(arr).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

async function handleAdminKeys(env) {
  try {
    const d = await env.D1_DB.prepare('SELECT id,key,name,scopes,enabled,created_at,last_used_at,usage_count FROM api_keys ORDER BY id DESC').all();
    return json({ ok: true, data: d.results || [] });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminKeysCreate(request, env) {
  try {
    const b = await request.json().catch(function() { return {}; });
    const name = String(b.name || '').slice(0, 60);
    const scopes = String(b.scopes || 'files:read').slice(0, 120);
    const key = genApiKey();
    const r = await env.D1_DB.prepare('INSERT INTO api_keys (key,name,scopes,enabled,created_at,usage_count) VALUES (?,?,?,1,?,0)').bind(key, name, scopes, new Date().toISOString()).run();
    return json({ ok: true, data: { id: r.meta?.last_row_id, key: key, name: name, scopes: scopes } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminKeysToggle(request, env) {
  try {
    const b = await request.json().catch(function() { return {}; });
    if (!b.id) return json({ ok: false, error: 'id required' });
    await env.D1_DB.prepare('UPDATE api_keys SET enabled=? WHERE id=?').bind(b.enabled ? 1 : 0, b.id).run();
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminKeysDelete(request, env) {
  try {
    const u = new URL(request.url);
    const id = u.searchParams.get('id');
    if (!id) return json({ ok: false, error: 'id required' });
    await env.D1_DB.prepare('DELETE FROM api_keys WHERE id=?').bind(id).run();
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminUsers(env) {
  try {
    const d = await env.D1_DB.prepare("SELECT user_id, username, full_name, COUNT(*) as file_count, SUM(file_size) as total_size, MAX(created_at) as last_active FROM files WHERE deleted_at IS NULL GROUP BY user_id ORDER BY file_count DESC LIMIT 100").all();
    return json({ ok: true, data: d.results || [] });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== Random pool ====================
async function handleAdminPoolList(request, env) {
  try {
    const u = new URL(request.url);
    const source = u.searchParams.get('source') || '';
    const enabled = u.searchParams.get('enabled');
    const tagsParam = u.searchParams.get('tags') || '';
    const kw = u.searchParams.get('keyword') || '';
    const idsParam = u.searchParams.get('ids') || '';
    const limit = clampInt(u.searchParams.get('limit') || '500', 500, 1, 500);
    const offset = clampInt(u.searchParams.get('offset') || '0', 0, 0);
    let w = 'WHERE 1=1'; const p = [];
    if (source) { w += ' AND source=?'; p.push(source); }
    if (enabled === '1' || enabled === '0') { w += ' AND enabled=?'; p.push(parseInt(enabled)); }
    if (tagsParam) { w = appendTagFilter(tagsParam, w, p); }
    if (kw) { w += ' AND (title LIKE ? OR url LIKE ?)'; p.push('%' + kw + '%', '%' + kw + '%'); }
    if (idsParam) {
      const arr = idsParam.split(',').map(function(s){ return parseInt(s.trim(), 10); }).filter(function(n){ return n > 0; });
      if (arr.length) { w += ' AND id IN (' + arr.map(function(){ return '?'; }).join(',') + ')'; arr.forEach(function(a){ p.push(a); }); }
    }
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM random_pool ' + w).bind(...p).first();
    const d = await env.D1_DB.prepare('SELECT * FROM random_pool ' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?').bind(...p, limit, offset).all();
    return json({ ok: true, data: d.results || [], total: t?.total || 0 });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminPoolCreate(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.urls) || !b.urls.length) return json({ ok: false, error: 'urls required' }, 400);
    const tags = (b.tags || []).map(String).map(function(t){ return t.trim(); }).filter(Boolean).join(',');
    const title = String(b.title || '').slice(0, 200);
    const now = new Date().toISOString();
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
      await env.D1_DB.prepare('INSERT INTO random_pool (url, thumb_url, title, tags, file_type, file_size, source, enabled, created_at) VALUES (?, ?, ?, ?, \'photo\', ?, \'manual\', 1, ?)')
        .bind(url, url, title, tags, fsize, now).run();
      added++;
    }
    return json({ ok: true, data: { added: added } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// Normalize an image URL against a base page URL (resolve relative paths)
function normUrl(u, base) {
  u = String(u || '').trim();
  if (!u || u.charAt(0) === '#') return null;
  if (/^\/\//.test(u)) return 'https:' + u;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.charAt(0) === '/') { try { var b = new URL(base); return b.origin + u; } catch (e) { return null; } }
  try { return new URL(u, base).href; } catch (e) { return null; }
}

// Canonicalize zupimages URLs (www vs non-www are the same image)
function canonImgUrl(u) {
  return u.replace(/^https?:\/\/zupimages\.net\//i, 'https://www.zupimages.net/');
}

// Convert a Zupimages viewer.php?id=<path> link into its direct image URL:
//   https://zupimages.net/viewer.php?id=26/35/8rfb.png
//     -> https://www.zupimages.net/up/26/35/8rfb.png
function zupViewerToDirect(u) {
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
async function handleAdminPoolImportPage(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const raw = b && b.url ? String(b.url).trim() : '';
    if (!raw) return json({ ok: false, error: 'url required' }, 400);
    const pageUrls = raw.split(/\r?\n/).map(function(s){ return s.trim(); }).filter(function(s){ return /^https?:\/\//i.test(s); });
    if (!pageUrls.length) return json({ ok: false, error: 'url must be http(s)' }, 400);
    const tags = (b.tags || []).map(String).map(function(t){ return t.trim(); }).filter(Boolean).join(',');
    const title = String(b.title || '').slice(0, 200);
    const now = new Date().toISOString();
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
      await env.D1_DB.prepare('INSERT INTO random_pool (url, thumb_url, title, tags, file_type, file_size, source, enabled, created_at) VALUES (?, ?, ?, ?, \'photo\', ?, \'manual\', 1, ?)')
        .bind(url, url, title, tags, fsize, now).run();
      added++;
    }
    return json({ ok: true, data: { fetched: fetched, found: urls.length, added: added, skipped: skipped } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

function randHex(len) {
  var s = '', chars = 'abcdef0123456789';
  for (var i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * 16));
  return s;
}

function b64ToBytes(b64) {
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Byte size of an image from base64 (best effort)
function b64Size(b64) {
  const s = String(b64 || '');
  return Math.floor((s.length - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0)) * 3 / 4);
}

// Best-effort HEAD probe to get an image's Content-Length (for manual imports)
async function probeImgSize(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PoolImporter/1.0)' } });
    if (!r.ok) return null;
    const cl = r.headers.get('Content-Length');
    return cl ? (parseInt(cl) || null) : null;
  } catch (e) { return null; }
}

// Local multi-image upload: receive base64 image, store to R2, add to random_pool.
// Body: { name: "a.jpg", data: "<base64>", tags: "a,b", title: "..." }
async function handleAdminPoolUpload(request, env) {
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
    const iso = now.toISOString();
    const fsize = (b.size && Number(b.size) > 0) ? Math.round(Number(b.size)) : b64Size(b.data);
    await env.D1_DB.prepare('INSERT INTO random_pool (url, thumb_url, title, tags, file_type, file_size, source, enabled, created_at) VALUES (?, ?, ?, ?, \'photo\', ?, \'upload\', 1, ?)')
      .bind(url, url, title, tags, fsize, iso).run();
    return json({ ok: true, data: { url: url, added: 1 } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// Upload a base64 image to Postimages via its official API
// (api.postimage.org/1/upload), then resolve the direct i.postimg.cc URL
// and add it to random_pool. Body: { name, data(base64), key, gallery }
async function handleAdminPoolUploadPostimages(request, env) {
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
    const now = new Date().toISOString();
    const ex = await env.D1_DB.prepare('SELECT id FROM random_pool WHERE url = ? LIMIT 1').bind(direct).first();
    if (ex) return json({ ok: true, data: { url: direct, added: 0, duplicate: true } });
    const fsize = b64Size(b.data);
    await env.D1_DB.prepare('INSERT INTO random_pool (url, thumb_url, title, tags, file_type, file_size, source, enabled, created_at) VALUES (?, ?, ?, ?, \'photo\', ?, \'postimages\', 1, ?)')
      .bind(direct, direct, title, tags, fsize, now).run();
    return json({ ok: true, data: { url: direct, added: 1 } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminGetPiKey(env) {
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'postimages_key'").first();
    return json({ ok: true, data: { key: s && s.value ? s.value : '' } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminSavePiKey(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const key = b && b.key ? String(b.key).trim().slice(0, 200) : '';
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('postimages_key', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key).run();
    return json({ ok: true, data: { saved: !!key } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 预设标签库（后台自定义，上传时点选，保证标签统一）
async function handleAdminGetPoolTags(env) {
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'pool_tags_preset'").first();
    let tags = [];
    if (s && s.value) {
      try { tags = JSON.parse(s.value); } catch (e) { tags = String(s.value).split(',').map(function(t){ return t.trim(); }).filter(Boolean); }
    }
    return json({ ok: true, data: { tags: Array.isArray(tags) ? tags : [] } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminSavePoolTags(request, env) {
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

async function handleAdminPoolToggle(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !b.id) return json({ ok: false, error: 'id required' }, 400);
    await env.D1_DB.prepare('UPDATE random_pool SET enabled = ? WHERE id = ?').bind(b.enabled ? 1 : 0, b.id).run();
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== 告警 / 限流 配置接口（notifyAdmin/genThumb/备份逻辑已移入 src/） ====================

async function handleAdminGetNotify(env) {
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'admin_chat_id'").first();
    return json({ ok: true, data: { chat_id: s && s.value ? s.value : '' } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminSaveNotify(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const chatId = b && b.chat_id ? String(b.chat_id).trim().slice(0, 40) : '';
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('admin_chat_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(chatId).run();
    return json({ ok: true, data: { chat_id: chatId } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminNotifyTest(request, env) {
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

async function handleAdminGetRateLimit(env) {
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'api_rate_limit'").first();
    let cfg = { enabled: false, limit_per_min: 60 };
    if (s && s.value) { try { cfg = Object.assign(cfg, JSON.parse(s.value)); } catch (e) {} }
    return json({ ok: true, data: cfg });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminSaveRateLimit(request, env) {
  try {
    const b = await request.json().catch(() => null);
    const enabled = !!(b && b.enabled);
    const limit = Math.max(1, Math.min(100000, parseInt((b && b.limit_per_min) || 60, 10) || 60));
    const cfg = { enabled: enabled, limit_per_min: limit };
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('api_rate_limit', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(cfg)).run();
    return json({ ok: true, data: cfg });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminPoolTags(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.ids) || !b.ids.length) return json({ ok: false, error: 'ids required' }, 400);
    const mode = b.mode || 'set';
    const tags = (b.tags || []).map(String).map(function(t){ return t.trim(); }).filter(Boolean);
    for (const id of b.ids) {
      const cur = await env.D1_DB.prepare('SELECT tags FROM random_pool WHERE id = ?').bind(id).first();
      let next = '';
      if (mode === 'append') {
        const set = new Set(((cur && cur.tags) || '').split(',').map(function(t){ return t.trim(); }).filter(Boolean));
        tags.forEach(function(t){ set.add(t); });
        next = Array.from(set).join(',');
      } else if (mode === 'remove') {
        const set = new Set(((cur && cur.tags) || '').split(',').map(function(t){ return t.trim(); }).filter(Boolean));
        tags.forEach(function(t){ set.delete(t); });
        next = Array.from(set).join(',');
      } else {
        next = tags.join(',');
      }
      await env.D1_DB.prepare('UPDATE random_pool SET tags = ? WHERE id = ?').bind(next, id).run();
    }
    return json({ ok: true, updated: b.ids.length });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminPoolBatch(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.ids) || !b.ids.length) return json({ ok: false, error: 'ids required' }, 400);
    for (const id of b.ids) {
      await env.D1_DB.prepare('UPDATE random_pool SET enabled = ? WHERE id = ?').bind(b.enabled ? 1 : 0, id).run();
    }
    return json({ ok: true, updated: b.ids.length });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminPoolBatchDelete(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.ids) || !b.ids.length) return json({ ok: false, error: 'ids required' }, 400);
    for (const id of b.ids) {
      await env.D1_DB.prepare('DELETE FROM random_pool WHERE id = ?').bind(id).run();
    }
    return json({ ok: true, deleted: b.ids.length });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleSetFilePoolStatus(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.ids) || !b.ids.length) return json({ ok: false, error: 'ids required' }, 400);
    const status = b.status === 'ignored' ? 'ignored' : '';
    let n = 0;
    for (const id of b.ids) {
      const r = await env.D1_DB.prepare('UPDATE files SET pool_status=? WHERE id=?').bind(status, parseInt(id, 10) || 0).run();
      n += (r && r.meta && r.meta.changes) || 0;
    }
    return json({ ok: true, updated: n });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminPoolFromTg(request, env) {
  try {
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.ids) || !b.ids.length) return json({ ok: false, error: 'ids required' }, 400);
    // 可选 tags：导入时统一设置标签（覆盖文件现有标签并同步回 files.tags）；不传则沿用文件现有标签
    const tagsOverride = Array.isArray(b.tags) ? b.tags.map(s => String(s).trim()).filter(Boolean) : [];
    const finalTags = tagsOverride.length ? Array.from(new Set(tagsOverride)).join(',') : '';
    let added = 0, skipped = 0;
    for (const id of b.ids) {
      const f = await env.D1_DB.prepare("SELECT id, r2_url, thumb_url, file_name, file_type, width, height, file_size, tags FROM files WHERE id = ? AND deleted_at IS NULL AND (pool_status IS NULL OR pool_status != 'ignored')").bind(id).first();
      if (!f) { skipped++; continue; }
      const ex = await env.D1_DB.prepare('SELECT id FROM random_pool WHERE tg_file_id = ?').bind(id).first();
      if (ex) continue;
      const now = new Date().toISOString();
      const useTags = finalTags || f.tags || '';
      await env.D1_DB.prepare('INSERT INTO random_pool (url, thumb_url, title, tags, file_type, width, height, file_size, source, tg_file_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'tg\', ?, 1, ?)')
        .bind(f.r2_url, f.thumb_url || f.r2_url, f.file_name || '', useTags, f.file_type || 'photo', f.width || null, f.height || null, f.file_size || null, id, now).run();
      if (finalTags) {
        // 同步文件标签，保证标签计数一致（files 与 pool 同标签）
        await env.D1_DB.prepare('UPDATE files SET tags=? WHERE id=? AND deleted_at IS NULL').bind(finalTags, id).run();
      }
      added++;
    }
    return json({ ok: true, data: { added: added, skipped: skipped } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminPoolDelete(request, env) {
  try {
    const u = new URL(request.url);
    const id = u.searchParams.get('id');
    if (!id) return json({ ok: false, error: 'id required' }, 400);
    await env.D1_DB.prepare('DELETE FROM random_pool WHERE id = ?').bind(id).run();
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleByChat(request, env) {
  const u = new URL(request.url); const ci = u.searchParams.get('chat_id'); const ct = u.searchParams.get('chat_title');
  const pg = clampInt(u.searchParams.get('page') || '1', 1, 1); const ps = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100); const off = (pg - 1) * ps;
  let w = 'WHERE deleted_at IS NULL'; const p = [];
  if (ci) { w += ' AND chat_id=?'; p.push(ci); } if (ct) { w += ' AND chat_title LIKE ?'; p.push('%' + ct + '%'); }
  try { const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM files ' + w).bind(...p).first(); const d = await env.D1_DB.prepare('SELECT * FROM files ' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?').bind(...p, ps, off).all(); return json({ ok: true, data: { total: t?.total || 0, page: pg, page_size: ps, items: d.results || [] } }); } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleByUser(request, env) {
  const u = new URL(request.url); const ui = u.searchParams.get('user_id'); const un = u.searchParams.get('username');
  const pg = clampInt(u.searchParams.get('page') || '1', 1, 1); const ps = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100); const off = (pg - 1) * ps;
  let w = 'WHERE deleted_at IS NULL'; const p = [];
  if (ui) { w += ' AND user_id=?'; p.push(parseInt(ui)); } if (un) { w += ' AND username LIKE ?'; p.push('%' + un + '%'); }
  try { const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM files ' + w).bind(...p).first(); const d = await env.D1_DB.prepare('SELECT * FROM files ' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?').bind(...p, ps, off).all(); return json({ ok: true, data: { total: t?.total || 0, page: pg, page_size: ps, items: d.results || [] } }); } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleByDate(request, env) {
  const u = new URL(request.url); const d2 = u.searchParams.get('date');
  if (!d2) return json({ ok: false, error: 'date required' });
  const pg = clampInt(u.searchParams.get('page') || '1', 1, 1); const ps = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100); const off = (pg - 1) * ps;
  try { const t = await env.D1_DB.prepare("SELECT COUNT(*) as total FROM files WHERE created_at LIKE ? AND deleted_at IS NULL").bind(d2 + '%').first(); const d = await env.D1_DB.prepare("SELECT * FROM files WHERE created_at LIKE ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ? OFFSET ?").bind(d2 + '%', ps, off).all(); return json({ ok: true, data: { total: t?.total || 0, date: d2, page: pg, page_size: ps, items: d.results || [] } }); } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleSearch(request, env) {
  const u = new URL(request.url); const q = u.searchParams.get('q') || '';
  if (!q) return json({ ok: false, error: 'q required' });
  const pg = clampInt(u.searchParams.get('page') || '1', 1, 1); const ps = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100); const off = (pg - 1) * ps;
  const lk = '%' + q + '%';
  try { const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM files WHERE (file_name LIKE ? OR caption LIKE ? OR chat_title LIKE ? OR username LIKE ? OR full_name LIKE ?) AND deleted_at IS NULL').bind(lk, lk, lk, lk, lk).first(); const d = await env.D1_DB.prepare('SELECT * FROM files WHERE (file_name LIKE ? OR caption LIKE ? OR chat_title LIKE ? OR username LIKE ? OR full_name LIKE ?) AND deleted_at IS NULL ORDER BY id DESC LIMIT ? OFFSET ?').bind(lk, lk, lk, lk, lk, ps, off).all(); return json({ ok: true, data: { total: t?.total || 0, keyword: q, page: pg, page_size: ps, items: d.results || [] } }); } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleLatest(request, env) {
  const u = new URL(request.url); const lm = clampInt(u.searchParams.get('limit') || '10', 10, 1, 50); const tp = u.searchParams.get('type') || '';
  let w = tp ? 'WHERE file_type=? AND deleted_at IS NULL' : 'WHERE deleted_at IS NULL'; const p = tp ? [lm] : [];
  try { const d = await env.D1_DB.prepare('SELECT * FROM files ' + w + ' ORDER BY id DESC LIMIT ?').bind(...p).all(); return json({ ok: true, data: d.results || [] }); } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleStream(request, env) {
  const u = new URL(request.url); const id = u.searchParams.get('id');
  try { const f = await env.D1_DB.prepare('SELECT storage_key FROM files WHERE id=? AND deleted_at IS NULL').bind(id).first(); if (!f) return json({ ok: false, error: 'not found' }, 404); const o = await env.R2_BUCKET.get(f.storage_key); if (!o) return json({ ok: false, error: 'gone' }, 404); bumpR2Usage(env, 'r2_class_b'); const h = new Headers(); o.writeHttpMetadata(h); h.set('Cache-Control', 'public,max-age=31536000'); h.set('Access-Control-Allow-Origin', '*'); return new Response(o.body, { headers: h }); } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleDeleteFile(request, env) {
  // Soft delete: mark the row deleted_at and keep the R2 object in place.
  // The file lands in the trash (recoverable); R2 cleanup happens on purge.
  const u = new URL(request.url); const id = u.searchParams.get('id'); const ids = u.searchParams.get('ids');
  const purge = u.searchParams.get('purge') === '1';
  const purgeAll = purge && u.searchParams.get('all') === '1';
  if (!id && !ids && !purgeAll) return json({ ok: false, error: 'id required' });
  const now = new Date().toISOString();
  let deleted = 0;
  if (purgeAll) {
    // Empty the whole trash: delete objects (last reference only) then the rows
    const rows = await env.D1_DB.prepare('SELECT id, storage_key FROM files WHERE deleted_at IS NOT NULL').all();
    for (const f of (rows.results || [])) {
      try {
        if (f.storage_key) {
          const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=?').bind(f.storage_key).first();
          if (!ref || (ref.c || 0) <= 1) { try { await env.R2_BUCKET.delete(f.storage_key); } catch (e) {} }
        }
        const r = await env.D1_DB.prepare('DELETE FROM files WHERE id=?').bind(f.id).run();
        if (r.meta && r.meta.changes) deleted++;
      } catch (e) {}
    }
    return json({ ok: true, deleted: deleted, message: 'Purged ' + deleted + ' file(s)' });
  }
  const list = ids ? ids.split(',').map(function(s){return s.trim();}).filter(Boolean) : [id];
  for (const one of list) {
    try {
      if (purge) {
        // Hard delete from trash: remove the R2 object (last reference only) then the row
        const f = await env.D1_DB.prepare('SELECT storage_key FROM files WHERE id=?').bind(one).first();
        if (f?.storage_key) {
          const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=?').bind(f.storage_key).first();
          if (!ref || (ref.c || 0) <= 1) { try { await env.R2_BUCKET.delete(f.storage_key); } catch (e) {} }
        }
        const r = await env.D1_DB.prepare('DELETE FROM files WHERE id=?').bind(one).run();
        if (r.meta && r.meta.changes) deleted++;
      } else {
        const r = await env.D1_DB.prepare('UPDATE files SET deleted_at=? WHERE id=? AND deleted_at IS NULL').bind(now, one).run();
        if (r.meta && r.meta.changes) deleted++;
      }
    } catch (e) {}
  }
  return json({ ok: true, deleted: deleted, message: (purge ? 'Purged ' : 'Deleted ') + deleted + ' file(s)' });
}

// Trash list: rows marked deleted_at, newest first
async function handleTrashList(request, env) {
  const u = new URL(request.url);
  const pg = clampInt(u.searchParams.get('page') || '1', 1, 1);
  const ps = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100);
  const off = (pg - 1) * ps;
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as total FROM files WHERE deleted_at IS NOT NULL').first();
    const d = await env.D1_DB.prepare('SELECT id, file_name, file_type, file_size, chat_title, created_at, deleted_at, r2_url FROM files WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ? OFFSET ?').bind(ps, off).all();
    return json({ ok: true, data: { total: t?.total || 0, page: pg, page_size: ps, total_pages: Math.ceil((t?.total || 0) / ps), items: d.results || [] } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// Restore: clear deleted_at so the file is visible again
async function handleTrashRestore(request, env) {
  const b = await request.json().catch(function(){ return null; });
  const ids = b && Array.isArray(b.ids) ? b.ids.map(String) : [];
  let restored = 0;
  if (!ids.length) {
    // Empty ids -> restore everything
    try {
      const r = await env.D1_DB.prepare('UPDATE files SET deleted_at=NULL WHERE deleted_at IS NOT NULL').run();
      restored = (r.meta && r.meta.changes) || 0;
    } catch (e) {}
    return json({ ok: true, restored: restored, message: 'Restored ' + restored + ' file(s)' });
  }
  for (const one of ids) {
    try {
      const r = await env.D1_DB.prepare('UPDATE files SET deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL').bind(one).run();
      if (r.meta && r.meta.changes) restored++;
    } catch (e) {}
  }
  return json({ ok: true, restored: restored, message: 'Restored ' + restored + ' file(s)' });
}

// Collect every object key that is still referenced by D1:
// - files.storage_key (including soft-deleted rows: their objects still live)
// - thumbnails referenced via files.thumb_url (stored as <public_url>/<key>)
// - the admin.html static page served from the same bucket
async function collectReferencedKeys(db) {
  const refs = new Set(['admin.html']);
  let lastId = 0;
  while (true) {
    const rows = await db.prepare('SELECT id, storage_key, thumb_url FROM files WHERE id > ? ORDER BY id LIMIT 5000').bind(lastId).all();
    const res = rows.results || [];
    if (!res.length) break;
    for (const x of res) {
      if (x.storage_key) refs.add(x.storage_key);
      if (x.thumb_url && x.thumb_url.indexOf('/') >= 0) {
        const tk = x.thumb_url.substring(x.thumb_url.lastIndexOf('/') + 1);
        if (tk) refs.add(tk);
      }
    }
    lastId = res[res.length - 1].id;
  }
  return refs;
}

// R2 orphan inspection: walk the bucket, list objects with no D1 reference.
// Read-only. max= limits how many objects are scanned per call (CPU budget).
async function handleR2Inspect(request, env) {
  try {
    const u = new URL(request.url);
    const maxObjects = clampInt(u.searchParams.get('max') || '50000', 50000, 1000, 200000);
    const refs = await collectReferencedKeys(env.D1_DB);
    const orphans = [];
    let scanned = 0;
    let cursor = null;
    while (scanned < maxObjects) {
      const list = cursor ? await env.R2_BUCKET.list({ limit: 1000, cursor: cursor }) : await env.R2_BUCKET.list({ limit: 1000 });
      const objs = list.objects || [];
      if (!objs.length) break;
      for (const o of objs) {
        scanned++;
        if (!refs.has(o.key)) orphans.push({ key: o.key, size: o.size, uploaded: o.uploaded });
      }
      if (!list.truncated) break;
      cursor = list.cursor;
    }
    return json({ ok: true, data: { referenced: refs.size, objects_scanned: scanned, orphan_count: orphans.length, orphans: orphans.slice(0, 2000) } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// R2 orphan cleanup: idempotent re-scan + delete every unreferenced object
async function handleR2Cleanup(env) {
  try {
    const refs = await collectReferencedKeys(env.D1_DB);
    let deleted = 0;
    let cursor = null;
    while (true) {
      const list = cursor ? await env.R2_BUCKET.list({ limit: 1000, cursor: cursor }) : await env.R2_BUCKET.list({ limit: 1000 });
      const objs = list.objects || [];
      if (!objs.length) break;
      for (const o of objs) {
        if (!refs.has(o.key)) {
          try { await env.R2_BUCKET.delete(o.key); deleted++; } catch (e) {}
        }
      }
      if (!list.truncated) break;
      cursor = list.cursor;
    }
    return json({ ok: true, data: { deleted: deleted } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleListBots(env) {
  try {
    const bots = [];
    if (env.TG_BOT_TOKEN) {
      const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getMe');
      const j = await r.json();
      if (j.ok) bots.push({ token: env.TG_BOT_TOKEN.substring(0, 10) + '...', username: j.result.username, name: j.result.first_name, id: j.result.id });
    }
    return json({ ok: true, data: bots });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAddBot(request, env) {
  return json({ ok: false, error: 'Bot management via env variables. Set TG_BOT_TOKEN in Worker settings.' });
}

async function handleRemoveBot(request, env) {
  return json({ ok: false, error: 'Bot management via env variables.' });
}

async function handleGetConfig(env) {
  const config = {
    bot_token_set: !!env.TG_BOT_TOKEN,
    api_key_set: !!env.API_KEY,
    r2_public_url: env.R2_PUBLIC_URL || '',
    tg_secret_set: !!env.TG_SECRET,
  };
  if (env.TG_BOT_TOKEN) {
    try {
      const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getMe');
      const j = await r.json();
      if (j.ok) { config.bot_username = j.result.username; config.bot_name = j.result.first_name; }
    } catch (e) {}
  }
  return json({ ok: true, data: config });
}

async function handleSetConfig(request, env) {
  return json({ ok: false, error: 'Config is set via Worker environment variables in CF Dashboard.' });
}

async function handleBotGetMeApi(env) {
  if (!env.TG_BOT_TOKEN) return json({ ok: false, error: 'Bot token not set' });
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getMe');
    const j = await r.json();
    return json(j);
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// ==================== ADMIN API ====================

// Retry a failed/stuck file record
async function handleRetry(request, env, ctx) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const u = new URL(request.url);
    const id = u.searchParams.get('id');
    if (!id) return json({ ok: false, error: 'missing id' }, 400);
    const f = await env.D1_DB.prepare('SELECT * FROM files WHERE id=? AND deleted_at IS NULL').bind(id).first();
    if (!f) return json({ ok: false, error: 'not found' }, 404);
    const fi = { type: f.file_type, fileId: f.telegram_file_id, fileName: f.file_name || 'file_' + id, fileSize: f.file_size || 0, width: f.width || 0, height: f.height || 0 };
    const date = new Date(f.created_at || Date.now());
    // Reset state + progress for the retry
    await env.D1_DB.prepare("UPDATE files SET processing_state='downloading', progress_bytes=0, total_bytes=?, error_msg='' WHERE id=?").bind(f.file_size || 0, id).run();
    const task = {
      dbId: parseInt(id), fi: fi, chatId: f.chat_id || '', msgId: f.message_id || '',
      chat: { title: f.chat_title, username: f.chat_username, type: f.chat_type },
      from: { id: f.user_id, username: f.username, first_name: '', last_name: '' },
      date: date.toISOString()
    };
    if (env.FILE_QUEUE) {
      await env.FILE_QUEUE.send(task);
      return json({ ok: true, queued: true, id: parseInt(id) });
    }
    // No queue: run inline (best effort)
    const p = processFileAsync(parseInt(id), fi, f.chat_id || '', f.message_id || '', task.chat, task.from, date, env).catch(e => console.error('retry async:', e.message));
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
    return json({ ok: true, id: parseInt(id) });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// 未转存列表：已入库但 processing_state 不是 completed 的记录（pending/downloading/uploading/failed）
async function handleUnsavedList(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const u = new URL(request.url);
    const pg = clampInt(u.searchParams.get('page') || '1', 1, 1);
    const ps = clampInt(u.searchParams.get('page_size') || '20', 20, 1, 100);
    const off = (pg - 1) * ps;
    // 卡住超 30 分钟的记录标记为 failed（crashed waitUntil/queue 任务）
    try { await env.D1_DB.prepare("UPDATE files SET processing_state='failed' WHERE processing_state IN ('downloading','hashing','uploading','saving') AND deleted_at IS NULL AND julianday(created_at) < julianday('now','-30 minutes')").run(); } catch (e) {}
    const t = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND processing_state != 'completed'").first();
    const d = await env.D1_DB.prepare("SELECT id, file_name, file_type, file_size, chat_title, chat_id, message_id, telegram_file_id, processing_state, error_msg, created_at FROM files WHERE deleted_at IS NULL AND processing_state != 'completed' ORDER BY id DESC LIMIT ? OFFSET ?").bind(ps, off).all();
    return json({ ok: true, data: { total: t?.c || 0, page: pg, page_size: ps, total_pages: Math.ceil((t?.c || 0) / ps), items: d.results || [] } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// 批量重试未转存：body { ids:[...] } 或 { all:true }（默认最多 5 条 pending/failed）
async function handleUnsavedRetry(request, env, ctx) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const b = await request.json().catch(function(){ return null; });
    let rows = [];
    if (b && Array.isArray(b.ids) && b.ids.length) {
      const arr = b.ids.slice(0, 50);
      const marks = arr.map(function(){ return '?'; }).join(',');
      // 用展开运算符而非 bind.apply（D1 对 apply(null,...) 会报 dbSession null 错误）
      rows = (await env.D1_DB.prepare('SELECT * FROM files WHERE id IN (' + marks + ') AND deleted_at IS NULL').bind(...arr).all()).results || [];
    } else {
      // 免费版单调用最多 50 个子请求（每条转存约占 5-8 个），默认批 8 条最安全；limit 可指定（最大 10）
      const lim = (b && b.limit) ? Math.min(parseInt(b.limit) || 8, 10) : 8;
      rows = (await env.D1_DB.prepare("SELECT * FROM files WHERE deleted_at IS NULL AND processing_state IN ('pending','failed') ORDER BY id ASC LIMIT ?").bind(lim).all()).results || [];
    }
    let started = 0;
    for (const f of rows) {
      const fi = { type: f.file_type, fileId: f.telegram_file_id, fileName: f.file_name || 'file_' + f.id, fileSize: f.file_size || 0, width: f.width || 0, height: f.height || 0 };
      const date = new Date(f.created_at || Date.now());
      await env.D1_DB.prepare("UPDATE files SET processing_state='downloading', progress_bytes=0, total_bytes=?, error_msg='' WHERE id=?").bind(f.file_size || 0, f.id).run();
      const task = { dbId: f.id, fi: fi, chatId: f.chat_id || '', msgId: f.message_id || '', chat: { title: f.chat_title, username: f.chat_username, type: f.chat_type }, from: { id: f.user_id, username: f.username, first_name: '', last_name: '' }, date: date.toISOString() };
      if (env.FILE_QUEUE) {
        try { await env.FILE_QUEUE.send(task); started++; } catch (e) {}
      } else {
        const p = processFileAsync(f.id, fi, f.chat_id || '', f.message_id || '', task.chat, task.from, date, env).catch(function(e){ console.error('unsaved retry:', e.message); });
        if (ctx && ctx.waitUntil) ctx.waitUntil(p);
        started++;
      }
    }
    return json({ ok: true, started: started, total: rows.length });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// Cron 兜底转存：每次最多 2 条 pending/failed（scheduled 与 webhook 自愈、查重叠加，子请求预算 ~30）
async function retryUnsavedCron(env, ctx) {
  if (!env.D1_DB) return;
  try {
    const d = await env.D1_DB.prepare("SELECT id FROM files WHERE deleted_at IS NULL AND processing_state IN ('pending','failed') ORDER BY id ASC LIMIT 2").all();
    for (const row of d.results || []) {
      const f = await env.D1_DB.prepare('SELECT * FROM files WHERE id=?').bind(row.id).first();
      if (!f) continue;
      const fi = { type: f.file_type, fileId: f.telegram_file_id, fileName: f.file_name || 'file_' + f.id, fileSize: f.file_size || 0, width: f.width || 0, height: f.height || 0 };
      const date = new Date(f.created_at || Date.now());
      const task = { dbId: f.id, fi: fi, chatId: f.chat_id || '', msgId: f.message_id || '', chat: { title: f.chat_title, username: f.chat_username, type: f.chat_type }, from: { id: f.user_id, username: f.username, first_name: '', last_name: '' }, date: date.toISOString() };
      await env.D1_DB.prepare("UPDATE files SET processing_state='downloading', progress_bytes=0, total_bytes=?, error_msg='' WHERE id=?").bind(f.file_size || 0, f.id).run();
      if (env.FILE_QUEUE) {
        try { await env.FILE_QUEUE.send(task); } catch (e) {}
      } else {
        const p = processFileAsync(f.id, fi, f.chat_id || '', f.message_id || '', task.chat, task.from, date, env).catch(function(e){ console.error('cron retry:', e.message); });
        if (ctx && ctx.waitUntil) ctx.waitUntil(p);
        // 每条最多等 10s，避免整批超 scheduled 30s 限制
        await Promise.race([p, new Promise(function(res){ setTimeout(res, 10000); })]);
      }
    }
  } catch (e) { console.error('retryUnsavedCron:', e.message); }
}

// Processing status
async function handleProcessingStatus(env) {
  if (!env.D1_DB) return json({ ok: true, data: [] });
  try {
    try { await ensureTablesOnce(env.D1_DB); } catch (e) { console.error('ensureTables:', e.message); }
    // Mark records stuck for >30 min as failed (crashed waitUntil/queue tasks)
    // Note: created_at is ISO (2026-08-26T10:00:00.000Z), so use julianday() not string compare
    try {
      await env.D1_DB.prepare("UPDATE files SET processing_state='failed' WHERE processing_state IN ('downloading','hashing','uploading','saving') AND julianday(created_at) < julianday('now','-30 minutes')").run();
    } catch (e) {}
    const r = await env.D1_DB.prepare('SELECT id, file_name, file_type, file_size, processing_state, chat_title, created_at, error_msg, progress_bytes, total_bytes FROM files WHERE processing_state!=\'completed\' AND deleted_at IS NULL ORDER BY id DESC LIMIT 20').all();
    return json({ ok: true, data: r.results || [] });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// Dedup stats
async function handleDedupStats(env) {
  if (!env.D1_DB) return json({ ok: true, data: { total: 0, with_md5: 0, unique: 0, duplicates: 0 } });
  try {
    const [t, w, u] = await Promise.all([
      env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first(),
      env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND md5_hash!=''").first(),
      env.D1_DB.prepare('SELECT COUNT(DISTINCT md5_hash) as c FROM files WHERE deleted_at IS NULL AND md5_hash!=""').first()
    ]);
    const total = t?.c || 0;
    const withMd5 = w?.c || 0;
    const unique = u?.c || 0;
    return json({ ok: true, data: { total, with_md5: withMd5, unique, duplicates: withMd5 - unique } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// Dedup groups preview: show every duplicate group with its members and the
// keeper that would survive a cleanup, so admins can verify before purging.
// 已优化：原来每组 2 次 D1 查询（N+1，最多 100 次往返 → 慢），改为 3~4 次总查询。
async function handleDedupGroups(env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    await ensureTablesOnce(env.D1_DB);
    const dupRows = await env.D1_DB.prepare(
      'SELECT md5_hash, COUNT(*) as cnt FROM files WHERE deleted_at IS NULL AND md5_hash!="" GROUP BY md5_hash HAVING COUNT(*)>1 ORDER BY cnt DESC LIMIT 50'
    ).all();
    const dups = dupRows.results || [];
    if (!dups.length) return json({ ok: true, data: { total_groups: 0, groups: [] } });
    // 1) 一次性取所有组成员（md5 IN 分批，SQLite 单条变量上限 999）
    const allRows = [];
    const md5List = dups.map(function(d) { return d.md5_hash; });
    for (let i = 0; i < md5List.length; i += 200) {
      const chunk = md5List.slice(i, i + 200);
      const ph = chunk.map(function() { return '?'; }).join(',');
      const rr = await env.D1_DB.prepare(
        'SELECT id, file_name, file_type, file_size, created_at, storage_key, r2_url, pool_status, tags, md5_hash FROM files WHERE deleted_at IS NULL AND md5_hash IN (' + ph + ')'
      ).bind(...chunk).all();
      (rr.results || []).forEach(function(x) { allRows.push(x); });
    }
    // 2) 收集所有成员 id，统一查一次随机库引用（分批防超限）
    const allIds = allRows.map(function(x) { return x.id; });
    const poolRefs = await poolRefIds(env, allIds);
    // 3) 组内排序（与清理时一致：池导入 > 有标签 > 已完成 > 其他）并分组
    const byMd5 = {};
    allRows.forEach(function(f) { (byMd5[f.md5_hash] = byMd5[f.md5_hash] || []).push(f); });
    const groups = [];
    for (const d of dups) {
      const res = (byMd5[d.md5_hash] || []).sort(function(a, b) {
        const ka = a.pool_status === 'imported' ? 0 : (a.tags ? 1 : 2);
        const kb = b.pool_status === 'imported' ? 0 : (b.tags ? 1 : 2);
        return ka - kb || a.id - b.id;
      }).slice(0, 20);
      if (!res.length) continue;
      groups.push({
        md5: d.md5_hash,
        count: d.cnt,
        keeper_id: res[0].id,
        files: res.map(function(f) { return { id: f.id, file_name: f.file_name, file_type: f.file_type, file_size: f.file_size, created_at: f.created_at, r2_url: f.r2_url || '', pool_ref: poolRefs.has(String(f.id)) }; })
      });
    }
    return json({ ok: true, data: { total_groups: groups.length, groups: groups } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 随机库引用 id 集合（分批查，避免 SQLite IN 变量超限）
async function poolRefIds(env, ids) {
  const set = new Set();
  for (let i = 0; i < ids.length; i += 800) {
    const chunk = ids.slice(i, i + 800);
    if (!chunk.length) continue;
    const pr = await env.D1_DB.prepare('SELECT tg_file_id FROM random_pool WHERE tg_file_id IN (' + chunk.join(',') + ')').all();
    (pr.results || []).forEach(function(x) { set.add(String(x.tg_file_id)); });
  }
  return set;
}

// 按行清理/保留：keep = 保留该 id 并清理同组其他；del = 只清理该 id。
// 默认软删（移入回收站），purge=1 硬删（含 R2 对象）。池引用文件自动跳过。
async function handleDedupRow(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const body = await request.json().catch(function() { return {}; });
    const md5 = String(body.md5 || '').trim();
    const id = Number(body.id) || 0;
    const action = body.action;
    const purge = body.purge === 1 || body.purge === '1';
    if (!md5 || !id || (action !== 'keep' && action !== 'del')) return json({ ok: false, error: '参数错误：需要 md5 / id / action(keep|del)' });
    const rows = await env.D1_DB.prepare("SELECT id, storage_key FROM files WHERE md5_hash=? AND deleted_at IS NULL").bind(md5).all();
    const res = rows.results || [];
    const poolRefs = await poolRefIds(env, res.map(function(x) { return x.id; }));
    let targets = [];
    if (action === 'keep') {
      targets = res.filter(function(r) { return r.id !== id && !poolRefs.has(String(r.id)); });
    } else {
      targets = res.filter(function(r) { return r.id === id && !poolRefs.has(String(r.id)); });
    }
    const cleaned = await purgeFileRows(env, targets, purge);
    const mode = purge ? '硬删除' : '移入回收站';
    const kept = action === 'keep' ? '（保留 id=' + id + '）' : '';
    return json({ ok: true, data: { cleaned: cleaned, message: (action === 'keep' ? '保留并清理同组' : '清理') + ' ' + cleaned + ' 个文件，已' + mode + kept + '。池引用文件已自动跳过。' } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// 批量清理选中的文件行（复选框多选）
async function handleDedupRows(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const body = await request.json().catch(function() { return {}; });
    const ids = (body.ids || []).map(Number).filter(Boolean);
    const purge = body.purge === 1 || body.purge === '1';
    if (!ids.length) return json({ ok: false, error: '未选择文件' });
    const ph = ids.map(function() { return '?'; }).join(',');
    const rows = await env.D1_DB.prepare("SELECT id, storage_key FROM files WHERE deleted_at IS NULL AND id IN (" + ph + ")").bind(...ids).all();
    const res = rows.results || [];
    const poolRefs = await poolRefIds(env, res.map(function(x) { return x.id; }));
    const targets = res.filter(function(r) { return !poolRefs.has(String(r.id)); });
    const cleaned = await purgeFileRows(env, targets, purge);
    const mode = purge ? '硬删除' : '移入回收站';
    return json({ ok: true, data: { cleaned: cleaned, skipped: res.length - targets.length, message: '已清理 ' + cleaned + ' 个文件（' + mode + '）' + (res.length - targets.length ? '，跳过池引用 ' + (res.length - targets.length) + ' 个。' : '。') } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// 批量软删/硬删（含 R2 对象，最后引用才删），返回实际清理数
async function purgeFileRows(env, targets, purge) {
  const now = new Date().toISOString();
  let cleaned = 0;
  for (const f of targets) {
    try {
      if (purge) {
        if (f.storage_key) {
          const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=?').bind(f.storage_key).first();
          if (!ref || (ref.c || 0) <= 1) { try { await env.R2_BUCKET.delete(f.storage_key); } catch (e) {} }
        }
        const r = await env.D1_DB.prepare('DELETE FROM files WHERE id=?').bind(f.id).run();
        if (r.meta && r.meta.changes) cleaned++;
      } else {
        const r = await env.D1_DB.prepare('UPDATE files SET deleted_at=? WHERE id=? AND deleted_at IS NULL').bind(now, f.id).run();
        if (r.meta && r.meta.changes) cleaned++;
      }
    } catch (e) {}
  }
  return cleaned;
}

// 后台 WebP 压缩：每 5 分钟最多 2 张（与手动 run 共享逻辑，限时 20s 防挤占 scheduled 预算）
async function compressCronBatch(env) {
  if (!env.D1_DB || !env.R2_BUCKET || !env.R2_PUBLIC_URL) return;
  try {
    const last = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='last_compress_cron'").first();
    if (last && last.value && (Date.now() - (parseInt(last.value, 10) || 0)) < 300000) return;
    const startT = Date.now();
    const rows = await env.D1_DB.prepare("SELECT id, storage_key, file_size FROM files WHERE deleted_at IS NULL AND storage_key!='' AND processing_state='completed' AND file_type='photo' AND (mime_type='' OR mime_type IN ('image/jpeg','image/png')) AND (storage_key LIKE '%.jpg' OR storage_key LIKE '%.jpeg' OR storage_key LIKE '%.png') ORDER BY file_size DESC LIMIT 2").all();
    let done = 0;
    for (const f of rows.results || []) {
      if (Date.now() - startT > 20000) break;
      try {
        const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=?').bind(f.storage_key).first();
        if (!ref || (ref.c || 0) > 1) continue;
        const res = await fetch(env.R2_PUBLIC_URL + '/' + f.storage_key, { cf: { image: { format: 'webp', quality: 80, fit: 'scale-down' } } });
        if (!res.ok) continue;
        const ct = res.headers.get('content-type') || '';
        if (ct.indexOf('webp') === -1) continue;
        const wbuf = await res.arrayBuffer();
        if (!wbuf.byteLength || wbuf.byteLength >= (f.file_size || 0)) continue;
        await env.R2_BUCKET.put(f.storage_key, wbuf, { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000' } });
        await env.D1_DB.prepare("UPDATE files SET mime_type='image/webp', file_size=?, md5_hash='', quick_hash='' WHERE id=?").bind(wbuf.byteLength, f.id).run();
        done++;
      } catch (e) {}
    }
    if (done) console.log('compress cron batch done:', done);
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('last_compress_cron', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(Date.now())).run();
  } catch (e) { console.error('compressCronBatch:', e.message); }
}

// 日报：cron "0 1 * * *"（UTC 01:00 = 北京 09:00）推送昨日转存汇总到管理员
async function sendDailyReport(env) {
  if (!env.D1_DB || !env.TG_BOT_TOKEN) return;
  try {
    let chatId = '';
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'admin_chat_id'").first();
    if (s && s.value) chatId = String(s.value).trim();
    if (!chatId && env.ADMIN_CHAT_ID) chatId = String(env.ADMIN_CHAT_ID).trim();
    if (!chatId) return;
    const dayStart = new Date(Date.now() - 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';
    const dayEnd = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
    const yNew = await env.D1_DB.prepare('SELECT COUNT(*) as c, COALESCE(SUM(file_size),0) as s FROM files WHERE created_at>=? AND created_at<?').bind(dayStart, dayEnd).first();
    const total = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first();
    const trash = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NOT NULL').first();
    let storageTxt = '';
    try {
      const ru = await handleAdminR2Usage(env);
      const rj = (ru instanceof Response) ? await ru.json() : ru;
      if (rj && rj.ok && rj.data) {
        storageTxt = 'R2 存储 ' + (rj.data.storage_bytes / 1073741824).toFixed(2) + ' GB / 10 GB（' + (rj.data.storage_pct !== null && rj.data.storage_pct !== undefined ? rj.data.storage_pct + '%' : '—') + '）';
      }
    } catch (e) {}
    const dayStr = new Date().toISOString().slice(0, 10);
    const reqs = await env.D1_DB.prepare('SELECT COALESCE(SUM(requests),0) as r FROM worker_stats WHERE day=?').bind(dayStr).first();
    const text = '\uD83D\uDCC5 图库日报\n\u2022 昨日新增：' + ((yNew && yNew.c) || 0) + ' 个 / ' + fmtSize((yNew && yNew.s) || 0) + '\n\u2022 文件总数：' + ((total && total.c) || 0) + ' 个\n\u2022 回收站待清：' + ((trash && trash.c) || 0) + ' 个（>30 天自动硬清）\n\u2022 ' + storageTxt + '\n\u2022 今日请求（本地计数）：' + ((reqs && reqs.r) || 0) + ' 次';
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true })
    });
  } catch (e) { console.error('sendDailyReport:', e.message); }
}

// 回收站自动清理：deleted_at 超过 30 天的文件硬删（含 R2 对象），24 小时最多执行一次。
// 与手动"清空回收站"不同，这里是兜底，防止软删文件无限占 R2 存储。
async function storageMaintenanceCron(env) {
  if (!env.D1_DB || !env.R2_BUCKET) return;
  try {
    const last = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='last_storage_maintenance'").first();
    if (last && last.value && (Date.now() - (parseInt(last.value, 10) || 0)) < 86400000) return;
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const rows = await env.D1_DB.prepare('SELECT id, storage_key FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 500').bind(cutoff).all();
    let purged = 0;
    for (const f of rows.results || []) {
      try {
        if (f.storage_key) {
          const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=? AND deleted_at IS NULL').bind(f.storage_key).first();
          if (!ref || (ref.c || 0) <= 0) { try { await env.R2_BUCKET.delete(f.storage_key); } catch (e) {} }
        }
        const r = await env.D1_DB.prepare('DELETE FROM files WHERE id=?').bind(f.id).run();
        if (r.meta && r.meta.changes) purged++;
      } catch (e) {}
    }
    await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('last_storage_maintenance', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(Date.now())).run();
    if (purged) console.log('storage maintenance purged:', purged);
  } catch (e) { console.error('storageMaintenanceCron:', e.message); }
}

// 存储压缩：photo (JPEG/PNG) → WebP 覆盖写回，省 50~70% 存储。
// 依赖 Cloudflare Image Resizing（cf.image 参数），账号未启用时明确报错。
// 分批执行（每批 3 张，限时），只处理 storage_key 唯一引用的文件，避免破坏去重。
async function handleCompressStats(env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const r = await env.D1_DB.prepare("SELECT COUNT(*) as c, COALESCE(SUM(file_size),0) as s FROM files WHERE deleted_at IS NULL AND storage_key!='' AND processing_state='completed' AND file_type='photo' AND (mime_type='' OR mime_type IN ('image/jpeg','image/png')) AND (storage_key LIKE '%.jpg' OR storage_key LIKE '%.jpeg' OR storage_key LIKE '%.png')").first();
    return json({ ok: true, data: { files: r?.c || 0, bytes: r?.s || 0, note: '统计转存且为 JPEG/PNG 的图片，压缩为 WebP 预计可省 50~70%。需账号启用 Cloudflare Image Resizing（Pro 或按量开通），未启用时运行会明确提示。' } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

async function handleCompressRun(request, env) {
  if (!env.D1_DB || !env.R2_BUCKET || !env.R2_PUBLIC_URL) return json({ ok: false, error: 'D1/R2 未配置' });
  try {
    var n = parseInt((request && new URL(request.url).searchParams.get('n')) || '10', 10);
    if (!(n > 0)) n = 10;
    if (n > 20) n = 20;
    const startT = Date.now();
    const rows = await env.D1_DB.prepare("SELECT id, storage_key, file_size FROM files WHERE deleted_at IS NULL AND storage_key!='' AND processing_state='completed' AND file_type='photo' AND (mime_type='' OR mime_type IN ('image/jpeg','image/png')) AND (storage_key LIKE '%.jpg' OR storage_key LIKE '%.jpeg' OR storage_key LIKE '%.png') ORDER BY file_size DESC LIMIT ?").bind(n).all();
    if (!(rows.results || []).length) return json({ ok: true, data: { done: 0, skipped: 0, not_available: false, message: '没有可压缩的图片了（已全部转 WebP）。' } });
    let done = 0, skipped = 0, webpFail = 0;
    for (const f of rows.results) {
      if (Date.now() - startT > 50000) break;
      try {
        const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=?').bind(f.storage_key).first();
        if (!ref || (ref.c || 0) > 1) { skipped++; continue; }
        const url = env.R2_PUBLIC_URL + '/' + f.storage_key;
        const res = await fetch(url, { cf: { image: { format: 'webp', quality: 80, fit: 'scale-down' } } });
        if (!res.ok) { skipped++; continue; }
        const ct = res.headers.get('content-type') || '';
        if (ct.indexOf('webp') === -1) { webpFail++; skipped++; continue; } // 该文件未转成 webp（如超大图超限）
        const wbuf = await res.arrayBuffer();
        if (!wbuf.byteLength || wbuf.byteLength >= (f.file_size || 0)) { skipped++; continue; } // 未变小不覆盖
        await env.R2_BUCKET.put(f.storage_key, wbuf, { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000' } });
        await env.D1_DB.prepare("UPDATE files SET mime_type='image/webp', file_size=?, md5_hash='', quick_hash='' WHERE id=?").bind(wbuf.byteLength, f.id).run();
        done++;
      } catch (e) { console.log('compress item fail:', e.message); }
    }
    const notAvailable = (webpFail > 0 && done === 0);
    const msg = notAvailable
      ? 'Cloudflare Image Resizing 未生效（需账号启用，通常为 Pro 套餐或按量开通）。可通过 fetch 加 cf.image 转换的 Worker 验证；未启用时无法转 WebP，可先用回收站清理/去重释放空间。'
      : ('本轮压缩 ' + done + ' 张为 WebP' + (skipped ? '，跳过 ' + skipped + ' 张（被多行引用/未变小/超大图超限）' : '') + '。分批执行（每批 ' + n + ' 张），可重复点击或 cron 自动加速。');
    return json({ ok: true, data: { done, skipped, not_available: notAvailable, message: msg } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// 查重分批执行（手动/定时共用）：算 N 个缺失 MD5，再清理 G 个重复组。
// 免费版单调用 50 子请求 + 30s 墙钟：手动 N=15/G=3/限时25s，定时 N=5/G=1/限时12s。
async function runDedupBatch(env, computeN, cleanGroups, timeLimitMs, purge) {
  if (!env.D1_DB) return { computed: 0, cleaned: 0, groups: 0 };
  const startT = Date.now();
  const deadline = timeLimitMs || 25000;
  function timedOut() { return Date.now() - startT > deadline; }
  // 1) 算缺失 MD5（每个 R2 读取限时，避免大文件拖垮整批）
  let computed = 0;
  const missing = await env.D1_DB.prepare("SELECT id, storage_key FROM files WHERE deleted_at IS NULL AND (md5_hash='' OR md5_hash IS NULL) LIMIT ?").bind(computeN).all();
  for (const f of (missing.results || [])) {
    if (timedOut()) break;
    try {
      const obj = await Promise.race([env.R2_BUCKET.get(f.storage_key), new Promise(function(res){ setTimeout(function(){ res(null); }, 4000); })]);
      if (!obj) continue;
      const buf = await Promise.race([obj.arrayBuffer(), new Promise(function(res){ setTimeout(function(){ res(null); }, 8000); })]);
      if (!buf) continue;
      const md5 = await computeMd5(buf);
      await env.D1_DB.prepare('UPDATE files SET md5_hash=? WHERE id=?').bind(md5, f.id).run();
      computed++;
    } catch (e) { console.log('dedup compute error:', e.message); }
  }
  // 2) 清理 G 个重复组（每组 1 个查询 + poolRefs + 逐行软删/硬删）
  let cleaned = 0, groups = 0;
  const dups = await env.D1_DB.prepare('SELECT md5_hash FROM files WHERE deleted_at IS NULL AND md5_hash!="" GROUP BY md5_hash HAVING COUNT(*)>1 LIMIT ?').bind(cleanGroups).all();
  const now = new Date().toISOString();
  for (const d of (dups.results || [])) {
    if (timedOut()) break;
    groups++;
    try {
      const rows = await env.D1_DB.prepare(
        "SELECT id, storage_key FROM files WHERE md5_hash=? AND deleted_at IS NULL ORDER BY CASE WHEN pool_status='imported' THEN 0 WHEN tags!='' THEN 1 WHEN processing_state='completed' THEN 2 ELSE 3 END, id ASC LIMIT 200"
      ).bind(d.md5_hash).all();
      const res = rows.results || [];
      if (res.length < 2) continue;
      // Rows still referenced by random_pool are NEVER cleaned (avoid dangling refs)
      const poolRefs = new Set();
      try {
        const pr = await env.D1_DB.prepare('SELECT tg_file_id FROM random_pool WHERE tg_file_id IN (' + res.map(function(x){ return x.id; }).join(',') + ')').all();
        (pr.results || []).forEach(function(x){ poolRefs.add(String(x.tg_file_id)); });
      } catch (e) {}
      for (let i = 1; i < res.length; i++) {
        if (timedOut()) break;
        const f = res[i];
        if (poolRefs.has(String(f.id))) continue;
        try {
          if (purge) {
            // Hard delete: remove R2 object (last reference only) then the row
            if (f?.storage_key) {
              const ref = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE storage_key=?').bind(f.storage_key).first();
              if (!ref || (ref.c || 0) <= 1) { try { await env.R2_BUCKET.delete(f.storage_key); } catch (e) {} }
            }
            const r = await env.D1_DB.prepare('DELETE FROM files WHERE id=?').bind(f.id).run();
            if (r.meta && r.meta.changes) cleaned++;
          } else {
            const r = await env.D1_DB.prepare('UPDATE files SET deleted_at=? WHERE id=? AND deleted_at IS NULL').bind(now, f.id).run();
            if (r.meta && r.meta.changes) cleaned++;
          }
        } catch (e) {}
      }
    } catch (e) {}
  }
  return { computed, cleaned, groups };
}

// Dedup existing files: compute missing MD5s, then clean duplicates.
// 已后台化：手动点击只跑一批（15 MD5 + 3 组），剩余由 cron 每 5 分钟自动分批完成。
async function handleDedup(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    await ensureTablesOnce(env.D1_DB);
    const purge = new URL(request.url).searchParams.get('purge') === '1';
    const r = await runDedupBatch(env, 15, 3, 25000, purge);
    const mode = purge ? '硬删除' : '移入回收站';
    return json({ ok: true, data: { computed: r.computed, duplicate_groups: r.groups, cleaned: r.cleaned, purge, message: '本轮计算 MD5 ' + r.computed + ' 个、清理重复 ' + r.cleaned + ' 个（' + mode + '）。剩余由定时任务每 5 分钟自动分批完成，可再次点击加速。' } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

async function handleAdminCommands(env) {
  if (!env.D1_DB) return json({ ok: true, data: [] });
  try {
    await ensureTablesOnce(env.D1_DB);
    const d = await env.D1_DB.prepare('SELECT * FROM bot_commands ORDER BY id ASC').all();
    return json({ ok: true, data: d.results || [] });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminAddCommand(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not configured' });
  try {
    await ensureTablesOnce(env.D1_DB);
    const in2 = await request.json();
    const cmd = (in2.command || '').trim().toLowerCase();
    const resp = (in2.response || '').trim();
    const desc = (in2.description || '').trim();
    const menu = (in2.menu || '').trim();
    if (!cmd || !resp) return json({ ok: false, error: 'command and response required' });
    await env.D1_DB.prepare('INSERT OR REPLACE INTO bot_commands (command, response, description, enabled, menu) VALUES (?, ?, ?, ?, ?)').bind(cmd, resp, desc, in2.enabled !== false ? 1 : 0, menu).run();
    return json({ ok: true, message: 'Command added' });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminUpdateCommand(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not configured' });
  try {
    const in2 = await request.json();
    if (!in2.id) return json({ ok: false, error: 'id required' });
    const fields = [];
    const vals = [];
    if (in2.command !== undefined) { fields.push('command = ?'); vals.push(in2.command.trim().toLowerCase()); }
    if (in2.response !== undefined) { fields.push('response = ?'); vals.push(in2.response.trim()); }
    if (in2.description !== undefined) { fields.push('description = ?'); vals.push(in2.description.trim()); }
    if (in2.menu !== undefined) { fields.push('menu = ?'); vals.push(String(in2.menu).trim()); }
    if (in2.enabled !== undefined) { fields.push('enabled = ?'); vals.push(in2.enabled ? 1 : 0); }
    if (fields.length === 0) return json({ ok: false, error: 'nothing to update' });
    vals.push(in2.id);
    await env.D1_DB.prepare('UPDATE bot_commands SET ' + fields.join(', ') + ' WHERE id = ?').bind(...vals).run();
    return json({ ok: true, message: 'Updated' });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleAdminDeleteCommand(request, env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not configured' });
  try {
    const u = new URL(request.url);
    const id = u.searchParams.get('id');
    if (!id) return json({ ok: false, error: 'id required' });
    await env.D1_DB.prepare('DELETE FROM bot_commands WHERE id = ?').bind(parseInt(id)).run();
    return json({ ok: true, message: 'Deleted' });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ==================== ADMIN PAGE ====================

async function handleAdminFromR2(env) {
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


// ==================== DOCS ====================

function handleDocs() {
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

async function handleDashboard(env) {
  let sh = '<div style="color:#64748b">loading...</div>';
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first();
    const s = await env.D1_DB.prepare('SELECT SUM(file_size) as s FROM files WHERE deleted_at IS NULL').first();
    const td = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=date('now')").first();
    const mo = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=date('now','start of month')").first();
    sh = '<div class="card"><div class="ct2">Total</div><div class="sv">' + (t?.c || 0) + '</div></div>'
      + '<div class="card"><div class="ct2">Storage</div><div class="sv">' + fmtSize(s?.s || 0) + '</div></div>'
      + '<div class="card"><div class="ct2">Today</div><div class="sv">' + (td?.c || 0) + '</div></div>'
      + '<div class="card"><div class="ct2">Month</div><div class="sv">' + (mo?.c || 0) + '</div></div>';
  } catch (e) {}
  return new Response('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0f172a;color:#e2e8f0}.hd{background:linear-gradient(135deg,#1e3a5f,#0f172a);padding:20px 30px;border-bottom:1px solid #1e293b}.hd h1{font-size:22px}.hd p{color:#94a3b8;margin-top:5px}.ct{max-width:1200px;margin:0 auto;padding:20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:15px;margin-bottom:20px}.card{background:#1e293b;border-radius:10px;padding:18px;border:1px solid #334155}.ct2{font-size:13px;color:#94a3b8;text-transform:uppercase;margin-bottom:10px}.sv{font-size:28px;font-weight:700;color:#60a5fa}.btn{background:#3b82f6;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px}.btn:hover{background:#2563eb}.sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.si{display:flex;align-items:center;gap:10px;padding:12px;background:#0f172a;border-radius:8px}.dot{width:10px;height:10px;border-radius:50%}.dot.ok{background:#22c55e}.dot.err{background:#ef4444}.dot.ld{background:#f59e0b;animation:p 1s infinite}@keyframes p{0%,100%{opacity:1}50%{opacity:.5}}.si h3{font-size:13px}.si p{font-size:11px;color:#64748b;margin-top:2px}.lg{background:#0f172a;border-radius:8px;padding:12px;max-height:200px;overflow-y:auto;font-family:monospace;font-size:11px;line-height:1.8}.le{color:#94a3b8}.le.ok{color:#22c55e}.le.err{color:#ef4444}.lt{color:#475569}</style></head><body>'
    + '<div class="hd"><h1>TG Bot Dashboard v6</h1><p>R2 + D1 + Custom Bot API</p></div>'
    + '<div class="ct"><div class="grid">' + sh + '</div>'
    + '<div class="card" style="margin-bottom:20px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h3 style="font-size:16px">Status</h3><button class="btn" onclick="go()" id="rb">Refresh</button></div>'
    + '<div class="sg"><div class="si"><div class="dot ld" id="d-h"></div><div><h3>Health</h3><p id="m-h">...</p></div></div>'
    + '<div class="si"><div class="dot ld" id="d-d"></div><div><h3>D1</h3><p id="m-d">...</p></div></div>'
    + '<div class="si"><div class="dot ld" id="d-r"></div><div><h3>R2</h3><p id="m-r">...</p></div></div>'
    + '<div class="si"><div class="dot ld" id="d-t"></div><div><h3>Telegram</h3><p id="m-t">...</p></div></div></div></div>'
    + '<div class="card"><h3 style="font-size:16px;margin-bottom:10px">Logs</h3><div class="lg" id="logs"></div></div></div>'
    + '<script>var K=localStorage.getItem("ak")||prompt("API Key:");if(K)localStorage.setItem("ak",K);var H={"X-API-Key":K},L=document.getElementById("logs");function lg(m,t){var t2=new Date().toLocaleTimeString();L.innerHTML="<div class=\\"le "+(t||"")+"\\"><span class=\\"lt\\">["+t2+"]</span> "+m+"</div>"+L.innerHTML}function sd(n,ok,m){document.getElementById("d-"+n).className="dot "+(ok?"ok":"err");document.getElementById("m-"+n).textContent=m}async function ck(n,u,okm,erm){try{var r=await fetch(u,{headers:H});var d=await r.json();var m=r.ok?okm:(d.error||"Error");sd(n,r.ok,m);lg(n+": "+m,r.ok?"ok":"err");return r.ok}catch(e){sd(n,false,e.message);lg(n+": "+e.message,"err");return false}}async function go(){document.getElementById("rb").disabled=true;await ck("h","/health","OK","Failed");await ck("d","/api/stats","D1 OK","D1 Error");await ck("r","/api/files?page_size=1","R2 OK","R2 Error");await ck("t","/health","Bot OK","Error");document.getElementById("rb").disabled=false;lg("Done","ok")}go()</script></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ==================== UTILS ====================
// json/cors/fmtSize/genHash 已移入 src/util.js（顶部 import）

function guessExt(ct, fn) { const e = fn.split('.').pop().toLowerCase(); if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mp3', 'ogg', 'pdf', 'zip', 'txt'].includes(e)) return e; if (ct?.includes('jpeg')) return 'jpg'; if (ct?.includes('png')) return 'png'; if (ct?.includes('gif')) return 'gif'; if (ct?.includes('webp')) return 'webp'; if (ct?.includes('video')) return 'mp4'; if (ct?.includes('audio')) return 'mp3'; if (ct?.includes('pdf')) return 'pdf'; return 'bin'; }

// 宽松扩展名推断（任意扩展名都保留，用于代理 URL 带后缀，如 /file/tg/123.jpg）
function fileExtOf(fileName, type) {
  const m = /\.([a-zA-Z0-9]{1,10})$/.exec(String(fileName || ''));
  if (m) return m[1].toLowerCase();
  const map = { photo: 'jpg', video: 'mp4', audio: 'mp3', voice: 'ogg', document: 'bin' };
  return map[type] || 'bin';
}
