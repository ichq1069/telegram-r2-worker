#!/usr/bin/env python3
"""
PicWall 轻量中转服务器
功能：接收图片 URL → 下载 → 上传到 Telegram Bot → 返回 file_id
解决 Worker 256MB 内存限制问题

部署：
  pip3 install aiohttp
  python3 relay.py

  # 或用 systemd / screen / pm2 守护
  # 端口默认 18088，可通过 PORT 环境变量修改
  # API_KEY 环境变量设置鉴权密钥

接口：
  POST /relay/grab
  Body: { "url": "...", "chat_id": "...", "bot_token": "...", "caption": "...", "as_photo": true }
  Response: { "ok": true, "file_id": "...", "message_id": 123, "file_size": 12345, "mime_type": "image/jpeg" }
"""

import os
import sys
import json
import asyncio
import logging
import mimetypes
import re
from pathlib import Path
from urllib.parse import urlparse

import aiohttp
from aiohttp import web

# ========== 配置 ==========
PORT = int(os.environ.get('PORT', '18088'))
API_KEY = os.environ.get('API_KEY', 'teleup2026')
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB 上限
DOWNLOAD_TIMEOUT = 120  # 下载超时（秒）
TELEGRAM_TIMEOUT = 120  # Telegram 上传超时（秒）
MAX_CONCURRENT = 10  # 最大并发下载数

# ========== 日志 ==========
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
log = logging.getLogger('relay')

# ========== 并发控制 ==========
semaphore = None  # asyncio.Semaphore, 在 start 时初始化

# ========== 工具函数 ==========
def guess_ext(url, content_type):
    """从 URL 或 content-type 推断扩展名"""
    try:
        path = urlparse(url).path
        ext = path.rsplit('.', 1)[-1].lower() if '.' in path else ''
        if ext and len(ext) <= 5 and ext.isalnum():
            return ext
    except Exception:
        pass
    ct = (content_type or '').split(';')[0].strip().lower()
    ext_map = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
        'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp',
        'video/mp4': 'mp4', 'video/webm': 'webm',
    }
    return ext_map.get(ct, 'jpg')


def is_image_or_video(ct):
    """判断是否为图片或视频类型"""
    return ct and (ct.startswith('image/') or ct.startswith('video/'))


def extract_xhs_note_id(url):
    """从小红书短链或笔记页 URL 中提取 note ID"""
    try:
        # xhslink.cn/o/xxx
        m = re.search(r'xhslink\.cn/[a-z]/{1}([^/?]+)', url)
        if m:
            return m.group(1)
        # xiaohongshu.com/explore/xxx 或 discovery/item/xxx
        m = re.search(r'xiaohongshu\.com/(?:explore|discovery/item)/([a-f0-9]+)', url)
        if m:
            return m.group(1)
    except Exception:
        pass
    return None


async def resolve_xhs_url(session, url, cookie=''):
    """解析小红书短链，返回笔记页 URL"""
    if not re.search(r'xhslink\.cn|xiaohongshu\.com', url, re.I):
        return url
    headers = {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://www.xiaohongshu.com/',
    }
    if cookie:
        headers['Cookie'] = cookie
    try:
        async with session.get(url, headers=headers, allow_redirects=False, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            # 处理 302 重定向
            if resp.status == 302:
                loc = resp.headers.get('Location', '')
                if loc and 'xiaohongshu.com' in loc:
                    # 从重定向 URL 提取 note_id
                    m = re.search(r'/(?:explore|discovery/item)/([a-f0-9]+)', loc)
                    if m:
                        note_id = m.group(1)
                        return f'https://www.xiaohongshu.com/explore/{note_id}'
                    return loc
                return url
            if resp.status != 200:
                return url
            text = await resp.text()
            # 从 __INITIAL_STATE__ 中提取最终 URL
            m = re.search(r'"noteDetailCard":\{"noteId":"([^"]+)"', text)
            if m:
                note_id = m.group(1)
                return f'https://www.xiaohongshu.com/explore/{note_id}'
            # 从 HTML 中提取 xiaohongshu.com URL
            m = re.search(r'https?://www\.xiaohongshu\.com/(?:explore|discovery/item)/([a-f0-9]+)', text)
            if m:
                return f'https://www.xiaohongshu.com/explore/{m.group(1)}'
            return url
    except Exception:
        return url


async def extract_xhs_images(session, note_url, cookie=''):
    """从笔记页提取图片 URL 列表"""
    images = []
    ua_mobile = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
    ua_desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    base_headers = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://www.xiaohongshu.com/',
    }
    if cookie:
        base_headers['Cookie'] = cookie

    # 尝试多种 UA 组合
    for ua in [ua_mobile, ua_desktop, ua_mobile.replace('iPhone', 'Android')]:
        headers = {**base_headers, 'User-Agent': ua}
        try:
            async with session.get(note_url, headers=headers, allow_redirects=True, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status != 200:
                    continue
                text = await resp.text()
                if not text or len(text) < 1000:
                    continue
                # 从 __INITIAL_STATE__ 提取图片
                m = re.search(r'__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*</script>', text)
                if m:
                    try:
                        data = json.loads(m[1].replace('undefined', 'null'))
                        note_data = (data.get('noteData') or {}).get('data') or {}
                        image_list = note_data.get('noteData', {}).get('imageList', [])
                        for img in image_list:
                            if img and img.get('url'):
                                images.append(img['url'])
                            if img and img.get('urlSizeLarge'):
                                images.append(img['urlSizeLarge'])
                        if images:
                            break
                    except Exception:
                        pass
        except Exception:
            continue

    # 备用：从 HTML 中直接匹配图片 URL
    if not images:
        for ua in [ua_mobile, ua_desktop]:
            headers = {**base_headers, 'User-Agent': ua}
            try:
                async with session.get(note_url, headers=headers, allow_redirects=True, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    if resp.status != 200:
                        continue
                    text = await resp.text()
                    # 匹配 sns-webpic-qc.xhscdn.com 或 ci.xiaohongshu.com
                    urls = re.findall(r'https?://[^"\s<>]+(?:xhscdn\.com|xiaohongshu\.com/[^"\s<>]+(?:image|photo)[^"\s<>]*)', text)
                    for u in urls:
                        if u not in images:
                            images.append(u)
                    if images:
                        break
            except Exception:
                continue

    return images[:10]  # 最多返回 10 张

# ========== 核心逻辑 ==========
async def grab_and_send(url, chat_id, bot_token, caption, as_photo, referer, cookie):
    """下载图片 + 上传到 Telegram，返回 { ok, file_id, message_id, file_size, mime_type }"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
    if referer:
        headers['Referer'] = referer
    if cookie:
        headers['Cookie'] = cookie[:8000]

    async with semaphore:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=DOWNLOAD_TIMEOUT)) as session:
            # ---- 小红书短链解析 ----
            if re.search(r'xhslink\.cn|xiaohongshu\.com', url, re.I):
                # 先解析短链
                note_url = await resolve_xhs_url(session, url, cookie)
                # 提取图片列表
                image_urls = await extract_xhs_images(session, note_url, cookie)
                if not image_urls:
                    # 无法提取图片，尝试直接访问短链（可能有 cookie）
                    log.info('无法从小红书页面提取图片，尝试直接下载')
                    # 不返回错误，继续尝试下载原始 URL
                else:
                    url = image_urls[0]
                    log.info(f'小红书笔记解析: {len(image_urls)} 张图片，上传第 1 张: {url[:100]}')

            # ---- 下载 ----
            log.info(f'下载: {url[:120]}')
            try:
                async with session.get(url, headers=headers, allow_redirects=True) as resp:
                    if resp.status != 200:
                        return {'ok': False, 'error': f'下载失败 HTTP {resp.status}'}
                    ct = (resp.content_type or '').split(';')[0].strip().lower()
                    cl = int(resp.headers.get('Content-Length', '0'))
                    if cl > MAX_FILE_SIZE:
                        return {'ok': False, 'error': f'文件过大 {cl / 1048576:.1f}MB > {MAX_FILE_SIZE / 1048576}MB'}
                    if not is_image_or_video(ct):
                        return {'ok': False, 'error': f'非图片/视频格式: {ct}'}
                    data = await resp.read()
            except asyncio.TimeoutError:
                return {'ok': False, 'error': '下载超时'}
            except Exception as e:
                return {'ok': False, 'error': f'下载异常: {e}'}

            if len(data) > MAX_FILE_SIZE:
                return {'ok': False, 'error': f'文件过大 {len(data) / 1048576:.1f}MB'}
            if len(data) == 0:
                return {'ok': False, 'error': '空响应'}

            file_size = len(data)
            mime_type = ct or 'image/jpeg'
            ext = guess_ext(url, mime_type)
            filename = f'image.{ext}'

            # ---- 上传到 Telegram ----
            tg_endpoint = 'sendPhoto' if as_photo else 'sendDocument'
            tg_field = 'photo' if as_photo else 'document'

            form = aiohttp.FormData()
            form.add_field('chat_id', str(chat_id))
            form.add_field(tg_field, data, filename=filename, content_type=mime_type)
            if caption:
                form.add_field('caption', str(caption)[:1024])

            tg_url = f'https://api.telegram.org/bot{bot_token}/{tg_endpoint}'
            log.info(f'上传到 Telegram: {tg_endpoint}, {file_size / 1024:.0f}KB')

            try:
                async with session.post(tg_url, data=form, timeout=aiohttp.ClientTimeout(total=TELEGRAM_TIMEOUT)) as tg_resp:
                    tg_json = await tg_resp.json()
            except asyncio.TimeoutError:
                return {'ok': False, 'error': 'Telegram 上传超时'}
            except Exception as e:
                return {'ok': False, 'error': f'Telegram 上传异常: {e}'}

            if not tg_json.get('ok'):
                desc = tg_json.get('description', 'unknown error')
                return {'ok': False, 'error': f'Telegram: {desc}'}

            result = tg_json.get('result', {})
            med = result.get('photo') if as_photo else result.get('document')
            file_id = ''
            if as_photo and isinstance(med, list) and med:
                file_id = med[-1].get('file_id', '')
            elif isinstance(med, dict):
                file_id = med.get('file_id', '')

            if not file_id:
                return {'ok': False, 'error': 'Telegram 未返回 file_id'}

            return {
                'ok': True,
                'file_id': file_id,
                'message_id': result.get('message_id', 0),
                'file_size': file_size,
                'mime_type': mime_type,
                'chat_id': str(result.get('chat', {}).get('id', chat_id)),
            }

# ========== HTTP 处理 ==========
async def handle_grab(request):
    """POST /relay/grab"""
    # 鉴权
    if API_KEY:
        auth = request.headers.get('Authorization', '')
        req_key = request.query.get('api_key', '')
        if auth != f'Bearer {API_KEY}' and req_key != API_KEY:
            return web.json_response({'ok': False, 'error': 'Unauthorized'}, status=401)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({'ok': False, 'error': 'Invalid JSON'}, status=400)

    url = (body.get('url') or '').strip()
    chat_id = (body.get('chat_id') or '').strip()
    bot_token = (body.get('bot_token') or '').strip()

    if not url or not url.startswith(('http://', 'https://')):
        return web.json_response({'ok': False, 'error': 'url required (http/https)'}, status=400)
    if not chat_id:
        return web.json_response({'ok': False, 'error': 'chat_id required'}, status=400)
    if not bot_token:
        return web.json_response({'ok': False, 'error': 'bot_token required'}, status=400)

    caption = (body.get('caption') or '').strip()
    as_photo = bool(body.get('as_photo', True))
    referer = (body.get('referer') or '').strip()
    cookie = (body.get('cookie') or '').strip()

    result = await grab_and_send(url, chat_id, bot_token, caption, as_photo, referer, cookie)
    status = 200 if result.get('ok') else 502
    return web.json_response(result, status=status)


async def handle_health(request):
    """GET /relay/health"""
    return web.json_response({
        'ok': True,
        'service': 'picwall-relay',
        'max_concurrent': MAX_CONCURRENT,
        'active': MAX_CONCURRENT - semaphore._value if semaphore else 0,
    })


async def handle_index(request):
    """GET /"""
    return web.json_response({
        'service': 'picwall-relay',
        'endpoints': {
            'POST /relay/grab': '下载图片并上传到 Telegram',
            'GET /relay/health': '健康检查',
        }
    })

# ========== 启动 ==========
def main():
    global semaphore
    semaphore = asyncio.Semaphore(MAX_CONCURRENT)

    app = web.Application()
    app.router.add_get('/', handle_index)
    app.router.add_get('/relay/health', handle_health)
    app.router.add_post('/relay/grab', handle_grab)
    # 兼容无 /relay 前缀
    app.router.add_post('/grab', handle_grab)
    app.router.add_get('/health', handle_health)

    log.info(f'PicWall Relay 启动: port={PORT}, max_concurrent={MAX_CONCURRENT}, auth={"on" if API_KEY else "off"}')
    web.run_app(app, host='0.0.0.0', port=PORT, print=None)


if __name__ == '__main__':
    main()
