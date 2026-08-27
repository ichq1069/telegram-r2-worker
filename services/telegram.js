/**
 * Telegram API 服务
 */

// 提取文件信息
export function extractFileInfo(message) {
  if (message.photo) {
    const largest = message.photo[message.photo.length - 1];
    return {
      type: 'photo',
      fileId: largest.file_id,
      fileName: `photo_${generateHash()}.jpg`,
      fileSize: largest.file_size,
      width: largest.width,
      height: largest.height,
    };
  }
  if (message.document) {
    return {
      type: 'document',
      fileId: message.document.file_id,
      fileName: message.document.file_name || `doc_${generateHash()}`,
      fileSize: message.document.file_size,
      width: 0,
      height: 0,
    };
  }
  if (message.video) {
    return {
      type: 'video',
      fileId: message.video.file_id,
      fileName: message.video.file_name || `video_${generateHash()}.mp4`,
      fileSize: message.video.file_size,
      width: message.video.width,
      height: message.video.height,
    };
  }
  if (message.audio) {
    return {
      type: 'audio',
      fileId: message.audio.file_id,
      fileName: message.audio.file_name || `audio_${generateHash()}.mp3`,
      fileSize: message.audio.file_size,
      width: 0,
      height: 0,
    };
  }
  if (message.voice) {
    return {
      type: 'voice',
      fileId: message.voice.file_id,
      fileName: `voice_${generateHash()}.ogg`,
      fileSize: message.voice.file_size,
      width: 0,
      height: 0,
    };
  }
  return null;
}

// 下载文件
export async function downloadFile(fileId, botToken) {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const json = await resp.json();
    if (!json.ok || !json.result?.file_path) return null;

    const fileResp = await fetch(`https://api.telegram.org/file/bot${botToken}/${json.result.file_path}`);
    if (!fileResp.ok) return null;

    return {
      buffer: await fileResp.arrayBuffer(),
      contentType: fileResp.headers.get('content-type') || 'application/octet-stream',
    };
  } catch (e) {
    console.error('下载失败:', e);
    return null;
  }
}

// 回复消息
export async function replyToChat(chatId, replyToMessageId, fileType, fileName, url, fileSize, env) {
  const sizeStr = formatFileSize(fileSize);
  const labels = { photo: '图片', document: '文件', video: '视频', audio: '音频', voice: '语音' };
  const icons = { photo: '🖼️', document: '📄', video: '🎬', audio: '🎵', voice: '🎤' };

  let text = fileType === 'photo'
    ? `${icons.photo} 图片已保存\n📎 ${url}`
    : `${icons[fileType] || '📎'} ${labels[fileType] || '文件'}已保存\n📁 ${fileName} (${sizeStr})\n📎 ${url}`;

  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, reply_to_message_id: replyToMessageId, text }),
    });
  } catch (e) {
    console.error('回复失败:', e);
  }
}

// 生成哈希
function generateHash() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let hash = '';
  for (let i = 0; i < 16; i++) hash += chars[Math.floor(Math.random() * chars.length)];
  return hash;
}

// 格式化文件大小
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
