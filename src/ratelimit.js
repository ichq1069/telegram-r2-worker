// 公开 API 限流（按 api_key + 分钟窗口计数，超限拒绝）
// 限流配置缓存到 isolate 级（30s 内不重复查 settings，减少每次请求一次 D1 往返）
let _cfgCache = null;
let _cfgCacheAt = 0;
async function getRateCfg(env) {
  const now = Date.now();
  if (_cfgCache && now - _cfgCacheAt < 30000) return _cfgCache;
  let cfg = { enabled: false, limit_per_min: 60 };
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'api_rate_limit'").first();
    if (s && s.value) { try { cfg = Object.assign(cfg, JSON.parse(s.value)); } catch (e) {} }
  } catch (e) { console.error('getRateCfg:', e.message); }
  _cfgCache = cfg; _cfgCacheAt = now;
  return cfg;
}
export async function applyRateLimit(env, key) {
  try {
    const cfg = await getRateCfg(env);
    if (!cfg.enabled || !cfg.limit_per_min) return false;
    const win = String(Math.floor(Date.now() / 60000));
    await env.D1_DB.prepare("INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET count=count+1").bind(key, win).run();
    const r = await env.D1_DB.prepare("SELECT count FROM rate_limits WHERE key=? AND window=?").bind(key, win).first();
    return !!(r && r.count > cfg.limit_per_min);
  } catch (e) { console.error('applyRateLimit:', e.message); return false; }
}
