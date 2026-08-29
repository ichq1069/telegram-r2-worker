// D1 数据库初始化与表结构（含列迁移）
let _tablesEnsured = false;

// Run ensureTables only once per isolate (cold start), then reuse. Avoids multi-second
// D1 setup overhead on every request (previously made /show etc. take 3s+).
export async function ensureTablesOnce(db) {
  if (_tablesEnsured) return true;
  await ensureTables(db);
  _tablesEnsured = true;
  return true;
}

export async function ensureTables(db) {
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
    "CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, name TEXT, scopes TEXT DEFAULT 'files:read', enabled INTEGER DEFAULT 1, created_at TEXT, last_used_at TEXT, usage_count INTEGER DEFAULT 0, expires_at TEXT, level TEXT DEFAULT 'pt');" +
    "CREATE TABLE IF NOT EXISTS random_pool (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, thumb_url TEXT, title TEXT, tags TEXT DEFAULT '', file_type TEXT DEFAULT 'photo', width INTEGER, height INTEGER, file_size INTEGER, source TEXT DEFAULT 'manual', tg_file_id INTEGER, enabled INTEGER DEFAULT 1, created_at TEXT, level TEXT DEFAULT 'pt', is_private INTEGER DEFAULT 0);" +
    "CREATE INDEX IF NOT EXISTS idx_pool_url ON random_pool(url);" +
    "CREATE TABLE IF NOT EXISTS show_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, images TEXT DEFAULT '', created_at TEXT);" +
    "CREATE TABLE IF NOT EXISTS rate_limits (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, window TEXT NOT NULL, count INTEGER DEFAULT 0, UNIQUE(key, window));" +
    "CREATE TABLE IF NOT EXISTS worker_stats (day TEXT PRIMARY KEY, requests INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, updated_at TEXT);"
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
    // api_keys.expires_at：到期时间（旧库无此列则补加）
    try {
      const ak = await db.prepare("PRAGMA table_info(api_keys)").all();
      const akn = (ak.results || []).map(function(c) { return c.name; });
      if (akn.indexOf('expires_at') === -1) {
        await db.exec("ALTER TABLE api_keys ADD COLUMN expires_at TEXT");
        console.log('migrated: api_keys.expires_at column');
      }
    } catch (e4) { console.error('api_keys expires migration:', e4.message); }
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
    // api_keys.level：密钥分级（旧库无此列则补加）
    try {
      const ak2 = await db.prepare("PRAGMA table_info(api_keys)").all();
      const ak2n = (ak2.results || []).map(function(c) { return c.name; });
      if (ak2n.indexOf('level') === -1) {
        await db.exec("ALTER TABLE api_keys ADD COLUMN level TEXT DEFAULT 'pt'");
        console.log('migrated: api_keys.level column');
      }
    } catch (e7) { console.error('api_keys level migration:', e7.message); }
  } catch(e) { console.error('column migration:', e.message); throw e; }
  return true;
}
