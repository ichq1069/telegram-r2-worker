// App 安装统计：安装上报 / 心跳 / 管理后台查询
import { json } from "./core.js";

// ─── 安装上报 ───────────────────────────────────────────
export async function handleAppInstall(request, env) {
  try {
    const body = await request.json();
    const {
      device_id, app_version, build_number, platform,
      model, os_version, screen_width, screen_height
    } = body;
    if (!device_id) return json({ ok: false, error: 'device_id required' }, 400);
    const now = new Date().toISOString();
    // UPSERT：同一 device_id 只保留一条记录，更新版本和设备信息
    await env.DB.prepare(
      `INSERT INTO app_installs (device_id, app_version, build_number, platform, model, os_version, screen_width, screen_height, installed_at, last_heartbeat_at, heartbeat_count, is_active)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 1, 1)
       ON CONFLICT(device_id) DO UPDATE SET
         app_version=excluded.app_version, build_number=excluded.build_number,
         platform=excluded.platform, model=excluded.model, os_version=excluded.os_version,
         screen_width=excluded.screen_width, screen_height=excluded.screen_height,
         last_heartbeat_at=excluded.last_heartbeat_at, is_active=1`
    ).bind(
      device_id, app_version || '', build_number || 0, platform || 'android',
      model || '', os_version || '', screen_width || 0, screen_height || 0, now
    ).run();
    return json({ ok: true });
  } catch (e) {
    console.error('app install error:', e.message);
    return json({ ok: false, error: e.message }, 500);
  }
}

// ─── 心跳上报 ───────────────────────────────────────────
export async function handleAppHeartbeat(request, env) {
  try {
    const body = await request.json();
    const { device_id, app_version, build_number } = body;
    if (!device_id) return json({ ok: false, error: 'device_id required' }, 400);
    const now = new Date().toISOString();
    // UPSERT：心跳时若设备不存在则自动创建
    await env.DB.prepare(
      `INSERT INTO app_installs (device_id, app_version, build_number, platform, installed_at, last_heartbeat_at, heartbeat_count, is_active)
       VALUES (?1, ?2, ?3, 'android', ?4, ?4, 1, 1)
       ON CONFLICT(device_id) DO UPDATE SET
         app_version=excluded.app_version, build_number=excluded.build_number,
         last_heartbeat_at=excluded.last_heartbeat_at,
         heartbeat_count=heartbeat_count+1, is_active=1`
    ).bind(device_id, app_version || '', build_number || 0, now).run();
    return json({ ok: true });
  } catch (e) {
    console.error('app heartbeat error:', e.message);
    return json({ ok: false, error: e.message }, 500);
  }
}

// ─── 管理后台：概览统计 ─────────────────────────────────
export async function handleAppStats(env) {
  try {
    const db = env.DB;
    // 总安装数
    const total = await db.prepare("SELECT COUNT(*) as c FROM app_installs").first();
    // 活跃设备（5 分钟内心跳）
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const active = await db.prepare(
      "SELECT COUNT(*) as c FROM app_installs WHERE last_heartbeat_at >= ?1 AND is_active=1"
    ).bind(fiveMinAgo).first();
    // 24 小时活跃
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const activeDay = await db.prepare(
      "SELECT COUNT(*) as c FROM app_installs WHERE last_heartbeat_at >= ?1 AND is_active=1"
    ).bind(dayAgo).first();
    // 版本分布
    const versions = await db.prepare(
      "SELECT app_version, COUNT(*) as c FROM app_installs GROUP BY app_version ORDER BY c DESC"
    ).all();
    // 设备分布 (Top 10)
    const devices = await db.prepare(
      "SELECT model, COUNT(*) as c FROM app_installs WHERE model != '' GROUP BY model ORDER BY c DESC LIMIT 10"
    ).all();
    // 系统版本分布 (Top 10)
    const osList = await db.prepare(
      "SELECT os_version, COUNT(*) as c FROM app_installs WHERE os_version != '' GROUP BY os_version ORDER BY c DESC LIMIT 10"
    ).all();
    // 今日新安装
    const today = new Date().toISOString().slice(0, 10);
    const todayNew = await db.prepare(
      "SELECT COUNT(*) as c FROM app_installs WHERE installed_at >= ?1"
    ).bind(today + 'T00:00:00.000Z').first();
    // 7 天趋势（按天聚合新安装）
    const weekTrend = await db.prepare(
      "SELECT SUBSTR(installed_at, 1, 10) as day, COUNT(*) as c FROM app_installs WHERE installed_at >= ?1 GROUP BY day ORDER BY day"
    ).bind(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000Z').all();

    return json({
      ok: true,
      total_installs: total?.c || 0,
      active_now: active?.c || 0,
      active_24h: activeDay?.c || 0,
      today_new: todayNew?.c || 0,
      versions: versions?.results || [],
      devices: devices?.results || [],
      os_versions: osList?.results || [],
      week_trend: weekTrend?.results || []
    });
  } catch (e) {
    console.error('app stats error:', e.message);
    return json({ ok: false, error: e.message }, 500);
  }
}

// ─── 管理后台：安装列表（分页） ─────────────────────────
export async function handleAppInstalls(request, env) {
  try {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '50')));
    const offset = (page - 1) * pageSize;
    const db = env.DB;
    const total = await db.prepare("SELECT COUNT(*) as c FROM app_installs").first();
    const rows = await db.prepare(
      "SELECT * FROM app_installs ORDER BY last_heartbeat_at DESC LIMIT ?1 OFFSET ?2"
    ).bind(pageSize, offset).all();
    // 标记超过 5 分钟无心跳的设备为离线
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await db.prepare(
      "UPDATE app_installs SET is_active=0 WHERE last_heartbeat_at < ?1 AND is_active=1"
    ).bind(fiveMinAgo).run();
    return json({
      ok: true,
      total: total?.c || 0,
      page, page_size: pageSize,
      items: rows?.results || []
    });
  } catch (e) {
    console.error('app installs error:', e.message);
    return json({ ok: false, error: e.message }, 500);
  }
}
