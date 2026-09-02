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

