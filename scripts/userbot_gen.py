#!/usr/bin/env python3
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
        subprocess.check_call([sys.executable, "-m", "pip", "install", "telethon", "-q"])
        print("telethon 安装完成\n")


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
