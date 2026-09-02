// 存量数据迁移：D1 → MySQL 全量镜像
// 使用方式：admin 调用 GET /admin/api/migrate?table=xxx（可选 batch）
// 幂等：INSERT IGNORE，可重复执行；游标存 MySQL settings，跨请求续跑。
// settings/bot_config 主键是 key；其余表主键是 id。
import { json } from './util.js';
import { mysqlExec, mysqlGet } from './mysql.js';

const PK_ID = ['files', 'userbot_tasks', 'ubot_albums', 'api_keys', 'redeem_codes', 'random_pool', 'tags', 'show_groups', 'bot_commands'];
const PK_KEY = ['settings', 'bot_config'];

const MIGRATE_TABLES = PK_ID.concat(PK_KEY);

function batchSizeFor(table) {
  return table === 'files' ? 100 : 500;
}

export async function handleMigrate(request, env) {
  const u = new URL(request.url);
  const table = u.searchParams.get('table') || '';
  const reset = u.searchParams.get('reset') === '1';
  const wantBatch = parseInt(u.searchParams.get('batch') || '0', 10);
  if (table && MIGRATE_TABLES.indexOf(table) === -1) {
    return json({ ok: false, error: 'unknown table: ' + table }, 400);
  }
  try {
    const list = table ? [table] : MIGRATE_TABLES;
    const out = { ok: true, done: {}, pending: {}, lastId: {} };
    for (const t of list) {
      if (reset) await mysqlExec(env, "INSERT INTO settings (`key`,`value`) VALUES (?,?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)", ['migrate_cursor_' + t, '0']);
      await migrateTable(env, t, wantBatch, out);
    }
    return json(out);
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function migrateTable(env, table, wantBatch, out) {
  const perBatch = (wantBatch > 0 ? wantBatch : batchSizeFor(table));
  const isKeyTable = PK_KEY.indexOf(table) !== -1;
  const cursorKey = 'migrate_cursor_' + table;

  // 读游标（从 MySQL settings）
  let cursor = '';
  if (isKeyTable) {
    // key 表无单调游标：一次全量，游标标 done
    const mark = await mysqlGet(env, "SELECT `value` FROM settings WHERE `key`=?", [cursorKey]);
    if (mark && mark.value === 'done') { out.done[table] = true; out.pending[table] = 0; return; }
  } else {
    const cur = await mysqlGet(env, "SELECT `value` FROM settings WHERE `key`=?", [cursorKey]);
    cursor = String((cur && cur.value) || '0');
  }

  if (isKeyTable) {
    // settings / bot_config：全量 SELECT * 到 MySQL（INSERT IGNORE）
    const d = await env.D1_DB.prepare('SELECT * FROM "' + table + '"').all();
    const rows = (d.results || []);
    if (rows.length) await insertRowsGeneric(env, table, rows);
    await mysqlExec(env, "INSERT INTO settings (`key`,`value`) VALUES (?,?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)", [cursorKey, 'done']);
    out.pending[table] = 0; out.done[table] = true;
    return;
  }

  // id 表：按游标分页
  const d = await env.D1_DB.prepare('SELECT * FROM "' + table + '" WHERE id > ? ORDER BY id ASC LIMIT ?').bind(Number(cursor) || 0, perBatch).all();
  const rows = (d.results || []);
  if (!rows.length) {
    out.done[table] = true; out.pending[table] = 0;
    return;
  }
  const maxId = Number(rows[rows.length - 1].id);
  await insertBatchMysql(env, table, rows);
  // 每表每批独立连接，游标写 MySQL settings（不用 D1，避免 D1 settings 循环）
  await mysqlExec(env, "INSERT INTO settings (`key`,`value`) VALUES (?,?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)", [cursorKey, String(maxId)]);
  out.pending[table] = rows.length;
  out.lastId[table] = maxId;
}

async function insertBatchMysql(env, table, rows) {
  if (table === 'userbot_tasks') {
    // D1 用 "limit" 列，MySQL 镜像用 blimit
    const mapped = rows.map(function(r) {
      const o = Object.assign({}, r);
      o.blimit = r.limit;
      delete o.limit;
      return o;
    });
    return insertRowsGeneric(env, table, mapped);
  }
  if (table === 'ubot_albums') {
    // D1 用 count 列，MySQL 镜像用 mcount
    const mapped = rows.map(function(r) {
      const o = Object.assign({}, r);
      o.mcount = r.count;
      delete o.count;
      return o;
    });
    return insertRowsGeneric(env, table, mapped);
  }
  return insertRowsGeneric(env, table, rows);
}

async function insertRowsGeneric(env, table, rows) {
  const cols = Object.keys(rows[0]);
  const cnames = cols.map(function(c) { return '`' + c + '`'; }).join(',');
  const ph = cols.map(function(){ return '?'; }).join(',');
  const multiSql = 'INSERT IGNORE INTO `' + table + '` (' + cnames + ') VALUES ' +
    rows.map(function(){ return '(' + ph + ')'; }).join(',');
  const flat = [];
  rows.forEach(function(r) {
    cols.forEach(function(c) { flat.push(r[c] === undefined ? null : r[c]); });
  });
  await mysqlExec(env, multiSql, flat);
}
