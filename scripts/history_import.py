#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""群历史图片回填工具

两种模式：
  forward  —— 翻历史 → 转发到 bot 所在群 → bot 自动接收存 R2（推荐）
  upload   —— 翻历史 → 下载字节 → POST 到 worker 的 /api/v1/upload 接口

在本地机器运行（用户会话走 MTProto，能翻 bot 进群前的历史）：
    pip install telethon httpx

forward 模式（推荐，无需 worker 域名/api_key）：
    API_ID=xxx API_HASH=xxx python history_import.py \
        --chat -100123456789 --bot-group -100987654321 \
        --limit 100 --dry-run

upload 模式：
    API_ID=xxx API_HASH=xxx python history_import.py \
        --chat -100123456789 --worker https://your.worker.dev --api-key xxx

前置条件：
  - forward 模式：bot 必须在 --bot-group 群里，且该群允许接收转发消息
  - upload 模式：需要图库后台生成的 api_key（/admin 里创建）
  - 群历史可见性：超级群默认可见；若开了「新成员看不到旧消息」，登录账号需是管理员
"""
import argparse
import asyncio
import json
import os
import sys
import time

from telethon import TelegramClient
from telethon.errors import FloodWaitError, ChatWriteForbiddenError, InputUserDeactivatedError
from telethon.tl.types import MessageMediaPhoto

# 上传模式的接口上限
UPLOAD_MAX = 18 * 1024 * 1024
# 翻历史消息的最小间隔（秒）
ITER_WAIT = 1.0
# 下载/转发前的最小间隔
WORK_DELAY = 0.5
# 每张转发完成后的最小间隔
FORWARD_DELAY = 1.0
# 每 N 张额外长休息
BATCH_SIZE = 20
BATCH_SLEEP = 8.0


def load_state(path):
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"processed": [], "last_id": None, "skipped_large": 0}


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, path)


async def main():
    ap = argparse.ArgumentParser(description="群历史图片回填")
    ap.add_argument("--chat", required=True, help="源群 ID，如 -100123456789")
    ap.add_argument("--mode", choices=["forward", "upload"], default="forward",
                    help="forward=转发到 bot 群（推荐）；upload=调 worker upload API")
    ap.add_argument("--bot-group", help="forward 模式：bot 所在的目标群 ID")
    ap.add_argument("--worker", help="upload 模式：图库 Worker 域名")
    ap.add_argument("--api-key", help="upload 模式：图库后台 api_key")
    ap.add_argument("--session", default="history_import", help="Telethon session 名")
    ap.add_argument("--tags", default="历史图片", help="upload 模式入库 tags")
    ap.add_argument("--title-prefix", default="", help="upload 模式 title 前缀")
    ap.add_argument("--limit", type=int, default=0, help="最多处理张数，0=不限")
    ap.add_argument("--start-id", type=int, default=0, help="从某 message id 开始翻，0=最新")
    ap.add_argument("--pool", action="store_true", help="upload 模式进共享库")
    ap.add_argument("--level", default="free", help="upload 模式入库级别")
    ap.add_argument("--max-size", type=int, default=UPLOAD_MAX, help="单张最大字节数，超过跳过")
    ap.add_argument("--dry-run", action="store_true", help="只统计不转发/不上传")
    args = ap.parse_args()

    api_id = int(os.environ.get("API_ID", "0"))
    api_hash = os.environ.get("API_HASH", "")
    if not api_id or not api_hash:
        print("请设置环境变量 API_ID / API_HASH（在 my.telegram.org 申请）", file=sys.stderr)
        sys.exit(1)

    if args.mode == "forward" and not args.bot_group:
        print("forward 模式需指定 --bot-group（bot 所在的目标群 ID）", file=sys.stderr)
        sys.exit(1)
    if args.mode == "upload" and (not args.worker or not args.api_key):
        print("upload 模式需指定 --worker 和 --api-key", file=sys.stderr)
        sys.exit(1)

    state_file = "state_" + os.path.basename(args.session) + ".json"
    state = load_state(state_file)
    processed = set(state.get("processed", []))

    boundary = args.start_id or (state.get("last_id") or 0)
    if boundary:
        print(f"续传：跳过已处理（message id >= {boundary}），继续向更早翻")

    async with TelegramClient(args.session, api_id, api_hash) as client:
        await client.start()
        if not await client.is_user_authorized():
            print("登录失败，请重试", file=sys.stderr)
            sys.exit(1)

        chat = await client.get_entity(args.chat)
        bot_group = None
        if args.mode == "forward":
            try:
                bot_group = await client.get_entity(args.bot_group)
            except Exception as e:
                print(f"无法找到目标群 {args.bot_group}: {e}", file=sys.stderr)
                sys.exit(1)
            print(f"转发模式：{getattr(chat, 'title', args.chat)} → {getattr(bot_group, 'title', args.bot_group)}")
        else:
            print(f"上传模式：{getattr(chat, 'title', args.chat)} → {args.worker}")

        count = 0
        skipped_large = state.get("skipped_large", 0)

        # 手动迭代（非 async for），支持 FloodWait 后重试同一条消息
        it = client.iter_messages(chat, reverse=False, wait_time=ITER_WAIT)
        done = False
        while not done:
            try:
                msg = await it.__anext__()
            except StopAsyncIteration:
                break
            except Exception:
                break

            if boundary and msg.id >= boundary:
                continue
            if msg.id in processed:
                continue
            if not msg.media or not isinstance(msg.media, MessageMediaPhoto):
                continue
            if count >= args.limit and args.limit > 0:
                break

            size = getattr(getattr(msg.media, "photo", None), "size", 0) or 0
            if size > args.max_size or size <= 0:
                if size > args.max_size:
                    skipped_large += 1
                processed.add(msg.id)
                save_state(state_file, state)
                continue

            if args.dry_run:
                caption = (msg.message or "").splitlines()[0] if msg.message else ""
                print(f"  [dry] #{msg.id} size={size} {caption[:40]}")
                count += 1
                processed.add(msg.id)
                if msg.id and (not state.get("last_id") or msg.id < state.get("last_id")):
                    state["last_id"] = msg.id
                state["processed"] = sorted(processed)[-5000:]
                state["skipped_large"] = skipped_large
                save_state(state_file, state)
                continue

            if args.mode == "forward":
                retry = True
                while retry:
                    try:
                        await client.forward_messages(bot_group, msg, chat)
                        print(f"  ✓ #{msg.id} forwarded")
                        retry = False
                    except FloodWaitError as e:
                        print(f"  风控暂停 {e.seconds}s，重试 #{msg.id}", file=sys.stderr)
                        await asyncio.sleep(e.seconds + 1)
                        # 重试同一条，不 break
                    except (ChatWriteForbiddenError, InputUserDeactivatedError) as e:
                        print(f"  目标群不可写: {e}", file=sys.stderr)
                        sys.exit(1)
                    except Exception as e:
                        print(f"  转发失败 #{msg.id}: {e}", file=sys.stderr)
                        time.sleep(5)
                        retry = False
                await asyncio.sleep(FORWARD_DELAY)
            else:
                try:
                    data = await msg.download_media(file=bytes)
                except Exception as e:
                    print(f"  下载失败 #{msg.id}: {e}", file=sys.stderr)
                    time.sleep(5)
                    continue
                if not data:
                    continue
                if len(data) > args.max_size:
                    skipped_large += 1
                    print(f"  跳过 #{msg.id}: {len(data)}B 超限", file=sys.stderr)
                    processed.add(msg.id)
                    save_state(state_file, state)
                    continue
                await asyncio.sleep(WORK_DELAY)

                caption = (msg.message or "").splitlines()[0] if msg.message else ""
                title = (args.title_prefix + " " + caption).strip()[:200]
                params = {"api_key": args.api_key, "tags": args.tags, "title": title, "level": args.level}
                if args.pool:
                    params["pool"] = "1"
                try:
                    import httpx
                    async with httpx.AsyncClient(timeout=60) as hc:
                        r = await hc.post(
                            args.worker.rstrip("/") + "/api/v1/upload",
                            params=params,
                            files={"file": (f"history_{msg.id}.jpg", data, "image/jpeg")}
                        )
                    if r.status_code != 200:
                        print(f"  上传失败 #{msg.id}: HTTP {r.status_code}", file=sys.stderr)
                        if r.status_code in (429, 500, 502, 503):
                            time.sleep(10)
                        continue
                    print(f"  ✓ #{msg.id} uploaded {len(data)}B")
                except Exception as e:
                    print(f"  上传异常 #{msg.id}: {e}", file=sys.stderr)
                    time.sleep(5)
                    continue
                await asyncio.sleep(FORWARD_DELAY)

            count += 1
            processed.add(msg.id)
            if msg.id and (not state.get("last_id") or msg.id < state.get("last_id")):
                state["last_id"] = msg.id
            state["processed"] = sorted(processed)[-5000:]
            state["skipped_large"] = skipped_large
            save_state(state_file, state)

            if count % BATCH_SIZE == 0:
                print(f"  已处理 {count} 张，休息 {BATCH_SLEEP}s…")
                await asyncio.sleep(BATCH_SLEEP)

        state["processed"] = sorted(processed)[-5000:]
        state["skipped_large"] = skipped_large
        save_state(state_file, state)
        print(f"完成：本次 {count} 张，超限跳过 {skipped_large} 张")


if __name__ == "__main__":
    asyncio.run(main())
