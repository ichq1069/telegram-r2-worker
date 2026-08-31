// D1 数据库初始化与表结构（含列迁移）
import { genShortKey } from "./core.js";
let _tablesEnsured = false;

// 已迁移的 schema 版本标记。冷启动时只查一次 settings 即可跳过全部 CREATE/迁移，
// 避免每次冷启动 15+ 次串行 D1 往返（此前冷启动接口要数秒到数十秒）。
// 今后新增列/表时递增此版本号，旧版标记会重新跑完整迁移并写入新版本。
const SCHEMA_VERSION = '3';

// Run ensureTables only once per isolate (cold start), then reuse. Avoids multi-second
// D1 setup overhead on every request (previously made /show etc. take 3s+).
export async function ensureTablesOnce(db) {
  if (_tablesEnsured) return true;
  await ensureTables(db);
  _tablesEnsured = true;
  return true;
}

export async function ensureTables(db) {
  // 已迁移完成：1 次 SELECT 判定直接返回，跳过全部 CREATE/ALTER（冷启动大提速）
  try {
    const v = await db.prepare("SELECT value FROM settings WHERE key='schema_version'").first();
    if (v && v.value === SCHEMA_VERSION) return true;
  } catch (e) { /* settings 表可能尚不存在，继续完整初始化 */ }
  // Single exec: all CREATE TABLE/INDEX in one round-trip (was 10+ sequential D1 calls,
  // which added seconds to every cold-start request). Column migration below stays as fallback.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT, storage_key TEXT NOT NULL, r2_url TEXT NOT NULL, chat_id TEXT, chat_title TEXT, chat_type TEXT, chat_username TEXT, user_id INTEGER, username TEXT, full_name TEXT, telegram_file_id TEXT, file_name TEXT, file_size INTEGER, file_type TEXT, mime_type TEXT, width INTEGER, height INTEGER, caption TEXT, message_id TEXT, md5_hash TEXT, processing_state TEXT DEFAULT 'completed', created_at TEXT, tg_file_url TEXT, error_msg TEXT, progress_bytes INTEGER DEFAULT 0, total_bytes INTEGER DEFAULT 0, thumb_url TEXT, quick_hash TEXT, tags TEXT DEFAULT '', pool_status TEXT DEFAULT '', group_ref TEXT DEFAULT '', level TEXT DEFAULT 'pt', is_private INTEGER DEFAULT 0, media_group_id TEXT DEFAULT '', receipt_msg_id INTEGER DEFAULT 0);" +
    "CREATE INDEX IF NOT EXISTS idx_files_chat ON files(chat_id);" +
    "CREATE INDEX IF NOT EXISTS idx_files_type ON files(file_type);" +
    "CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);" +
    "CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at);" +
    "CREATE INDEX IF NOT EXISTS idx_files_md5 ON files(md5_hash);" +
    "CREATE INDEX IF NOT EXISTS idx_files_state ON files(processing_state);" +
    "CREATE INDEX IF NOT EXISTS idx_files_quickhash ON files(quick_hash);" +
    "CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at);" +
    "CREATE INDEX IF NOT EXISTS idx_files_tgfileid ON files(telegram_file_id);" +
    "CREATE TABLE IF NOT EXISTS bot_config (key TEXT PRIMARY KEY, value TEXT);" +
    "CREATE TABLE IF NOT EXISTS bot_commands (id INTEGER PRIMARY KEY AUTOINCREMENT, command TEXT UNIQUE, response TEXT, description TEXT, enabled INTEGER, created_at TEXT, menu TEXT DEFAULT '');" +
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);" +
    "CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, name TEXT, scopes TEXT DEFAULT 'files:read', enabled INTEGER DEFAULT 1, created_at TEXT, last_used_at TEXT, usage_count INTEGER DEFAULT 0, expires_at TEXT, level TEXT DEFAULT 'pt', key_pass TEXT, username TEXT);" +
    "CREATE TABLE IF NOT EXISTS random_pool (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, thumb_url TEXT, title TEXT, tags TEXT DEFAULT '', file_type TEXT DEFAULT 'photo', width INTEGER, height INTEGER, file_size INTEGER, source TEXT DEFAULT 'manual', tg_file_id INTEGER, enabled INTEGER DEFAULT 1, created_at TEXT, level TEXT DEFAULT 'pt', is_private INTEGER DEFAULT 0);" +
    "CREATE INDEX IF NOT EXISTS idx_pool_url ON random_pool(url);" +
    "CREATE TABLE IF NOT EXISTS show_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, images TEXT DEFAULT '', created_at TEXT);" +
    "CREATE TABLE IF NOT EXISTS rate_limits (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, window TEXT NOT NULL, count INTEGER DEFAULT 0, UNIQUE(key, window));" +
    "CREATE TABLE IF NOT EXISTS worker_stats (day TEXT PRIMARY KEY, requests INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, updated_at TEXT);" +
    "CREATE TABLE IF NOT EXISTS user_stats (user_id INTEGER PRIMARY KEY, username TEXT, full_name TEXT, messages INTEGER DEFAULT 0, commands INTEGER DEFAULT 0, files INTEGER DEFAULT 0, inline_queries INTEGER DEFAULT 0, callback_clicks INTEGER DEFAULT 0, last_active_at TEXT);" +
    "CREATE TABLE IF NOT EXISTS known_chats (chat_id TEXT PRIMARY KEY, chat_type TEXT DEFAULT '', chat_title TEXT, chat_username TEXT, last_active_at TEXT);" +
    "CREATE TABLE IF NOT EXISTS redeem_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, level TEXT DEFAULT 'pt', quota INTEGER DEFAULT 1, used_count INTEGER DEFAULT 0, note TEXT DEFAULT '', enabled INTEGER DEFAULT 1, created_at TEXT, expires_at TEXT, type TEXT DEFAULT 'register', extend_days INTEGER DEFAULT 0);" +
    "CREATE INDEX IF NOT EXISTS idx_redeem_code ON redeem_codes(code);" +
    "CREATE TABLE IF NOT EXISTS api_call_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, key_id INTEGER, api_key TEXT, path TEXT, method TEXT, ip TEXT, status INTEGER DEFAULT 200, created_at TEXT);" +
    "CREATE INDEX IF NOT EXISTS idx_calls_key ON api_call_logs(key_id);" +
    "CREATE INDEX IF NOT EXISTS idx_calls_created ON api_call_logs(created_at);" +
    "CREATE TABLE IF NOT EXISTS userbot_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, title TEXT DEFAULT '', tags TEXT DEFAULT '', pool INTEGER DEFAULT 0, level TEXT DEFAULT 'pt', max_size INTEGER DEFAULT 0, \"limit\" INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1, last_id INTEGER DEFAULT 0, done INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, note TEXT DEFAULT '', created_at TEXT, updated_at TEXT);" +
    "CREATE INDEX IF NOT EXISTS idx_ubot_chat ON userbot_tasks(chat_id);" +
    "CREATE TABLE IF NOT EXISTS ub_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT DEFAULT '', token TEXT DEFAULT '', note TEXT DEFAULT '', status TEXT DEFAULT 'offline', last_seen_at TEXT, last_ip TEXT, last_info TEXT DEFAULT '', task_ids TEXT DEFAULT '', created_at TEXT, updated_at TEXT);" +
    "CREATE TABLE IF NOT EXISTS ub_task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, server_id INTEGER DEFAULT 0, server_name TEXT DEFAULT '', status TEXT DEFAULT 'running', done INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, error TEXT DEFAULT '', started_at TEXT, finished_at TEXT);"
  );

  // Reliable column migration fallback: check with PRAGMA, then ALTER individually (old DBs only)
  const wantCols = [
    ["md5_hash", "ALTER TABLE files ADD COLUMN md5_hash TEXT DEFAULT ''"],
    ["processing_state", "ALTER TABLE files ADD COLUMN processing_state TEXT DEFAULT 'completed'"],
    ["tg_file_url", 'ALTER TABLE files ADD COLUMN tg_file_url TEXT'],
    ["error_msg", 'ALTER TABLE files ADD COLUMN error_msg TEXT'],
    ["progress_bytes", 'ALTER TABLE files ADD COLUMN progress_bytes INTEGER DEFAULT 0'],
    ["total_bytes", 'ALTER TABLE files ADD COLUMN total_bytes INTEGER DEFAULT 0'],
    ["thumb_url", 'ALTER TABLE files ADD COLUMN thumb_url TEXT'],
    ["quick_hash", 'ALTER TABLE files ADD COLUMN quick_hash TEXT'],
    ["tags", "ALTER TABLE files ADD COLUMN tags TEXT DEFAULT ''"],
    ["pool_status", "ALTER TABLE files ADD COLUMN pool_status TEXT DEFAULT ''"],
    ["group_ref", "ALTER TABLE files ADD COLUMN group_ref TEXT DEFAULT ''"],
    ["deleted_at", 'ALTER TABLE files ADD COLUMN deleted_at TEXT'],
    ["view_count", 'ALTER TABLE files ADD COLUMN view_count INTEGER DEFAULT 0'],
    ["level", "ALTER TABLE files ADD COLUMN level TEXT DEFAULT 'pt'"],
    ["is_private", "ALTER TABLE files ADD COLUMN is_private INTEGER DEFAULT 0"],
    ["media_group_id", "ALTER TABLE files ADD COLUMN media_group_id TEXT DEFAULT ''"],
    ["receipt_msg_id", "ALTER TABLE files ADD COLUMN receipt_msg_id INTEGER DEFAULT 0"]
  ];
  try {
    const cols = await db.prepare("PRAGMA table_info(files)").all();
    const names = (cols.results || []).map(function(c) { return c.name; });
    for (const wc of wantCols) {
      if (names.indexOf(wc[0]) !== -1) continue;
      try {
        await db.exec(wc[1]);
        console.log('migrated: added ' + wc[0] + ' column');
      } catch (e2) {
        console.error('column migration failed for ' + wc[0] + ':', e2.message);
      }
    }
    // Verify columns actually exist. If a critical one is still missing, fail
    // (instead of silently setting the once-flag) so it is retried next request.
    const cols2 = await db.prepare("PRAGMA table_info(files)").all();
    const names2 = (cols2.results || []).map(function(c) { return c.name; });
    for (const wc of wantCols) {
      if (names2.indexOf(wc[0]) === -1) throw new Error('column still missing after migration: ' + wc[0]);
    }
    // bot_commands.menu：数字菜单交互配置（旧库无此列则补加）
    try {
      const bc = await db.prepare("PRAGMA table_info(bot_commands)").all();
      const bcn = (bc.results || []).map(function(c) { return c.name; });
      if (bcn.indexOf('menu') === -1) {
        await db.exec("ALTER TABLE bot_commands ADD COLUMN menu TEXT DEFAULT ''");
        console.log('migrated: bot_commands.menu column');
      }
      if (bcn.indexOf('builtin') === -1) {
        await db.exec("ALTER TABLE bot_commands ADD COLUMN builtin INTEGER DEFAULT 0");
        console.log('migrated: bot_commands.builtin column');
      }
    } catch (e3) { console.error('bot_commands menu migration:', e3.message); }
    // api_keys 各列迁移（expires_at / level / key_pass / username / short_key）合并为一次 PRAGMA，
    // 避免冷启动时 5 次串行 D1 往返；short_key 缺失值一次性补生成
    try {
      const ak = await db.prepare("PRAGMA table_info(api_keys)").all();
      const akn = (ak.results || []).map(function(c) { return c.name; });
      if (akn.indexOf('expires_at') === -1) {
        await db.exec("ALTER TABLE api_keys ADD COLUMN expires_at TEXT");
        console.log('migrated: api_keys.expires_at column');
      }
      if (akn.indexOf('level') === -1) {
        await db.exec("ALTER TABLE api_keys ADD COLUMN level TEXT DEFAULT 'pt'");
        console.log('migrated: api_keys.level column');
      }
      if (akn.indexOf('key_pass') === -1) {
        await db.exec("ALTER TABLE api_keys ADD COLUMN key_pass TEXT");
        console.log('migrated: api_keys.key_pass column');
      }
      if (akn.indexOf('username') === -1) {
        await db.exec("ALTER TABLE api_keys ADD COLUMN username TEXT");
        console.log('migrated: api_keys.username column');
      }
      if (akn.indexOf('short_key') === -1) {
        await db.exec("ALTER TABLE api_keys ADD COLUMN short_key TEXT");
        console.log('migrated: api_keys.short_key column');
      }
      const missing = await db.prepare("SELECT id FROM api_keys WHERE short_key IS NULL OR short_key=''").all();
      for (const row of (missing.results || [])) {
        const sk = genShortKey();
        await db.prepare("UPDATE api_keys SET short_key=? WHERE id=?").bind(sk, row.id).run();
      }
      if ((missing.results || []).length) console.log('migrated: backfilled short_key for ' + missing.results.length + ' keys');
    } catch (e4) { console.error('api_keys migrations:', e4.message); }
    // show_groups.mode / daily_count / updated_at：节目组定时换图（旧库无此列则补加）
    try {
      const sg = await db.prepare("PRAGMA table_info(show_groups)").all();
      const sgn = (sg.results || []).map(function(c) { return c.name; });
      if (sgn.indexOf('mode') === -1) await db.exec("ALTER TABLE show_groups ADD COLUMN mode TEXT DEFAULT 'fixed'");
      if (sgn.indexOf('daily_count') === -1) await db.exec("ALTER TABLE show_groups ADD COLUMN daily_count INTEGER DEFAULT 0");
      if (sgn.indexOf('updated_at') === -1) await db.exec("ALTER TABLE show_groups ADD COLUMN updated_at TEXT");
      console.log('migrated: show_groups mode/daily_count/updated_at columns');
    } catch (e5) { console.error('show_groups migration:', e5.message); }
    // random_pool.level / is_private：内容分级与私密库（旧库无此列则补加）
    try {
      const rp = await db.prepare("PRAGMA table_info(random_pool)").all();
      const rpn = (rp.results || []).map(function(c) { return c.name; });
      if (rpn.indexOf('level') === -1) await db.exec("ALTER TABLE random_pool ADD COLUMN level TEXT DEFAULT 'pt'");
      if (rpn.indexOf('is_private') === -1) await db.exec("ALTER TABLE random_pool ADD COLUMN is_private INTEGER DEFAULT 0");
      console.log('migrated: random_pool level/is_private columns');
    } catch (e6) { console.error('random_pool migration:', e6.message); }
    // user_stats 交互统计列（旧库有表但缺列时补加，避免 INSERT 失败）
    try {
      const us = await db.prepare("PRAGMA table_info(user_stats)").all();
      const usn = (us.results || []).map(function(c) { return c.name; });
      const usCols = [
        ['messages', "ALTER TABLE user_stats ADD COLUMN messages INTEGER DEFAULT 0"],
        ['commands', "ALTER TABLE user_stats ADD COLUMN commands INTEGER DEFAULT 0"],
        ['files', "ALTER TABLE user_stats ADD COLUMN files INTEGER DEFAULT 0"],
        ['inline_queries', "ALTER TABLE user_stats ADD COLUMN inline_queries INTEGER DEFAULT 0"],
        ['callback_clicks', "ALTER TABLE user_stats ADD COLUMN callback_clicks INTEGER DEFAULT 0"],
        ['last_active_at', "ALTER TABLE user_stats ADD COLUMN last_active_at TEXT"]
      ];
      for (const uc of usCols) {
        if (usn.indexOf(uc[0]) !== -1) continue;
        await db.exec(uc[1]);
        console.log('migrated: user_stats.' + uc[0] + ' column');
      }
    } catch (e8) { console.error('user_stats migration:', e8.message); }
    // redeem_codes.type / extend_days：兑换码类型（register=注册码 / upgrade=权限升级码 / extend=延时码）与延时天数
    try {
      const rc = await db.prepare("PRAGMA table_info(redeem_codes)").all();
      const rcn = (rc.results || []).map(function(c) { return c.name; });
      if (rcn.indexOf('type') === -1) {
        await db.exec("ALTER TABLE redeem_codes ADD COLUMN type TEXT DEFAULT 'register'");
        console.log('migrated: redeem_codes.type column');
      }
      if (rcn.indexOf('extend_days') === -1) {
        await db.exec("ALTER TABLE redeem_codes ADD COLUMN extend_days INTEGER DEFAULT 0");
        console.log('migrated: redeem_codes.extend_days column');
      }
    } catch (e10) { console.error('redeem_codes migration:', e10.message); }
    // webhook_logs：webhook 投递日志（最近正常/错误记录，供后台查看）
    try {
      await db.exec("CREATE TABLE IF NOT EXISTS webhook_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, status INTEGER DEFAULT 200, ok INTEGER DEFAULT 1, source TEXT DEFAULT 'webhook', error TEXT DEFAULT '', created_at TEXT)");
    } catch (e11) { console.error('webhook_logs table:', e11.message); }
    // userbot_tasks：MTProto 群历史抓取任务（每群一条，脚本从后台拉配置执行，断点 last_id 回写）
    try {
      await db.exec("CREATE TABLE IF NOT EXISTS userbot_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, title TEXT DEFAULT '', tags TEXT DEFAULT '', pool INTEGER DEFAULT 0, level TEXT DEFAULT 'pt', max_size INTEGER DEFAULT 0, \"limit\" INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1, last_id INTEGER DEFAULT 0, done INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, note TEXT DEFAULT '', created_at TEXT, updated_at TEXT)");
    } catch (e12) { console.error('userbot_tasks table:', e12.message); }
    // ub_servers：群抓取执行服务器节点（VPS/Containers），脚本定时心跳上报在线状态
    try {
      await db.exec("CREATE TABLE IF NOT EXISTS ub_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT DEFAULT '', token TEXT DEFAULT '', note TEXT DEFAULT '', status TEXT DEFAULT 'offline', last_seen_at TEXT, last_ip TEXT, last_info TEXT DEFAULT '', task_ids TEXT DEFAULT '', created_at TEXT, updated_at TEXT)");
    } catch (e13) { console.error('ub_servers table:', e13.message); }
    // ub_task_runs：任务执行日志（脚本每次执行前后上报状态）
    try {
      await db.exec("CREATE TABLE IF NOT EXISTS ub_task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, server_id INTEGER DEFAULT 0, server_name TEXT DEFAULT '', status TEXT DEFAULT 'running', done INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, error TEXT DEFAULT '', started_at TEXT, finished_at TEXT)");
    } catch (e14) { console.error('ub_task_runs table:', e14.message); }
    // 迁移完成：写入 schema 版本标记，后续冷启动跳过全部 CREATE/ALTER
    try {
      await db.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(SCHEMA_VERSION).run();
    } catch (e16) { console.error('write schema_version:', e16.message); }
  } catch(e) { console.error('column migration:', e.message); throw e; }
  return true;
}
