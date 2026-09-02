// ==================== COMMANDS / MENU / AI / R2 USAGE ====================
// 数字菜单交互、AI 管理（function calling）、R2 用量统计与套餐配额、Bot 命令处理器。
// 依赖 telegram.js（回复/键盘/文件签名）与 admin.js（handleUnsavedRetry，循环 import，运行时调用安全）。
import { json, fmtSize } from "./util.js";
import { ensureTablesOnce } from "./db.js";
import { cnShift, cnTodayStr, cnDayIso, cnNowISO, fileExtOf, CN_OFFSET_MS, splitTags } from "./core.js";
import { replyText, replyTextPlain, MAIN_BUTTONS, sendQuickReplyKeyboard, replyTextWithKeyboard, fileTok } from "./telegram.js";
import { handleUnsavedRetry } from "./admin.js";

// ==================== BOT COMMANDS ====================

export const DEFAULT_COMMANDS = {
  '/start': '👋 欢迎！发送任意文件即可自动入库并转存到云端存储。\n\n常用命令:\n/count - 查询现有数量\n/pending - 查询未转存数量\n/retry - 继续完成未转存入库\n/health - 查询服务状态\n/stats - 完整统计\n/file <id> - 按 ID 获取文件\n/search <关键词> - 搜索文件\n/img <标签> - 从共享库随机抽图',
  '/help': '📖 可用命令:\n\n/count - 查询现有数量\n/pending - 查询未转存数量\n/retry - 继续完成未转存入库\n/health - 查询服务状态\n/stats - 完整统计\n/file <id> - 按 ID 获取文件\n/search <关键词> - 搜索文件\n/img <标签> - 从共享库随机抽图\n\n直接发送文件（图片/视频/文档/音频）即可自动保存！',
  '/stats': '__STATS__',
  '/file': 'Usage: /file <id>\nExample: /file 123',
  '/search': 'Usage: /search <keyword>\nExample: /search cat',
  '/img': 'Usage: /img <标签1,标签2 或 关键词>\nExample: /img 风景 或 /img 美女',
};

// ==================== 数字菜单交互（1/2/3 选择） ====================
// 命令的 menu 字段：JSON 数组 [{"n":1,"label":"重试全部未转存","action":"retry_all"},...]
// action 支持内置操作（retry_all/retry_recent/unsaved_count/count/stats/health/help/pending）或 text:xxx 直接回复
export function parseMenu(menuStr) {
  if (!menuStr) return [];
  try {
    const arr = JSON.parse(menuStr);
    if (!Array.isArray(arr)) return [];
    return arr.filter(function(m) {
      if (!m || !m.label) return false;
      if (typeof m.n === 'string') m.n = parseInt(m.n, 10); // 后台可能以字符串存 n，统一归一为数字
      return typeof m.n === 'number' && Number.isFinite(m.n) && Number.isInteger(m.n);
    });
  } catch (e) { return []; }
}
export function menuButtons(items) {
  var row = [];
  for (var i = 0; i < items.length; i++) row.push({ text: items[i].label, callback_data: 'menu:n:' + items[i].n });
  return [row];
}
export function menuText(items) {
  var s = '';
  for (var i = 0; i < items.length; i++) s += items[i].n + '. ' + items[i].label + '\n';
  return s;
}
export async function setMenuCtx(env, chatId, cmd, items) {
  try {
    const payload = { cmd: cmd, items: items, expires_at: Date.now() + 30 * 60 * 1000 };
    await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind('menu_ctx_' + chatId, JSON.stringify(payload)).run();
  } catch (e) {}
}
export async function getMenuCtx(env, chatId) {
  try {
    const r = await env.D1_DB.prepare("SELECT value FROM settings WHERE key=?").bind('menu_ctx_' + chatId).first();
    if (r && r.value) {
      const j = JSON.parse(r.value);
      if (j && Array.isArray(j.items)) {
        // 30 分钟 TTL：过期菜单不可再用，避免用户隔天发 "2" 仍触发旧动作
        if (!j.expires_at || Date.now() < j.expires_at) return j;
        try { await env.D1_DB.prepare('DELETE FROM settings WHERE key=?').bind('menu_ctx_' + chatId).run(); } catch (e) {}
      }
    }
  } catch (e) {}
  return null;
}
export async function clearMenuCtx(env, chatId) {
  if (!env || !env.D1_DB || !chatId) return;
  try { await env.D1_DB.prepare('DELETE FROM settings WHERE key=?').bind('menu_ctx_' + chatId).run(); } catch (e) {}
}
export async function execMenuAction(action, chatId, env, msgId) {
  // 无论动作是否有效，执行后都清掉菜单上下文：避免旧菜单被反复触发
  await clearMenuCtx(env, chatId);
  if (!action) { await replyText(chatId, msgId || 0, '❌ 无效选项', env); return; }
  if (action.indexOf('text:') === 0) {
    await replyTextWithKeyboard(chatId, action.slice(5), MAIN_BUTTONS, env);
    return;
  }
  if (action === 'retry_all') return await handleRetryCommand(chatId, env, null, 8, true);
  if (action === 'retry_recent') return await handleRetryCommand(chatId, env, null, 8, false);
  if (action === 'unsaved_count' || action === 'pending') return await handlePendingCommand(chatId, env);
  if (action === 'count') return await handleCountCommand(chatId, env);
  if (action === 'stats') return await handleStatsCommand(chatId, env);
  if (action === 'health') return await handleHealthCommand(chatId, env);
  if (action === 'help') { await replyTextWithKeyboard(chatId, DEFAULT_COMMANDS['/help'], MAIN_BUTTONS, env); return; }
  await replyTextWithKeyboard(chatId, '❌ 未知操作：' + action, MAIN_BUTTONS, env);
}
export async function replyCommandMenu(chatId, msgId, cmd, resp, items, env) {
  const txt = (resp || ('📋 ' + cmd + ' 菜单')) + '\n\n' + menuText(items) + '\n（回复数字或点击按钮）';
  await replyTextWithKeyboard(chatId, txt, menuButtons(items), env);
  await setMenuCtx(env, chatId, cmd, items);
}

// ==================== AI 管理（function calling） ====================
export let _aiCfgCache = null, _aiCfgAt = 0;
export async function getAIConfig(env) {
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
export async function handleAdminGetAI(env) {
  const c = await getAIConfig(env);
  return json({ ok: true, data: { enabled: c.enabled, base: c.base, model: c.model, api_key: c.key ? String(c.key).slice(0, 4) + '****' : '', has_key: !!c.key, prompt: c.prompt } });
}
export async function handleAdminSaveAI(request, env) {
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
export async function cfR2Usage(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return { _err: 'no CF_API_TOKEN or CF_ACCOUNT_ID' };
  const gql = function(q) {
    return fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.CF_API_TOKEN },
      body: JSON.stringify({ query: q })
    }).then(function(r) { return r.json(); });
  };
  const acct = String(env.CF_ACCOUNT_ID).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  try {
    const endDate = cnNowISO();
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
export async function handleUsageForecast(env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    await ensureTablesOnce(env.D1_DB);
    const cnNow = cnShift(new Date());
    const dayStr = cnNow.toISOString().slice(0, 10);
    const hourNow = cnNow.getUTCHours() + 1; // 已过小时数（1-24）
    const t = await env.D1_DB.prepare('SELECT COALESCE(SUM(requests),0) as r FROM worker_stats WHERE day=?').bind(dayStr).first();
    const today = (t && t.r) || 0;
    const quota = 100000;
    const projected = hourNow > 0 ? Math.round(today / hourNow * 24) : today;
    const daysToQuota = projected > 0 ? Math.max(1, Math.floor(quota / projected)) : null;
    const todayStart = cnDayIso(dayStr);
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
    const trendBase = Date.now() + CN_OFFSET_MS;
    const dStart = new Date(trendBase - 13 * 86400000).toISOString().slice(0, 10);
    const hist = await env.D1_DB.prepare('SELECT day, requests FROM worker_stats WHERE day>=? ORDER BY day').bind(dStart).all();
    const map = {};
    (hist.results || []).forEach(function(r) { map[r.day] = r.requests; });
    const trend = [];
    for (let i = 13; i >= 0; i--) {
      const dd = new Date(trendBase - i * 86400000).toISOString().slice(0, 10);
      trend.push({ day: dd.slice(5), requests: map[dd] || 0 });
    }
    return json({ ok: true, data: { today_requests: today, today_projected: projected, quota: quota, days_to_quota: daysToQuota, new_files: newFiles, new_bytes: newBytes, storage_bytes: storageBytes, storage_remaining: storageRemaining, capacity: cap, days_to_full: daysToFull, trend: trend } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

// 官方 Worker 用量：Cloudflare GraphQL Analytics（workersInvocationsAdaptiveGroups）
// 需要 secret CF_API_TOKEN（权限：Account.Workers Analytics:Read）+ var CF_ACCOUNT_ID
export async function cfWorkerUsage(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return { _err: 'no CF_API_TOKEN or CF_ACCOUNT_ID' };
  const acct = String(env.CF_ACCOUNT_ID).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const gql = function(q) {
    return fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.CF_API_TOKEN },
      body: JSON.stringify({ query: q })
    }).then(function(r) { return r.json(); });
  };
  try {
    const cnNow = cnShift(new Date());
    const dayStr = cnNow.toISOString().slice(0, 10);
    const todayStart = cnDayIso(dayStr);
    const nowIso = cnNowISO();
    const monthStart = cnDayIso(dayStr.slice(0, 8) + '01');
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

export async function handleAdminWorkerUsage(env) {
  if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' });
  try {
    const dayStr = cnTodayStr();
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
export async function handleAdminR2Usage(env) {
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
export async function handleAdminGetR2Quota(env) {
  try {
    const map = {};
    const q = await env.D1_DB.prepare("SELECT key, value FROM settings WHERE key = 'r2_plan'").all();
    (q.results || []).forEach(function(r) { map[r.key] = r.value; });
    const plan = map.r2_plan === 'paid' ? 'paid' : 'free';
    return json({ ok: true, data: { plan: plan, free: { capacity_gb: 10, class_a_quota: 1000000, class_b_quota: 10000000 } } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}
export async function handleAdminSaveR2Quota(request, env) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const plan = b.plan === 'paid' ? 'paid' : 'free';
    await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES ('r2_plan',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(plan).run();
    return json({ ok: true, data: { saved: true, plan: plan } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
export var AI_TOOLS = [
  { type: 'function', function: { name: 'get_stats', description: '获取图库完整统计（总数、存储、今日新增、未转存、类型分布）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'count_files', description: '查询文件总数', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'unsaved_list', description: '查询未转存文件列表与数量', parameters: { type: 'object', properties: { limit: { type: 'number', description: '显示条数，默认 10' } } } } },
  { type: 'function', function: { name: 'retry_unsaved', description: '触发未转存文件重试转存（下载并上传到 R2）', parameters: { type: 'object', properties: { limit: { type: 'number', description: '重试条数，默认 8，最大 10' } } } } },
  { type: 'function', function: { name: 'search_files', description: '按关键字搜索已入库文件（文件名/标签/编号/说明）', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '搜索关键字' }, limit: { type: 'number', description: '显示条数，默认 10' } }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'get_file', description: '按 ID 查询单个文件信息（状态、大小、标签、链接）', parameters: { type: 'object', properties: { id: { type: 'number', description: '文件 id' } }, required: ['id'] } } }
];
// AI 对话（function calling 循环，最多 3 轮工具调用），返回 {ok,text} 或 {ok:false,error}
export async function aiComplete(env, userText) {
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
export var AI_THROTTLE = {};
export function aiThrottled(chatId) {
  const now = Date.now();
  const last = AI_THROTTLE[chatId] || 0;
  if (now - last < 5000) return true;
  AI_THROTTLE[chatId] = now;
  pruneThrottle(AI_THROTTLE, now, 10 * 60 * 1000);
  return false;
}
// 定期清理超过保留窗口的键，避免聊天数持续增长导致内存膨胀
function pruneThrottle(map, now, keepMs) {
  let size = 0;
  for (const k in map) { size++; if (now - (map[k] || 0) > keepMs) delete map[k]; }
  if (size > 500) {
    const cutoff = now - keepMs;
    for (const k in map) if ((map[k] || 0) < cutoff) delete map[k];
  }
}
// 判断消息文本是否为「提问/请求」，仅此类文本触发 AI 自动回复；
// 避免图片刷屏、闲聊等非提问消息反复调用 AI 消耗配额并触发服务商 429 限流
export function isAIReplyText(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 2) return false;
  if (/[?？]$/.test(t)) return true;               // 以问号结尾
  if (/@[A-Za-z0-9_]{4,}/.test(t)) return true;    // 显式 @ 提及 bot
  if (/(吗|呢|么)$/.test(t)) return true;          // 结尾疑问助词
  return /(怎么|如何|为什么|什么|哪个|哪些|几个|多少|能不能|可不可以|可以吗|怎么办|怎么弄|帮我|请查|查一下|查下|查查|搜索|找一下|找找|统计|重试|转存|更新|最近|今天|明天|推荐|来一张|来.{0,2}张|发我|给我|发几张|发.{0,2}张)/.test(t);
}
export async function callAIManage(chatId, msgId, text, env) {
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
export async function handleAdminTestAI(request, env) {
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
// 后台 AI 浮窗问答：返回 AI 回复文本（同一来源 3 秒冷却，防止连点放大请求触发 429）
export var AI_ASK = {};
export async function handleAdminAskAI(request, env) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'local';
    const now = Date.now();
    if (now - (AI_ASK[ip] || 0) < 3000) return json({ ok: false, error: '请求过于频繁，请 3 秒后再试' });
    AI_ASK[ip] = now;
    pruneThrottle(AI_ASK, now, 10 * 60 * 1000);
    const b = await request.json().catch(function(){ return {}; });
    const q = String(b.question || '').trim();
    if (!q) return json({ ok: false, error: '缺少问题' });
    const r = await aiComplete(env, q);
    if (!r.ok) return json({ ok: false, error: r.error });
    return json({ ok: true, data: { text: r.text } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
export async function fetchAI(cfg, msgs) {
  const url = (cfg.base || 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions';
  const body = JSON.stringify({ model: cfg.model || 'deepseek-chat', messages: msgs, tools: AI_TOOLS, tool_choice: 'auto' });
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key };
  // 429（含 Cloudflare 1015 限流）：不重试，避免失败请求被重试放大后再次撞上限流；
  // 5xx（服务端瞬时错误）：退避重试（1s、3s）
  const delays = [1000, 3000];
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: headers, body: body });
      if (!r.ok) {
        const tb = String(await r.text()).slice(0, 220);
        if (r.status === 429) {
          console.log('ai 429 (rate limited):', tb);
          return { _err: 'HTTP 429 ' + tb };
        }
        if (r.status >= 500 && attempt < delays.length) {
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
export async function aiRunTool(name, args, env) {
  if (name === 'get_stats') return await aiGetStatsText(env);
  if (name === 'count_files') return '文件总数: ' + (await aiCountFiles(env));
  if (name === 'unsaved_list') return await aiUnsavedText(env, args.limit || 10);
  if (name === 'retry_unsaved') { const n = await triggerRetryN(env, args.limit || 8); return '已触发 ' + n + ' 条未转存文件开始重试转存'; }
  if (name === 'search_files') return await aiSearchText(env, args.keyword || '', args.limit || 10);
  if (name === 'get_file') return await aiFileText(env, parseInt(args.id) || 0);
  return 'unknown tool: ' + name;
}
export async function aiCountFiles(env) {
  try { const t = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first(); return t?.c || 0; } catch (e) { return 0; }
}
export async function aiGetStatsText(env) {
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first();
    const s = await env.D1_DB.prepare('SELECT SUM(file_size) as s FROM files WHERE deleted_at IS NULL').first();
    const td = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=?').bind(cnDayIso(cnTodayStr())).first();
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
export async function aiUnsavedText(env, limit) {
  try {
    await env.D1_DB.prepare("UPDATE files SET processing_state='failed' WHERE processing_state IN ('downloading','hashing','uploading','saving') AND deleted_at IS NULL AND julianday(created_at) < julianday('now','-30 minutes')").run();
  } catch (e) {}
  try {
    const n = Math.max(1, Math.min(parseInt(limit) || 10, 15));
    const t = await env.D1_DB.prepare("SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND processing_state != 'completed'").first();
    const d = await env.D1_DB.prepare("SELECT id, file_name, processing_state, group_ref FROM files WHERE deleted_at IS NULL AND processing_state != 'completed' ORDER BY id DESC LIMIT ?").bind(n).all();
    if ((d.results || []).length === 0) return '未转存: 0 条，全部已完成 ✓';
    let s = '⏳ 未转存 ' + (t?.c || 0) + ' 条（显示前 ' + (d.results || []).length + ' 条）：\n';
    (d.results || []).forEach(function(r) { s += '· #' + (r.group_ref || r.id) + ' ' + (r.file_name || '') + ' [' + r.processing_state + ']\n'; });
    return s;
  } catch (e) { return '查询失败: ' + e.message; }
}
export async function aiSearchText(env, kw, limit) {
  try {
    const n = Math.max(1, Math.min(parseInt(limit) || 10, 15));
    const k = '%' + kw + '%';
    const d = await env.D1_DB.prepare("SELECT id, file_name, file_type, group_ref FROM files WHERE deleted_at IS NULL AND processing_state='completed' AND (file_name LIKE ? OR caption LIKE ? OR group_ref LIKE ? OR tags LIKE ?) ORDER BY id DESC LIMIT ?").bind(k, k, k, k, n).all();
    if (!(d.results || []).length) return '未找到「' + kw + '」相关文件';
    let s = '🔍 「' + kw + '」结果 ' + (d.results || []).length + ' 条：\n';
    (d.results || []).forEach(function(r) { s += '· #' + (r.group_ref || r.id) + ' ' + (r.file_name || '') + ' (' + r.file_type + ')\n'; });
    return s;
  } catch (e) { return '搜索失败: ' + e.message; }
}
export async function aiFileText(env, id) {
  try {
    const f = await env.D1_DB.prepare("SELECT * FROM files WHERE id=? AND deleted_at IS NULL").bind(id).first();
    if (!f) return '未找到 id=' + id;
    const realR2 = f.r2_url && f.r2_url.indexOf('/file/tg/') !== 0;
    const tok = await fileTok(f.id, env);
    return '#' + (f.group_ref || f.id) + ' ' + (f.file_name || '') + '\n类型: ' + (f.file_type || '') + ' | 大小: ' + fmtSize(f.file_size || 0) + '\n状态: ' + (f.processing_state || '') + '\n标签: ' + (f.tags || '（无）') + '\n链接: ' + (realR2 ? f.r2_url : '（未转存，代理: https://telegram-r2-bot.wo58.cn/file/tg/' + tok + '/' + f.id + '.' + fileExtOf(f.file_name, f.file_type) + '）');
  } catch (e) { return '查询失败: ' + e.message; }
}
export async function triggerRetryN(env, n) {
  try {
    const lim = Math.max(1, Math.min(parseInt(n) || 8, 50));
    const fakeReq = { json: function() { return Promise.resolve({ all: true, limit: lim }); } };
    const r = await handleUnsavedRetry(fakeReq, env);
    return (r && r.started) || 0;
  } catch (e) { return 0; }
}

export async function handleBotCommand(chatId, msgId, text, env, waitFn) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  // Check custom commands in DB
  if (env.D1_DB) {
    try {
      const custom = await env.D1_DB.prepare('SELECT response, enabled, menu, builtin FROM bot_commands WHERE command = ?').bind(cmd).first();
      if (custom) {
        // 后台停用的命令（含内置）直接拒绝
        if (!custom.enabled) {
          await replyText(chatId, msgId, '该命令已在后台停用，如需使用请在后台「命令」页启用。', env);
          return { ok: true, disabled: true };
        }
        // 仅当有实际自定义响应时才拦截；内置占位符（__BUILTIN__）走代码内置逻辑
        if (custom.response && custom.response !== '__BUILTIN__') {
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
      }
    } catch (e) {}
  }

  // Built-in commands
  if (cmd === '/start' || cmd === '/help') {
    const helpText = cmd === '/start' ? DEFAULT_COMMANDS['/start'] : DEFAULT_COMMANDS['/help'];
    await replyTextWithKeyboard(chatId, helpText, MAIN_BUTTONS, env);
    // /start 附带下发快捷回复键盘（纯文本按钮，点"查看图库/帮助"直接触发）
    if (cmd === '/start') await sendQuickReplyKeyboard(chatId, env);
    return { ok: true };
  }

  if (cmd === '/stats') {
    return await handleStatsCommand(chatId, env);
  }

  if (cmd === '/file') {
    if (!/^\d+$/.test(String(args || '').trim())) {
      await replyText(chatId, msgId, 'Usage: /file <id>\nExample: /file 123', env);
      return { ok: true };
    }
    return await handleFileCommand(chatId, msgId, parseInt(String(args).trim(), 10), env);
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

  // /img <标签1,标签2 或 关键词>：从共享库随机抽一张符合条件的图发到群里
  if (cmd === '/img' || cmd === '/image' || cmd === '/图') {
    return await handleImgCommand(chatId, msgId, args, env);
  }

  return null; // Not a command
}

// 内置命令清单：同步入库后后台可见/可停用/可自定义响应（见 syncBuiltinCommands）
export var BUILTIN_COMMANDS = [
  { command: '/start', description: '欢迎与使用说明' },
  { command: '/help', description: '帮助' },
  { command: '/stats', description: '转存统计' },
  { command: '/file', description: '按编号取文件：/file 123' },
  { command: '/search', description: '按关键词搜索：/search cat' },
  { command: '/count', description: '现有数量统计' },
  { command: '/pending', description: '未转存数量' },
  { command: '/retry', description: '继续完成未转存（数字菜单）' },
  { command: '/health', description: '健康检查' },
  { command: '/img', description: '从共享库随机抽图：/img 风景,美女 或 /img 关键词' }
];

// 把内置命令同步进 bot_commands（INSERT OR IGNORE，不覆盖用户已修改的），后台统一管理
export async function syncBuiltinCommands(env) {
  if (!env.D1_DB) return;
  try {
    await ensureTablesOnce(env.D1_DB);
    for (const c of BUILTIN_COMMANDS) {
      try {
        await env.D1_DB.prepare("INSERT OR IGNORE INTO bot_commands (command, response, description, enabled, menu, builtin) VALUES (?, '__BUILTIN__', ?, 1, '', 1)").bind(c.command, c.description).run();
      } catch (e) {}
    }
  } catch (e) { console.error('syncBuiltinCommands:', e.message); }
}

// 命令：查询现有数量（中文版）
export async function handleCountCommand(chatId, env) {
  if (!env.D1_DB) { await replyText(chatId, 0, '❌ D1 未配置', env); return { ok: true }; }
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first();
    const s = await env.D1_DB.prepare('SELECT SUM(file_size) as s FROM files WHERE deleted_at IS NULL').first();
    const td = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=?').bind(cnDayIso(cnTodayStr())).first();
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
export async function handlePendingCommand(chatId, env) {
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

// 命令：继续完成未转存入库（默认批 8 条，限频 60s/会话；limit/all 由菜单选项传入）
var lastRetryCmdTs = {}; // 按 chatId 独立限频，避免一个群触发后所有会话被连带拒绝
export async function handleRetryCommand(chatId, env, waitFn, limit, all) {
  const now = Date.now();
  const last = lastRetryCmdTs[chatId] || 0;
  if (now - last < 60000) {
    await replyText(chatId, 0, '⏳ 本会话 60 秒内已执行过，请稍后再试（' + Math.ceil((60000 - (now - last)) / 1000) + 's）', env);
    return { ok: true };
  }
  lastRetryCmdTs[chatId] = now;
  // 定期清理超过 10 分钟的会话记录，避免聊天数持续增长导致内存膨胀
  if (Object.keys(lastRetryCmdTs).length > 500) {
    const cutoff = now - 10 * 60 * 1000;
    for (const k in lastRetryCmdTs) if (lastRetryCmdTs[k] < cutoff) delete lastRetryCmdTs[k];
  }
  if (!env.D1_DB) { await replyText(chatId, 0, '❌ D1 未配置', env); return { ok: true }; }
  try {
    // 有队列时"重试全部"可安全拉起更多条（每条仅 1 个 subrequest 入队）；无队列直接进程内转存，保守批 8 条
    const lim = all ? (env.FILE_QUEUE ? 50 : 8) : (limit || 8);
    const fakeReq = { json: function() { return Promise.resolve({ all: !!all, limit: lim }); } };
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
export async function handleHealthCommand(chatId, env) {
  let lines = ['🛰 **服务状态**'];
  lines.push('· Worker 版本: v7');
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

export async function handleStatsCommand(chatId, env) {
  if (!env.D1_DB) { await replyText(chatId, 0, '❌ D1 未配置', env); return { ok: true }; }
  try {
    const t = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL').first();
    const s = await env.D1_DB.prepare('SELECT SUM(file_size) as s FROM files WHERE deleted_at IS NULL').first();
    const td = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL AND created_at>=?').bind(cnDayIso(cnTodayStr())).first();
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
    await replyText(chatId, 0, '❌ 统计出错: ' + e.message, env);
    return { ok: true };
  }
}

export async function handleFileCommand(chatId, msgId, fileId, env) {
  if (!env.D1_DB) { await replyText(chatId, msgId, '❌ D1 未配置', env); return { ok: true }; }
  try {
    const f = await env.D1_DB.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').bind(fileId).first();
    if (!f) { await replyText(chatId, msgId, '❌ 未找到该文件', env); return { ok: true }; }

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
    await replyText(chatId, msgId, '❌ 查询出错: ' + e.message, env);
    return { ok: true };
  }
}

export async function handleSearchCommand(chatId, msgId, keyword, env) {
  if (!env.D1_DB) { await replyText(chatId, msgId, '❌ D1 未配置', env); return { ok: true }; }
  try {
    const lk = '%' + keyword + '%';
    // 与 AI search_files 字段保持一致：文件名/说明/群名/编号/标签
    const d = await env.D1_DB.prepare(
      'SELECT id, file_name, file_type, file_size, chat_title, r2_url, group_ref, tags FROM files WHERE (file_name LIKE ? OR caption LIKE ? OR chat_title LIKE ? OR group_ref LIKE ? OR tags LIKE ?) AND deleted_at IS NULL ORDER BY id DESC LIMIT 5'
    ).bind(lk, lk, lk, lk, lk).all();

    if (!d.results?.length) {
      await replyText(chatId, msgId, '🔍 未找到「' + keyword + '」相关文件', env);
      return { ok: true };
    }

    let text = '🔍 **搜索: "' + keyword + '"** (' + d.results.length + ' 条)\n\n';
    for (const f of d.results) {
      const ic = { photo: '🖼', document: '📄', video: '🎬', audio: '🎵' };
      text += `${ic[f.file_type] || '📁'} #${f.group_ref || f.id} ${f.file_name} (${fmtSize(f.file_size)})\n`;
      text += `   ${f.chat_title} → ${f.r2_url}\n\n`;
    }
    await replyText(chatId, msgId, text, env);
    return { ok: true };
  } catch (e) {
    await replyText(chatId, msgId, '❌ 搜索出错: ' + e.message, env);
    return { ok: true };
  }
}

// 群内索图：从共享库 random_pool 随机抽 1 张符合条件(enabled=1 + level<=pt 且非私密)的图发回群里。
// 参数为空则完全随机。支持逗号分隔标签（命中任意一个即可）或关键词（标题/URL 包含）。
// 等级过滤：默认仅公开 'pt' 图可被群内抽出；如需按用户等级解锁 vip/vvip，可调整 IMG_LEVEL_FILTER
var IMG_LEVEL_FILTER = ['pt'];
function imgLevelSql() {
  return IMG_LEVEL_FILTER.map(function(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }).join(',');
}
export async function handleImgCommand(chatId, msgId, args, env) {
  if (!env.D1_DB) { await replyText(chatId, msgId, '❌ D1 未配置', env); return { ok: true }; }
  try {
    const parts = String(args || '').split(/[\s,，]+/).map(function(s){ return s.trim(); }).filter(Boolean);
    const tags = parts.length ? parts : [];
    let w = "WHERE enabled=1 AND is_private=0 AND level IN (" + imgLevelSql() + ")"; const p = [];
    if (tags.length) {
      const ts = [];
      tags.forEach(function(t) {
        ts.push('(tags LIKE ? OR tags LIKE ? OR tags LIKE ? OR tags = ? OR title LIKE ? OR url LIKE ?)');
        p.push('%,' + t + ',%', t + ',%', '%,' + t, t, '%' + t + '%', '%' + t + '%');
      });
      w += ' AND (' + ts.join(' OR ') + ')';
    }
    const d = await env.D1_DB.prepare('SELECT id, url, thumb_url, title, tags, file_type FROM random_pool ' + w + ' ORDER BY RANDOM() LIMIT 1').bind(...p).all();
    const it = (d.results || [])[0];
    if (!it) {
      await replyText(chatId, msgId, tags.length ? ('😕 共享库中没有匹配「' + tags.join('、') + '」的图') : '😕 共享库还没有内容，先在后台「共享库」添加一些吧', env);
      return { ok: true };
    }
    const cap = (it.title || '') + (it.tags ? '\n#' + splitTags(it.tags).join(' #') : '');
    // 优先发图片（sendPhoto 支持 URL）；非图片类型或发送失败时退化为发链接文本
    if (it.file_type === 'photo' && it.url) {
      try {
        const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendPhoto', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, photo: it.url, caption: String(cap).slice(0, 1024), parse_mode: '' })
        });
        const j = await r.json().catch(function() { return { ok: false }; });
        if (j && j.ok) return { ok: true, img: true };
        // 发送失败（URL 失效/类型不符等）：继续走文本兜底
      } catch (e) {}
    }
    await replyText(chatId, msgId, '📸 ' + (it.title || '（无标题）') + '\n' + it.url + (it.tags ? '\n#' + splitTags(it.tags).join(' #') : ''), env);
    return { ok: true, img: true };
  } catch (e) {
    await replyText(chatId, msgId, '❌ ' + e.message, env);
    return { ok: true };
  }
}

// Inline 模式：用户在任何聊天输入 @<bot> 关键词，从共享库随机池返回可发送的图片（与群内索图同源）。
// 空查询→完全随机；有关键词→标签/标题/URL 模糊匹配（逗号分隔，命中任意一个即可）。
// 仅返回图片类结果（photo）；非图片内容在图片不足时以 article 兜底展示链接。
export async function handleInlineQuery(iq, env) {
  const iqId = String(iq.id || '');
  const query = String(iq.query || '').trim();
  if (!iqId || !env.TG_BOT_TOKEN) return { ok: false, error: 'no_iq' };
  const fail = async function(message) {
    try {
      await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/answerInlineQuery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inline_query_id: iqId, cache_time: 0, results: [], is_personal: true, switch_pm_text: message, switch_pm_parameter: 'inline' })
      });
    } catch (e) {}
    return { ok: true, empty: true };
  };
  if (!env.D1_DB) return await fail('❌ D1 未配置');
  try {
    const parts = String(query).split(/[\s,，]+/).map(function(s){ return s.trim(); }).filter(Boolean);
    let w = "WHERE enabled=1 AND is_private=0 AND level IN (" + imgLevelSql() + ")"; const p = [];
    if (parts.length) {
      const ts = [];
      parts.forEach(function(t) {
        ts.push('(tags LIKE ? OR tags LIKE ? OR tags LIKE ? OR tags = ? OR title LIKE ? OR url LIKE ?)');
        p.push('%,' + t + ',%', t + ',%', '%,' + t, t, '%' + t + '%', '%' + t + '%');
      });
      w += ' AND (' + ts.join(' OR ') + ')';
    }
    const d = await env.D1_DB.prepare('SELECT id, url, thumb_url, title, tags, file_type, width, height FROM random_pool ' + w + ' ORDER BY RANDOM() LIMIT 50').bind(...p).all();
    const rows = (d.results || []).filter(function(r) { return r.url; });
    if (!rows.length) return await fail(parts.length ? ('共享库没有匹配「' + parts.join('、') + '」的图') : '共享库还没有内容，先在后台「共享库」添加');
    const results = rows.map(function(r, i) {
      const cap = (r.title || '') + (r.tags ? '\n#' + splitTags(r.tags).join(' #') : '');
      const w = r.width || 0, h = r.height || 0;
      // 图片类：photo 结果；非图片类（video/document 等）：article 兜底展示标题+链接，避免把非图片 URL 硬塞给 photo_url 被 Telegram 拒收
      if (r.file_type === 'photo') {
        return {
          type: 'photo', id: 'i' + r.id + '_' + i, title: r.title || (parts.join(' ') || '图片'),
          photo_url: r.url, thumb_url: r.thumb_url || r.url,
          photo_width: w || 800, photo_height: h || 600, caption: String(cap).slice(0, 1024)
        };
      }
      return {
        type: 'article', id: 'a' + r.id + '_' + i, title: r.title || (r.file_type || '文件'),
        description: String(cap).slice(0, 256) || undefined,
        message_text: '📄 ' + (r.title || '文件') + (r.tags ? '\n#' + splitTags(r.tags).join(' #') : '') + '\n' + r.url,
        thumb_url: r.thumb_url || r.url, hide_url: true
      };
    });
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/answerInlineQuery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inline_query_id: iqId, results: results, cache_time: 0, is_personal: true })
    }).catch(function(e) { console.log('answerInlineQuery:', e.message); });
    return { ok: true, results: results.length };
  } catch (e) {
    return await fail('❌ ' + String(e.message).slice(0, 100));
  }
}

