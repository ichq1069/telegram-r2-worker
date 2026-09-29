# 抓取中转 relay

`relay/`：独立 Python 服务，替 Worker 下载图片并上传到 Telegram，避开 256MB 内存。

## 运行

```bash
pip3 install --break-system-packages aiohttp
python3 relay/relay.py
```

或 `relay/docker-compose.yml`：镜像 `picwall-relay`，端口 18088，`API_KEY` 环境变量。

## 接口

`POST /relay/grab`

Body：`url`、`chat_id`、`bot_token`、`caption`、`as_photo`，以及可选 referer/cookie。

成功：`ok`、`file_id`、`message_id`、`file_size`、`mime_type`。

鉴权：请求带与 `API_KEY` 一致的密钥（实现见 `relay.py`）。Worker 侧 `src/public.js` `grabViaRelay` 使用 `RELAY_URL` + `RELAY_KEY`。

上限 50MB，下载/上传超时 120s，并发 10。
