/**
 * API 接口处理
 */
import { jsonResponse } from '../utils/response.js';
import { formatFileSize } from '../utils/helpers.js';
import { ensureTable } from '../services/d1.js';

// 初始化/诊断
export async function handleInit(env) {
  const result = { d1: false, r2: false, table: false, error: null };
  try {
    if (env.D1_DB) {
      result.d1 = true;
      const ok = await ensureTable(env.D1_DB);
      result.table = ok;
      if (ok) {
        const count = await env.D1_DB.prepare('SELECT COUNT(*) as c FROM files').first();
        result.count = count?.c || 0;
      }
    }
    if (env.R2_BUCKET) {
      result.r2 = true;
    }
  } catch (e) {
    result.error = e.message;
  }
  return jsonResponse({ ok: true, data: result });
}

// 查询文件列表
export async function handleQueryFiles(request, env) {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = Math.min(parseInt(url.searchParams.get('page_size') || '20'), 100);
  const fileType = url.searchParams.get('type') || '';
  const chatId = url.searchParams.get('chat_id') || '';
  const userId = url.searchParams.get('user_id') || '';
  const keyword = url.searchParams.get('keyword') || '';
  const startDate = url.searchParams.get('start_date') || '';
  const endDate = url.searchParams.get('end_date') || '';
  const offset = (page - 1) * pageSize;

  let where = 'WHERE 1=1';
  const params = [];

  if (fileType) { where += ' AND file_type = ?'; params.push(fileType); }
  if (chatId) { where += ' AND chat_id = ?'; params.push(chatId); }
  if (userId) { where += ' AND user_id = ?'; params.push(parseInt(userId)); }
  if (keyword) {
    where += ' AND (file_name LIKE ? OR caption LIKE ? OR chat_title LIKE ? OR username LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (startDate) { where += ' AND created_at >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND created_at <= ?'; params.push(endDate + ' 23:59:59'); }

  try {
    const countResult = await env.D1_DB.prepare(`SELECT COUNT(*) as total FROM files ${where}`).bind(...params).first();
    const total = countResult?.total || 0;

    const dataResult = await env.D1_DB.prepare(
      `SELECT * FROM files ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    ).bind(...params, pageSize, offset).all();

    return jsonResponse({
      ok: true,
      data: {
        total,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(total / pageSize),
        items: dataResult.results || [],
      }
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// 查询单个文件
export async function handleGetFile(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const fileUrl = url.searchParams.get('url');

  try {
    let file;
    if (id) {
      file = await env.D1_DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
    } else if (fileUrl) {
      file = await env.D1_DB.prepare('SELECT * FROM files WHERE r2_url = ?').bind(fileUrl).first();
    }
    return jsonResponse({ ok: true, data: file || null });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// 统计信息
export async function handleStats(request, env) {
  try {
    const total = await env.D1_DB.prepare('SELECT COUNT(*) as count FROM files').first();
    const byType = await env.D1_DB.prepare('SELECT file_type, COUNT(*) as count FROM files GROUP BY file_type').all();
    const byChat = await env.D1_DB.prepare('SELECT chat_title, chat_id, COUNT(*) as count FROM files GROUP BY chat_title ORDER BY count DESC LIMIT 20').all();
    const totalSize = await env.D1_DB.prepare('SELECT SUM(file_size) as total_size FROM files').first();
    const today = await env.D1_DB.prepare("SELECT COUNT(*) as count FROM files WHERE created_at >= date('now')").first();
    const thisMonth = await env.D1_DB.prepare("SELECT COUNT(*) as count FROM files WHERE created_at >= date('now', 'start of month')").first();

    return jsonResponse({
      ok: true,
      data: {
        total_files: total?.count || 0,
        total_size: totalSize?.total_size || 0,
        total_size_formatted: formatFileSize(totalSize?.total_size || 0),
        today_uploads: today?.count || 0,
        month_uploads: thisMonth?.count || 0,
        by_type: byType.results || [],
        by_chat: byChat.results || [],
      }
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// 按群组查询
export async function handleByChat(request, env) {
  const url = new URL(request.url);
  const chatId = url.searchParams.get('chat_id');
  const chatTitle = url.searchParams.get('chat_title');
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = Math.min(parseInt(url.searchParams.get('page_size') || '20'), 100);
  const offset = (page - 1) * pageSize;

  let where = 'WHERE 1=1';
  const params = [];
  if (chatId) { where += ' AND chat_id = ?'; params.push(chatId); }
  if (chatTitle) { where += ' AND chat_title LIKE ?'; params.push(`%${chatTitle}%`); }

  try {
    const total = await env.D1_DB.prepare(`SELECT COUNT(*) as total FROM files ${where}`).bind(...params).first();
    const data = await env.D1_DB.prepare(`SELECT * FROM files ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...params, pageSize, offset).all();

    return jsonResponse({
      ok: true,
      data: { total: total?.total || 0, page, page_size: pageSize, items: data.results || [] }
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// 按用户查询
export async function handleByUser(request, env) {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  const username = url.searchParams.get('username');
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = Math.min(parseInt(url.searchParams.get('page_size') || '20'), 100);
  const offset = (page - 1) * pageSize;

  let where = 'WHERE 1=1';
  const params = [];
  if (userId) { where += ' AND user_id = ?'; params.push(parseInt(userId)); }
  if (username) { where += ' AND username LIKE ?'; params.push(`%${username}%`); }

  try {
    const total = await env.D1_DB.prepare(`SELECT COUNT(*) as total FROM files ${where}`).bind(...params).first();
    const data = await env.D1_DB.prepare(`SELECT * FROM files ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...params, pageSize, offset).all();

    return jsonResponse({
      ok: true,
      data: { total: total?.total || 0, page, page_size: pageSize, items: data.results || [] }
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// 按日期查询
export async function handleByDate(request, env) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = Math.min(parseInt(url.searchParams.get('page_size') || '20'), 100);
  const offset = (page - 1) * pageSize;

  if (!date) return jsonResponse({ ok: false, error: '请提供 date 参数' });

  try {
    const total = await env.D1_DB.prepare("SELECT COUNT(*) as total FROM files WHERE created_at LIKE ?").bind(`${date}%`).first();
    const data = await env.D1_DB.prepare("SELECT * FROM files WHERE created_at LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?").bind(`${date}%`, pageSize, offset).all();

    return jsonResponse({
      ok: true,
      data: { total: total?.total || 0, date, page, page_size: pageSize, items: data.results || [] }
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// 搜索文件
export async function handleSearch(request, env) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = Math.min(parseInt(url.searchParams.get('page_size') || '20'), 100);
  const offset = (page - 1) * pageSize;

  if (!q) return jsonResponse({ ok: false, error: '请提供搜索关键词 q' });

  const like = `%${q}%`;
  try {
    const total = await env.D1_DB.prepare(
      'SELECT COUNT(*) as total FROM files WHERE file_name LIKE ? OR caption LIKE ? OR chat_title LIKE ? OR username LIKE ? OR full_name LIKE ?'
    ).bind(like, like, like, like, like).first();

    const data = await env.D1_DB.prepare(
      'SELECT * FROM files WHERE file_name LIKE ? OR caption LIKE ? OR chat_title LIKE ? OR username LIKE ? OR full_name LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?'
    ).bind(like, like, like, like, like, pageSize, offset).all();

    return jsonResponse({
      ok: true,
      data: { total: total?.total || 0, keyword: q, page, page_size: pageSize, items: data.results || [] }
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// 获取最新文件
export async function handleLatest(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 50);
  const fileType = url.searchParams.get('type') || '';

  let where = fileType ? 'WHERE file_type = ?' : '';
  const params = fileType ? [limit] : [];

  try {
    const data = await env.D1_DB.prepare(
      `SELECT * FROM files ${where} ORDER BY id DESC LIMIT ?`
    ).bind(...params).all();

    return jsonResponse({ ok: true, data: data.results || [] });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// 文件流
export async function handleStream(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const fileUrl = url.searchParams.get('url');

  try {
    let storageKey;
    if (id) {
      const file = await env.D1_DB.prepare('SELECT storage_key FROM files WHERE id = ?').bind(id).first();
      storageKey = file?.storage_key;
    } else if (fileUrl) {
      const file = await env.D1_DB.prepare('SELECT storage_key FROM files WHERE r2_url = ?').bind(fileUrl).first();
      storageKey = file?.storage_key;
    }

    if (!storageKey) return jsonResponse({ ok: false, error: '文件不存在' }, 404);

    const object = await env.R2_BUCKET.get(storageKey);
    if (!object) return jsonResponse({ ok: false, error: '文件未找到' }, 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=31536000');
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(object.body, { headers });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}
