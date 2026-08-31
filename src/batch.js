// ==================== 群资源编号 + 批量编号 ====================
// allocTgRef：每条入库消息分配唯一编号 group_ref（批内第 1 条以预计下一条 id 为批次基准）。
// getFileRef/scheduleBatchRef/refreshGroupReceipt：同一 chat 3 秒内消息视为一批，统一编号后合并回执。
// handleDeletedMsg：用户撤销已入库媒体时软删记录并清理批量回执。
// startManualBatch/finalizeManualBatch：用户通过 #开始 #结束 手动控制批次边界。
import { countCompleted } from "./telegram.js";
import { log } from "./util.js";

// ==================== 群资源编号（批次-序号，如 440-001） ====================
// 每条入库消息分配唯一编号 group_ref：批内第 1 条以「下一条预计 id」为批次基准，
// 之后批内递增。距上一条消息超过 5 分钟视为新批次。编号同时写入 bot 回复与后台，
// 用户转发大量消息后对照回复即可发现哪条未入库。
var TG_REF_GAP_MS = 300 * 1000;
export async function allocTgRef(env) {
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
export async function getFileRef(env, dbId) {
  if (!env.D1_DB || !dbId) return '';
  try {
    const r = await env.D1_DB.prepare('SELECT group_ref FROM files WHERE id=?').bind(dbId).first();
    return (r && r.group_ref) || '';
  } catch (e) { return ''; }
}
export async function scheduleBatchRef(env, chatId, dbId, waitFn) {
  if (!env.D1_DB || !chatId || !dbId) return;
  const p = (async () => {
    try {
      // 等 3 秒让"这一批"的其余消息到齐（TG 批量转发/相册消息间隔 <1s）
      await new Promise(function(res) { setTimeout(res, 3000); });
      const win = new Date(Date.now() - 6000).toISOString();
      const rows = await env.D1_DB.prepare('SELECT id, message_id, file_name, media_group_id, tags FROM files WHERE chat_id=? AND deleted_at IS NULL AND created_at>=? ORDER BY id ASC').bind(chatId, win).all();
      const list = (rows.results || []).filter(function(r) { return r.id; });
      if (!list.length) return;

      // 传播标签：同 media_group_id 的文件共享第一张图的标签
      await propagateAlbumTags(env, list);

      const N = list.length;
      // 统一编号：批次号 = 本次总数 N，序号 = 批内位置（可重复执行，值稳定）
      for (var i = 0; i < list.length; i++) {
        const ref = N + '-' + String(i + 1).padStart(3, '0');
        try { await env.D1_DB.prepare('UPDATE files SET group_ref=? WHERE id=?').bind(ref, list[i].id).run(); } catch (e) {}
      }
      // 由批内最后一条统一回复（最后唤醒者拿到最终批号，避免中途编号变化/重复回复）
      if (list[list.length - 1].id !== dbId || !env.TG_BOT_TOKEN) return;
      const cnt = await countCompleted(env);
      const cntStr = cnt ? '\n📊 已完成: ' + cnt.completed + ' / ' + cnt.total + ' 条' : '';
      // 按 media_group_id 合并：同一相册只发一条合并回执（其余文件仍一条一条回执）
      const groups = {}; const order = [];
      list.forEach(function(r) {
        const key = r.media_group_id || ('single:' + r.id);
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(r);
      });
      for (var g = 0; g < order.length; g++) {
        const members = groups[order[g]];
        const isAlbum = order[g].indexOf('single:') !== 0;
        const lines = members.map(function(r) {
          const ref = N + '-' + String(list.indexOf(r) + 1).padStart(3, '0');
          const nm = String(r.file_name || '').slice(0, 40);
          return '#' + ref + (nm ? ' · ' + nm : '');
        });
        const text = (isAlbum ? '📥 相册已入库（' + (g + 1) + '/' + order.length + ' 批，' + members.length + ' 张）\n' : '📥 已入库 ') + lines.join('\n') + cntStr;
        try {
          const resp = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, reply_to_message_id: parseInt(members[0].message_id, 10) || undefined, text: text })
          });
          const j = await resp.json();
          const mid = j && j.ok && j.result && j.result.message_id;
          if (mid) {
            // 记录回执 message_id：转存完成后 editMessageText 原地更新为直链（媒体组更新整条合并回执）
            for (const mb of members) {
              try { await env.D1_DB.prepare('UPDATE files SET receipt_msg_id=? WHERE id=?').bind(mid, mb.id).run(); } catch (e) {}
            }
          }
        } catch (e) {}
      }
    } catch (e) { console.error('batchRef:', e.message); }
  })();
  if (waitFn) waitFn(p); else p;
}

// 相册合并回执原地更新：重查同 media_group_id 的所有文件，把已完成项换成直链、未完成项标"转存中"
export async function refreshGroupReceipt(env, chatId, mediaGroupId) {
  if (!env.D1_DB || !chatId || !mediaGroupId || !env.TG_BOT_TOKEN) return;
  try {
    const rows = await env.D1_DB.prepare('SELECT id, group_ref, file_name, r2_url, processing_state, receipt_msg_id FROM files WHERE chat_id=? AND media_group_id=? AND deleted_at IS NULL ORDER BY id ASC').bind(chatId, mediaGroupId).all();
    const members = (rows.results || []).filter(function(r) { return r.id && r.receipt_msg_id; });
    if (!members.length) return;
    const mid = members[0].receipt_msg_id;
    const cnt = await countCompleted(env);
    const cntStr = cnt ? '\n📊 已完成: ' + cnt.completed + ' / ' + cnt.total + ' 条' : '';
    // 提取批次号，查询同批次所有相册以确定当前位置
    let batchPos = '';
    const batchNum = members[0].group_ref ? parseInt(members[0].group_ref.split('-')[0], 10) : 0;
    if (batchNum > 1) {
      const batchRows = await env.D1_DB.prepare('SELECT DISTINCT media_group_id FROM files WHERE chat_id=? AND deleted_at IS NULL AND group_ref LIKE ?').bind(chatId, batchNum + '-%').all();
      const batchAlbums = (batchRows.results || []).map(function(r) { return r.media_group_id || ''; }).filter(Boolean);
      const pos = batchAlbums.indexOf(mediaGroupId);
      if (pos !== -1 && batchAlbums.length > 1) batchPos = '（' + (pos + 1) + '/' + batchAlbums.length + ' 批）';
    }
    const lines = members.map(function(r) {
      const ref = r.group_ref || String(r.id);
      const nm = String(r.file_name || '').slice(0, 40);
      if (r.processing_state === 'completed' && r.r2_url) return '✅ #' + ref + (nm ? ' · ' + nm : '') + '\n' + r.r2_url;
      return '⏳ #' + ref + (nm ? ' · ' + nm : '') + ' 转存中…';
    });
    const text = '📥 相册回执' + batchPos + '（' + members.length + ' 张）\n' + lines.join('\n') + cntStr;
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/editMessageText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: mid, text: String(text).slice(0, 1024) })
    }).catch(function(e) { console.log('refreshGroupReceipt edit fail:', e.message); });
  } catch (e) { console.log('refreshGroupReceipt:', e.message); }
}

// 用户撤销已入库的媒体消息（Telegram 补发空内容 message 更新）：
// 1) 将对应入库记录移入回收站（软删）
// 2) 清理批量回执：相册合并回执若无其余存活文件则删掉回执消息，否则刷新回执去掉已删项；单条回执直接删除
export async function handleDeletedMsg(msg, env) {
  const chatId = String(msg.chat && msg.chat.id ? msg.chat.id : '');
  const messageId = String(msg.message_id || '');
  if (!env.D1_DB || !chatId || !messageId) return { ok: true, skip: true };
  try {
    // 只处理近期(24h 内)仍有入库记录的消息，避免误删旧数据
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const row = await env.D1_DB.prepare('SELECT id, media_group_id, receipt_msg_id FROM files WHERE chat_id=? AND message_id=? AND deleted_at IS NULL AND created_at>=? ORDER BY id DESC LIMIT 1').bind(chatId, messageId, cutoff).first();
    if (!row || !row.id) return { ok: true, skip: true };
    await env.D1_DB.prepare('UPDATE files SET deleted_at=? WHERE id=?').bind(new Date().toISOString(), row.id).run();
    if (row.receipt_msg_id && env.TG_BOT_TOKEN) {
      if (row.media_group_id) {
        const alive = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files WHERE chat_id=? AND media_group_id=? AND deleted_at IS NULL').bind(chatId, row.media_group_id).first();
        if (alive && (alive.c || 0) > 0) {
          await refreshGroupReceipt(env, chatId, row.media_group_id).catch(function(){});
        } else {
          try { await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/deleteMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: row.receipt_msg_id }) }); } catch (e) {}
        }
      } else {
        try { await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/deleteMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: row.receipt_msg_id }) }); } catch (e) {}
      }
    }
    return { ok: true, deleted: true };
  } catch (e) { console.error('handleDeletedMsg:', e.message); return { ok: true, skip: true }; }
}

// ==================== 手动批量标记（#开始 #结束） ====================
// 用户发 #开始 后，该 chat 的后续文件全部归入同一批次，直到发 #结束 统一编号回复。
// 存储：settings 表 batch_pending_<chat_id> = start_timestamp，batch_start_msg_<chat_id> = 起始 message_id

// 检测是否为批量标记指令（#开始 #结束 #批次 #batch start #batch end）
export function isBatchCommand(text) {
  if (!text) return null;
  const t = text.trim();
  if (/^#(开始|start)$/i.test(t)) return 'start';
  if (/^#(结束|end|完成|done)$/i.test(t)) return 'end';
  if (/^#(批次|batch)$/i.test(t)) return 'status';
  return null;
}

// 开启手动批次：记录起始时间，返回当前待入库文件数
export async function startManualBatch(env, chatId, msgId) {
  if (!env.D1_DB || !chatId) return 0;
  const now = Date.now();
  try {
    await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind('batch_pending_' + chatId, String(now)).run();
    await env.D1_DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind('batch_start_msg_' + chatId, String(msgId || '')).run();
  } catch (e) { log.error('startManualBatch:', e.message); }
  return 0;
}

// 查询某 chat 是否有进行中的手动批次
export async function isManualBatchActive(env, chatId) {
  if (!env.D1_DB || !chatId) return false;
  try {
    const r = await env.D1_DB.prepare("SELECT value FROM settings WHERE key=?").bind('batch_pending_' + chatId).first();
    return !!(r && r.value && parseInt(r.value, 10) > 0);
  } catch (e) { return false; }
}

// 获取手动批次状态信息（供 #批次 命令使用）
export async function getManualBatchStatus(env, chatId) {
  if (!env.D1_DB || !chatId) return null;
  let startTs = 0;
  try {
    const r = await env.D1_DB.prepare("SELECT value FROM settings WHERE key=?").bind('batch_pending_' + chatId).first();
    startTs = parseInt(r && r.value, 10) || 0;
  } catch (e) {}
  if (!startTs) return null;

  const startIso = new Date(startTs).toISOString();
  let count = 0;
  try {
    const rows = await env.D1_DB.prepare(
      'SELECT COUNT(*) as c FROM files WHERE chat_id=? AND deleted_at IS NULL AND created_at>=?'
    ).bind(chatId, startIso).first();
    count = (rows && rows.c) || 0;
  } catch (e) {}

  const elapsed = Math.floor((Date.now() - startTs) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return {
    active: true,
    count: count,
    startTime: new Date(startTs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    elapsed: mins > 0 ? mins + '分' + secs + '秒' : secs + '秒'
  };
}

// 传播相册标签：同 media_group_id 的文件共享第一张图的标签
async function propagateAlbumTags(env, list) {
  if (!env.D1_DB || !list || !list.length) return;

  // 按 media_group_id 分组
  const groups = {};
  list.forEach(function(item) {
    const key = item.media_group_id || ('single:' + item.id);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  });

  // 对每个相册组，用第一张图的标签更新其他图
  for (const key in groups) {
    const members = groups[key];
    if (members.length <= 1) continue; // 单张图不需要传播

    // 找到第一张有标签的图
    let sourceTags = '';
    for (let i = 0; i < members.length; i++) {
      if (members[i].tags && members[i].tags.trim()) {
        sourceTags = members[i].tags;
        break;
      }
    }

    if (!sourceTags) continue; // 没有标签可传播

    // 更新其他没有标签的图
    for (let i = 0; i < members.length; i++) {
      if (!members[i].tags || !members[i].tags.trim()) {
        try {
          await env.D1_DB.prepare('UPDATE files SET tags=? WHERE id=?').bind(sourceTags, members[i].id).run();
        } catch (e) { log.error('propagateAlbumTags:', e.message); }
      }
    }
  }
}

// 结束手动批次：查询批次内所有文件，统一编号，发送合并回执，清除批次状态
export async function finalizeManualBatch(env, chatId, msgId) {
  if (!env.D1_DB || !chatId) return { ok: false, count: 0 };
  let startTs = 0;
  try {
    const r = await env.D1_DB.prepare("SELECT value FROM settings WHERE key=?").bind('batch_pending_' + chatId).first();
    startTs = parseInt(r && r.value, 10) || 0;
  } catch (e) {}
  if (!startTs) return { ok: false, count: 0, reason: 'no_active_batch' };

  const startIso = new Date(startTs).toISOString();
  // 查询批次开始后的所有文件（含已完成和处理中）
  let list = [];
  try {
    const rows = await env.D1_DB.prepare(
      'SELECT id, file_name, file_type, processing_state, r2_url, group_ref, media_group_id, tags FROM files WHERE chat_id=? AND deleted_at IS NULL AND created_at>=? ORDER BY id ASC'
    ).bind(chatId, startIso).all();
    list = (rows.results || []).filter(function(r) { return r.id; });
  } catch (e) { log.error('finalizeManualBatch query:', e.message); }

  // 清除批次状态
  try {
    await env.D1_DB.prepare("DELETE FROM settings WHERE key IN (?,?)").bind('batch_pending_' + chatId, 'batch_start_msg_' + chatId).run();
  } catch (e) {}

  if (!list.length) return { ok: true, count: 0 };

  // 传播标签：同 media_group_id 的文件共享第一张图的标签
  await propagateAlbumTags(env, list);

  const N = list.length;
  // 统一编号
  for (var i = 0; i < list.length; i++) {
    const ref = N + '-' + String(i + 1).padStart(3, '0');
    try { await env.D1_DB.prepare('UPDATE files SET group_ref=? WHERE id=?').bind(ref, list[i].id).run(); } catch (e) {}
  }

  // 发送合并回执
  const cnt = await countCompleted(env);
  const cntStr = cnt ? '\n📊 已完成: ' + cnt.completed + ' / ' + cnt.total + ' 条' : '';
  const lines = list.map(function(r, i) {
    const ref = N + '-' + String(i + 1).padStart(3, '0');
    const nm = String(r.file_name || '').slice(0, 40);
    return '#' + ref + (nm ? ' · ' + nm : '');
  });
  const text = '📥 批次已入库（' + N + ' 个）\n' + lines.join('\n') + cntStr;

  // 尝试 reply 到 #结束 消息
  if (env.TG_BOT_TOKEN) {
    try {
      await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, reply_to_message_id: parseInt(msgId, 10) || undefined, text: text })
      });
    } catch (e) { log.error('finalizeManualBatch send:', e.message); }
  }

  return { ok: true, count: N };
}
