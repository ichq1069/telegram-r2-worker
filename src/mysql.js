// MySQL 查询层：通过 Hyperdrive 直连 VPS MySQL（D1 故障/限额时的读写备库）
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

// ==================== MySQL 表结构初始化 ====================
const MYSQL_TABLES = [
  `CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    storage_key TEXT NOT NULL,
    r2_url TEXT NOT NULL,
    chat_id TEXT,
    chat_title TEXT,
    chat_type TEXT,
    chat_username TEXT,
    user_id INTEGER,
    username TEXT,
    full_name TEXT,
    telegram_file_id TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_type TEXT,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    caption TEXT,
    message_id TEXT,
    md5_hash TEXT,
    processing_state TEXT DEFAULT 'completed',
    created_at TEXT,
    tg_file_url TEXT,
    error_msg TEXT,
    progress_bytes INTEGER DEFAULT 0,
    total_bytes INTEGER DEFAULT 0,
    thumb_url TEXT,
    quick_hash TEXT,
    tags TEXT DEFAULT '',
    pool_status TEXT DEFAULT '',
    group_ref TEXT DEFAULT '',
    level TEXT DEFAULT 'pt',
    is_private INTEGER DEFAULT 0,
    media_group_id TEXT DEFAULT '',
    receipt_msg_id INTEGER DEFAULT 0,
    deleted_at TEXT,
    view_count INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS random_pool (
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    url TEXT NOT NULL,
    thumb_url TEXT,
    title TEXT,
    tags TEXT DEFAULT '',
    file_type TEXT DEFAULT 'photo',
    width INTEGER,
    height INTEGER,
    file_size INTEGER,
    source TEXT DEFAULT 'manual',
    tg_file_id INTEGER,
    enabled INTEGER DEFAULT 1,
    created_at TEXT,
    level TEXT DEFAULT 'pt',
    is_private INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS user_uploads (
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    thumb_url TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_type TEXT,
    width INTEGER,
    height INTEGER,
    tags TEXT DEFAULT '',
    created_at TEXT,
    deleted_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    \`key\` TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    \`key\` TEXT UNIQUE NOT NULL,
    name TEXT,
    scopes TEXT DEFAULT 'files:read',
    enabled INTEGER DEFAULT 1,
    created_at TEXT,
    last_used_at TEXT,
    usage_count INTEGER DEFAULT 0,
    expires_at TEXT,
    level TEXT DEFAULT 'pt',
    key_pass TEXT,
    username TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS known_chats (
    chat_id TEXT PRIMARY KEY,
    chat_type TEXT DEFAULT '',
    chat_title TEXT,
    chat_username TEXT,
    last_active_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS user_stats (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    full_name TEXT,
    messages INTEGER DEFAULT 0,
    commands INTEGER DEFAULT 0,
    files INTEGER DEFAULT 0,
    inline_queries INTEGER DEFAULT 0,
    callback_clicks INTEGER DEFAULT 0,
    last_active_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS bot_commands (
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    command TEXT UNIQUE,
    response TEXT,
    description TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT,
    menu TEXT DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS bot_config (
    \`key\` TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS redeem_codes (
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    code TEXT UNIQUE NOT NULL,
    level TEXT DEFAULT 'pt',
    quota INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    note TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    created_at TEXT,
    expires_at TEXT,
    type TEXT DEFAULT 'register',
    extend_days INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS show_groups (
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    name TEXT NOT NULL,
    images TEXT DEFAULT '',
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '',
    category TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    key TEXT NOT NULL,
    window TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    UNIQUE(key, window)
  )`,
  `CREATE TABLE IF NOT EXISTS worker_stats (
    day TEXT PRIMARY KEY,
    requests INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS api_call_logs (
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    key_id INTEGER,
    api_key TEXT,
    path TEXT,
    method TEXT,
    ip TEXT,
    status INTEGER DEFAULT 200,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER DEFAULT NULL,
    created_at TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_logs (
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    status INTEGER DEFAULT 200,
    ok INTEGER DEFAULT 1,
    source TEXT DEFAULT 'webhook',
    error TEXT DEFAULT '',
    created_at TEXT
  )`
];

let _tablesEnsured = false;

export async function ensureMySQLTables(env) {
  if (_tablesEnsured) return true;
  let okCount = 0;
  let failCount = 0;
  const errors = [];
  try {
    await withConn(env, async (c) => {
      for (const sql of MYSQL_TABLES) {
        try {
          await c.query(sql);
          okCount++;
        } catch (e) {
          failCount++;
          errors.push(e.message);
          console.error('ensureMySQLTables table error:', e.message);
        }
      }
    });
    // 至少部分表创建成功就标记为已初始化（避免阻塞双写）
    if (okCount > 0) _tablesEnsured = true;
    if (failCount > 0) console.error('ensureMySQLTables: ' + failCount + ' tables failed:', errors.join('; '));
    return okCount > 0;
  } catch (e) {
    console.error('ensureMySQLTables connection error:', e.message);
    return false;
  }
}

// ==================== 双写辅助函数 ====================
// 写入 D1 后同步写入 MySQL，MySQL 失败不影响主流程

// 双写 files 表 INSERT
export async function dualInsertFiles(env, params) {
  try {
    await ensureMySQLTables(env);
    const sql = `INSERT INTO files (storage_key, r2_url, chat_id, chat_title, chat_type, chat_username, user_id, username, full_name, telegram_file_id, file_name, file_size, file_type, mime_type, width, height, caption, message_id, md5_hash, processing_state, created_at, tags, group_ref, media_group_id, level, is_private, deleted_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const p = params;
    return await mysqlExec(env, sql, [
      p.storage_key, p.r2_url, p.chat_id, p.chat_title, p.chat_type, p.chat_username,
      p.user_id, p.username, p.full_name, p.telegram_file_id, p.file_name, p.file_size,
      p.file_type, p.mime_type, p.width, p.height, p.caption, p.message_id, p.md5_hash,
      p.processing_state, p.created_at, p.tags, p.group_ref, p.media_group_id, p.level, p.is_private, p.deleted_at
    ]);
  } catch (e) {
    console.error('dualInsertFiles error:', e.message, 'storage_key:', params?.storage_key);
    return { ok: false };
  }
}

// 双写 files 表 UPDATE（按 id 更新指定字段）
export async function dualUpdateFiles(env, id, updates) {
  try {
    await ensureMySQLTables(env);
    const keys = Object.keys(updates);
    if (!keys.length) return { ok: true };
    const setClause = keys.map(k => `\`${k}\`=?`).join(', ');
    const sql = `UPDATE files SET ${setClause} WHERE id=?`;
    const params = [...keys.map(k => updates[k]), id];
    return await mysqlExec(env, sql, params);
  } catch (e) {
    console.error('dualUpdateFiles error:', e.message);
    return { ok: false };
  }
}

// 双写 random_pool 表 INSERT
export async function dualInsertRandomPool(env, params) {
  try {
    await ensureMySQLTables(env);
    const sql = `INSERT INTO random_pool (url, thumb_url, title, tags, file_type, width, height, file_size, source, tg_file_id, enabled, created_at, level, is_private)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    return await mysqlExec(env, sql, [
      params.url, params.thumb_url, params.title, params.tags, params.file_type,
      params.width, params.height, params.file_size, params.source, params.tg_file_id,
      params.enabled, params.created_at, params.level, params.is_private
    ]);
  } catch (e) {
    console.error('dualInsertRandomPool error:', e.message);
    return { ok: false };
  }
}

// 双写 random_pool 表 UPDATE
export async function dualUpdateRandomPool(env, id, updates) {
  try {
    await ensureMySQLTables(env);
    const keys = Object.keys(updates);
    if (!keys.length) return { ok: true };
    const setClause = keys.map(k => `\`${k}\`=?`).join(', ');
    const sql = `UPDATE random_pool SET ${setClause} WHERE id=?`;
    const params = [...keys.map(k => updates[k]), id];
    return await mysqlExec(env, sql, params);
  } catch (e) {
    console.error('dualUpdateRandomPool error:', e.message);
    return { ok: false };
  }
}

// 双写 user_uploads 表 INSERT
export async function dualInsertUserUploads(env, params) {
  try {
    await ensureMySQLTables(env);
    const sql = `INSERT INTO user_uploads (user_id, url, thumb_url, file_name, file_size, file_type, width, height, tags, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    return await mysqlExec(env, sql, [
      params.user_id, params.url, params.thumb_url, params.file_name, params.file_size,
      params.file_type, params.width, params.height, params.tags, params.created_at
    ]);
  } catch (e) {
    console.error('dualInsertUserUploads error:', e.message);
    return { ok: false };
  }
}

// 双写 user_uploads 表 UPDATE
export async function dualUpdateUserUploads(env, id, updates) {
  try {
    await ensureMySQLTables(env);
    const keys = Object.keys(updates);
    if (!keys.length) return { ok: true };
    const setClause = keys.map(k => `\`${k}\`=?`).join(', ');
    const sql = `UPDATE user_uploads SET ${setClause} WHERE id=?`;
    const params = [...keys.map(k => updates[k]), id];
    return await mysqlExec(env, sql, params);
  } catch (e) {
    console.error('dualUpdateUserUploads error:', e.message);
    return { ok: false };
  }
}

// 双写 settings 表（upsert）
export async function dualUpsertSettings(env, key, value) {
  try {
    await ensureMySQLTables(env);
    return await mysqlExec(env,
      "INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)",
      [key, value]
    );
  } catch (e) {
    console.error('dualUpsertSettings error:', e.message);
    return { ok: false };
  }
}

// 双写 api_keys 表 INSERT
export async function dualInsertApiKeys(env, params) {
  try {
    await ensureMySQLTables(env);
    const sql = `INSERT INTO api_keys (\`key\`, name, scopes, enabled, created_at, expires_at, level, key_pass, username)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    return await mysqlExec(env, sql, [
      params.key, params.name, params.scopes, params.enabled, params.created_at,
      params.expires_at, params.level, params.key_pass, params.username
    ]);
  } catch (e) {
    console.error('dualInsertApiKeys error:', e.message);
    return { ok: false };
  }
}

// 双写 api_keys 表 UPDATE
export async function dualUpdateApiKeys(env, id, updates) {
  try {
    await ensureMySQLTables(env);
    const keys = Object.keys(updates);
    if (!keys.length) return { ok: true };
    const setClause = keys.map(k => `\`${k}\`=?`).join(', ');
    const sql = `UPDATE api_keys SET ${setClause} WHERE id=?`;
    const params = [...keys.map(k => updates[k]), id];
    return await mysqlExec(env, sql, params);
  } catch (e) {
    console.error('dualUpdateApiKeys error:', e.message);
    return { ok: false };
  }
}

// 双写 known_chats 表（upsert）
export async function dualUpsertKnownChats(env, params) {
  try {
    await ensureMySQLTables(env);
    const sql = `INSERT INTO known_chats (chat_id, chat_type, chat_title, chat_username, last_active_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE chat_type=VALUES(chat_type), chat_title=VALUES(chat_title),
                 chat_username=VALUES(chat_username), last_active_at=VALUES(last_active_at)`;
    return await mysqlExec(env, sql, [
      params.chat_id, params.chat_type, params.chat_title, params.chat_username, params.last_active_at
    ]);
  } catch (e) {
    console.error('dualUpsertKnownChats error:', e.message);
    return { ok: false };
  }
}

// 双写 user_stats 表（upsert）
export async function dualUpsertUserStats(env, params) {
  try {
    await ensureMySQLTables(env);
    const sql = `INSERT INTO user_stats (user_id, username, full_name, messages, commands, files, inline_queries, callback_clicks, last_active_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE username=VALUES(username), full_name=VALUES(full_name),
                 messages=VALUES(messages), commands=VALUES(commands), files=VALUES(files),
                 inline_queries=VALUES(inline_queries), callback_clicks=VALUES(callback_clicks),
                 last_active_at=VALUES(last_active_at)`;
    return await mysqlExec(env, sql, [
      params.user_id, params.username, params.full_name, params.messages, params.commands,
      params.files, params.inline_queries, params.callback_clicks, params.last_active_at
    ]);
  } catch (e) {
    console.error('dualUpsertUserStats error:', e.message);
    return { ok: false };
  }
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

