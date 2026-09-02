// MySQL 查询层：通过 Hyperdrive 直连 VPS MySQL（全量业务表镜像存储）
// 用途：D1 故障/限额降级时的读写备库 + userbot 相册专用存储
// 使用 mysql2/promise + disableEval: true（Hyperdrive 要求）+ nodejs_compat 兼容标志
// 官方推荐：每次操作 createConnection（Hyperdrive 底层维护连接池，新建连接开销小）
import { createConnection } from 'mysql2/promise';

function connCfg(env) {
  const hd = env.telequnphoto;
  if (!hd) throw new Error('Hyperdrive binding (telequnphoto) not configured');
  // Hyperdrive 绑定提供 host/port/user/password/database 独立字段
  return {
    host: hd.host,
    port: hd.port,
    user: hd.user,
    password: hd.password,
    database: hd.database,
    // 必须禁用 eval（static parsing），Workers 运行时无 eval()
    disableEval: true,
    connectTimeout: 10000,
  };
}

// 每次操作新建连接并自动关闭（Hyperdrive 已池化底层 TCP 连接）
export async function withConn(env, fn) {
  const conn = await createConnection(connCfg(env));
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(function(){});
  }
}

// ==================== userbot_tasks ====================

export async function mysqlTaskGetById(env, id) {
  return withConn(env, async (sql) => {
    const [rows] = await sql.query('SELECT * FROM userbot_tasks WHERE id=?', [id]);
    return rows[0] || null;
  });
}

export async function mysqlTaskGetAll(env) {
  return withConn(env, async (sql) => {
    const [rows] = await sql.query('SELECT * FROM userbot_tasks ORDER BY id DESC');
    return rows;
  });
}

export async function mysqlTaskCreate(env, params) {
  return withConn(env, async (sql) => {
    const [result] = await sql.query(
      `INSERT INTO userbot_tasks (chat_id, title, tags, pool, level, max_size, blimit, enabled, last_id, mode, scan_limit, selected_msg_ids, scan_progress, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [params.chat_id, params.title || '', params.tags || '', params.pool || 0, params.level || 'pt',
       params.max_size || 0, params.limit || 0, params.enabled ? 1 : 0, params.last_id || 0,
       params.mode || 'normal', params.scan_limit || 100000, params.selected_msg_ids || '',
       params.scan_progress || '', params.note || '']
    );
    return { id: result.insertId };
  });
}

export async function mysqlTaskUpdate(env, id, fields) {
  return withConn(env, async (sql) => {
    const set = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      set.push('`' + k + '`=?');
      vals.push(v);
    }
    if (!set.length) return { updated: false };
    set.push('updated_at=NOW()');
    vals.push(id);
    await sql.query('UPDATE userbot_tasks SET ' + set.join(',') + ' WHERE id=?', vals);
    return { updated: true };
  });
}

export async function mysqlTaskDelete(env, id) {
  return withConn(env, async (sql) => {
    await sql.query('DELETE FROM userbot_tasks WHERE id=?', [id]);
    await sql.query('DELETE FROM ubot_albums WHERE task_id=?', [id]);
    return { deleted: true };
  });
}

// ==================== ubot_albums ====================

export async function mysqlAlbumsGetByTask(env, taskId) {
  return withConn(env, async (sql) => {
    const [rows] = await sql.query('SELECT * FROM ubot_albums WHERE task_id=? ORDER BY first_ts DESC, id ASC', [taskId]);
    return rows;
  });
}

export async function mysqlAlbumsGetGroupedIds(env, taskId) {
  return withConn(env, async (sql) => {
    const [rows] = await sql.query('SELECT grouped_id FROM ubot_albums WHERE task_id=? LIMIT 50000', [taskId]);
    return rows.map(r => r.grouped_id);
  });
}

export async function mysqlAlbumsGetSizes(env, taskId) {
  return withConn(env, async (sql) => {
    const [rows] = await sql.query('SELECT sizes FROM ubot_albums WHERE task_id=?', [taskId]);
    return rows;
  });
}

export async function mysqlAlbumsDeleteByTask(env, taskId) {
  return withConn(env, async (sql) => {
    await sql.query('DELETE FROM ubot_albums WHERE task_id=?', [taskId]);
  });
}

export async function mysqlAlbumsInsertBatch(env, albums) {
  if (!albums.length) return { stored: 0 };
  return withConn(env, async (sql) => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const batch = albums.map(a => {
      const msgIds = Array.isArray(a.msg_ids) ? a.msg_ids.filter(x => /^\d+$/.test(String(x))).slice(0, 500) : [];
      const sizes = Array.isArray(a.sizes) ? a.sizes.map(s => ({
        id: Number(s.id) || 0, size: Number(s.size) || 0, w: Number(s.w) || 0, h: Number(s.h) || 0,
        thumb_url: String(s.thumb_url || '').slice(0, 500) || (s.file_id ? '/api/tg-proxy?file_id=' + s.file_id : ''),
        type: String(s.type || 'photo'), duration: Number(s.duration) || 0, file_id: String(s.file_id || '').slice(0, 200)
      })).slice(0, 500) : [];
      return [a.task_id || 0, String(a.grouped_id || '').slice(0, 64), msgIds.join(','), msgIds.length,
              JSON.stringify(sizes), String(a.cover_url || '').slice(0, 500), Number(a.first_ts) || 0,
              a.has_oversize ? 1 : 0, now];
    });
    // 多行批量 INSERT IGNORE（mysql2 text protocol 支持）
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
    const flat = batch.flat();
    await sql.query(
      `INSERT IGNORE INTO ubot_albums (task_id, grouped_id, msg_ids, mcount, sizes, cover_url, first_ts, has_oversize, created_at) VALUES ${placeholders}`,
      flat
    );
    return { stored: albums.length };
  });
}

export async function mysqlAlbumsSelectMsgIds(env, taskId) {
  return withConn(env, async (sql) => {
    const [rows] = await sql.query('SELECT msg_ids FROM ubot_albums WHERE task_id=?', [taskId]);
    const allowed = {};
    rows.forEach(r => {
      String(r.msg_ids || '').split(',').filter(Boolean).forEach(m => { allowed[m] = 1; });
    });
    return allowed;
  });
}

// ==================== ubot_scan_progress ====================

export async function mysqlProgressGet(env, taskId) {
  return withConn(env, async (sql) => {
    const [rows] = await sql.query('SELECT * FROM ubot_scan_progress WHERE task_id=?', [taskId]);
    return rows[0] || null;
  });
}

export async function mysqlProgressUpsert(env, taskId, data) {
  return withConn(env, async (sql) => {
    await sql.query(
      `INSERT INTO ubot_scan_progress (task_id, phase, scanned_msgs, media_count, video_count, albums_count, elapsed_s, scan_limit, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE phase=VALUES(phase), scanned_msgs=VALUES(scanned_msgs), media_count=VALUES(media_count),
       video_count=VALUES(video_count), albums_count=VALUES(albums_count), elapsed_s=VALUES(elapsed_s),
       scan_limit=VALUES(scan_limit), updated_at=NOW()`,
      [taskId, data.phase || '', data.scanned_msgs || 0, data.media_count || 0, data.video_count || 0,
       data.albums_count || 0, data.elapsed_s || 0, data.scan_limit || 100000]
    );
  });
}

// ==================== 通用执行层（D1 降级读取备库） ====================
// D1 故障/限额时，所有业务表读取回落到这里的等价 MySQL 查询。
// 时间字段 MySQL 存的是 varchar(32)（与 D1 TEXT 一致），避免类型转换差异。

export async function mysqlRows(env, sql, params) {
  return withConn(env, async (c) => {
    const [rows] = await c.query(sql, params || []);
    return rows;
  });
}

export async function mysqlGet(env, sql, params) {
  return withConn(env, async (c) => {
    const [rows] = await c.query(sql, params || []);
    return rows[0] || null;
  });
}

// 只返回标量值（COUNT/SUM 等聚合的第一行第一列）
export async function mysqlScalar(env, sql, params) {
  return withConn(env, async (c) => {
    const [rows] = await c.query(sql, params || []);
    if (!rows.length) return null;
    const k = Object.keys(rows[0])[0];
    return rows[0][k];
  });
}

// 通用 DELETE，返回 affected rows（不做 SELECT 回读，节省一次往返）
export async function mysqlDel(env, sql, params) {
  return withConn(env, async (c) => {
    const [r] = await c.query(sql, params || []);
    return r.affectedRows || 0;
  });
}

// 通用 INSERT/UPDATE（返回 ok:true），由调用方传完整 MySQL 方言 SQL
export async function mysqlExec(env, sql, params) {
  return withConn(env, async (c) => {
    const [r] = await c.query(sql, params || []);
    return { ok: true, affectedRows: r.affectedRows || 0, insertId: r.insertId || 0 };
  });
}

// ==================== settings 镜像（D1 降级时读/写开关） ====================

// 读多个 settings 键，返回 {key: value}（缺失键不含）
export async function mysqlSettingsGetMany(env, keys) {
  if (!keys || !keys.length) return {};
  const marks = keys.map(function(){ return '?'; }).join(',');
  const rows = await mysqlRows(env, 'SELECT `key`, `value` FROM settings WHERE `key` IN (' + marks + ')', keys);
  const out = {};
  rows.forEach(function(r) { out[r.key] = r.value; });
  return out;
}

// 写单个 settings 键（upsert）
export async function mysqlSettingsSet(env, key, value) {
  return mysqlExec(env,
    "INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)",
    [key, value]
  );
}

// ==================== D1 降级控制开关（存 MySQL settings） ====================
// mode: 'd1' | 'mysql' | 'auto'
//   'd1'   = 强制 D1（默认，手动恢复用）
//   'mysql' = 手动强制降级到 MySQL（D1 故障/维修期间用）
//   'auto' = 自动：D1 连续失败自动降级，成功恢复自动回 D1（默认）
// D1 故障时 settings 可能读不了，所以开关放 MySQL settings，由 dbaccess 直接查 MySQL。

const FAILOVER_KEY = 'db_failover_mode';

export async function mysqlFailoverGet(env) {
  try {
    const s = await mysqlGet(env, "SELECT `value` FROM settings WHERE `key`=?", [FAILOVER_KEY]);
    if (s && s.value) {
      let v = null; try { v = JSON.parse(s.value); } catch (e) {}
      if (v && v.mode) return v;
    }
  } catch (e) {}
  return { mode: 'auto', updated_at: 0, reason: '' };
}

export async function mysqlFailoverSet(env, mode, reason) {
  const v = JSON.stringify({ mode: mode, updated_at: Date.now(), reason: reason || '' });
  try {
    await mysqlSettingsSet(env, FAILOVER_KEY, v);
    return true;
  } catch (e) { return false; }
}

