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

流程：
    1. GET /api/ubot/task/<id>/config 拉取任务参数 + 全局 api_id/api_hash/StringSession
    2. 用 StringSession 登录（无需本地 .session 文件，换机无感）
    3. 从最新向更早翻历史图片，跳过 >max_size（默认 19MB，与 /api/v1/upload 上限一致）
    4. 逐张 POST 到 /api/v1/upload 入库
    5. 每批处理完回写断点 POST /api/ubot/task/<id>/progress（下次从断点续拉）

断点说明：last_id 表示「已处理的最小 message id」，脚本只处理 id < last_id 的消息。
首次运行时 last_id=0，从最新开始；后台可手动改 last_id 从指定位置重拉。
"""
import argparse
import asyncio
import json
import socket
import sys
import time

import httpx

from telethon import TelegramClient
from telethon.errors import FloodWaitError
from telethon.sessions import StringSession
from telethon.tl.types import MessageMediaPhoto

# 与 worker /api/v1/upload 的 19MB 上限保持一致
UPLOAD_MAX = 19 * 1024 * 1024
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
    """向 worker 上报本节点在线状态（server_token 鉴权），失败静默。"""
    if not srv_token:
        return
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
        if r.status_code != 200:
            print(f"心跳失败: HTTP {r.status_code}", file=sys.stderr)
    except Exception as e:
        print(f"心跳异常: {e}", file=sys.stderr)


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
    ap.add_argument("--srv-token", default="", help="服务器节点 token（后台「服务器」面板生成，用于心跳鉴权）")
    ap.add_argument("--tasks", default="", help="常驻模式要执行的任务 ID 列表，逗号分隔（空=该服务器全部分配任务）")
    ap.add_argument("--dry-run", action="store_true", help="只统计不上传")
    ap.add_argument("--limit", type=int, default=None, help="覆盖后台任务 limit（0=后台配置）")
    ap.add_argument("--timeout", type=int, default=60, help="HTTP 超时秒数")
    args = ap.parse_args()

    server = args.server.rstrip("/")

    # 常驻模式：循环执行分配的任务 + 定时心跳，防掉线
    if args.daemon:
        tasks = [int(t) for t in (args.tasks or "").replace(" ", "").split(",") if t.isdigit()]
        print(f"[daemon] server={server} 心跳间隔 {HEARTBEAT_EVERY}s，任务列表={tasks or '全部分配'}，循环间隔 {DAEMON_LOOP_SLEEP}s")
        while True:
            async with httpx.AsyncClient(timeout=args.timeout) as hc:
                await send_heartbeat(hc, server, args.srv_token, [str(t) for t in tasks])
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
                # 逐个执行（异常不中断循环）
                for tid in assigned:
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
            await asyncio.sleep(DAEMON_LOOP_SLEEP)
        return

    if not args.task:
        ap.error("单次模式必须指定 --task；常驻请用 --daemon")

    async with httpx.AsyncClient(timeout=args.timeout) as hc:
        await run_task_once(hc, args, args.task)


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
    max_size = int(task.get("max_size") or 0) or UPLOAD_MAX
    limit = args.limit if args.limit is not None else int(task.get("limit") or 0)
    last_id = int(task.get("last_id") or 0)
    title_prefix = task.get("title") or ""

    print(f"任务 #{task_id}: chat={chat_id} title={task.get('title')} tags={tags} pool={pool} level={level} max_size={max_size} limit={limit}")
    if last_id:
        print(f"断点续拉：跳过 message id >= {last_id}，向更早翻")

    # 复用外部传入的 httpx 客户端（上传 + 回写断点）
    await run_pull(hc, client_kwargs=(session_str, api_id, api_hash), chat_id=chat_id,
                   tags=tags, pool=pool, level=level, max_size=max_size, limit=limit,
                   last_id=last_id, title_prefix=title_prefix, upload_api_key=upload_api_key,
                   server=server, task=task, task_id=task_id, args=args)


async def run_pull(hc, client_kwargs, chat_id, tags, pool, level, max_size, limit, last_id, title_prefix, upload_api_key, server, task, task_id, args):
    session_str, api_id, api_hash = client_kwargs
    async with TelegramClient(StringSession(session_str), api_id, api_hash) as client:
        await client.start()
        if not await client.is_user_authorized():
            print("会话未授权（StringSession 失效），请在本地重新登录并更新后台配置", file=sys.stderr)
            sys.exit(1)
        chat = await client.get_entity(chat_id)
        title = getattr(chat, "title", chat_id)
        print(f"群: {title}")

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
                    r = await hc.post(
                        server + "/api/v1/upload",
                        params=params,
                        files={"file": (f"ubot_{task['id']}_{msg.id}.jpg", data, "image/jpeg")}
                    )
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


if __name__ == "__main__":
    asyncio.run(main())
