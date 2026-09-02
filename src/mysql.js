// MySQL 查询层：通过 Hyperdrive 直连 VPS MySQL（相册数据存储）
// D1 继续管 settings/api_keys/files，MySQL 专管 ubot_albums/userbot_tasks/ubot_scan_progress
// 使用 mysql2/promise + disableEval: true（Hyperdrive 要求）
import mysql from 'mysql2/promise';

let _pool = null;

export function getMySQL(env) {
  if (_pool) return _pool;
  const connStr = env.telequnphoto && env.telequnphoto.connectionString;
  if (!connStr) throw new Error('Hyperdrive binding (telequnphoto) not configured');
  _pool = mysql.createPool({
    uri: connStr,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    // Hyperdrive 要求禁用 eval（prepared statements 走 text protocol）
    disableEval: true,
  });
  return _pool;
}

// 关闭连接池（用于 graceful shutdown）
export async function closeMySQL() {
  if (_pool) { await _pool.end(); _pool = null; }
}

// ==================== userbot_tasks ====================

export async function mysqlTaskGetById(env, id) {
  const sql = getMySQL(env);
  const [rows] = await sql.query('SELECT * FROM userbot_tasks WHERE id=?', [id]);
  return rows[0] || null;
}

export async function mysqlTaskGetAll(env) {
  const sql = getMySQL(env);
  const [rows] = await sql.query('SELECT * FROM userbot_tasks ORDER BY id DESC');
  return rows;
}

export async function mysqlTaskCreate(env, params) {
  const sql = getMySQL(env);
  const [result] = await sql.query(
    `INSERT INTO userbot_tasks (chat_id, title, tags, pool, level, max_size, blimit, enabled, last_id, mode, scan_limit, selected_msg_ids, scan_progress, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [params.chat_id, params.title || '', params.tags || '', params.pool || 0, params.level || 'pt',
     params.max_size || 0, params.limit || 0, params.enabled ? 1 : 0, params.last_id || 0,
     params.mode || 'normal', params.scan_limit || 100000, params.selected_msg_ids || '',
     params.scan_progress || '', params.note || '']
  );
  return { id: result.insertId };
}

export async function mysqlTaskUpdate(env, id, fields) {
  const sql = getMySQL(env);
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
}

export async function mysqlTaskDelete(env, id) {
  const sql = getMySQL(env);
  await sql.query('DELETE FROM userbot_tasks WHERE id=?', [id]);
  await sql.query('DELETE FROM ubot_albums WHERE task_id=?', [id]);
  return { deleted: true };
}

// ==================== ubot_albums ====================

export async function mysqlAlbumsGetByTask(env, taskId) {
  const sql = getMySQL(env);
  const [rows] = await sql.query('SELECT * FROM ubot_albums WHERE task_id=? ORDER BY first_ts DESC, id ASC', [taskId]);
  return rows;
}

export async function mysqlAlbumsGetGroupedIds(env, taskId) {
  const sql = getMySQL(env);
  const [rows] = await sql.query('SELECT grouped_id FROM ubot_albums WHERE task_id=? LIMIT 50000', [taskId]);
  return rows.map(r => r.grouped_id);
}

export async function mysqlAlbumsGetSizes(env, taskId) {
  const sql = getMySQL(env);
  const [rows] = await sql.query('SELECT sizes FROM ubot_albums WHERE task_id=?', [taskId]);
  return rows;
}

export async function mysqlAlbumsDeleteByTask(env, taskId) {
  const sql = getMySQL(env);
  await sql.query('DELETE FROM ubot_albums WHERE task_id=?', [taskId]);
}

export async function mysqlAlbumsInsertBatch(env, albums) {
  if (!albums.length) return { stored: 0 };
  const sql = getMySQL(env);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const stmt = `INSERT IGNORE INTO ubot_albums (task_id, grouped_id, msg_ids, mcount, sizes, cover_url, first_ts, has_oversize, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
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
  // mysql2 prepared statements with arrays
  await sql.query(stmt, batch[0]);
  // Batch insert for performance
  if (batch.length > 1) {
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
    const flat = batch.flat();
    await sql.query(`INSERT IGNORE INTO ubot_albums (task_id, grouped_id, msg_ids, mcount, sizes, cover_url, first_ts, has_oversize, created_at) VALUES ${placeholders}`, flat);
  }
  return { stored: albums.length };
}

export async function mysqlAlbumsSelectMsgIds(env, taskId) {
  const sql = getMySQL(env);
  const [rows] = await sql.query('SELECT msg_ids FROM ubot_albums WHERE task_id=?', [taskId]);
  const allowed = {};
  rows.forEach(r => {
    String(r.msg_ids || '').split(',').filter(Boolean).forEach(m => { allowed[m] = 1; });
  });
  return allowed;
}

// ==================== ubot_scan_progress ====================

export async function mysqlProgressGet(env, taskId) {
  const sql = getMySQL(env);
  const [rows] = await sql.query('SELECT * FROM ubot_scan_progress WHERE task_id=?', [taskId]);
  return rows[0] || null;
}

export async function mysqlProgressUpsert(env, taskId, data) {
  const sql = getMySQL(env);
  await sql.query(
    `INSERT INTO ubot_scan_progress (task_id, phase, scanned_msgs, media_count, video_count, albums_count, elapsed_s, scan_limit, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE phase=VALUES(phase), scanned_msgs=VALUES(scanned_msgs), media_count=VALUES(media_count),
     video_count=VALUES(video_count), albums_count=VALUES(albums_count), elapsed_s=VALUES(elapsed_s),
     scan_limit=VALUES(scan_limit), updated_at=NOW()`,
    [taskId, data.phase || '', data.scanned_msgs || 0, data.media_count || 0, data.video_count || 0,
     data.albums_count || 0, data.elapsed_s || 0, data.scan_limit || 100000]
  );
}
