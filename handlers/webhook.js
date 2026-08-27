/**
 * Telegram Webhook 处理
 */
import { extractFileInfo, replyToChat } from '../services/telegram.js';
import { downloadFile } from '../services/telegram.js';
import { uploadToR2 } from '../services/r2.js';
import { insertRecord, ensureTable } from '../services/d1.js';
import { notifyBackend } from '../services/backend.js';
import { jsonResponse } from '../utils/response.js';
import { guessExt, generateHash, formatFileSize } from '../utils/helpers.js';

export async function handleWebhook(request, env) {
  try {
    // 确保表存在
    if (env.D1_DB) await ensureTable(env.D1_DB);

    const body = await request.text();
    const update = JSON.parse(body);

    const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (env.TG_SECRET && secretToken !== env.TG_SECRET) {
      return jsonResponse({ error: 'Unauthorized' }, 403);
    }

    const result = await processUpdate(update, env);
    return jsonResponse(result);
  } catch (err) {
    console.error('处理错误:', err);
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

async function processUpdate(update, env) {
  const message = update.message || update.channel_post;
  if (!message) return { ok: true, skipped: true };

  const chatId = String(message.chat.id);
  const messageId = String(message.message_id);
  const caption = message.caption || '';
  const from = message.from || {};
  const chat = message.chat || {};
  const date = message.date ? new Date(message.date * 1000) : new Date();

  const chatTitle = chat.title || chat.username || chatId;
  const chatType = chat.type || 'unknown';
  const userId = from.id || 0;
  const username = from.username || '';
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ') || username || 'Unknown';

  const fileInfo = extractFileInfo(message);
  if (!fileInfo) return { ok: true, skipped: true, reason: 'unsupported_type' };

  // 下载
  const fileData = await downloadFile(fileInfo.fileId, env.TG_BOT_TOKEN);
  if (!fileData) return { ok: false, error: 'download_failed' };

  // 生成路径
  const ext = guessExt(fileData.contentType, fileInfo.fileName);
  const datePath = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
  const storageKey = `${datePath}/${generateHash()}.${ext}`;

  // 上传 R2
  const r2Url = await uploadToR2(storageKey, fileData.buffer, fileData.contentType, env);
  if (!r2Url) return { ok: false, error: 'r2_upload_failed' };

  // 写入 D1
  const recordId = await insertRecord(env.D1_DB, {
    storageKey, r2Url, chatId, chatTitle, chatType,
    chatUsername: chat.username || '',
    userId, username, fullName,
    telegramFileId: fileInfo.fileId,
    fileName: fileInfo.fileName, fileSize: fileInfo.fileSize,
    fileType: fileInfo.type, mimeType: fileData.contentType,
    width: fileInfo.width, height: fileInfo.height,
    caption, messageId, createdAt: date.toISOString(),
  });

  // 回复
  await replyToChat(chatId, messageId, fileInfo.type, fileInfo.fileName, r2Url, fileInfo.fileSize, env);

  // 通知后端
  if (env.BACKEND_API_URL) {
    await notifyBackend({
      chat_id: chatId, message_id: messageId,
      from_user: username || fullName, caption,
      file_url: r2Url, file_name: fileInfo.fileName,
      file_type: fileInfo.type, file_size: fileInfo.fileSize,
      chat_title: chatTitle, created_at: date.toISOString(),
    }, env);
  }

  return { ok: true, url: r2Url, fileId: recordId, fileType: fileInfo.type };
}
