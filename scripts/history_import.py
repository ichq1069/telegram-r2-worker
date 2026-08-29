#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回填群历史图片到 Telegram R2 Worker 图库

在本地机器运行（用户会话走 MTProto，能翻 bot 进群前的历史）：
    pip install telethon httpx

配置（环境变量或命令行）：
    API_ID=123456 API_HASH=xxxx python history_import.py --chat -100123456789

必填参数：
    --chat       群 ID（Telegram 群 ID，如 -100123456789）
    --worker     图库 Worker 域名，如 https://your-worker.example.workers.dev
    --api-key    图库后台生成的 api_key（/admin 里创建）

限速与防封号说明：
    - 翻消息 iter_messages 间隔 wait_time
    - 每张下载/上传之间 sleep，降低请求频率
    - 超过 max-size 的文件跳过（图库上传上限 19MB，留余量）
    - 断点续传：已处理的 message id 记入 state.json，中断后重跑跳过已入库的
"""
import argparse
import asyncio
import json
import os
import sys
import time

import httpx
from telethon import TelegramClient
from telethon.tl.types import MessageMediaPhoto

# 图库上传接口上限（worker.js PUBLIC_UPLOAD_MAX = 19MB），留 1MB 余量
UPLOAD_MAX = 18 * 1024 * 1024
# 翻历史消息的最小间隔（秒）——防止触发 Telegram flood 风控
ITER_WAIT = 1.0
# 每张图片下载完成后、上传前的最小间隔（秒）
DOWNLOAD_DELAY = 0.5
# 每次上传完成后的最小间隔（秒）
UPLOAD_DELAY = 1.0
# 每处理 N 张后额外长休息（秒），进一步降低触发风控概率
BATCH_SIZE = 20
BATCH_SLEEP = 5.0


def load_state(state_file):
    if os.path.exists(state_file):
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"processed": [], "last_id": None, "skipped_large": 0}


def save_state(state_file, state):
    tmp = state_file + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, state_file)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chat", required=True, help="群 ID，如 -100123456789")
    ap.add_argument("--worker", required=True, help="图库 Worker 域名")
    ap.add_argument("--api-key", required=True, help="图库后台 api_key")
    ap.add_argument("--session", default="history_import", help="Telethon session 名")
    ap.add_argument("--tags", default="历史图片", help="入库 tags，逗号分隔")
    ap.add_argument("--title-prefix", default="", help="入库 title 前缀")
    ap.add_argument("--limit", type=int, default=0, help="最多处理张数，0=不限")
    ap.add_argument("--start-id", type=int, default=0, help="从某 message id 开始（跳过更大的），0=最新开始")
    ap.add_argument("--pool", action="store_true", help="进共享库（random_pool），默认进 files 表")
    ap.add_argument("--level", default="free", help="入库级别：free/member/plus/vip/vvip")
    ap.add_argument("--max-size", type=int, default=UPLOAD_MAX, help="单张最大字节数，超过跳过")
    ap.add_argument("--dry-run", action="store_true", help="只统计不上传")
    args = ap.parse_args()

    api_id = int(os.environ.get("API_ID", "0"))
    api_hash = os.environ.get("API_HASH", "")
    if not api_id or not api_hash:
        print("请设置环境变量 API_ID / API_HASH（在 my.telegram.org 申请）", file=sys.stderr)
        sys.exit(1)

    state_file = "state_" + os.path.basename(args.session) + ".json"
    state = load_state(state_file)
    processed = set(state.get("processed", []))

    # 断点续传：last_id = 已处理的最旧 message id；边界以上（更新的）都已入库，跳过
    boundary = args.start_id or (state.get("last_id") or 0)
    if boundary:
        print(f"续传：跳过已处理（message id >= {boundary}），继续向更早翻")

    async with TelegramClient(args.session, api_id, api_hash) as client:
        await client.start()
        if not await client.is_user_authorized():
            print("登录失败，请重试", file=sys.stderr)
            sys.exit(1)

        async def upload_one(data_bytes, caption, msg_id, msg_date):
            title = (args.title_prefix + " " + caption).strip()[:200]
            params = {"api_key": args.api_key, "tags": args.tags, "title": title, "level": args.level}
            if args.pool:
                params["pool"] = "1"
            files = {"file": (f"history_{msg_id}.jpg", data_bytes, "image/jpeg")}
            async with httpx.AsyncClient(timeout=60) as hc:
                r = await hc.post(args.worker.rstrip("/") + "/api/v1/upload", params=params, files=files)
            return r

        chat = await client.get_entity(args.chat)
        print(f"开始回填 {getattr(chat, 'title', args.chat)} 的历史图片…")
        count = 0
        skipped_large = state.get("skipped_large", 0)

        async for msg in client.iter_messages(chat, reverse=False, wait_time=ITER_WAIT):
            # 边界以上（更新的）已处理过，跳过；翻到最旧自然结束
            if boundary and msg.id >= boundary:
                continue
            if msg.id in processed:
                continue
            if not msg.media or not isinstance(msg.media, MessageMediaPhoto):
                continue
            if count >= args.limit and args.limit > 0:
                break

            # 文件大小预检：超过上限则跳过（不阻塞回填）
            size = getattr(getattr(msg.media, "photo", None), "size", 0) or 0
            if size > args.max_size or size <= 0:
                if size > args.max_size:
                    skipped_large += 1
                print(f"  跳过 #{msg.id}: 大小 {size} 超出限制", file=sys.stderr)
                processed.add(msg.id)
                save_state(state_file, state)
                continue

            caption = (msg.message or "").splitlines()[0] if msg.message else ""
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
                print(f"  跳过 #{msg.id}: 实际 {len(data)}B 超出限制", file=sys.stderr)
                processed.add(msg.id)
                save_state(state_file, state)
                continue
            await asyncio.sleep(DOWNLOAD_DELAY)

            if args.dry_run:
                print(f"  [dry] #{msg.id} {len(data)}B {caption[:40]}")
            else:
                try:
                    r = await upload_one(data, caption, msg.id, msg.date)
                    if r.status_code != 200:
                        print(f"  上传失败 #{msg.id}: HTTP {r.status_code} {r.text[:200]}", file=sys.stderr)
                        if r.status_code in (429, 500, 502, 503):
                            time.sleep(10)
                        continue
                    print(f"  ✓ #{msg.id} {len(data)}B {caption[:40]}")
                except Exception as e:
                    print(f"  上传异常 #{msg.id}: {e}", file=sys.stderr)
                    time.sleep(5)
                    continue
                await asyncio.sleep(UPLOAD_DELAY)

            count += 1
            processed.add(msg.id)
            # last_id 始终记录"当前翻到的最旧已处理边界"
            if msg.id and (not state.get("last_id") or msg.id < state.get("last_id")):
                state["last_id"] = msg.id
            state["processed"] = sorted(processed)[-5000:]  # 仅保留最近 5000 条防止文件膨胀
            state["skipped_large"] = skipped_large
            save_state(state_file, state)

            if count % BATCH_SIZE == 0:
                print(f"  已处理 {count} 张，休息 {BATCH_SLEEP}s…")
                await asyncio.sleep(BATCH_SLEEP)

        state["processed"] = sorted(processed)[-5000:]
        state["skipped_large"] = skipped_large
        save_state(state_file, state)
        print(f"完成：本次回填 {count} 张，因超限跳过 {skipped_large} 张")


if __name__ == "__main__":
    asyncio.run(main())
