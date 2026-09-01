// 群抓取执行服务器节点管理：后台配置 N 个 VPS/Containers 节点，脚本定时心跳上报在线状态，
// 掉线可实时发现；同时提供 VPS 一键部署脚本（拉取部署，傻瓜式操作）。
// 设计：
//   - ub_servers 表存每个节点（name/token/note/status/last_seen_at/last_ip/last_info/task_ids）
//   - 脚本侧用每台独立的 server_token 做心跳与任务拉取鉴权；抓取配置/回写断点仍用 ub_token
//   - 后台按 last_seen_at 距今 > OFFLINE_AFTER 毫秒判定 offline（不依赖 cron，列表时计算）
import { json } from './util.js';

const OFFLINE_AFTER = 180 * 1000; // 3 分钟无心跳视为掉线

function genServerToken() {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  for (let i = 0; i < b.length; i++) r += c[b[i] % c.length];
  return 'srv_' + r;
}

// ---------------- Admin：服务器节点 CRUD ----------------
export async function handleAdminServers(env) {
  try {
    const d = await env.D1_DB.prepare('SELECT * FROM ub_servers ORDER BY id DESC').all();
    const now = Date.now();
    const list = (d.results || []).map(function(s) {
      const last = s.last_seen_at ? (new Date(s.last_seen_at).getTime() || 0) : 0;
      s.online = last && (now - last) <= OFFLINE_AFTER ? 1 : 0;
      s.status = s.online ? 'online' : 'offline';
      s.seen_ago = last ? Math.round((now - last) / 1000) : null;
      return s;
    });
    return json({ ok: true, data: list, offline_after: OFFLINE_AFTER });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminServerCreate(request, env) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const name = String(b.name || '').trim().slice(0, 100);
    if (!name) return json({ ok: false, error: 'name 必填' }, 400);
    const now = new Date().toISOString();
    const tok = genServerToken();
    const r = await env.D1_DB.prepare('INSERT INTO ub_servers (name, token, note, status, task_ids, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .bind(name, tok, String(b.note || '').slice(0, 500), 'offline', String(b.task_ids || '').slice(0, 500), now, now).run();
    return json({ ok: true, data: { id: r.meta?.last_row_id || 0, token: tok } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminServerUpdate(request, env, id) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const set = [];
    const vals = [];
    const col = function(k, v) { set.push(k + '=?'); vals.push(v); };
    if (b.name !== undefined) col('name', String(b.name).slice(0, 100));
    if (b.note !== undefined) col('note', String(b.note).slice(0, 500));
    if (b.task_ids !== undefined) col('task_ids', String(b.task_ids).slice(0, 500));
    if (b.reset_token) {
      const tok = genServerToken();
      col('token', tok);
      set.push('updated_at=?'); vals.push(new Date().toISOString());
      await env.D1_DB.prepare('UPDATE ub_servers SET ' + set.join(',') + ' WHERE id=?').bind(...vals, id).run();
      return json({ ok: true, data: { updated: true, new_token: tok } });
    }
    if (set.length === 0) return json({ ok: true, data: { updated: false } });
    set.push('updated_at=?');
    vals.push(new Date().toISOString());
    await env.D1_DB.prepare('UPDATE ub_servers SET ' + set.join(',') + ' WHERE id=?').bind(...vals, id).run();
    return json({ ok: true, data: { updated: true } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function handleAdminServerDelete(env, id) {
  try {
    await env.D1_DB.prepare('DELETE FROM ub_servers WHERE id=?').bind(id).run();
    return json({ ok: true, data: { deleted: true } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ---------------- 脚本侧：心跳上报（server_token 鉴权） ----------------
// POST /api/ubot/heartbeat  body: { info: {hostname,version,ip,tasks,uptime}, note? }
export async function handleServerHeartbeat(request, env) {
  try {
    const u = new URL(request.url);
    const tok = u.searchParams.get('token') || request.headers.get('X-Ub-Token') || '';
    const s = await env.D1_DB.prepare('SELECT * FROM ub_servers WHERE token=?').bind(tok).first();
    if (!s) return json({ ok: false, error: 'Unauthorized' }, 401);
    const b = await request.json().catch(function(){ return {}; });
    const info = b.info && typeof b.info === 'object' ? b.info : {};
    const nowIso = new Date().toISOString();
    const lastInfo = JSON.stringify({ hostname: String(info.hostname || ''), version: String(info.version || ''), ip: String(info.ip || ''), tasks: Array.isArray(info.tasks) ? info.tasks.map(String) : [], uptime: Number(info.uptime) || 0 }).slice(0, 2000);
    await env.D1_DB.prepare('UPDATE ub_servers SET status=?, last_seen_at=?, last_ip=?, last_info=?, updated_at=? WHERE id=?')
      .bind('online', nowIso, String(info.ip || ''), lastInfo, nowIso, s.id).run();
    return json({ ok: true, data: { saved: true, server_id: s.id } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ---------------- 脚本侧：拉取本服务器负责的任务列表 + 全局配置 ----------------
// GET /api/ubot/server/tasks?token=<server_token>
// task_ids 为空 = 返回全部 enabled 任务；否则只返回指定 id 且 enabled 的任务
export async function handleServerTasks(request, env) {
  try {
    const u = new URL(request.url);
    const tok = u.searchParams.get('token') || request.headers.get('X-Ub-Token') || '';
    const s = await env.D1_DB.prepare('SELECT * FROM ub_servers WHERE token=?').bind(tok).first();
    if (!s) return json({ ok: false, error: 'Unauthorized' }, 401);
    const g = await env.D1_DB.prepare('SELECT key,value FROM settings WHERE key IN (?,?,?,?)').bind('ub_api_id', 'ub_api_hash', 'ub_session', 'ub_api_key').all();
    const gcfg = { api_id: '', api_hash: '', session: '', api_key: '' };
    (g.results || []).forEach(function(r) {
      if (r.key === 'ub_api_id') gcfg.api_id = r.value || '';
      else if (r.key === 'ub_api_hash') gcfg.api_hash = r.value || '';
      else if (r.key === 'ub_session') gcfg.session = r.value || '';
      else if (r.key === 'ub_api_key') gcfg.api_key = r.value || '';
    });
    let tasks = [];
    const ids = String(s.task_ids || '').split(',').map(function(x){ return x.trim(); }).filter(Boolean);
    if (ids.length) {
      const qmarks = ids.map(function(){ return '?'; }).join(',');
      const rows = await env.D1_DB.prepare('SELECT * FROM userbot_tasks WHERE enabled=1 AND id IN (' + qmarks + ') ORDER BY id').bind(...ids).all();
      tasks = rows.results || [];
    } else {
      const rows = await env.D1_DB.prepare('SELECT * FROM userbot_tasks WHERE enabled=1 ORDER BY id').all();
      tasks = rows.results || [];
    }
    // 心跳（拉任务也算在线）
    const nowIso = new Date().toISOString();
    await env.D1_DB.prepare('UPDATE ub_servers SET status=?, last_seen_at=?, updated_at=? WHERE id=?').bind('online', nowIso, nowIso, s.id).run();
    return json({ ok: true, data: { server: { id: s.id, name: s.name }, global: gcfg, tasks: tasks } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ---------------- VPS 一键部署脚本下发（无需鉴权，脚本本身不含密钥） ----------------
// GET /deploy/ubot.sh?server=<worker域名>&token=<ub_token>&srv=<server_token>&tasks=<1,2>
export function handleDeployScript(request, env) {
  const u = new URL(request.url);
  const server = (u.searchParams.get('server') || 'https://telegram-r2-bot.wo58.cn').replace(/\/+$/, '');
  const token = u.searchParams.get('token') || '';
  const srv = u.searchParams.get('srv') || '';
  const tasks = u.searchParams.get('tasks') || '';
  const sh = deploySh(server, token, srv, tasks);
  return new Response(sh, { status: 200, headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function deploySh(server, token, srv, tasks) {
  return `#!/usr/bin/env bash
# 群抓取执行节点一键部署（拉取部署，傻瓜式操作）
# 用法（后台「群抓取 → 服务器」复制）：
#   bash -c "$(curl -fsSL '${server}/deploy/ubot.sh?server=${server}&token=${token}&srv=${srv}&tasks=${tasks}')"
set -e
echo "[1/4] 安装依赖（python3 + pip + telethon + httpx）..."
if ! command -v python3 >/dev/null 2>&1; then
  (apt-get update -y && apt-get install -y python3 python3-pip) || (yum install -y python3 python3-pip) || true
fi
python3 -m pip install --break-system-packages --upgrade pip -q || true
python3 -m pip install --break-system-packages -q telethon httpx || true

echo "[2/4] 下载抓取脚本..."
mkdir -p /opt/ubot
curl -fsSL '${server}/deploy/userbot_pull.py' -o /opt/ubot/userbot_pull.py || exit 1
python3 -m py_compile /opt/ubot/userbot_pull.py || { echo "脚本下载/语法校验失败"; exit 1; }

echo "[3/4] 写入运行配置..."
cat > /opt/ubot/config.env <<'EOF'
UBOT_SERVER=${server}
UBOT_TOKEN=${token}
UBOT_SRV_TOKEN=${srv}
UBOT_TASKS=${tasks}
EOF
chmod 600 /opt/ubot/config.env

echo "[4/4] 注册 systemd 常驻服务（自动重启）..."
cat > /etc/systemd/system/ubot-agent.service <<'EOF'
[Unit]
Description=Telegram Ubot Agent (群历史图片抓取执行节点)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/ubot
EnvironmentFile=/opt/ubot/config.env
ExecStart=/usr/bin/python3 /opt/ubot/userbot_pull.py --daemon --server \$UBOT_SERVER --token \$UBOT_TOKEN --srv-token \$UBOT_SRV_TOKEN --tasks \$UBOT_TASKS
Restart=always
RestartSec=10
StandardOutput=append:/var/log/ubot-agent.log
StandardError=append:/var/log/ubot-agent.log

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ubot-agent
systemctl restart ubot-agent
sleep 3
systemctl --no-pager status ubot-agent | head -8 || true
echo ""
echo "部署完成！节点已注册常驻服务 ubot-agent，可运行：journalctl -u ubot-agent -f 查看日志"
`;
}

// GET /deploy/userbot_pull.py：返回抓取脚本源码（public，脚本本身不含密钥）
// 源码来源优先级：R2 的 deploy/userbot_pull.py（GitHub Actions 上传）→ 内置精简版提示
export async function handleDeployPullScript(request, env) {
  const src = await readScriptSource(env);
  if (src === null) return json({ ok: false, error: 'script source unavailable' }, 500);
  return new Response(src, { status: 200, headers: { 'Content-Type': 'text/x-python; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function handleDeployGenScript() {
  const GEN_SCRIPT = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 StringSession（一次性工具）

Telethon 的登录凭证本质上是一段可跨机使用的字符串。本脚本在本地运行一次，
登录成功后把 StringSession 打印出来，粘到后台「群抓取 → 全局配置 → StringSession」，
之后所有拉取脚本（userbot_pull.py）在任意机器上都能直接用它登录，无需再输验证码。

一键运行（自动安装依赖）：
    curl -sSL https://telegram-r2-bot.wo58.cn/deploy/userbot_gen.py | python3

或手动运行：
    pip install telethon
    python3 userbot_gen.py

脚本会询问：API ID / API Hash（my.telegram.org 获取）→ 手机号 → 登录码。
若账号开启两步验证，还需要输入密码。
"""
import subprocess
import sys


def ensure_telethon():
    try:
        import telethon
    except ImportError:
        print("正在安装 telethon...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "telethon", "-q"],
                            stdin=subprocess.DEVNULL)
        print("telethon 安装完成\\n")


ensure_telethon()

import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession


async def main():
    api_id = int(input("API ID: ").strip())
    api_hash = input("API Hash: ").strip()
    if not api_id or not api_hash:
        print("API ID / API Hash 不能为空", file=sys.stderr)
        return

    async with TelegramClient(StringSession(), api_id, api_hash) as client:
        phone = input("手机号（带国家码，例如 +8613812345678）: ").strip()
        await client.start(phone=phone)
        if not await client.is_user_authorized():
            print("登录未完成", file=sys.stderr)
            return
        me = await client.get_me()
        sess = client.session.save()
        print()
        print("=" * 60)
        print("登录成功：", getattr(me, "first_name", ""), getattr(me, "username", ""))
        print("StringSession（复制下面整行，粘到后台「群抓取 → 全局配置 → StringSession」）：")
        print(sess)
        print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
`;
  return new Response(GEN_SCRIPT, { status: 200, headers: { 'Content-Type': 'text/x-python; charset=utf-8', 'Cache-Control': 'no-store' } });
}
const PULL_SCRIPT_FALLBACK = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""群历史图片抓取执行脚本（从 worker 拉配置，断点回写，支持 --daemon 常驻心跳）

用法（脚本由 /opt/ubot 部署或手动下载后）：
  单次： python3 userbot_pull.py --server <worker域名> --token <ub_token> --task <任务ID>
  常驻： python3 userbot_pull.py --daemon --server <worker域名> --token <ub_token> --srv-token <server_token> --tasks <1,2>

详细源码以 GitHub 仓库 scripts/userbot_pull.py 为准；worker 通过 R2 下发同源文件。
"""
import argparse
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--task", type=int, default=None)
    ap.add_argument("--srv-token", default="")
    ap.add_argument("--tasks", default="")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--timeout", type=int, default=60)
    args = ap.parse_args()
    print("请在 VPS 上通过一键部署安装完整版脚本：")
    print('  bash -c "$(curl -fsSL \' + args.server + '/deploy/ubot.sh\')"')
    print("或从仓库下载 scripts/userbot_pull.py 覆盖本文件后重跑。")
    sys.exit(1)


if __name__ == "__main__":
    main()
`;

async function readScriptSource(env) {
  // 优先 R2：GitHub Actions 已把 scripts/userbot_pull.py 上传到 R2 的 deploy/userbot_pull.py
  try {
    if (env && env.R2_BUCKET && typeof env.R2_BUCKET.get === 'function') {
      const obj = await env.R2_BUCKET.get('deploy/userbot_pull.py');
      if (obj) return await obj.text();
    }
  } catch (e) {}
  return PULL_SCRIPT_FALLBACK;
}

// ---------------- 脚本侧：上报任务执行状态 ----------------
// POST /api/ubot/task/{id}/run-report  body: { status, server_id, server_name, done, skipped, error }
export async function handleTaskRunReport(request, env, taskId) {
  try {
    const u = new URL(request.url);
    const tok = u.searchParams.get('token') || request.headers.get('X-Ub-Token') || '';
    const cfg = await env.D1_DB.prepare('SELECT value FROM settings WHERE key=?').bind('ub_token').first();
    if (!tok || !cfg || !cfg.value || tok !== cfg.value) return json({ ok: false, error: 'Unauthorized' }, 401);
    const b = await request.json().catch(function(){ return {}; });
    const now = new Date().toISOString();
    const status = String(b.status || 'running').slice(0, 20);
    const serverId = Number(b.server_id) || 0;
    const serverName = String(b.server_name || '').slice(0, 100);
    const done = Number(b.done) || 0;
    const skipped = Number(b.skipped) || 0;
    const error = String(b.error || '').slice(0, 500);
    if (status === 'running') {
      const r = await env.D1_DB.prepare('INSERT INTO ub_task_runs (task_id, server_id, server_name, status, done, skipped, error, started_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind(taskId, serverId, serverName, status, done, skipped, error, now).run();
      return json({ ok: true, data: { run_id: r.meta?.last_row_id || 0 } });
    } else {
      // finished / error：更新最近一条 running 记录
      const last = await env.D1_DB.prepare('SELECT id FROM ub_task_runs WHERE task_id=? AND status=? ORDER BY id DESC LIMIT 1').bind(taskId, 'running').first();
      if (last) {
        await env.D1_DB.prepare('UPDATE ub_task_runs SET status=?, done=?, skipped=?, error=?, finished_at=? WHERE id=?')
          .bind(status, done, skipped, error, now, last.id).run();
      } else {
        await env.D1_DB.prepare('INSERT INTO ub_task_runs (task_id, server_id, server_name, status, done, skipped, error, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .bind(taskId, serverId, serverName, status, done, skipped, error, now, now).run();
      }
      // 同步更新 userbot_tasks 的 done/skipped
      if (status === 'finished') {
        await env.D1_DB.prepare('UPDATE userbot_tasks SET done=?, skipped=?, updated_at=? WHERE id=?').bind(done, skipped, now, taskId).run();
        // selected（选择抓取）一次性模式：本轮全部完成后清空选择、恢复普通模式
        const t = await env.D1_DB.prepare("SELECT mode FROM userbot_tasks WHERE id=? AND mode='selected'").bind(taskId).first();
        if (t) {
          await env.D1_DB.prepare("UPDATE userbot_tasks SET mode='normal', selected_msg_ids='', updated_at=? WHERE id=?").bind(now, taskId).run();
        }
      }
      return json({ ok: true });
    }
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ---------------- 脚本侧：长轮询拉取任务（等待新任务最多 hold 30 秒） ----------------
// GET /api/ubot/server/tasks-poll?token=<server_token>&last_run_id=<上次最大run_id>
// 有新任务立即返回；无新任务等 30 秒后返回空
export async function handleServerTasksPoll(request, env) {
  try {
    const u = new URL(request.url);
    const tok = u.searchParams.get('token') || request.headers.get('X-Ub-Token') || '';
    const s = await env.D1_DB.prepare('SELECT * FROM ub_servers WHERE token=?').bind(tok).first();
    if (!s) return json({ ok: false, error: 'Unauthorized' }, 401);
    // 先拉一次任务
    const g = await env.D1_DB.prepare('SELECT key,value FROM settings WHERE key IN (?,?,?,?)').bind('ub_api_id', 'ub_api_hash', 'ub_session', 'ub_api_key').all();
    const gcfg = { api_id: '', api_hash: '', session: '', api_key: '' };
    (g.results || []).forEach(function(r) {
      if (r.key === 'ub_api_id') gcfg.api_id = r.value || '';
      else if (r.key === 'ub_api_hash') gcfg.api_hash = r.value || '';
      else if (r.key === 'ub_session') gcfg.session = r.value || '';
      else if (r.key === 'ub_api_key') gcfg.api_key = r.value || '';
    });
    const ids = String(s.task_ids || '').split(',').map(function(x){ return x.trim(); }).filter(Boolean);
    let tasks = [];
    if (ids.length) {
      const qmarks = ids.map(function(){ return '?'; }).join(',');
      const rows = await env.D1_DB.prepare('SELECT * FROM userbot_tasks WHERE enabled=1 AND id IN (' + qmarks + ') ORDER BY id').bind(...ids).all();
      tasks = rows.results || [];
    } else {
      const rows = await env.D1_DB.prepare('SELECT * FROM userbot_tasks WHERE enabled=1 ORDER BY id').all();
      tasks = rows.results || [];
    }
    // 心跳
    const nowIso = new Date().toISOString();
    await env.D1_DB.prepare('UPDATE ub_servers SET status=?, last_seen_at=?, updated_at=? WHERE id=?').bind('online', nowIso, nowIso, s.id).run();
    // 如果有任务直接返回
    if (tasks.length) return json({ ok: true, data: { server: { id: s.id, name: s.name }, global: gcfg, tasks: tasks } });
    // 无任务：等待最多 30 秒（Cloudflare Workers 最长 waitUntil 30 秒）
    const deadline = Date.now() + 25000; // 留 5 秒余量
    while (Date.now() < deadline) {
      await new Promise(function(r){ setTimeout(r, 3000); });
      let freshTasks = [];
      if (ids.length) {
        const qmarks2 = ids.map(function(){ return '?'; }).join(',');
        const rows2 = await env.D1_DB.prepare('SELECT * FROM userbot_tasks WHERE enabled=1 AND id IN (' + qmarks2 + ') ORDER BY id').bind(...ids).all();
        freshTasks = rows2.results || [];
      } else {
        const rows2 = await env.D1_DB.prepare('SELECT * FROM userbot_tasks WHERE enabled=1 ORDER BY id').all();
        freshTasks = rows2.results || [];
      }
      if (freshTasks.length) return json({ ok: true, data: { server: { id: s.id, name: s.name }, global: gcfg, tasks: freshTasks } });
    }
    return json({ ok: true, data: { server: { id: s.id, name: s.name }, global: gcfg, tasks: [] } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ---------------- Admin：查询任务执行日志 ----------------
// GET /admin/api/ub-task-runs?task_id=<可选>&server_id=<可选>
export async function handleAdminTaskRuns(request, env) {
  try {
    const u = new URL(request.url);
    const taskId = u.searchParams.get('task_id');
    const serverId = u.searchParams.get('server_id');
    let d;
    if (taskId && serverId) {
      d = await env.D1_DB.prepare('SELECT * FROM ub_task_runs WHERE task_id=? AND server_id=? ORDER BY id DESC LIMIT 50').bind(taskId, serverId).all();
    } else if (taskId) {
      d = await env.D1_DB.prepare('SELECT * FROM ub_task_runs WHERE task_id=? ORDER BY id DESC LIMIT 50').bind(taskId).all();
    } else if (serverId) {
      d = await env.D1_DB.prepare('SELECT * FROM ub_task_runs WHERE server_id=? ORDER BY id DESC LIMIT 50').bind(serverId).all();
    } else {
      d = await env.D1_DB.prepare('SELECT * FROM ub_task_runs ORDER BY id DESC LIMIT 50').all();
    }
    return json({ ok: true, data: d.results || [] });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}
