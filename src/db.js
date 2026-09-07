// D1 数据库初始化与表结构（含列迁移）
import { genShortKey } from "./core.js";
let _tablesEnsured = false;

// 已迁移的 schema 版本标记。冷启动时只查一次 settings 即可跳过全部 CREATE/迁移，
// 避免每次冷启动 15+ 次串行 D1 往返（此前冷启动接口要数秒到数十秒）。
// 今后新增列/表时递增此版本号，旧版标记会重新跑完整迁移并写入新版本。
const SCHEMA_VERSION = '13';

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
    "CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT, storage_key TEXT NOT NULL, r2_url TEXT NOT NULL, chat_id TEXT, chat_title TEXT, chat_type TEXT, chat_username TEXT, user_id INTEGER, username TEXT, full_name TEXT, telegram_file_id TEXT, file_name TEXT, file_size INTEGER, file_type TEXT, mime_type TEXT, width INTEGER, height INTEGER, caption TEXT, message_id TEXT, md5_hash TEXT, processing_state TEXT DEFAULT 'completed', created_at TEXT, tg_file_url TEXT, error_msg TEXT, progress_bytes INTEGER DEFAULT 0, total_bytes INTEGER DEFAULT 0, thumb_url TEXT, quick_hash TEXT, tags TEXT DEFAULT '', pool_status TEXT DEFAULT '', group_ref TEXT DEFAULT '', level TEXT DEFAULT 'pt', is_private INTEGER DEFAULT 0, media_group_id TEXT DEFAULT '', receipt_msg_id INTEGER DEFAULT 0, source_platform TEXT DEFAULT '', page_url TEXT DEFAULT '', original_url TEXT DEFAULT '');" +
    "CREATE INDEX IF NOT EXISTS idx_files_chat ON files(chat_id);" +
    "CREATE INDEX IF NOT EXISTS idx_files_type ON files(file_type);" +
    "CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);" +
    "CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at);" +
    "CREATE INDEX IF NOT EXISTS idx_files_md5 ON files(md5_hash);" +
    "CREATE INDEX IF NOT EXISTS idx_files_state ON files(processing_state);" +
    "CREATE INDEX IF NOT EXISTS idx_files_quickhash ON files(quick_hash);" +
    "CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at);" +
    "CREATE INDEX IF NOT EXISTS idx_files_tgfileid ON files(telegram_file_id);" +
    "CREATE INDEX IF NOT EXISTS idx_files_active ON files(deleted_at, id DESC);" +
    "CREATE INDEX IF NOT EXISTS idx_files_type_created ON files(file_type, created_at);" +
    "CREATE INDEX IF NOT EXISTS idx_files_chat_created ON files(chat_id, created_at);" +
    "CREATE INDEX IF NOT EXISTS idx_files_user_created ON files(user_id, created_at);" +
    "CREATE TABLE IF NOT EXISTS bot_config (key TEXT PRIMARY KEY, value TEXT);" +
    "CREATE TABLE IF NOT EXISTS bot_commands (id INTEGER PRIMARY KEY AUTOINCREMENT, command TEXT UNIQUE, response TEXT, description TEXT, enabled INTEGER, created_at TEXT, menu TEXT DEFAULT '');" +
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);" +
    "CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, name TEXT, scopes TEXT DEFAULT 'files:read', enabled INTEGER DEFAULT 1, created_at TEXT, last_used_at TEXT, usage_count INTEGER DEFAULT 0, expires_at TEXT, level TEXT DEFAULT 'pt', key_pass TEXT, username TEXT);" +
    "CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);" +
    "CREATE INDEX IF NOT EXISTS idx_api_keys_username ON api_keys(username);" +
    "CREATE INDEX IF NOT EXISTS idx_api_keys_enabled ON api_keys(enabled);" +
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
    "CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT DEFAULT '', category TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, created_at TEXT);" +
    "CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);" +
    "CREATE TABLE IF NOT EXISTS folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_id INTEGER DEFAULT NULL, created_at TEXT, updated_at TEXT);" +
    "CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);" +
    "CREATE TABLE IF NOT EXISTS user_uploads (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, url TEXT NOT NULL, thumb_url TEXT, file_name TEXT, file_size INTEGER, file_type TEXT, width INTEGER, height INTEGER, tags TEXT DEFAULT '', created_at TEXT, deleted_at TEXT);" +
    "CREATE INDEX IF NOT EXISTS idx_user_uploads_user ON user_uploads(user_id);" +
    "CREATE INDEX IF NOT EXISTS idx_user_uploads_created ON user_uploads(created_at);" +
    "CREATE TABLE IF NOT EXISTS app_installs (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, app_version TEXT DEFAULT '', build_number INTEGER DEFAULT 0, platform TEXT DEFAULT 'android', model TEXT DEFAULT '', os_version TEXT DEFAULT '', screen_width INTEGER DEFAULT 0, screen_height INTEGER DEFAULT 0, installed_at TEXT, last_heartbeat_at TEXT, heartbeat_count INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1);" +
    "CREATE INDEX IF NOT EXISTS idx_app_installs_device ON app_installs(device_id);" +
    "CREATE INDEX IF NOT EXISTS idx_app_installs_version ON app_installs(app_version);" +
    "CREATE INDEX IF NOT EXISTS idx_app_installs_active ON app_installs(is_active);" +
    "CREATE INDEX IF NOT EXISTS idx_app_installs_heartbeat ON app_installs(last_heartbeat_at);"
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
    ["receipt_msg_id", "ALTER TABLE files ADD COLUMN receipt_msg_id INTEGER DEFAULT 0"],
    ["page_url", "ALTER TABLE files ADD COLUMN page_url TEXT DEFAULT ''"],
    ["original_url", "ALTER TABLE files ADD COLUMN original_url TEXT DEFAULT ''"]
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
      if (akn.indexOf('upload_quota') === -1) {
        await db.exec("ALTER TABLE api_keys ADD COLUMN upload_quota INTEGER DEFAULT 100");
        console.log('migrated: api_keys.upload_quota column');
      }
      if (akn.indexOf('upload_used') === -1) {
        await db.exec("ALTER TABLE api_keys ADD COLUMN upload_used INTEGER DEFAULT 0");
        console.log('migrated: api_keys.upload_used column');
      }
      if (akn.indexOf('storage_used') === -1) {
        await db.exec("ALTER TABLE api_keys ADD COLUMN storage_used INTEGER DEFAULT 0");
        console.log('migrated: api_keys.storage_used column');
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
    // random_pool.level / is_private / folder_id：内容分级、私密库与文件夹（旧库无此列则补加）
    try {
      const rp = await db.prepare("PRAGMA table_info(random_pool)").all();
      const rpn = (rp.results || []).map(function(c) { return c.name; });
      if (rpn.indexOf('level') === -1) await db.exec("ALTER TABLE random_pool ADD COLUMN level TEXT DEFAULT 'pt'");
      if (rpn.indexOf('is_private') === -1) await db.exec("ALTER TABLE random_pool ADD COLUMN is_private INTEGER DEFAULT 0");
      if (rpn.indexOf('folder_id') === -1) await db.exec("ALTER TABLE random_pool ADD COLUMN folder_id INTEGER DEFAULT NULL");
      console.log('migrated: random_pool level/is_private/folder_id columns');
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
    // app_installs：App 安装统计表（设备心跳 / 版本分布 / 存活统计）
    try {
      await db.exec("CREATE TABLE IF NOT EXISTS app_installs (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, app_version TEXT DEFAULT '', build_number INTEGER DEFAULT 0, platform TEXT DEFAULT 'android', model TEXT DEFAULT '', os_version TEXT DEFAULT '', screen_width INTEGER DEFAULT 0, screen_height INTEGER DEFAULT 0, installed_at TEXT, last_heartbeat_at TEXT, heartbeat_count INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_app_installs_device ON app_installs(device_id)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_app_installs_version ON app_installs(app_version)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_app_installs_active ON app_installs(is_active)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_app_installs_heartbeat ON app_installs(last_heartbeat_at)");
      console.log('migrated: app_installs table');
    } catch (e12) { console.error('app_installs table:', e12.message); }
    // api_keys 表索引：加速 key/username 查询
    try {
      await db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_username ON api_keys(username)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_enabled ON api_keys(enabled)");
      console.log('migrated: api_keys indexes');
    } catch (e15) { console.error('api_keys indexes:', e15.message); }
    // files 表复合索引：优化常见查询模式
    try {
      await db.exec("CREATE INDEX IF NOT EXISTS idx_files_active ON files(deleted_at, id DESC)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_files_type_created ON files(file_type, created_at)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_files_chat_created ON files(chat_id, created_at)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_files_user_created ON files(user_id, created_at)");
      console.log('migrated: files composite indexes');
    } catch (e16) { console.error('files composite indexes:', e16.message); }
    // 迁移完成：写入 schema 版本标记，后续冷启动跳过全部 CREATE/ALTER
    try {
      await db.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(SCHEMA_VERSION).run();
    } catch (e16) { console.error('write schema_version:', e16.message); }
  } catch(e) { console.error('column migration:', e.message); throw e; }
  return true;
}
