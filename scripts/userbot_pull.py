#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""群历史图片抓取（后台配置驱动版）

worker 当「控制面」：每群任务配置 + 断点 last_id + api_id/api_hash/StringSession 全部存
Cloudflare D1（后台 admin → 群抓取 面板配置），本脚本只在本地/VPS/Containers 上执行翻历史。

    pip install telethon httpx

用法（无需任何本地配置，全部从后台拉取）：
    单次执行：
        python userbot_pull.py --server https://your.worker.dev --token ub_xxxxx --task 1
    常驻执行（VPS 一键部署使用，自动循环 + 心跳防掉线）：
        python userbot_pull.py --daemon --server https://your.worker.dev --token ub_xxxxx --srv-token srv_xxxxx [--tasks 1,2]

    --server     worker 域名
    --token      后台「群抓取」生成的 ub_token（全局配置里可重置）
    --task       任务 ID（单次模式）
    --daemon     常驻模式：循环执行任务 + 定时心跳上报
    --srv-token  服务器节点 token（后台「群抓取 → 服务器」面板生成，心跳鉴权用）
    --tasks      常驻模式要执行的任务 ID 列表（空=执行该服务器分配的全部任务）
    --dry-run    只统计不上传
    --limit      覆盖后台任务的 limit（0=用后台配置）

三种模式（由后台任务 mode 字段驱动，脚本无感知自动切换）：
    normal   普通抓取：从最新向更早翻历史图片，跳过 >max_size，断点 last_id 续拉
    list     相册列表：枚举最近 scan_limit 条消息聚合相册，只传封面缩略图，整批上报元数据
    selected 选择抓取：仅下载已选消息 id 的媒体并上传（一次性，完成后 worker 清空选择）

上传：≤19MB 走 multipart；>19MB ≤90MB 走 stream=1 流式（worker 直接流入 R2，不整块进内存）；
      >90MB 跳过（任务 max_size 上限已被后台收紧到 90MB）。
"""
import argparse
import asyncio
import json
import socket
import sys
import time

import httpx

from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import MessageMediaPhoto

# 与 worker /api/v1/upload 一致：≤19MB 走 multipart；>19MB ≤90MB 走 stream 流式
UPLOAD_SMALL_MAX = 19 * 1024 * 1024
UPLOAD_HARD_MAX = 90 * 1024 * 1024
# 相册上报分片：单次 POST 最多多少个相册
ALBUM_MAX_PER_POST = 500
# 翻历史消息的最小间隔（秒）
ITER_WAIT = 1.0
# 下载/上传前的最小间隔
WORK_DELAY = 0.5
# 每张上传完成后的最小间隔
FORWARD_DELAY = 1.0
# 每 N 张额外长休息
BATCH_SIZE = 20
BATCH_SLEEP = 8.0
# 常驻模式：心跳间隔 / 每轮任务循环间隔
HEARTBEAT_EVERY = 60
DAEMON_LOOP_SLEEP = 120


async def send_heartbeat(hc, server, srv_token, tasks):
    """向 worker 上报本节点在线状态（server_token 鉴权），失败静默。返回 dialogs_pending 标记。"""
    if not srv_token:
        return False
    try:
        ip = ""
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
        except Exception:
            pass
        info = {
            "hostname": socket.gethostname(),
            "version": "userbot_pull.py",
            "ip": ip,
            "tasks": tasks,
            "uptime": int(time.time()),
        }
        r = await hc.post(f"{server}/api/ubot/heartbeat?token={srv_token}", json={"info": info}, timeout=15)
        if r.status_code == 200:
            try:
                return bool((r.json().get("data") or {}).get("dialogs_pending"))
            except Exception:
                pass
        else:
            print(f"心跳失败: HTTP {r.status_code}", file=sys.stderr)
    except Exception as e:
        print(f"心跳异常: {e}", file=sys.stderr)
    return False


async def refresh_dialogs(hc, server, ub_token):
    """拉取账号所在群/频道并上报（供后台选群建任务）；同时上报 StringSession 校验结果。"""
    if not ub_token:
        return
    try:
        r = await hc.get(f"{server}/api/ubot/global?token={ub_token}", timeout=30)
        if r.status_code != 200:
            print(f"[dialogs] 拉取配置失败 HTTP {r.status_code}", file=sys.stderr)
            return
        g = (r.json().get("data") or {}).get("global") or {}
        api_id, api_hash, session = g.get("api_id"), g.get("api_hash"), g.get("session")
        if not api_id or not api_hash or not session:
            try:
                await hc.post(f"{server}/api/ubot/dialogs?token={ub_token}", json={"dialogs": [], "session_valid": False, "error": "后台未配置 api_id/api_hash/session"}, timeout=30)
            except Exception:
                pass
            print("[dialogs] 后台未配置 api_id/api_hash/session", file=sys.stderr)
            return
        from telethon import TelegramClient
        from telethon.sessions import StringSession
        client = TelegramClient(StringSession(session), int(api_id), api_hash, connection_retries=2)
        await client.connect()
        if not await client.is_user_authorized():
            try:
                await hc.post(f"{server}/api/ubot/dialogs?token={ub_token}", json={"dialogs": [], "session_valid": False, "error": "StringSession 未授权/已失效，请重新生成"}, timeout=30)
            except Exception:
                pass
            print("[dialogs] StringSession 未授权，无法获取群列表", file=sys.stderr)
            await client.disconnect()
            return
        dialogs = []
        async for d in client.iter_dialogs(limit=200):
            if d.is_group or d.is_channel:
                ent = d.entity
                from telethon.tl.types import Channel, Chat
                if isinstance(ent, Chat):
                    chat_type = "group"
                elif isinstance(ent, Channel):
                    chat_type = "channel" if not getattr(ent, "megagroup", False) else "supergroup"
                else:
                    chat_type = "group"
                participants = 0
                try:
                    participants = int(getattr(ent, "participants_count", 0) or 0)
                except Exception:
                    participants = 0
                dialogs.append({
                    "chat_id": str(d.id),
                    "title": (d.title or "")[:200],
                    "chat_type": chat_type,
                    "username": getattr(ent, "username", None) or "",
                    "participants": participants,
                })
        await client.disconnect()
        r2 = await hc.post(f"{server}/api/ubot/dialogs?token={ub_token}", json={"dialogs": dialogs, "session_valid": True, "error": ""}, timeout=30)
        print(f"[dialogs] 上报 {len(dialogs)} 个群/频道, HTTP {r2.status_code}", file=sys.stderr)
    except Exception as e:
        print(f"[dialogs] 异常: {e}", file=sys.stderr)
        try:
            await hc.post(f"{server}/api/ubot/dialogs?token={ub_token}", json={"dialogs": [], "session_valid": False, "error": str(e)[:200]}, timeout=30)
        except Exception:
            pass


async def report_run(hc, server, args, task_id, status, error=""):
    """向 worker 上报任务执行状态（running/finished/error），失败静默。"""
    if not args.token:
        return
    try:
        url = f"{server}/api/ubot/task/{task_id}/run-report?token={args.token}"
        await hc.post(url, json={
            "status": status,
            "server_id": 0,
            "server_name": socket.gethostname(),
            "done": 0,
            "skipped": 0,
            "error": error,
        }, timeout=10)
    except Exception:
        pass


async def main():
    ap = argparse.ArgumentParser(description="群历史图片抓取（后台配置驱动）")
    ap.add_argument("--server", required=True, help="worker 域名，如 https://your.worker.dev")
    ap.add_argument("--token", required=True, help="后台生成的 ub_token（群抓取面板可重置）")
    ap.add_argument("--task", type=int, default=None, help="任务 ID（后台任务列表）")
    ap.add_argument("--daemon", action="store_true", help="常驻模式：循环执行任务 + 定时心跳上报")
    ap.add_argument("--srv-token", nargs="?", const="", default="", help="服务器节点 token（后台「服务器」面板生成，用于心跳鉴权）")
    ap.add_argument("--tasks", nargs="?", const="", default="", help="常驻模式要执行的任务 ID 列表，逗号分隔（空=该服务器全部分配任务）")
    ap.add_argument("--dry-run", action="store_true", help="只统计不上传")
    ap.add_argument("--limit", type=int, default=None, help="覆盖后台任务 limit（0=后台配置）")
    ap.add_argument("--timeout", type=int, default=60, help="HTTP 超时秒数")
    args = ap.parse_args()

    server = args.server.rstrip("/")

    # 常驻模式：循环执行分配的任务 + 定时心跳（独立后台任务，跑长任务期间心跳不停，防止后台判离线）
    if args.daemon:
        tasks = [int(t) for t in (args.tasks or "").replace(" ", "").split(",") if t.isdigit()]
        print(f"[daemon] server={server} 心跳间隔 {HEARTBEAT_EVERY}s，任务列表={tasks or '全部分配'}，循环间隔 {DAEMON_LOOP_SLEEP}s")
        hc = httpx.AsyncClient(timeout=args.timeout)

        async def heartbeat_loop():
            while True:
                try:
                    need_dialogs = await send_heartbeat(hc, server, args.srv_token, [str(t) for t in tasks])
                    if need_dialogs:
                        try:
                            await refresh_dialogs(hc, server, args.token)
                        except Exception as e:
                            print(f"[daemon] 刷新群列表异常: {e}", file=sys.stderr)
                except Exception as e:
                    print(f"[daemon] 心跳异常: {e}", file=sys.stderr)
                await asyncio.sleep(HEARTBEAT_EVERY)

        asyncio.create_task(heartbeat_loop())
        # 任务并发调度：每个任务独立 asyncio task，互不阻塞，长任务不再卡住其他任务
        MAX_CONCURRENT = 3
        sem = asyncio.Semaphore(MAX_CONCURRENT)
        running = {}

        async def run_one(tid):
            async with sem:
                try:
                    await report_run(hc, server, args, tid, "running")
                    await run_task_once(hc, args, tid)
                    await report_run(hc, server, args, tid, "finished")
                except Exception as e:
                    print(f"任务 #{tid} 执行异常: {e}", file=sys.stderr)
                    try:
                        await report_run(hc, server, args, tid, "error", str(e))
                    except Exception:
                        pass
            running.pop(tid, None)

        while True:
            # 长轮询拉取本服务器分配的任务（task_ids 空=全部 enabled，无任务时 hold 30秒等待）
            assigned = tasks
            if not assigned:
                try:
                    poll_url = f"{server}/api/ubot/server/tasks-poll?token={args.srv_token}"
                    r = await hc.get(poll_url, timeout=35)
                    if r.status_code == 200:
                        j = r.json()
                        assigned = [t["id"] for t in (j.get("data") or {}).get("tasks", [])]
                        if assigned:
                            print(f"[daemon] 拉到 {len(assigned)} 个任务: {assigned}")
                        else:
                            print(f"[daemon] 无任务，等待下一轮...")
                except Exception as e:
                    print(f"[daemon] 拉取任务异常: {e}", file=sys.stderr)
            # 启动未在运行的任务；取消已不在列表中的任务
            active = set()
            for tid in assigned:
                active.add(tid)
                if tid not in running:
                    running[tid] = asyncio.create_task(run_one(tid))
                    print(f"[daemon] 启动任务 #{tid}")
            for tid in list(running.keys()):
                if tid not in active and running[tid] and not running[tid].done():
                    running[tid].cancel()
                    print(f"[daemon] 停止任务 #{tid}（已不在分配列表）")
                    running.pop(tid, None)
            await asyncio.sleep(DAEMON_LOOP_SLEEP)
        return

    if not args.task:
        ap.error("单次模式必须指定 --task；常驻请用 --daemon")

    async with httpx.AsyncClient(timeout=args.timeout) as hc:
        await run_task_once(hc, args, args.task)


async def resolve_peer(client, chat_id):
    """智能解析 chat_id：兼容普通群、已迁移超群/频道（-100 前缀）、username、t.me 链接。

    普通负 ID（basic group 时期）解析失败时自动重试 -100 前缀形式——
    Telegram 把 basic group 迁移成 supergroup/channel 后，其 peer 需用 -100 前缀（如 -1001884867389）。
    """
    from telethon.errors import ChatIdInvalidError, ChannelInvalidError, UsernameNotOccupiedError
    raw = str(chat_id).strip()
    candidates = []
    if raw.startswith(('t.me/', 'https://t.me/')) and '/' in raw:
        candidates.append(raw.rsplit('/', 1)[-1])
    elif raw.startswith('@'):
        candidates.append(raw[1:])
    elif raw.lstrip('-').isdigit():
        n = int(raw)
        if n < 0:
            candidates.append(n)
            if not raw.startswith('-100'):
                candidates.append(int('-100' + raw.lstrip('-')))
        else:
            candidates.append(n)
            candidates.append(-n)
            candidates.append(int('-100' + raw))
    else:
        candidates.append(raw)

    last_err = None
    for c in candidates:
        try:
            return await client.get_entity(c)
        except (ChatIdInvalidError, ChannelInvalidError, UsernameNotOccupiedError, ValueError, TypeError) as e:
            last_err = e
            continue
    raise ValueError(
        f"无法解析 chat_id={chat_id}（已尝试 {candidates}）。若该群已迁移为超群/频道，请在后台填入 -100 前缀的 ID（如 -100{str(chat_id).lstrip('-')}），或用「已有群 → 用此群创建」自动填入正确 ID。原始错误: {last_err}"
    )


async def run_task_once(hc, args, task_id):
    server = args.server.rstrip("/")
    cfg_url = f"{server}/api/ubot/task/{task_id}/config?token={args.token}"
    r = await hc.get(cfg_url)
    if r.status_code != 200:
        print(f"任务 #{task_id} 拉取配置失败: HTTP {r.status_code} {r.text[:200]}", file=sys.stderr)
        return
    j = r.json()
    if not j.get("ok"):
        print(f"任务 #{task_id} 拉取配置失败: {j}", file=sys.stderr)
        return
    data = j["data"]
    task = data["task"]
    g = data["global"]

    api_id = int(g.get("api_id") or 0)
    api_hash = g.get("api_hash") or ""
    session_str = g.get("session") or ""
    upload_api_key = g.get("api_key") or ""
    if not api_id or not api_hash:
        print("后台未配置 api_id / api_hash（群抓取 → 全局配置）", file=sys.stderr)
        return
    if not session_str:
        print("后台未配置 StringSession（首次需在本地生成后填入后台，见 README 说明）", file=sys.stderr)
        return
    if not upload_api_key:
        print("后台未配置上传 api_key（群抓取 → 全局配置，填后台「密钥管理」里生成的 key）", file=sys.stderr)
        return

    chat_id = int(task.get("chat_id") or 0)
    tags = task.get("tags") or ""
    pool = 1 if task.get("pool") else 0
    level = task.get("level") or "pt"
    max_size = int(task.get("max_size") or 0) or UPLOAD_SMALL_MAX
    if max_size > UPLOAD_HARD_MAX:
        max_size = UPLOAD_HARD_MAX
    limit = args.limit if args.limit is not None else int(task.get("limit") or 0)
    last_id = int(task.get("last_id") or 0)
    title_prefix = task.get("title") or ""
    mode = task.get("mode") or "normal"
    selected_ids = [x for x in str(task.get("selected_msg_ids") or "").replace(" ", "").split(",") if x.isdigit()]
    scan_limit = int(task.get("scan_limit") or 0) or ALBUM_MAX_PER_POST * 4

    print(f"任务 #{task_id}: chat={chat_id} title={task.get('title')} tags={tags} pool={pool} level={level} max_size={max_size} limit={limit} mode={mode}")
    if mode == "list":
        print(f"列表模式：枚举最近 {scan_limit} 条消息聚合相册（不下载相册媒体）")
    elif mode == "selected":
        print(f"选择抓取模式：仅处理 {len(selected_ids)} 条已选消息")
    elif last_id:
        print(f"断点续拉：跳过 message id >= {last_id}，向更早翻")

    # 打开会话一次，按 mode 分发到对应流程
    async with TelegramClient(StringSession(session_str), api_id, api_hash) as client:
        await client.connect()
        if not await client.is_user_authorized():
            print("会话未授权（StringSession 无效或已失效），请重新生成并更新后台「群抓取 → 全局配置 → StringSession」", file=sys.stderr)
            return
        chat = await resolve_peer(client, chat_id)
        print(f"群: {getattr(chat, 'title', chat_id)}")

        if mode == "list":
            await run_list_albums(hc, client, chat, task_id, scan_limit, max_size, upload_api_key, server, args)
        elif mode == "selected":
            await run_selected_pull(hc, client, chat, task, tags, pool, level, max_size, title_prefix, upload_api_key, server, args)
        else:
            await run_pull(hc, client, chat, task, tags, pool, level, max_size, limit, last_id, title_prefix, upload_api_key, server, args)


async def upload_media(hc, server, task_id, msg_id, data, params):
    """按文件大小选上传路径：≤19MB 走 multipart；>19MB ≤90MB 走 stream=1 流式（worker 直入 R2）。"""
    name = f"ubot_{task_id}_{msg_id}.jpg"
    if len(data) <= UPLOAD_SMALL_MAX:
        return await hc.post(server + "/api/v1/upload", params=params,
                             files={"file": (name, data, "image/jpeg")}, timeout=120)
    p = dict(params)
    p["stream"] = "1"
    return await hc.post(server + "/api/v1/upload", params=p, content=data,
                         headers={"X-File-Name": name, "Content-Type": "image/jpeg"}, timeout=600)


async def upload_cover(hc, server, upload_api_key, task_id, grouped_id, data):
    """相册封面缩略图：cover=1 上传到 album_covers/，不写 files 表；失败返回空串。"""
    try:
        params = {"api_key": upload_api_key, "cover": "1", "task_id": task_id, "grouped_id": grouped_id}
        r = await hc.post(server + "/api/v1/upload", params=params,
                          files={"file": (f"cover_{task_id}_{grouped_id}.jpg", data, "image/jpeg")}, timeout=60)
        if r.status_code == 200:
            j = r.json()
            return (j.get("data") or {}).get("url", "")
    except Exception as e:
        print(f"  封面上传异常 {grouped_id}: {e}", file=sys.stderr)
    return ""


async def run_pull(hc, client, chat, task, tags, pool, level, max_size, limit, last_id, title_prefix, upload_api_key, server, args):
    """普通抓取模式：从最新向更早翻历史图片，跳过 >max_size，断点 last_id 续拉。"""
    task_id = task["id"]
    done = 0
    skipped = 0
    min_id = last_id or None  # 已处理的最小 id，回写给后台
    pending_progress = {"last_id": min_id or 0, "done": 0, "skipped": 0}

    async def save_progress(final=False):
        # 向 worker 回写断点（不阻塞主循环，失败静默）
        pending_progress["last_id"] = min_id or 0
        pending_progress["done"] = done
        pending_progress["skipped"] = skipped
        try:
            u = f"{server}/api/ubot/task/{task_id}/progress?token={args.token}"
            await hc.post(u, json=pending_progress)
        except Exception:
            pass

    # 手动迭代（非 async for），支持 FloodWait 后重试同一条消息
    it = client.iter_messages(chat, reverse=False, wait_time=ITER_WAIT)
    while True:
        try:
            msg = await it.__anext__()
        except StopAsyncIteration:
            break
        except Exception:
            break

        if last_id and msg.id >= last_id:
            continue
        if not msg.media or not isinstance(msg.media, MessageMediaPhoto):
            continue
        if limit and done >= limit:
            break

        size = getattr(getattr(msg.media, "photo", None), "size", 0) or 0
        if size > max_size or size <= 0:
            if size > max_size:
                skipped += 1
                print(f"  跳过 #{msg.id}: {size}B 超限(>{max_size})", file=sys.stderr)
            min_id = msg.id if (min_id is None or msg.id < min_id) else min_id
            done += 1
            continue

        if args.dry_run:
            caption = (msg.message or "").splitlines()[0] if msg.message else ""
            print(f"  [dry] #{msg.id} size={size} {caption[:40]}")
        else:
            try:
                data = await msg.download_media(file=bytes)
            except Exception as e:
                print(f"  下载失败 #{msg.id}: {e}", file=sys.stderr)
                time.sleep(5)
                continue
            if not data:
                continue
            if len(data) > max_size:
                skipped += 1
                print(f"  跳过 #{msg.id}: {len(data)}B 超限", file=sys.stderr)
                min_id = msg.id if (min_id is None or msg.id < min_id) else min_id
                done += 1
                continue
            await asyncio.sleep(WORK_DELAY)

            caption = (msg.message or "").splitlines()[0] if msg.message else ""
            title = (title_prefix + " " + caption).strip()[:200]
            params = {"api_key": upload_api_key, "tags": tags, "title": title, "level": level}
            if pool:
                params["pool"] = "1"
            try:
                r = await upload_media(hc, server, task_id, msg.id, data, params)
                if r.status_code != 200:
                    print(f"  上传失败 #{msg.id}: HTTP {r.status_code} {r.text[:120]}", file=sys.stderr)
                    if r.status_code in (429, 500, 502, 503):
                        time.sleep(10)
                    continue
                print(f"  ✓ #{msg.id} uploaded {len(data)}B")
            except Exception as e:
                print(f"  上传异常 #{msg.id}: {e}", file=sys.stderr)
                time.sleep(5)
                continue
            await asyncio.sleep(FORWARD_DELAY)

        min_id = msg.id if (min_id is None or msg.id < min_id) else min_id
        done += 1

        if done % BATCH_SIZE == 0:
            await save_progress()
            print(f"  已处理 {done} 张，休息 {BATCH_SLEEP}s…")
            await asyncio.sleep(BATCH_SLEEP)

    await save_progress()
    print(f"完成：本次 {done} 张（跳过超限 {skipped} 张），断点 last_id={min_id or 0}")


async def run_list_albums(hc, client, chat, task_id, scan_limit, max_size, upload_api_key, server, args):
    """列表模式：枚举最近 scan_limit 条消息聚合相册，传封面缩略图，整批上报元数据（不下载相册媒体）。"""
    albums = {}  # grouped_id -> {msg_ids, sizes, first_ts, cover_msg_id}
    scanned = 0
    t0 = time.time()
    it = client.iter_messages(chat, reverse=False, wait_time=ITER_WAIT)
    while True:
        try:
            msg = await it.__anext__()
        except StopAsyncIteration:
            break
        except Exception:
            break
        if scanned >= scan_limit:
            break
        scanned += 1
        if scanned % 500 == 0:
            print(f"  [进度] 已扫描 {scanned}/{scan_limit} 条，聚合相册 {len(albums)} 个（耗时 {int(time.time()-t0)}s）", file=sys.stderr, flush=True)
        if not msg.media or msg.grouped_id is None:
            continue
        if not isinstance(msg.media, MessageMediaPhoto):
            continue
        gid = str(msg.grouped_id)
        a = albums.setdefault(gid, {"msg_ids": [], "sizes": [], "first_ts": 0})
        a["msg_ids"].append(msg.id)
        photo = getattr(msg.media, "photo", None)
        sz = 0
        w = 0
        h = 0
        if photo and getattr(photo, "sizes", None):
            for s in photo.sizes:
                ss = getattr(s, "size", 0) or 0
                if ss and ss > sz:
                    sz = ss
                    w = getattr(s, "w", 0) or 0
                    h = getattr(s, "h", 0) or 0
        a["sizes"].append({"id": msg.id, "size": sz, "w": w, "h": h})
        if msg.date:
            ts0 = int(msg.date.timestamp())
            if not a["first_ts"] or ts0 < a["first_ts"]:
                a["first_ts"] = ts0

    # 每相册上传封面 + 每张图缩略图（thumb_url 供后台逐张预览/勾选）
    for gid, a in albums.items():
        a["msg_ids"].sort()
        a["sizes"].sort(key=lambda s: s["id"])
        thumbs = {}
        cover_url = ""
        try:
            for idx, mid in enumerate(a["msg_ids"]):
                m = await client.get_messages(chat, ids=mid)
                if not m or not m.media:
                    continue
                data = await m.download_media(file=bytes, thumb=1)
                if data:
                    tu = await upload_cover(hc, server, upload_api_key, task_id, f"{gid}_{mid}", data)
                    if tu:
                        thumbs[str(mid)] = tu
                if idx == 0 and thumbs.get(str(mid)):
                    cover_url = thumbs[str(mid)]
                await asyncio.sleep(WORK_DELAY)
        except Exception as e:
            print(f"  相册缩略图失败 {gid}: {e}", file=sys.stderr)
        for s in a["sizes"]:
            s["thumb_url"] = thumbs.get(str(s["id"]), "")
        a["cover_url"] = cover_url
        await asyncio.sleep(WORK_DELAY)

    payload = []
    for gid, a in albums.items():
        payload.append({
            "grouped_id": gid,
            "msg_ids": a["msg_ids"],
            "count": len(a["msg_ids"]),
            "sizes": a["sizes"],
            "cover_url": a["cover_url"],
            "first_ts": a["first_ts"],
            "has_oversize": 1 if any(s["size"] > max_size for s in a["sizes"]) else 0,
        })
    # 分片上报（单次 ≤ALBUM_MAX_PER_POST）；worker 收到后把任务 mode 收敛回 normal
    for i in range(0, len(payload), ALBUM_MAX_PER_POST):
        chunk = payload[i:i + ALBUM_MAX_PER_POST]
        try:
            r = await hc.post(f"{server}/api/ubot/task/{task_id}/albums?token={args.token}",
                              json={"albums": chunk}, timeout=60)
            if r.status_code != 200:
                print(f"  相册上报失败: HTTP {r.status_code} {r.text[:120]}", file=sys.stderr)
        except Exception as e:
            print(f"  相册上报异常: {e}", file=sys.stderr)
    print(f"列表模式完成：扫描 {scanned} 条，聚合 {len(payload)} 个相册")


async def run_selected_pull(hc, client, chat, task, tags, pool, level, max_size, title_prefix, upload_api_key, server, args):
    """选择抓取模式：仅下载已选消息 id 的媒体并上传入库（一次性，worker 完成后清空选择恢复 normal）。"""
    task_id = task["id"]
    selected_ids = [int(x) for x in str(task.get("selected_msg_ids") or "").replace(" ", "").split(",") if x.isdigit()]
    if not selected_ids:
        print("选择抓取模式：选择集合为空，跳过本轮", file=sys.stderr)
        return
    done = 0
    skipped = 0
    pending_progress = {"last_id": 0, "done": 0, "skipped": 0}

    async def save_progress(final=False):
        pending_progress["done"] = done
        pending_progress["skipped"] = skipped
        try:
            u = f"{server}/api/ubot/task/{task_id}/progress?token={args.token}"
            await hc.post(u, json=pending_progress)
        except Exception:
            pass

    # 分批拉取消息（每批 50 条，减少 MTProto 往返），再逐条下载上传
    for i in range(0, len(selected_ids), 50):
        chunk = selected_ids[i:i + 50]
        msgs = []
        try:
            got = await client.get_messages(chat, ids=chunk)
            if got:
                msgs = got if isinstance(got, list) else [got]
        except Exception as e:
            print(f"  批量取消息失败 {chunk}: {e}", file=sys.stderr)
            msgs = []
        for msg in msgs:
            mid = msg.id if msg else None
            if not msg or not msg.media or not isinstance(msg.media, MessageMediaPhoto):
                if mid:
                    skipped += 1
                continue
            size = getattr(getattr(msg.media, "photo", None), "size", 0) or 0
            if size > max_size or size <= 0:
                skipped += 1
                print(f"  跳过 #{mid}: {size}B 超限(>{max_size})", file=sys.stderr)
                continue
            if args.dry_run:
                print(f"  [dry] #{mid} size={size}")
            else:
                try:
                    data = await msg.download_media(file=bytes)
                except Exception as e:
                    print(f"  下载失败 #{mid}: {e}", file=sys.stderr)
                    time.sleep(5)
                    continue
                if not data:
                    continue
                if len(data) > max_size:
                    skipped += 1
                    print(f"  跳过 #{mid}: {len(data)}B 超限", file=sys.stderr)
                    continue
                await asyncio.sleep(WORK_DELAY)
                caption = (msg.message or "").splitlines()[0] if msg.message else ""
                title = (title_prefix + " " + caption).strip()[:200]
                params = {"api_key": upload_api_key, "tags": tags, "title": title, "level": level}
                if pool:
                    params["pool"] = "1"
                try:
                    r = await upload_media(hc, server, task_id, msg.id, data, params)
                    if r.status_code != 200:
                        print(f"  上传失败 #{mid}: HTTP {r.status_code} {r.text[:120]}", file=sys.stderr)
                        if r.status_code in (429, 500, 502, 503):
                            time.sleep(10)
                        continue
                    print(f"  ✓ #{mid} uploaded {len(data)}B")
                except Exception as e:
                    print(f"  上传异常 #{mid}: {e}", file=sys.stderr)
                    time.sleep(5)
                    continue
                await asyncio.sleep(FORWARD_DELAY)
            done += 1
            if done % BATCH_SIZE == 0:
                await save_progress()
                await asyncio.sleep(BATCH_SLEEP)

    await save_progress()
    print(f"选择抓取完成：{done} 张（跳过 {skipped} 张）")


if __name__ == "__main__":
    asyncio.run(main())
