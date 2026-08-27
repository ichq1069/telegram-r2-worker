// 公开 API 限流（按 api_key + 分钟窗口计数，超限拒绝）
export async function applyRateLimit(env, key) {
  try {
    const s = await env.D1_DB.prepare("SELECT value FROM settings WHERE key = 'api_rate_limit'").first();
    let cfg = { enabled: false, limit_per_min: 60 };
    if (s && s.value) { try { cfg = Object.assign(cfg, JSON.parse(s.value)); } catch (e) {} }
    if (!cfg.enabled || !cfg.limit_per_min) return false;
    const win = String(Math.floor(Date.now() / 60000));
    await env.D1_DB.prepare("INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET count=count+1").bind(key, win).run();
    const r = await env.D1_DB.prepare("SELECT count FROM rate_limits WHERE key=? AND window=?").bind(key, win).first();
    return !!(r && r.count > cfg.limit_per_min);
  } catch (e) { console.error('applyRateLimit:', e.message); return false; }
}
