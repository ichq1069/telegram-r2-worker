/**
 * 监控面板页面
 */
import { jsonResponse } from '../utils/response.js';

export function handleDashboard(request, env) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Telegram Bot 监控面板</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    .header { background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%); padding: 20px 30px; border-bottom: 1px solid #1e293b; }
    .header h1 { font-size: 24px; font-weight: 600; }
    .header p { color: #94a3b8; margin-top: 5px; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
    .card-title { font-size: 14px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 15px; }
    .stat-value { font-size: 32px; font-weight: 700; color: #60a5fa; }
    .stat-label { font-size: 12px; color: #64748b; margin-top: 5px; }
    .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; }
    .status-item { display: flex; align-items: center; gap: 12px; padding: 15px; background: #0f172a; border-radius: 8px; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .status-dot.ok { background: #22c55e; box-shadow: 0 0 8px #22c55e80; }
    .status-dot.error { background: #ef4444; box-shadow: 0 0 8px #ef444480; }
    .status-dot.loading { background: #f59e0b; animation: pulse 1s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .status-info h3 { font-size: 14px; font-weight: 500; }
    .status-info p { font-size: 12px; color: #64748b; margin-top: 2px; }
    .api-list { list-style: none; }
    .api-list li { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #334155; }
    .api-list li:last-child { border-bottom: none; }
    .api-method { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .api-method.get { background: #166534; color: #86efac; }
    .api-method.post { background: #1e3a5f; color: #93c5fd; }
    .api-path { font-family: monospace; font-size: 13px; color: #e2e8f0; }
    .api-status { font-size: 12px; padding: 4px 10px; border-radius: 12px; }
    .api-status.ok { background: #166534; color: #86efac; }
    .api-status.error { background: #7f1d1d; color: #fca5a5; }
    .api-status.pending { background: #78350f; color: #fcd34d; }
    .refresh-btn { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; }
    .refresh-btn:hover { background: #2563eb; }
    .refresh-btn:disabled { background: #475569; cursor: not-allowed; }
    .section-title { font-size: 18px; font-weight: 600; margin-bottom: 15px; display: flex; align-items: center; gap: 10px; }
    .logs { background: #0f172a; border-radius: 8px; padding: 15px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 12px; line-height: 1.8; }
    .log-entry { color: #94a3b8; }
    .log-entry.success { color: #22c55e; }
    .log-entry.error { color: #ef4444; }
    .log-time { color: #475569; }
  </style>
</head>
<body>
  <div class="header">
    <h1>📡 Telegram Bot 监控面板</h1>
    <p>R2 + D1 永久存储 · 实时监控</p>
  </div>

  <div class="container">
    <!-- 统计卡片 -->
    <div class="grid" id="stats-grid">
      <div class="card">
        <div class="card-title">总文件数</div>
        <div class="stat-value" id="stat-total">-</div>
        <div class="stat-label">全部存储文件</div>
      </div>
      <div class="card">
        <div class="card-title">总存储大小</div>
        <div class="stat-value" id="stat-size">-</div>
        <div class="stat-label">R2 存储占用</div>
      </div>
      <div class="card">
        <div class="card-title">今日上传</div>
        <div class="stat-value" id="stat-today">-</div>
        <div class="stat-label">今日新增文件</div>
      </div>
      <div class="card">
        <div class="card-title">本月上传</div>
        <div class="stat-value" id="stat-month">-</div>
        <div class="stat-label">本月新增文件</div>
      </div>
    </div>

    <!-- 服务状态 -->
    <div class="card" style="margin-bottom: 20px;">
      <div class="section-title">
        <span>🔍 服务状态</span>
        <button class="refresh-btn" onclick="checkAll()" id="refresh-btn">刷新检查</button>
      </div>
      <div class="status-grid" id="status-grid">
        <div class="status-item">
          <div class="status-dot loading" id="dot-health"></div>
          <div class="status-info">
            <h3>Health API</h3>
            <p id="msg-health">检查中...</p>
          </div>
        </div>
        <div class="status-item">
          <div class="status-dot loading" id="dot-d1"></div>
          <div class="status-info">
            <h3>D1 数据库</h3>
            <p id="msg-d1">检查中...</p>
          </div>
        </div>
        <div class="status-item">
          <div class="status-dot loading" id="dot-r2"></div>
          <div class="status-info">
            <h3>R2 存储</h3>
            <p id="msg-r2">检查中...</p>
          </div>
        </div>
        <div class="status-item">
          <div class="status-dot loading" id="dot-tg"></div>
          <div class="status-info">
            <h3>Telegram API</h3>
            <p id="msg-tg">检查中...</p>
          </div>
        </div>
      </div>
    </div>

    <!-- API 接口列表 -->
    <div class="card" style="margin-bottom: 20px;">
      <div class="section-title">📋 API 接口</div>
      <ul class="api-list" id="api-list"></ul>
    </div>

    <!-- 最近上传 -->
    <div class="card" style="margin-bottom: 20px;">
      <div class="section-title">📸 最近上传</div>
      <div id="recent-files" style="color: #64748b;">加载中...</div>
    </div>

    <!-- 日志 -->
    <div class="card">
      <div class="section-title">📝 检查日志</div>
      <div class="logs" id="logs"></div>
    </div>
  </div>

  <script>
    const WORKER_URL = window.location.origin;
    const API_KEY = localStorage.getItem('api_key') || prompt('请输入 API Key：');
    if (API_KEY) localStorage.setItem('api_key', API_KEY);

    const headers = { 'X-API-Key': API_KEY };
    const logs = document.getElementById('logs');

    function log(msg, type = '') {
      const time = new Date().toLocaleTimeString();
      logs.innerHTML = '<div class="log-entry ' + type + '"><span class="log-time">[' + time + ']</span> ' + msg + '</div>' + logs.innerHTML;
    }

    function setStatus(name, ok, msg) {
      const dot = document.getElementById('dot-' + name);
      const msgEl = document.getElementById('msg-' + name);
      dot.className = 'status-dot ' + (ok ? 'ok' : 'error');
      msgEl.textContent = msg;
    }

    // API 接口列表
    const apis = [
      { method: 'GET', path: '/health', desc: '健康检查（无需认证）' },
      { method: 'GET', path: '/api/files', desc: '文件列表（分页筛选）' },
      { method: 'GET', path: '/api/file?id=1', desc: '文件详情' },
      { method: 'GET', path: '/api/stats', desc: '统计信息' },
      { method: 'GET', path: '/api/latest', desc: '最新文件' },
      { method: 'GET', path: '/api/search?q=xxx', desc: '搜索文件' },
      { method: 'GET', path: '/api/by-chat', desc: '按群组查询' },
      { method: 'GET', path: '/api/by-user', desc: '按用户查询' },
      { method: 'GET', path: '/api/by-date?date=2026-08-23', desc: '按日期查询' },
      { method: 'GET', path: '/api/stream?id=1', desc: '文件流' },
      { method: 'POST', path: '/webhook', desc: 'Telegram 回调' },
    ];

    function renderApiList() {
      const list = document.getElementById('api-list');
      list.innerHTML = apis.map(api => 
        '<li>' +
          '<div><span class="api-method ' + api.method.toLowerCase() + '">' + api.method + '</span> <span class="api-path">' + api.path + '</span></div>' +
          '<div><span style="color:#64748b;font-size:12px;margin-right:10px;">' + api.desc + '</span><span class="api-status pending" id="api-status-' + api.path.replace(/[^a-zA-Z]/g, '') + '">待检测</span></div>' +
        '</li>'
      ).join('');
    }

    async function checkApi(method, path, name) {
      const statusEl = document.getElementById('api-status-' + path.replace(/[^a-zA-Z]/g, ''));
      try {
        const opts = { method, headers };
        if (method === 'POST') {
          opts.body = '{}';
          opts.headers = { ...headers, 'Content-Type': 'application/json' };
        }
        const resp = await fetch(WORKER_URL + path, opts);
        const data = await resp.json();
        if (statusEl) {
          statusEl.textContent = resp.status + ' ' + (data.ok ? 'OK' : 'Error');
          statusEl.className = 'api-status ' + (resp.ok ? 'ok' : 'error');
        }
        log(method + ' ' + path + ' → ' + resp.status, resp.ok ? 'success' : 'error');
        return resp.ok;
      } catch (e) {
        if (statusEl) {
          statusEl.textContent = 'Error';
          statusEl.className = 'api-status error';
        }
        log(method + ' ' + path + ' → ' + e.message, 'error');
        return false;
      }
    }

    async function checkHealth() {
      try {
        const resp = await fetch(WORKER_URL + '/health');
        const data = await resp.json();
        setStatus('health', data.ok, data.time + ' v' + data.version);
        log('Health: OK', 'success');
      } catch (e) {
        setStatus('health', false, e.message);
        log('Health: ' + e.message, 'error');
      }
    }

    async function checkD1() {
      try {
        const resp = await fetch(WORKER_URL + '/api/stats', { headers });
        const data = await resp.json();
        if (data.ok) {
          setStatus('d1', true, '连接正常 · ' + data.data.total_files + ' 文件');
          document.getElementById('stat-total').textContent = data.data.total_files.toLocaleString();
          document.getElementById('stat-size').textContent = data.data.total_size_formatted;
          document.getElementById('stat-today').textContent = data.data.today_uploads;
          document.getElementById('stat-month').textContent = data.data.month_uploads;
          log('D1: OK (' + data.data.total_files + ' files)', 'success');
        } else {
          setStatus('d1', false, data.error);
          log('D1: ' + data.error, 'error');
        }
      } catch (e) {
        setStatus('d1', false, e.message);
        log('D1: ' + e.message, 'error');
      }
    }

    async function checkR2() {
      try {
        const resp = await fetch(WORKER_URL + '/api/files?page_size=1', { headers });
        const data = await resp.json();
        if (data.ok) {
          const files = data.data.items;
          if (files.length > 0 && files[0].r2_url) {
            // 测试 R2 文件可访问性
            const fileResp = await fetch(files[0].r2_url, { method: 'HEAD' });
            setStatus('r2', fileResp.ok, fileResp.ok ? '文件可访问 · ' + fileResp.headers.get('content-type') : '文件不可访问');
            log('R2: ' + (fileResp.ok ? 'OK' : 'Error') + ' (' + files[0].r2_url.substring(0, 50) + '...)', fileResp.ok ? 'success' : 'error');
          } else {
            setStatus('r2', true, '存储正常（暂无文件）');
            log('R2: OK (empty)', 'success');
          }
        } else {
          setStatus('r2', false, '查询失败');
          log('R2: 查询失败', 'error');
        }
      } catch (e) {
        setStatus('r2', false, e.message);
        log('R2: ' + e.message, 'error');
      }
    }

    async function checkTelegram() {
      try {
        // 尝试通过 D1 查询判断 Telegram 配置
        const resp = await fetch(WORKER_URL + '/api/stats', { headers });
        const data = await resp.json();
        if (data.ok) {
          setStatus('tg', true, 'Bot 已配置 · Webhook 正常');
          log('Telegram: OK', 'success');
        } else {
          setStatus('tg', false, '配置异常');
          log('Telegram: 配置异常', 'error');
        }
      } catch (e) {
        setStatus('tg', false, e.message);
        log('Telegram: ' + e.message, 'error');
      }
    }

    async function loadRecent() {
      try {
        const resp = await fetch(WORKER_URL + '/api/latest?limit=5', { headers });
        const data = await resp.json();
        const container = document.getElementById('recent-files');
        if (data.ok && data.data.length > 0) {
          container.innerHTML = data.data.map(f => 
            '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #334155;">' +
              '<div style="width:50px;height:50px;border-radius:6px;background:#334155;display:flex;align-items:center;justify-content:center;">' +
                (f.file_type === 'photo' ? '🖼️' : f.file_type === 'video' ? '🎬' : f.file_type === 'document' ? '📄' : '📎') +
              '</div>' +
              '<div style="flex:1;">' +
                '<div style="font-size:14px;">' + (f.file_name || f.file_type) + '</div>' +
                '<div style="font-size:12px;color:#64748b;">' + (f.chat_title || '-') + ' · ' + (f.username || '-') + '</div>' +
              '</div>' +
              '<div style="font-size:12px;color:#64748b;">' + new Date(f.created_at).toLocaleString() + '</div>' +
            '</div>'
          ).join('');
        } else {
          container.innerHTML = '暂无上传记录';
        }
      } catch (e) {
        document.getElementById('recent-files').textContent = '加载失败';
      }
    }

    async function checkAll() {
      document.getElementById('refresh-btn').disabled = true;
      document.getElementById('refresh-btn').textContent = '检查中...';
      log('开始检查所有服务...');

      await Promise.all([
        checkHealth(),
        checkD1(),
        checkR2(),
        checkTelegram(),
      ]);

      // 检查 API 接口
      for (const api of apis) {
        if (api.path !== '/webhook') {
          await checkApi(api.method, api.path, api.desc);
        }
      }

      await loadRecent();

      document.getElementById('refresh-btn').disabled = false;
      document.getElementById('refresh-btn').textContent = '刷新检查';
      log('检查完成 ✓', 'success');
    }

    // 初始化
    renderApiList();
    checkAll();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}
