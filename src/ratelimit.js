// API 限流（支持按 api_key、IP 或管理员角色限制）
// 限流配置缓存到 isolate 级（30s 内不重复查 settings，减少每次请求一次 D1 往返）
import { log } from "./util.js";

let _cfgCache = null;
let _cfgCacheAt = 0;
async function getRateCfg(env) {
  const now = Date.now();
  if (_cfgCache && now - _cfgCacheAt < 30000) return _cfgCache;
  let cfg = { 
    enabled: false, 
    limit_per_min: 60,
    // 公开 API 限流（无需认证的端点）
    public_enabled: false,
    public_limit_per_min: 30,
    // IP 限流（防止恶意请求）
    ip_enabled: false,
    ip_limit_per_min: 100,
    // 管理员限流（保护管理接口）
    admin_enabled: true,
    admin_limit_per_min: 200,
    // 用户门户限流（保护用户接口）
    user_enabled: true,
    user_limit_per_min: 120
  };
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'api_rate_limit'").first();
    if (s && s.value) { try { cfg = Object.assign(cfg, JSON.parse(s.value)); } catch (e) {} }
  } catch (e) { log.error('getRateCfg:', e.message); }
  _cfgCache = cfg; _cfgCacheAt = now;
  return cfg;
}

// 获取客户端真实 IP（优先使用 CF-Connecting-IP 头）
function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') || 
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 
         'unknown';
}

// 通用限流函数（内部实现）
async function _applyLimit(env, key, limit) {
  try {
    const win = String(Math.floor(Date.now() / 60000));
    await env.D1_DB.prepare("INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET count=count+1").bind(key, win).run();
    const r = await env.D1_DB.prepare("SELECT count FROM rate_limits WHERE key=? AND window=?").bind(key, win).first();
    return !!(r && r.count > limit);
  } catch (e) { log.error('_applyLimit:', e.message); return false; }
}

// 按 API Key 限流（已认证用户）
export async function applyRateLimit(env, key) {
  try {
    const cfg = await getRateCfg(env);
    if (!cfg.enabled || !cfg.limit_per_min) return false;
    return await _applyLimit(env, key, cfg.limit_per_min);
  } catch (e) { log.error('applyRateLimit:', e.message); return false; }
}

// 按 IP 限流（公开 API）
export async function applyIPRateLimit(env, request) {
  try {
    const cfg = await getRateCfg(env);
    if (!cfg.ip_enabled || !cfg.ip_limit_per_min) return false;
    const ip = getClientIP(request);
    const key = 'ip:' + ip;
    return await _applyLimit(env, key, cfg.ip_limit_per_min);
  } catch (e) { log.error('applyIPRateLimit:', e.message); return false; }
}

// 管理员限流（保护管理接口，基于 IP）
export async function applyAdminRateLimit(env, request) {
  try {
    const cfg = await getRateCfg(env);
    if (!cfg.admin_enabled || !cfg.admin_limit_per_min) return false;
    const ip = getClientIP(request);
    const key = 'admin:' + ip;
    return await _applyLimit(env, key, cfg.admin_limit_per_min);
  } catch (e) { log.error('applyAdminRateLimit:', e.message); return false; }
}

// 用户门户限流（保护用户接口，基于 key）
export async function applyUserRateLimit(env, key) {
  try {
    const cfg = await getRateCfg(env);
    if (!cfg.user_enabled || !cfg.user_limit_per_min) return false;
    const userKey = 'user:' + key;
    return await _applyLimit(env, userKey, cfg.user_limit_per_min);
  } catch (e) { log.error('applyUserRateLimit:', e.message); return false; }
}

// 检查是否被限流（不增加计数，用于预检查）
export async function isRateLimited(env, key) {
  try {
    const cfg = await getRateCfg(env);
    if (!cfg.enabled || !cfg.limit_per_min) return false;
    const win = String(Math.floor(Date.now() / 60000));
    const r = await env.D1_DB.prepare("SELECT count FROM rate_limits WHERE key=? AND window=?").bind(key, win).first();
    return !!(r && r.count >= cfg.limit_per_min);
  } catch (e) { log.error('isRateLimited:', e.message); return false; }
}

// 权限检查：验证 API Key 是否具有指定 scope
export function hasScope(rec, requiredScope) {
  if (!rec || !rec.scopes) return false;
  const scopes = rec.scopes.split(',').map(s => s.trim());
  return scopes.includes(requiredScope) || scopes.includes('*');
}

// 权限检查：验证 API Key 级别是否满足要求
export function hasLevel(rec, requiredLevel) {
  if (!rec || !rec.level) return false;
  const LEVEL_RANK = { 'pt': 0, 'vip': 1, 'svip': 2, 'vvip': 3 };
  const userRank = LEVEL_RANK[rec.level] || 0;
  const requiredRank = LEVEL_RANK[requiredLevel] || 0;
  return userRank >= requiredRank;
}
