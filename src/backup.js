// D1 数据备份（导出全部表为 JSON 存到 R2 backups/）
import { json } from './util.js';
import { cnNowISO } from './core.js';

export async function dumpAllTables(env) {
  const tables = await env.D1_DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all();
  const dump = { exported_at: cnNowISO(), version: 'v6', tables: {} };
  for (const t of tables.results || []) {
    try {
      const rows = await env.D1_DB.prepare('SELECT * FROM "' + t.name + '"').all();
      dump.tables[t.name] = rows.results || [];
    } catch (e) {
      // D1 内部表（如 _cf_KV）禁止读取，跳过该表
      console.log('dump skip ' + t.name + ':', e.message);
      dump.tables[t.name] = { _error: e.message };
    }
  }
  return dump;
}

export async function handleAdminBackup(env) {
  try {
    const dump = await dumpAllTables(env);
    return json({ ok: true, data: dump });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminBackupSave(env) {
  try {
    const dump = await dumpAllTables(env);
    const name = 'backups/db-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_') + '.json';
    await env.R2_BUCKET.put(name, JSON.stringify(dump), { httpMetadata: { contentType: 'application/json' } });
    // 保留最近 20 份，删除更旧的
    try {
      const listed = await env.R2_BUCKET.list({ prefix: 'backups/db-' });
      const keys = (listed.objects || []).map(function(o){ return o.key; }).sort();
      while (keys.length > 20) {
        await env.R2_BUCKET.delete(keys.shift());
      }
    } catch (e) {}
    return json({ ok: true, data: { name: name, tables: Object.keys(dump.tables).length } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminBackupList(env) {
  try {
    const listed = await env.R2_BUCKET.list({ prefix: 'backups/db-' });
    const items = (listed.objects || []).map(function(o) {
      return { key: o.key, size: o.size, uploaded: o.uploaded };
    }).sort(function(a, b){ return a.uploaded < b.uploaded ? 1 : -1; });
    return json({ ok: true, data: { backups: items } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminBackupDelete(request, env) {
  try {
    const u = new URL(request.url);
    const name = u.searchParams.get('name') || '';
    if (!name || name.indexOf('backups/db-') !== 0 || name.indexOf('..') !== -1) return json({ ok: false, error: 'invalid name' }, 400);
    await env.R2_BUCKET.delete(name);
    return json({ ok: true });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
