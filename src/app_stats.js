// App 安装统计：安装上报 / 心跳 / 管理后台查询 / 更新源查询
// 注意：D1 绑定名是 D1_DB（wrangler.toml 里 [[d1_databases]] binding = "D1_DB"），
// 不要写成 env.DB —— 那会导致 prepare 未定义而 500。
import { json } from "./util.js";

function dbOf(env) {
  return env.D1_DB;
}

// 上报/心跳统一 UPSERT：user_uploads 之类的 device_id 无唯一约束，先查后写。
async function upsertInstall(env, data) {
  const db = dbOf(env);
  const {
    device_id, app_version, build_number, platform,
    model, os_version, screen_width, screen_height
  } = data;
  const now = new Date().toISOString();
  const existing = await db.prepare('SELECT id FROM app_installs WHERE device_id = ?1').bind(device_id).first();
  if (existing && existing.id) {
    // 心跳/覆盖安装：保留首次 installed_at，刷新版本与设备信息，心跳计数 +1
    await db.prepare(
      `UPDATE app_installs SET
         app_version=?2, build_number=?3, platform=?4,
         model=?5, os_version=?6, screen_width=?7, screen_height=?8,
         last_heartbeat_at=?9, heartbeat_count=heartbeat_count+1, is_active=1
       WHERE id=?1`
    ).bind(
      existing.id, app_version || '', build_number || 0, platform || 'android',
      model || '', os_version || '', screen_width || 0, screen_height || 0, now
    ).run();
    return { created: false };
  }
  await db.prepare(
    `INSERT INTO app_installs
       (device_id, app_version, build_number, platform, model, os_version,
        screen_width, screen_height, installed_at, last_heartbeat_at, heartbeat_count, is_active)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 1, 1)`
  ).bind(
    device_id, app_version || '', build_number || 0, platform || 'android',
    model || '', os_version || '', screen_width || 0, screen_height || 0, now
  ).run();
  return { created: true };
}

// ─── 安装上报 ───────────────────────────────────────────
export async function handleAppInstall(request, env) {
  try {
    const body = await request.json();
    const { device_id } = body;
    if (!device_id) return json({ ok: false, error: 'device_id required' }, 400);
    await upsertInstall(env, body);
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
    const { device_id } = body;
    if (!device_id) return json({ ok: false, error: 'device_id required' }, 400);
    await upsertInstall(env, body);
    return json({ ok: true });
  } catch (e) {
    console.error('app heartbeat error:', e.message);
    return json({ ok: false, error: e.message }, 500);
  }
}

// ─── 管理后台：概览统计 ─────────────────────────────────
export async function handleAppStats(env) {
  try {
    const db = dbOf(env);
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
    const db = dbOf(env);
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

// ─── 应用更新源（Worker 侧读取 R2 公开静态托管清单） ──
// GitHub 仓库是私有的，App/Worker 匿名访问 api.github.com 都会 404，不能作为更新源。
// 改为：CI 构建成功后把 APK 与 apk/latest.json 上传到 R2 公开桶（R2_PUBLIC_URL 指向的
// 静态站点），App 通过同源 Worker /api/app/update 读取清单拿版本号与 APK 直链。
// latest.json 结构：{ "version": "0.1.0+54", "body": "...", "published_at": "..." }，
// download_url 固定拼 R2_PUBLIC_URL/apk/picwall-latest.apk（文件名稳定、免编码问题）。
export async function handleAppUpdate(env) {
  try {
    if (!env.R2_BUCKET) return json({ ok: false, error: 'r2 not configured' }, 500);
    const obj = await env.R2_BUCKET.get('apk/latest.json');
    if (!obj) return json({ ok: false, error: 'update manifest not found' }, 404);
    const meta = await obj.json().catch(() => null);
    const version = String((meta && meta.version) || '').trim().replace(/^[vV]/, '');
    if (!version) return json({ ok: false, error: 'bad manifest' }, 502);

    const publicBase = (env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
    const downloadUrl = publicBase ? publicBase + '/apk/picwall-latest.apk' : '';

    return json({
      ok: true,
      version: version,
      tag: 'v' + version,
      download_url: downloadUrl,
      body: String((meta && meta.body) || '').slice(0, 2000),
      published_at: String((meta && meta.published_at) || '')
    });
  } catch (e) {
    console.error('app update error:', e.message);
    return json({ ok: false, error: e.message }, 500);
  }
}
