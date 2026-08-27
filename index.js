/**
 * 入口文件 - 路由分发
 */
import { handleWebhook } from './handlers/webhook.js';
import { handleQueryFiles, handleGetFile, handleStats, handleByChat, handleByUser, handleByDate, handleSearch, handleLatest, handleStream } from './handlers/api.js';
import { handleDashboard } from './handlers/dashboard.js';
import { ensureTable } from './services/d1.js';
import { jsonResponse, corsResponse } from './utils/response.js';

let tableReady = false;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 公开接口
    if (method === 'GET' && path === '/health') {
      return jsonResponse({ ok: true, time: new Date().toISOString(), version: 'v4' });
    }

    // Webhook
    if (method === 'POST' && path === '/webhook') {
      return handleWebhook(request, env);
    }

    // 监控面板（无需认证）
    if (method === 'GET' && path === '/dashboard') {
      return handleDashboard(request, env);
    }

    // 确保 D1 表存在
    if (env.D1_DB && !tableReady) {
      tableReady = await ensureTable(env.D1_DB);
    }

    // API 认证
    const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('api_key');
    if (!apiKey || apiKey !== env.API_KEY) {
      return jsonResponse({ ok: false, error: '未授权' }, 401);
    }

    // API 路由
    if (method === 'GET' && path === '/api/files') return handleQueryFiles(request, env);
    if (method === 'GET' && path === '/api/file') return handleGetFile(request, env);
    if (method === 'GET' && path === '/api/stats') return handleStats(request, env);
    if (method === 'GET' && path === '/api/by-chat') return handleByChat(request, env);
    if (method === 'GET' && path === '/api/by-user') return handleByUser(request, env);
    if (method === 'GET' && path === '/api/by-date') return handleByDate(request, env);
    if (method === 'GET' && path === '/api/search') return handleSearch(request, env);
    if (method === 'GET' && path === '/api/latest') return handleLatest(request, env);
    if (method === 'GET' && path === '/api/stream') return handleStream(request, env);

    return jsonResponse({ ok: false, error: 'API 不存在' }, 404);
  },
};
