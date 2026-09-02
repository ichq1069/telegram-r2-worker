// D1 降级访问层（D1 为主，故障/限额自动或手动切换 MySQL）
// 职责：
//   1. 维护降级状态：isolate 内缓存 + MySQL settings 持久（跨 isolate 一致）
//   2. auto 模式：检测 D1 错误特征，命中即切换降级窗口
//   3. 手动开关：admin 可强制 mysql / 恢复 d1
// 业务代码不直接 import 本层做判断，由各 handler 在入口处调用 ensureMode(env)，
// 或读取当前开关决定本次请求的读写后端。
import { log } from './util.js';
import { mysqlFailoverGet, mysqlFailoverSet } from './mysql.js';

// isolate 级缓存：D1 是否处于降级窗口（最近 N 秒内出现过 D1 限额/故障错误）
let _degradedAt = 0;
// 最近一次 auto 降级窗口结束时间
let _autoWindowUntil = 0;
// 手动模式缓存
let _manualMode = null;
let _manualCheckedAt = 0;

const DEGRADE_WINDOW_MS = 30 * 1000; // auto 触发后降级窗口 30s，避免每请求都打到坏 D1
const MODE_REFRESH_MS = 15 * 1000;   // 手动模式缓存刷新间隔

// D1 错误特征：限额耗尽 / 服务不可用。命中说明 D1 处于不可用或超限状态。
const D1_ERROR_HINTS = [
  'limit exceeded',
  'daily limit',
  'rows written',
  'rows read',
  'sqlite',
  'd1_error',
  'service unavailable',
  'internal error',
  'database connection',
  'timeout',
  'too many requests',
  '502',
  '503',
  '5400', // D1 query error
  '5001',
  'unexpected failure',
  'api error',
  'fetch failed',
  'hyperdrive',
  'connection',
];

export function isD1FaultError(e) {
  const msg = String((e && e.message) || e || '').toLowerCase();
  if (!msg) return false;
  return D1_ERROR_HINTS.some(function(h) { return msg.indexOf(h) !== -1; });
}

// 记录一次 D1 故障：进入降级窗口
export function noteD1Fault() {
  _degradedAt = Date.now();
  _autoWindowUntil = Date.now() + DEGRADE_WINDOW_MS;
  log.warn('dbaccess: D1 fault noted, degraded window ' + DEGRADE_WINDOW_MS + 'ms');
}

// 读取当前生效模式：手动(mysql/d1) > auto 降级窗口
export async function currentMode(env) {
  // 手动模式缓存（15s 刷新）
  const now = Date.now();
  if (_manualMode && now - _manualCheckedAt < MODE_REFRESH_MS) {
    return { mode: _manualMode.mode, source: 'manual-cache', manual: _manualMode };
  }
  try {
    const m = await mysqlFailoverGet(env);
    _manualMode = m;
    _manualCheckedAt = now;
    if (m.mode === 'mysql' || m.mode === 'd1') {
      return { mode: m.mode, source: 'manual', manual: m };
    }
  } catch (e) { log.error('dbaccess.currentMode mysql check:', e.message); }

  // auto：命中降级窗口则走 mysql
  if (Date.now() < _autoWindowUntil) {
    return { mode: 'mysql', source: 'auto-window' };
  }
  return { mode: 'd1', source: 'auto' };
}

// 请求级入口：返回本次请求应使用的读写后端
// 返回 'd1' 或 'mysql'
export async function decideBackend(env) {
  const m = await currentMode(env);
  return m.mode;
}

// 手动设置模式（admin 调用）
export async function setMode(env, mode, reason) {
  if (mode !== 'mysql' && mode !== 'd1' && mode !== 'auto') {
    return { ok: false, error: 'mode must be d1|mysql|auto' };
  }
  const ok = await mysqlFailoverSet(env, mode, reason || '');
  if (ok) {
    _manualMode = { mode: mode, updated_at: Date.now(), reason: reason || '' };
    _manualCheckedAt = Date.now();
    if (mode === 'd1' || mode === 'auto') { _autoWindowUntil = 0; _degradedAt = 0; }
  }
  return { ok: ok, mode: mode };
}

export function resetIsolateState() {
  _degradedAt = 0; _autoWindowUntil = 0; _manualMode = null; _manualCheckedAt = 0;
}

// ==================== 通用降级读取辅助 ====================
// D1 优先读；D1 故障（限额/服务错误）自动降级到 MySQL 等价查询。
// 返回 { rows, source } 或 { row, source }（视 withFirst 而定）。两库都失败返回空。
// 手动模式为 mysql 时直接走 MySQL，不打扰 D1。

// opts:
//   table   — 镜像表名（读 MySQL settings 手动开关需要）
//   run     — async () => D1 的 .all()/.first() 结果（.all() 返回 {results}；.first() 返回行对象）
//   mysqlFn — async () => 返回 MySQL rows 数组或单行（由 runFirst 决定形态）
//   runFirst— true 则 D1 用 first()（返回单行）；false 用 all()
export async function d1Read(env, opts) {
  const m = await currentMode(env);
  if (m.mode === 'mysql') {
    try {
      const rows = await opts.mysqlFn();
      if (opts.runFirst) return { row: rows || null, source: 'mysql' };
      return { rows: rows || [], source: 'mysql' };
    } catch (e) { log.error('d1Read(mysql):', e.message); return { rows: [], row: null, source: 'none' }; }
  }
  // D1 优先
  try {
    const d = await opts.run();
    if (opts.runFirst) return { row: d || null, source: 'd1' };
    return { rows: (d.results || []), source: 'd1' };
  } catch (e) {
    if (isD1FaultError(e)) {
      noteD1Fault();
      try {
        const rows = await opts.mysqlFn();
        if (opts.runFirst) return { row: rows || null, source: 'mysql' };
        return { rows: rows || [], source: 'mysql' };
      } catch (e2) { log.error('d1Read mysql fallback:', e2.message); return { rows: [], row: null, source: 'none' }; }
    }
    throw e; // 非 D1 故障错误（SQL 语法等）继续抛，交由上层处理
  }
}
