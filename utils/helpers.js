/**
 * 通用工具函数
 */

// 根据 MIME 类型和文件名猜测扩展名
export function guessExt(contentType, fileName) {
  if (fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (ext && ext.length <= 5) return ext;
  }
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi',
    'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
    'application/pdf': 'pdf', 'application/zip': 'zip',
    'application/x-rar': 'rar', 'application/x-7z-compressed': '7z',
    'text/plain': 'txt', 'text/html': 'html', 'text/css': 'css',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  };
  return map[contentType] || 'bin';
}

// 格式化文件大小
export function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 生成随机哈希
export function generateHash() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let hash = '';
  for (let i = 0; i < 16; i++) {
    hash += chars[Math.floor(Math.random() * chars.length)];
  }
  return hash;
}
