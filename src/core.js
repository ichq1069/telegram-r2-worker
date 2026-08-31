// ==================== CORE ====================
// 纯工具函数与常量：无业务依赖，被所有模块共享

export const CN_OFFSET_MS = 8 * 3600 * 1000;
export function cnShift(d) { return new Date(d.getTime() + CN_OFFSET_MS); }
export function cnTodayStr() { return cnShift(new Date()).toISOString().slice(0, 10); }
export function cnDayIso(dayStr) { return new Date(dayStr + 'T00:00:00+08:00').toISOString(); }

// 内容分级：pt < vip < svip < vvip。密钥级别决定可访问内容级别（级别对等）
export const LEVEL_RANK = { pt: 0, vip: 1, svip: 2, vvip: 3 };
export const LEVEL_ORDER = ['pt', 'vip', 'svip', 'vvip'];
export function sanitizeLevel(lv) { return LEVEL_RANK[lv] === undefined ? 'pt' : lv; }
// 根据访问方级别生成 SQL 过滤子句与参数（低级别密钥不得获取高级别内容）
export function levelFilter(keyLevel) {
  const rank = LEVEL_RANK[keyLevel] === undefined ? 0 : LEVEL_RANK[keyLevel];
  const allowed = LEVEL_ORDER.filter(function(l) { return LEVEL_RANK[l] <= rank; });
  return { sql: ' AND level IN (' + allowed.map(function() { return '?'; }).join(',') + ')', params: allowed };
}

export function clampInt(v, def, min, max) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = def;
  if (min !== undefined && n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return n;
}

export function guessExt(ct, fn) { const e = fn.split('.').pop().toLowerCase(); if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mp3', 'ogg', 'pdf', 'zip', 'txt'].includes(e)) return e; if (ct?.includes('jpeg')) return 'jpg'; if (ct?.includes('png')) return 'png'; if (ct?.includes('gif')) return 'gif'; if (ct?.includes('webp')) return 'webp'; if (ct?.includes('video')) return 'mp4'; if (ct?.includes('audio')) return 'mp3'; if (ct?.includes('pdf')) return 'pdf'; return 'bin'; }

// 宽松扩展名推断（任意扩展名都保留，用于代理 URL 带后缀，如 /file/tg/123.jpg）
export function fileExtOf(fileName, type) {
  const m = /\.([a-zA-Z0-9]{1,10})$/.exec(String(fileName || ''));
  if (m) return m[1].toLowerCase();
  const map = { photo: 'jpg', video: 'mp4', audio: 'mp3', voice: 'ogg', document: 'bin' };
  return map[type] || 'bin';
}

export function randHex(len) {
  var s = '', chars = 'abcdef0123456789';
  for (var i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * 16));
  return s;
}

// key-pass 登录密码哈希：sha256(pass + ':' + key)，加盐防彩虹表，不可逆
export async function hashKeyPass(pass, key) {
  const data = new TextEncoder().encode(String(pass) + ':' + String(key));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

export function genApiKey() {
  const arr = new Uint8Array(18);
  crypto.getRandomValues(arr);
  return 'vk_' + Array.from(arr).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

// 生成短链接别名 key（8 位 base62 随机，约 2.2e14 组合，用于 ?sk= 短链接鉴权，避免使用易猜的用户名）
export function genShortKey() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += chars[arr[i] % 62];
  return 'sk_' + s;
}

// 生成兑换码（后台管理用），格式 RZ + 8 位随机大写
export function genRedeemCode() {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return 'RZ-' + Array.from(arr).map(function(b) { return '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 32]; }).join('');
}

// 从 caption 中提取 #标签（<=4 字符的才算标签，如 #风景#美女）
export function extractTags(caption) {
  if (!caption) return [];
  const tags = [];
  const regex = /#([^\s#]{1,4})/g;
  let match;
  while ((match = regex.exec(caption)) !== null) {
    const tag = match[1].trim();
    if (tag && tag.length <= 4 && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return tags;
}
