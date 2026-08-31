// 通用工具函数（纯函数，无依赖）
export function json(d, s) { return new Response(JSON.stringify(d), { status: s || 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-API-Key' } }); }
export function cors(d, s) { return new Response(d ? JSON.stringify(d) : null, { status: s || 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-API-Key' } }); }
export function fmtSize(b) { if (!b) return '0 B'; const k = 1024, s = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.floor(Math.log(b) / Math.log(k)); return (b / Math.pow(k, i)).toFixed(1) + ' ' + s[i]; }
export function genHash() { const c = 'abcdef0123456789'; const b = new Uint8Array(16); crypto.getRandomValues(b); let r = ''; for (let i = 0; i < b.length; i++) r += c[b[i] & 15]; return r; }

// 日志工具：支持日志级别控制
// 级别: 0=error, 1=warn, 2=info, 3=debug
// 生产环境默认只输出 error 和 warn
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let _currentLogLevel = LOG_LEVELS.info;

export function setLogLevel(level) {
  if (typeof level === 'number' && level >= 0 && level <= 3) {
    _currentLogLevel = level;
  } else if (typeof level === 'string' && LOG_LEVELS[level] !== undefined) {
    _currentLogLevel = LOG_LEVELS[level];
  }
}

export function getLogLevel() {
  return _currentLogLevel;
}

function _log(level, ...args) {
  if (LOG_LEVELS[level] <= _currentLogLevel) {
    const prefix = `[${level.toUpperCase()}]`;
    if (level === 'error') {
      console.error(prefix, ...args);
    } else if (level === 'warn') {
      console.warn(prefix, ...args);
    } else {
      console.log(prefix, ...args);
    }
  }
}

export const log = {
  error: (...args) => _log('error', ...args),
  warn: (...args) => _log('warn', ...args),
  info: (...args) => _log('info', ...args),
  debug: (...args) => _log('debug', ...args),
};

// 简易内存缓存：用于缓存频繁查询的 API 响应
// 注意：仅在单个 Worker Isolate 内有效，跨 Isolate 无效
const _cache = new Map();

/**
 * 获取缓存值，若未命中或过期则返回 null
 * @param {string} key - 缓存键
 * @returns {*} 缓存的值，未命中时返回 null
 */
export function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * 设置缓存值
 * @param {string} key - 缓存键
 * @param {*} value - 缓存的值
 * @param {number} ttlMs - 过期时间（毫秒）
 */
export function cacheSet(key, value, ttlMs) {
  _cache.set(key, {
    value,
    expireAt: Date.now() + ttlMs,
  });
  // 防止内存泄漏：限制缓存条目数量
  if (_cache.size > 1000) {
    const firstKey = _cache.keys().next().value;
    _cache.delete(firstKey);
  }
}

/**
 * 删除指定前缀的所有缓存
 * @param {string} prefix - 前缀
 */
export function cacheDeletePrefix(prefix) {
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) _cache.delete(key);
  }
}

/**
 * 包装异步函数，自动缓存结果
 * @param {string} prefix - 缓存键前缀
 * @param {number} ttlMs - 过期时间（毫秒）
 * @param {Function} fn - 异步函数
 * @returns {Function} 带缓存的函数
 */
export function withCache(prefix, ttlMs, fn) {
  return async (...args) => {
    const key = `${prefix}:${JSON.stringify(args)}`;
    const cached = cacheGet(key);
    if (cached !== null) return cached;
    const result = await fn(...args);
    cacheSet(key, result, ttlMs);
    return result;
  };
}

// 缓存失效工具：文件操作后清除相关缓存
export function invalidateStatsCache() {
  cacheDeletePrefix('stats:');
}

export function invalidateFilesCache() {
  cacheDeletePrefix('files:');
}
