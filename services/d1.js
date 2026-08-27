/**
 * D1 数据库服务
 */

// 建表 SQL
const CREATE_TABLE_SQL = [
  `CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storage_key TEXT NOT NULL,
    r2_url TEXT NOT NULL,
    chat_id TEXT DEFAULT '',
    chat_title TEXT DEFAULT '',
    chat_type TEXT DEFAULT '',
    chat_username TEXT DEFAULT '',
    user_id INTEGER DEFAULT 0,
    username TEXT DEFAULT '',
    full_name TEXT DEFAULT '',
    telegram_file_id TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    file_type TEXT DEFAULT '',
    mime_type TEXT DEFAULT '',
    width INTEGER DEFAULT 0,
    height INTEGER DEFAULT 0,
    caption TEXT DEFAULT '',
    message_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_files_chat ON files(chat_id)`,
  `CREATE INDEX IF NOT EXISTS idx_files_type ON files(file_type)`,
  `CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at)`,
];

export async function ensureTable(db) {
  try {
    // 检查表是否已存在
    const check = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'").first();
    if (check) return true;

    // 建表
    await db.prepare(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        storage_key TEXT NOT NULL,
        r2_url TEXT NOT NULL,
        chat_id TEXT DEFAULT '',
        chat_title TEXT DEFAULT '',
        chat_type TEXT DEFAULT '',
        chat_username TEXT DEFAULT '',
        user_id INTEGER DEFAULT 0,
        username TEXT DEFAULT '',
        full_name TEXT DEFAULT '',
        telegram_file_id TEXT DEFAULT '',
        file_name TEXT DEFAULT '',
        file_size INTEGER DEFAULT 0,
        file_type TEXT DEFAULT '',
        mime_type TEXT DEFAULT '',
        width INTEGER DEFAULT 0,
        height INTEGER DEFAULT 0,
        caption TEXT DEFAULT '',
        message_id TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run();

    // 建索引
    await db.prepare('CREATE INDEX idx_files_chat ON files(chat_id)').run();
    await db.prepare('CREATE INDEX idx_files_type ON files(file_type)').run();
    await db.prepare('CREATE INDEX idx_files_user ON files(user_id)').run();
    await db.prepare('CREATE INDEX idx_files_created ON files(created_at)').run();

    console.log('建表成功');
    return true;
  } catch (e) {
    console.error('建表失败:', e);
    return false;
  }
}

export async function insertRecord(db, data) {
  try {
    await ensureTable(db);

    const result = await db.prepare(`
      INSERT INTO files (
        storage_key, r2_url, chat_id, chat_title, chat_type, chat_username,
        user_id, username, full_name, telegram_file_id,
        file_name, file_size, file_type, mime_type, width, height,
        caption, message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      data.storageKey, data.r2Url, data.chatId, data.chatTitle, data.chatType, data.chatUsername,
      data.userId, data.username, data.fullName, data.telegramFileId,
      data.fileName, data.fileSize, data.fileType, data.mimeType, data.width, data.height,
      data.caption, data.messageId, data.createdAt
    ).run();

    return result.meta?.last_row_id || null;
  } catch (e) {
    console.error('插入记录失败:', e);
    return null;
  }
}

export async function queryFiles(db, { where, params, page, pageSize }) {
  const offset = (page - 1) * pageSize;

  const countResult = await db.prepare(`SELECT COUNT(*) as total FROM files ${where}`).bind(...params).first();
  const total = countResult?.total || 0;

  const dataResult = await db.prepare(
    `SELECT * FROM files ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(...params, pageSize, offset).all();

  return {
    total,
    page,
    page_size: pageSize,
    total_pages: Math.ceil(total / pageSize),
    items: dataResult.results || [],
  };
}

export async function getFileById(db, id) {
  return await db.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
}

export async function getFileByUrl(db, url) {
  return await db.prepare('SELECT * FROM files WHERE r2_url = ?').bind(url).first();
}

export async function getStorageKey(db, id) {
  const file = await db.prepare('SELECT storage_key FROM files WHERE id = ?').bind(id).first();
  return file?.storage_key;
}

export async function getStats(db) {
  const total = await db.prepare('SELECT COUNT(*) as count FROM files').first();
  const byType = await db.prepare('SELECT file_type, COUNT(*) as count FROM files GROUP BY file_type').all();
  const byChat = await db.prepare('SELECT chat_title, chat_id, COUNT(*) as count FROM files GROUP BY chat_title ORDER BY count DESC LIMIT 20').all();
  const totalSize = await db.prepare('SELECT SUM(file_size) as total_size FROM files').first();
  const today = await db.prepare("SELECT COUNT(*) as count FROM files WHERE created_at >= date('now')").first();
  const thisMonth = await db.prepare("SELECT COUNT(*) as count FROM files WHERE created_at >= date('now', 'start of month')").first();

  return {
    total_files: total?.count || 0,
    total_size: totalSize?.total_size || 0,
    total_size_formatted: formatFileSize(totalSize?.total_size || 0),
    today_uploads: today?.count || 0,
    month_uploads: thisMonth?.count || 0,
    by_type: byType.results || [],
    by_chat: byChat.results || [],
  };
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
