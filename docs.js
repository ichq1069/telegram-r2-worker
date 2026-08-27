// ==================== API 文档 ====================

function handleDocs() {
  return new Response(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>API 文档 - TG Bot R2</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0f172a;color:#e2e8f0}
.hd{background:linear-gradient(135deg,#1e3a5f,#0f172a);padding:30px;text-align:center;border-bottom:1px solid #1e293b}
.hd h1{font-size:26px;margin-bottom:6px}.hd p{color:#94a3b8}
.ct{max-width:880px;margin:0 auto;padding:25px 20px}
.auth{background:#78350f;border:1px solid #92400e;border-radius:10px;padding:18px;margin-bottom:25px}
.auth h3{color:#fbbf24;margin-bottom:8px}.auth p{color:#fcd34d;font-size:14px;margin:4px 0}
.auth code{background:#92400e;padding:2px 8px;border-radius:3px;color:#fff}
.sec h2{font-size:18px;color:#60a5fa;margin:25px 0 15px;padding-bottom:8px;border-bottom:1px solid #1e293b}
.ac{background:#1e293b;border-radius:8px;padding:16px;border:1px solid #334155;margin-bottom:12px}
.ah{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.m{padding:3px 10px;border-radius:4px;font-size:12px;font-weight:700}
.m.get{background:#166534;color:#86efac}.m.post{background:#1e3a5f;color:#93c5fd}
.pp{font-family:monospace;font-size:14px;color:#f1f5f9}
.tg{padding:2px 8px;border-radius:4px;font-size:11px}
.tp{background:#166534;color:#86efac}.ta{background:#78350f;color:#fcd34d}
.ad{color:#94a3b8;font-size:13px;margin:8px 0}
.pt{margin-top:8px}.pt table{width:100%;border-collapse:collapse;font-size:12px}
.pt th{text-align:left;color:#94a3b8;padding:5px 8px;border-bottom:1px solid #334155}
.pt td{padding:5px 8px;border-bottom:1px solid #1e293b}
.pt code{background:#334155;padding:1px 5px;border-radius:3px;font-size:11px;color:#fbbf24}
.cd{font-family:monospace;font-size:12px;background:#0f172a;padding:12px;border-radius:6px;margin-top:10px;overflow-x:auto;white-space:pre;line-height:1.6}
.cd.g{color:#86efac}.cd.b{color:#93c5fd}
</style></head><body>
<div class="hd"><h1>Telegram R2 Bot API</h1><p>R2 + D1 永久存储 - 接口文档</p></div>
<div class="ct">
<div class="auth"><h3>认证方式</h3><p>所有需认证接口必须携带 API Key：</p><p>方式一: <code>X-API-Key: your_api_key</code></p><p>方式二: <code>?api_key=your_api_key</code></p></div>

<div class="sec"><h2>接口列表</h2>

<div class="ac"><div class="ah"><span class="m get">GET</span><span class="pp">/health</span><span class="tg tp">公开</span></div><div class="ad">健康检查，无需认证</div>
<div class="cd g">{"ok":true,"time":"2026-08-23T...","version":"v5"}</div></div>

<div class="ac"><div class="ah"><span class="m get">GET</span><span class="pp">/api/files</span><span class="tg ta">需认证</span></div><div class="ad">文件列表 - 支持分页和多条件筛选</div>
<div class="pt"><table><tr><th>参数</th><th>类型</th><th>必填</th><th>说明</th></tr>
<tr><td><code>page</code></td><td>int</td><td>否</td><td>页码, 默认 1</td></tr>
<tr><td><code>page_size</code></td><td>int</td><td>否</td><td>每页数量, 默认 20, 最大 100</td></tr>
<tr><td><code>type</code></td><td>string</td><td>否</td><td>photo / document / video / audio</td></tr>
<tr><td><code>chat_id</code></td><td>string</td><td>否</td><td>群组 ID</td></tr>
<tr><td><code>user_id</code></td><td>int</td><td>否</td><td>用户 ID</td></tr>
<tr><td><code>keyword</code></td><td>string</td><td>否</td><td>搜索关键词(匹配文件名/说明/群组名/用户名)</td></tr>
<tr><td><code>start_date</code></td><td>string</td><td>否</td><td>开始日期 2026-08-01</td></tr>
<tr><td><code>end_date</code></td><td>string</td><td>否</td><td>结束日期 2026-08-31</td></tr>
</table></div></div>

<div class="ac"><div class="ah"><span class="m get">GET</span><span class="pp">/api/file?id=1</span><span class="tg ta">需认证</span></div><div class="ad">单个文件详情</div>
<div class="pt"><table><tr><th>参数</th><th>类型</th><th>说明</th></tr>
<tr><td><code>id</code></td><td>int</td><td>文件 ID (与 url 二选一)</td></tr>
<tr><td><code>url</code></td><td>string</td><td>文件直链 (与 id 二选一)</td></tr>
</table></div></div>

<div class="ac"><div class="ah"><span class="m get">GET</span><span class="pp">/api/stats</span><span class="tg ta">需认证</span></div><div class="ad">统计信息 - 总文件数/存储大小/今日上传/按类型分组/按群组分组</div></div>

<div class="ac"><div class="ah"><span class="m get">GET</span><span class="pp">/api/latest</span><span class="tg ta">需认证</span></div><div class="ad">最新文件</div>
<div class="pt"><table><tr><th>参数</th><th>类型</th><th>说明</th></tr>
<tr><td><code>limit</code></td><td>int</td><td>数量, 默认 10, 最大 50</td></tr>
<tr><td><code>type</code></td><td>string</td><td>类型筛选</td></tr>
</table></div></div>

<div class="ac"><div class="ah"><span class="m get">GET</span><span class="pp">/api/search?q=xxx</span><span class="tg ta">需认证</span></div><div class="ad">搜索文件 (匹配文件名/说明/群组名/用户名/姓名)</div>
<div class="pt"><table><tr><th>参数</th><th>类型</th><th>必填</th><th>说明</th></tr>
<tr><td><code>q</code></td><td>string</td><td>是</td><td>搜索关键词</td></tr>
<tr><td><code>page</code></td><td>int</td><td>否</td><td>页码</td></tr>
<tr><td><code>page_size</code></td><td>int</td><td>否</td><td>每页数量</td></tr>
</table></div></div>

<div class="ac"><div class="ah"><span class="m get">GET</span><span class="pp">/api/by-chat</span><span class="tg ta">需认证</span></div><div class="ad">按群组查询</div>
<div class="pt"><table><tr><th>参数</th><th>类型</th><th>说明</th></tr>
<tr><td><code>chat_id</code></td><td>string</td><td>群组 ID</td></tr>
<tr><td><code>chat_title</code></td><td>string</td><td>群组名称(模糊匹配)</td></tr>
<tr><td><code>page</code></td><td>int</td><td>页码</td></tr>
<tr><td><code>page_size</code></td><td>int</td><td>每页数量</td></tr>
</table></div></div>

<div class="ac"><div class="ah"><span class="m get">GET</span><span class="pp">/api/by-user</span><span class="tg ta">需认证</span></div><div class="ad">按用户查询</div>
<div class="pt"><table><tr><th>参数</th><th>类型</th><th>说明</th></tr>
<tr><td><code>user_id</code></td><td>int</td><td>用户 ID</td></tr>
<tr><td><code>username</code></td><td>string</td><td>用户名(模糊匹配)</td></tr>
<tr><td><code>page</code></td><td>int</td><td>页码</td></tr>
<tr><td><code>page_size</code></td><td>int</td><td>每页数量</td></tr>
</table></div></div>

<div class="ac"><div class="ah"><span class="m get">GET</span><span class="pp">/api/by-date?date=2026-08-23</span><span class="tg ta">需认证</span></div><div class="ad">按日期查询</div>
<div class="pt"><table><tr><th>参数</th><th>类型</th><th>必填</th><th>说明</th></tr>
<tr><td><code>date</code></td><td>string</td><td>是</td><td>日期 2026-08-23</td></tr>
<tr><td><code>page</code></td><td>int</td><td>否</td><td>页码</td></tr>
<tr><td><code>page_size</code></td><td>int</td><td>否</td><td>每页数量</td></tr>
</table></div></div>

<div class="ac"><div class="ah"><span class="m get">GET</span><span class="pp">/api/stream?id=1</span><span class="tg ta">需认证</span></div><div class="ad">获取文件流 - 直接返回文件二进制数据</div></div>

<div class="ac"><div class="ah"><span class="m post">POST</span><span class="pp">/webhook</span><span class="tg tp">公开</span></div><div class="ad">Telegram Webhook 回调 (Telegram 自动调用)</div></div>
<div class="ac"><div class="ah"><span class="m get">GET</span><span class="pp">/dashboard</span><span class="tg tp">公开</span></div><div class="ad">监控面板</div></div>
<div class="ac"><div class="ah"><span class="m get">GET</span><span class="pp">/docs</span><span class="tg tp">公开</span></div><div class="ad">API 文档 (当前页面)</div></div>
</div>

<div class="sec"><h2>返回格式</h2><div class="ac"><div class="cd g">{
  "ok": true,
  "data": {
    "total": 100, "page": 1, "page_size": 20, "total_pages": 5,
    "items": [{
      "id": 1,
      "r2_url": "https://telegramup.wo58.cn/2026/08/abc.jpg",
      "file_name": "photo.jpg",
      "file_type": "photo",
      "file_size": 1024000,
      "chat_title": "群组名",
      "username": "user123",
      "created_at": "2026-08-23T10:30:00.000Z"
    }]
  }
}</div></div></div>

<div class="sec"><h2>对接示例</h2>
<div class="ac"><h4 style="color:#94a3b8;font-size:13px;margin-bottom:8px">JavaScript</h4>
<div class="cd b">const API = 'https://telegram-r2-bot.wo58.cn';
const KEY = 'your_api_key';

const res = await fetch(API + '/api/latest?type=photo&limit=10', {
  headers: { 'X-API-Key': KEY }
});
const { ok, data } = await res.json();
if (ok) data.forEach(f => console.log(f.file_name, f.r2_url));</div></div>

<div class="ac"><h4 style="color:#94a3b8;font-size:13px;margin-bottom:8px">Python</h4>
<div class="cd b">import requests

API = 'https://telegram-r2-bot.wo58.cn'
KEY = 'your_api_key'

resp = requests.get(f'{API}/api/latest',
    headers={'X-API-Key': KEY},
    params={'limit': 10, 'type': 'photo'})
for f in resp.json()['data']:
    print(f['file_name'], f['r2_url'])</div></div>

<div class="ac"><h4 style="color:#94a3b8;font-size:13px;margin-bottom:8px">cURL</h4>
<div class="cd b">curl -H "X-API-Key: your_api_key" \
  "https://telegram-r2-bot.wo58.cn/api/files?type=photo&page=1&page_size=10"</div></div>
</div>
</div></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ==================== 监控面板 ====================
