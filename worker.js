/**
 * Telegram Bot → R2 + D1 Worker v7
 * Features: Bot commands, Custom API, Webhook, Dashboard, Large file support
 * 拆模块：工具/db/告警/备份/限流在 src/ 目录，主体逻辑仍在本文件
 */
import { json, cors, fmtSize, genHash } from './src/util.js';
import { ensureTablesOnce } from './src/db.js';
import { notifyAdmin, genThumb } from './src/notify.js';
import { dumpAllTables, handleAdminBackup, handleAdminBackupSave, handleAdminBackupList, handleAdminBackupDelete } from './src/backup.js';
import { applyRateLimit, applyIPRateLimit, applyAdminRateLimit, applyUserRateLimit, hasScope, hasLevel } from './src/ratelimit.js';
import { cnShift, cnTodayStr, cnDayIso, cnNowISO, LEVEL_RANK, LEVEL_ORDER, sanitizeLevel, levelFilter, clampInt, guessExt, fileExtOf, randHex, hashKeyPass, genApiKey, genRedeemCode } from './src/core.js';
import { OFFICIAL_API, tgApiBases, fileDownloadUrl, dlFileStream, dlFileLarger, readBodyWithProgress, dlFileStreamLarger, dlFile, lastUploadError, COLD_STORAGE_MIN, COLD_STORAGE_CLASS, bumpR2Usage, bumpWorkerStat, putR2, putR2Stream, computeMd5, stripExifIfJpeg, countCompleted, replyText, replyTextPlain, MAIN_BUTTONS, getMainMenuCfg, sendQuickReplyKeyboard, broadcastQuickReplyKeyboard, handleAdminGetMainMenu, handleAdminSaveMainMenu, handleAdminMainMenuBroadcast, replyTextWithKeyboard, proxyBotApi, handleBotSendMessage, handleBotSendPhoto, handleBotSendDocument, handleBotSendVideo, handleBotGetFile, handleBotGetMe, handleBotGetWebhookInfo, handleBotSetWebhook, handleBotGetUpdates, handleBotGetChat, handleBotGetChatMemberCount, handleBotBanChatMember, handleBotUnbanChatMember, handleBotDeleteMessage, handleBotForwardMessage, handleBotCopyMessage, handleBotAnswerInlineQuery, handleBotSendMediaGroup, handleBotEditMessageText, handleBotEditMessageCaption, handleBotPinChatMessage, handleBotUnpinChatMessage, handleBotSendChatAction, fileTok } from './src/telegram.js';
import { DEFAULT_COMMANDS, parseMenu, menuButtons, menuText, setMenuCtx, getMenuCtx, execMenuAction, replyCommandMenu, getAIConfig, handleAdminGetAI, handleAdminSaveAI, cfR2Usage, handleUsageForecast, cfWorkerUsage, handleAdminWorkerUsage, handleAdminR2Usage, handleAdminGetR2Quota, handleAdminSaveR2Quota, aiComplete, aiThrottled, isAIReplyText, callAIManage, handleAdminTestAI, handleAdminAskAI, fetchAI, aiRunTool, aiCountFiles, aiGetStatsText, aiUnsavedText, aiSearchText, aiFileText, triggerRetryN, handleBotCommand, syncBuiltinCommands, handleCountCommand, handlePendingCommand, handleRetryCommand, handleHealthCommand, handleStatsCommand, handleFileCommand, handleSearchCommand, handleImgCommand, handleInlineQuery } from './src/commands.js';
import { handleShowConfigGet, handleShowGroupsList, handleShowGroupsSave, handleShowGroupsDelete, handleShowGroupRoll, rotateProgramImages, handleShowConfigSet, handleShowPage, handleShowData, handleGalleryPage, handleGalleryData, checkApiKey, appendTagFilter, handlePublicFiles, handlePublicRandom, handlePublicUpload, handleDiagnoseKey, handleAdminTags, handleAdminTagList, handleAdminTagCreate, handleAdminTagUpdate, handleAdminTagDelete, handleSetFileTags, checkUserPortal, handleAdminKeys, handleAdminKeysCreate, handleAdminKeysUpdate, handleAdminKeysToggle, handleAdminKeysDelete, handleAdminKeyUsers, handleAdminUsernameCheck, handleAdminRedeemList, handleAdminRedeemCreate, handleAdminRedeemUpdate, handleAdminRedeemDelete, handleAdminCallLogs, handleAdminCallStats, handleUserRegister, handleUserRedeem, handleUserCallLogs, handleUserCallStats, handleUserResetPassword, handleUserGetKeyInfo, recordKnownChat, recordUserInteraction, handleAdminUsers, handleAdminUsersInteractions, handleAdminPoolList, handleAdminPoolCreate, handleAdminPoolImportPage, handleAdminPoolUpload, handleAdminFilesUpload, handleAdminFilesImport, handleAdminPoolUploadPostimages, handleAdminGetPiKey, handleAdminSavePiKey, handleAdminGetPoolTags, handleAdminSavePoolTags, handleAdminPoolToggle, handleAdminFoldersList, handleAdminFoldersCreate, handleAdminFoldersRename, handleAdminFoldersDelete, handleAdminPoolMoveToFolder, handleUserUpload, handleUserFiles, handleUserFileDetail, handleUserFileDelete, handleUserFilesCleanup, handleUserFileTags, handleUserRandom, handleUserQuota, handleAdminGetUploadGroup, handleAdminSaveUploadGroup, handleAdminGetKnownGroups, handleAdminGetUserQuotas, handleAdminUpdateUserQuota, handleAdminUserFiles, handleAdminGetPoolFallback, handleAdminSavePoolFallback, handleAdminFilesUploadTg, handleAdminPoolUploadTg, handleAdminScrapeAnalyze, handleAdminScrapeGrab, handleAdminScrapeGrabOne, handleAdminScrapeRuleGroupsGet, handleAdminScrapeRuleGroupsSave } from './src/public.js';
import { allocTgRef, getFileRef, scheduleBatchRef, refreshGroupReceipt, handleDeletedMsg } from './src/batch.js';

import { handleTgFileRedirect, handleFiles, handleFile, getProxyMode, getBotUsername, handleAdminGetProxyMode, handleAdminSaveProxyMode, handleAdminGetProxyOnly, handleAdminSaveProxyOnly, handleStats } from './src/api.js';
import { handleAdminGetNotify, handleAdminSaveNotify, handleAdminNotifyTest, handleAdminGetRateLimit, handleAdminSaveRateLimit } from './src/notify.js';

import { fireWebhook, handleAdminGetWebhook, handleAdminSaveWebhook, handleAdminWebhookTest, handleAdminPoolTags, handleAdminPoolBatch, handleAdminPoolBatchDelete, handleSetFilePoolStatus, handleAdminGetAutoPoolTags, handleAdminSaveAutoPoolTags, handleAdminPoolFromTg, handleAdminPoolDelete, handleAdminPrivatePoolList, handleAdminPrivatePoolFromTg, handleByChat, handleByUser, handleByDate, handleSearch, handleLatest, handleStream, handleDeleteFile, handleTrashList, handleTrashRestore, handleR2Inspect, handleR2Cleanup, handleR2FixMime, handleR2List, handleR2Delete, handleListBots, handleAddBot, handleRemoveBot, handleGetConfig, handleSetConfig, handleBotGetMeApi } from './src/events.js';
import { handleRetry, handleUnsavedList, handleUnsavedRetry, retryUnsavedCron, handleProcessingStatus, handleDedupStats, handleDedupGroups, handleDedupRow, handleDedupRows, compressCronBatch, sendDailyReport, storageMaintenanceCron, handleCompressStats, handleCompressRun, runDedupBatch, handleDedup, handleAdminCommands, handleAdminAddCommand, handleAdminUpdateCommand, handleAdminDeleteCommand } from './src/admin.js';
import { handleWebhook, ensureWebhook, handleAdminWebhookStatus, handleAdminWebhookFix, handleAdminWebhookLogs, handlePollUpdates, handlePollEndpoint, processShareLinkAsync, processFileAsync } from './src/webhook.js';




import { handleAdminFromR2, handleAdminGuideFromR2, handleUserFromR2, handleUserManageFromR2, handleJxPage, handleScrapePage, handleUserLogin, handleDocs, handleDashboard } from './src/pages.js';

import { handleMigrate } from './src/migrate.js';
import { currentMode, setMode, resetIsolateState } from './src/dbaccess.js';
import { mysqlFailoverGet, mysqlRows, mysqlGet, mysqlExec } from './src/mysql.js';
import { handleParseLink, handleGetCobaltConfig, handleSaveCobaltConfig } from './src/parser.js';
import { handleAppInstall, handleAppHeartbeat, handleAppStats, handleAppInstalls, handleAppDeviceUsers, handleAppUpdate } from './src/app_stats.js';




// 东八区辅助：统计"今日/本月"统一按北京时间（UTC+8）口径，避免凌晨上传的文件被计入前一天

export default {
  async fetch(request, env, ctx) {
    try {
    if (request.method === 'OPTIONS') return cors(null, 204);
    // Ensure tables exist (only once per isolate, avoiding per-request D1 overhead)
    if (env.D1_DB) { try { await ensureTablesOnce(env.D1_DB); } catch (e) {} }
    // 本地请求计数（兜底统计，异步不阻塞；主统计走 Cloudflare GraphQL）
    bumpWorkerStat(env);
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    if (m === 'GET' && p === '/health') return json({ ok: true, time: cnNowISO(), version: 'v7' });
    if (m === 'POST' && p === '/webhook') return handleWebhook(request, env, ctx);
    if (m === 'GET' && p === '/dashboard') return handleDashboard(env);
    if (m === 'GET' && p === '/docs') return handleDocs();
    if (m === 'GET' && p === '/show') return handleShowPage();
    if (m === 'GET' && p === '/show/data') {
      // 公开 API：添加 IP 速率限制
      if (await applyIPRateLimit(env, request)) {
        return json({ ok: false, error: 'Rate limit exceeded' }, 429);
      }
      return handleShowData(request, env);
    }
    // 画廊瀑布流页（带 key 鉴权，多级+标签+类型筛选）
    if (m === 'GET' && p === '/gallery') return handleGalleryPage();
    if (m === 'GET' && p === '/gallery/data') {
      // 公开 API：添加 IP 速率限制
      if (await applyIPRateLimit(env, request)) {
        return json({ ok: false, error: 'Rate limit exceeded' }, 429);
      }
      return handleGalleryData(request, env);
    }
    if (m === 'GET' && p === '/admin') return handleAdminFromR2(env);
    // 链接解析页（管理员专用）
    if (m === 'GET' && p === '/jx') return handleJxPage(env);
    // 网页图片直传页（管理员专用）
    if (m === 'GET' && p === '/scrape') return handleScrapePage(env);
    // 用户门户（普通用户用 key + key-pass 登录，查看密钥统计 + 生成公开接口 URL）
    if (m === 'GET' && p === '/user') return handleUserFromR2(env);
    if (m === 'GET' && p === '/user-manage') return handleUserManageFromR2(env);
    if (m === 'POST' && p === '/api/user/login') {
      // 公开 API：添加 IP 速率限制
      if (await applyIPRateLimit(env, request)) {
        return json({ ok: false, error: 'Rate limit exceeded' }, 429);
      }
      return handleUserLogin(request, env);
    }
    if (m === 'POST' && p === '/api/user/register') {
      // 公开 API：添加 IP 速率限制
      if (await applyIPRateLimit(env, request)) {
        return json({ ok: false, error: 'Rate limit exceeded' }, 429);
      }
      return handleUserRegister(request, env);
    }
    if (m === 'POST' && p === '/api/user/redeem') {
      // 公开 API：添加 IP 速率限制
      if (await applyIPRateLimit(env, request)) {
        return json({ ok: false, error: 'Rate limit exceeded' }, 429);
      }
      return handleUserRedeem(request, env);
    }
    if (m === 'POST' && p === '/api/user/reset-password') {
      // 公开 API：添加 IP 速率限制
      if (await applyIPRateLimit(env, request)) {
        return json({ ok: false, error: 'Rate limit exceeded' }, 429);
      }
      return handleUserResetPassword(request, env);
    }
    if (m === 'POST' && p === '/api/user/key-info') {
      // 公开 API：添加 IP 速率限制
      if (await applyIPRateLimit(env, request)) {
        return json({ ok: false, error: 'Rate limit exceeded' }, 429);
      }
      return handleUserGetKeyInfo(request, env);
    }
    // User upload API
    if (m === 'POST' && p === '/api/v1/user/upload') return handleUserUpload(request, env);
    if (m === 'GET' && p === '/api/v1/user/files') return handleUserFiles(request, env);
    if (m === 'GET' && p.match(/^\/api\/v1\/user\/files\/\d+$/)) return handleUserFileDetail(request, env);
    if (m === 'DELETE' && p.match(/^\/api\/v1\/user\/files\/\d+$/)) return handleUserFileDelete(request, env);
    if (m === 'POST' && p.match(/^\/api\/v1\/user\/files\/\d+\/tags$/)) return handleUserFileTags(request, env);
    if (m === 'POST' && p === '/api/v1/user/files/cleanup') return handleUserFilesCleanup(request, env);
    if (m === 'GET' && p === '/api/v1/user/random') return handleUserRandom(request, env);
    if (m === 'GET' && p === '/api/v1/user/quota') return handleUserQuota(request, env);
    // 管理员使用手册（R2 静态页，与 admin.html 同源发布）
    if (m === 'GET' && p === '/admin/guide') return handleAdminGuideFromR2(env);
    if (m === 'GET' && p === '/favicon.ico') return new Response(null, { status: 204 });
    // File proxy: /file/tg/<id> -> 302 to official Telegram direct link (clean URL, no token exposed)
    if (m === 'GET' && p.indexOf('/file/tg/') === 0) {
      // 公开 API：添加 IP 速率限制
      if (await applyIPRateLimit(env, request)) {
        return json({ ok: false, error: 'Rate limit exceeded' }, 429);
      }
      return handleTgFileRedirect(request, env, ctx);
    }
    // Admin API (auth via query param or header)
    const adminKey = url.searchParams.get('api_key') || request.headers.get('X-API-Key');
    const isAdmin = adminKey && adminKey === env.API_KEY;
    // 管理员路由添加限流保护
    if (isAdmin && p.startsWith('/admin/api/')) {
      if (await applyAdminRateLimit(env, request)) {
        return json({ ok: false, error: '管理员请求过于频繁，请稍后再试' }, 429);
      }
    }
    if (m === 'GET' && p === '/admin/api/commands') return isAdmin ? handleAdminCommands(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/commands') return isAdmin ? handleAdminAddCommand(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'PATCH' && p === '/admin/api/commands') return isAdmin ? handleAdminUpdateCommand(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/commands') return isAdmin ? handleAdminDeleteCommand(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/files') return isAdmin ? handleFiles(request, env, { admin: true }) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/files') return isAdmin ? handleDeleteFile(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/files/upload') return isAdmin ? handleAdminFilesUpload(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/files/upload-tg') return isAdmin ? handleAdminFilesUploadTg(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/upload-tg') return isAdmin ? handleAdminPoolUploadTg(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/scrape/analyze') return isAdmin ? handleAdminScrapeAnalyze(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/scrape/grab') return isAdmin ? handleAdminScrapeGrab(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/scrape/grab_one') return isAdmin ? handleAdminScrapeGrabOne(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/scrape/rule-groups') return isAdmin ? handleAdminScrapeRuleGroupsGet(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/scrape/rule-groups') return isAdmin ? handleAdminScrapeRuleGroupsSave(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/files/import') return isAdmin ? handleAdminFilesImport(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/stats') return isAdmin ? handleStats(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/app/stats') return isAdmin ? handleAppStats(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/app/installs') return isAdmin ? handleAppInstalls(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/app/users') return isAdmin ? handleAppDeviceUsers(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/bot-info') return isAdmin ? handleBotGetMeApi(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/dedup') return isAdmin ? handleDedup(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/dedup/stats') return isAdmin ? handleDedupStats(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/dedup/groups') return isAdmin ? handleDedupGroups(env) : json({ok:false,error:'Unauthorized'},401);
    // 去重行级操作：单文件清理 / 设为保留（keep 保留该行并清理同组其他）
    if (m === 'POST' && p === '/admin/api/dedup/row') return isAdmin ? handleDedupRow(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/dedup/rows') return isAdmin ? handleDedupRows(request, env) : json({ok:false,error:'Unauthorized'},401);
    // 存储压缩：photo 转 WebP 省存储（需账号开通 Image Resizing）
    if (m === 'GET' && p === '/admin/api/compress/stats') return isAdmin ? handleCompressStats(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/compress/run') return isAdmin ? handleCompressRun(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/processing') return isAdmin ? handleProcessingStatus(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/retry') return isAdmin ? handleRetry(request, env, ctx) : json({ok:false,error:'Unauthorized'},401);
    // 未转存列表（已入库但未完成）+ 批量重试
    if (m === 'GET' && p === '/admin/api/unsaved') return isAdmin ? handleUnsavedList(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/unsaved/retry') return isAdmin ? handleUnsavedRetry(request, env, ctx) : json({ok:false,error:'Unauthorized'},401);
    // Trash (soft-deleted files) + R2 storage maintenance
    if (m === 'GET' && p === '/admin/api/trash') return isAdmin ? handleTrashList(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/trash/restore') return isAdmin ? handleTrashRestore(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/r2/inspect') return isAdmin ? handleR2Inspect(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/r2/cleanup') return isAdmin ? handleR2Cleanup(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/r2/fix-mime') return isAdmin ? handleR2FixMime(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/r2/list') return isAdmin ? handleR2List(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/r2/delete') return isAdmin ? handleR2Delete(request, env) : json({ok:false,error:'Unauthorized'},401);
    // Manual poll trigger (fallback while cron is being set up)
    if (m === 'GET' && p === '/admin/api/poll') return isAdmin ? handlePollEndpoint(env) : json({ok:false,error:'Unauthorized'},401);
    // Tag management
    if (m === 'GET' && p === '/admin/api/tags') return isAdmin ? handleAdminTags(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/tags/list') return isAdmin ? handleAdminTagList(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/tags') return isAdmin ? handleAdminTagCreate(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'PATCH' && p === '/admin/api/tags') return isAdmin ? handleAdminTagUpdate(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/tags') return isAdmin ? handleAdminTagDelete(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/files/tags') return isAdmin ? handleSetFileTags(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/files/pool-status') return isAdmin ? handleSetFilePoolStatus(request, env) : json({ok:false,error:'Unauthorized'},401);
    // D1 → MySQL 存量数据迁移（幂等，分批执行）
    if (m === 'GET' && p === '/admin/api/migrate') return isAdmin ? handleMigrate(request, env) : json({ok:false,error:'Unauthorized'},401);
    // D1 降级控制：GET 查当前模式，POST 设置（d1|mysql|auto）
    if (m === 'GET' && p === '/admin/api/db-mode') return isAdmin ? handleDbModeGet(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/db-mode') return isAdmin ? handleDbModeSet(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/db-stats') return isAdmin ? handleDbStats(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/db-test-mysql') return isAdmin ? handleDbTestMysql(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/db-rebuild-mysql') return isAdmin ? handleDbRebuildMysql(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/db-force-sync') return isAdmin ? handleDbForceSync(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/db-sync') return isAdmin ? handleDbSync(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/db-full-sync') return isAdmin ? handleDbFullSync(env) : json({ok:false,error:'Unauthorized'},401);
    // API key management (for third-party programs)
    if (m === 'GET' && p === '/admin/api/keys') return isAdmin ? handleAdminKeys(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/keys') return isAdmin ? handleAdminKeysCreate(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'PATCH' && p === '/admin/api/keys') return isAdmin ? handleAdminKeysUpdate(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/keys/toggle') return isAdmin ? handleAdminKeysToggle(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/keys') return isAdmin ? handleAdminKeysDelete(request, env) : json({ok:false,error:'Unauthorized'},401);
    // 密钥用户管理（注册用户列表 / 用户名查重 / 停用删除）
    if (m === 'GET' && p === '/admin/api/key-users') return isAdmin ? handleAdminKeyUsers(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/key-users/username-check') return isAdmin ? handleAdminUsernameCheck(request, env) : json({ok:false,error:'Unauthorized'},401);
    // 兑换码管理（生成/列表/编辑/删除）
    if (m === 'GET' && p === '/admin/api/redeem') return isAdmin ? handleAdminRedeemList(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/redeem') return isAdmin ? handleAdminRedeemCreate(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'PATCH' && p === '/admin/api/redeem') return isAdmin ? handleAdminRedeemUpdate(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/redeem') return isAdmin ? handleAdminRedeemDelete(request, env) : json({ok:false,error:'Unauthorized'},401);
    // 调用日志（全部密钥调用记录 + 最近 1h/6h/24h 统计）
    if (m === 'GET' && p === '/admin/api/call-logs') return isAdmin ? handleAdminCallLogs(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/call-stats') return isAdmin ? handleAdminCallStats(env) : json({ok:false,error:'Unauthorized'},401);
    // User stats
    if (m === 'GET' && p === '/admin/api/users') return isAdmin ? handleAdminUsers(env) : json({ok:false,error:'Unauthorized'},401);
    // 用户聊天交互统计（消息/命令/文件/Inline/回调 汇总 + 最近活跃）
    if (m === 'GET' && p === '/admin/api/users/interactions') return isAdmin ? handleAdminUsersInteractions(env) : json({ok:false,error:'Unauthorized'},401);
    // Slideshow page config
    if (m === 'GET' && p === '/admin/api/show-config') return isAdmin ? handleShowConfigGet(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/show-config') return isAdmin ? handleShowConfigSet(request, env) : json({ok:false,error:'Unauthorized'},401);
    // Random pool management
    if (m === 'GET' && p === '/admin/api/pool') return isAdmin ? handleAdminPoolList(request, env) : json({ok:false,error:'Unauthorized'},401);
    // Show groups (image playlists bound to schedule programs)
    if (m === 'GET' && p === '/admin/api/show-groups') return isAdmin ? handleShowGroupsList(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/show-groups') return isAdmin ? handleShowGroupsSave(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/show-groups') return isAdmin ? handleShowGroupsDelete(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/show-groups/roll') return isAdmin ? handleShowGroupRoll(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool') return isAdmin ? handleAdminPoolCreate(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/import-page') return isAdmin ? handleAdminPoolImportPage(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/upload') return isAdmin ? handleAdminPoolUpload(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/upload-postimages') return isAdmin ? handleAdminPoolUploadPostimages(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/toggle') return isAdmin ? handleAdminPoolToggle(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/batch') return isAdmin ? handleAdminPoolBatch(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/batch-delete') return isAdmin ? handleAdminPoolBatchDelete(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/tags') return isAdmin ? handleAdminPoolTags(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/from-tg') return isAdmin ? handleAdminPoolFromTg(request, env, ctx) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/pool') return isAdmin ? handleAdminPoolDelete(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/pool/move') return isAdmin ? handleAdminPoolMoveToFolder(request, env) : json({ok:false,error:'Unauthorized'},401);
    // 文件夹管理
    if (m === 'GET' && p === '/admin/api/folders') return isAdmin ? handleAdminFoldersList(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/folders') return isAdmin ? handleAdminFoldersCreate(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'PATCH' && p.startsWith('/admin/api/folders/') && p.endsWith('/rename')) return isAdmin ? handleAdminFoldersRename(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p.startsWith('/admin/api/folders/')) return isAdmin ? handleAdminFoldersDelete(request, env) : json({ok:false,error:'Unauthorized'},401);
    // 私密库（is_private=1）：私密内容等同 vvip，仅 vvip 密钥可访问，不进入共享库
    if (m === 'GET' && p === '/admin/api/private-pool') return isAdmin ? handleAdminPrivatePoolList(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/private-pool/from-tg') return isAdmin ? handleAdminPrivatePoolFromTg(request, env, ctx) : json({ok:false,error:'Unauthorized'},401);
    // Postimages API key stored in D1 settings (shared across browsers/devices)
    if (m === 'GET' && p === '/admin/api/settings/pi-key') return isAdmin ? handleAdminGetPiKey(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/pi-key') return isAdmin ? handleAdminSavePiKey(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/settings/pool-tags') return isAdmin ? handleAdminGetPoolTags(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/pool-tags') return isAdmin ? handleAdminSavePoolTags(request, env) : json({ok:false,error:'Unauthorized'},401);
    // 自动入共享库标签：命中即自动转入共享库
    if (m === 'GET' && p === '/admin/api/settings/auto-pool-tags') return isAdmin ? handleAdminGetAutoPoolTags(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/auto-pool-tags') return isAdmin ? handleAdminSaveAutoPoolTags(request, env) : json({ok:false,error:'Unauthorized'},401);
    // 代理模式：1=入库不转存 R2，直链 /file/tg/<id> 由 worker 实时拉 Telegram（省 R2 存储）
    if (m === 'GET' && p === '/admin/api/settings/proxy-mode') return isAdmin ? handleAdminGetProxyMode(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/proxy-mode') return isAdmin ? handleAdminSaveProxyMode(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/settings/proxy-only') return isAdmin ? handleAdminGetProxyOnly(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/proxy-only') return isAdmin ? handleAdminSaveProxyOnly(request, env) : json({ok:false,error:'Unauthorized'},401);
    // AI 管理配置（enabled/base/model/api_key/prompt）
    if (m === 'GET' && p === '/admin/api/settings/ai') return isAdmin ? handleAdminGetAI(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/ai') return isAdmin ? handleAdminSaveAI(request, env) : json({ok:false,error:'Unauthorized'},401);
    // AI 测试（往指定 chat 发测试消息）/ AI 浮窗问答
    if (m === 'POST' && p === '/admin/api/ai/test') return isAdmin ? handleAdminTestAI(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/ai/ask') return isAdmin ? handleAdminAskAI(request, env) : json({ok:false,error:'Unauthorized'},401);
    // R2 用量概览 / 套餐配额配置
    if (m === 'GET' && p === '/admin/api/r2-usage') return isAdmin ? handleAdminR2Usage(env) : json({ok:false,error:'Unauthorized'},401);
    // Worker 用量统计（请求数/CPU/错误，GraphQL 官方 + 本地兜底）
    if (m === 'GET' && p === '/admin/api/worker-usage') return isAdmin ? handleAdminWorkerUsage(env) : json({ok:false,error:'Unauthorized'},401);
    // 用量预测 + 趋势（请求/存储）
    if (m === 'GET' && p === '/admin/api/usage-forecast') return isAdmin ? handleUsageForecast(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/settings/r2-quota') return isAdmin ? handleAdminGetR2Quota(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/r2-quota') return isAdmin ? handleAdminSaveR2Quota(request, env) : json({ok:false,error:'Unauthorized'},401);
    // Webhook 有效性检查 / 一键修复（getWebhookInfo / setWebhook）
    if (m === 'GET' && p === '/admin/api/webhook-status') return isAdmin ? handleAdminWebhookStatus(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/webhook-logs') return isAdmin ? handleAdminWebhookLogs(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/webhook-fix') return isAdmin ? handleAdminWebhookFix(request, env) : json({ok:false,error:'Unauthorized'},401);
    // D1 备份 / 失败告警配置 / API 限流配置
    if (m === 'GET' && p === '/admin/api/backup') return isAdmin ? handleAdminBackup(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/backup') return isAdmin ? handleAdminBackupSave(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/backup/list') return isAdmin ? handleAdminBackupList(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'DELETE' && p === '/admin/api/backup') return isAdmin ? handleAdminBackupDelete(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/settings/notify') return isAdmin ? handleAdminGetNotify(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/notify') return isAdmin ? handleAdminSaveNotify(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/settings/rate-limit') return isAdmin ? handleAdminGetRateLimit(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/rate-limit') return isAdmin ? handleAdminSaveRateLimit(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/notify-test') return isAdmin ? handleAdminNotifyTest(request, env) : json({ok:false,error:'Unauthorized'},401);
    // 事件 Webhook 通知配置（入库/删除/失败时 POST 到外部 URL）
    if (m === 'GET' && p === '/admin/api/settings/webhook') return isAdmin ? handleAdminGetWebhook(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/webhook') return isAdmin ? handleAdminSaveWebhook(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/webhook/test') return isAdmin ? handleAdminWebhookTest(request, env) : json({ok:false,error:'Unauthorized'},401);
    // 链接解析配置（cobalt API）
    if (m === 'GET' && p === '/admin/api/settings/cobalt') return isAdmin ? handleGetCobaltConfig(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/cobalt') return isAdmin ? handleSaveCobaltConfig(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/parse-link') return isAdmin ? handleParseLink(request, env) : json({ok:false,error:'Unauthorized'},401);
    // 快捷回复键盘配置 / 广播（main_menu）
    if (m === 'GET' && p === '/admin/api/settings/main-menu') return isAdmin ? handleAdminGetMainMenu(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/main-menu') return isAdmin ? handleAdminSaveMainMenu(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/main-menu/broadcast') return isAdmin ? handleAdminMainMenuBroadcast(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/settings/upload-group') return isAdmin ? handleAdminGetUploadGroup(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/upload-group') return isAdmin ? handleAdminSaveUploadGroup(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/settings/pool-fallback') return isAdmin ? handleAdminGetPoolFallback(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/settings/pool-fallback') return isAdmin ? handleAdminSavePoolFallback(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/known-groups') return isAdmin ? handleAdminGetKnownGroups(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/user-quotas') return isAdmin ? handleAdminGetUserQuotas(env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'POST' && p === '/admin/api/user-quotas') return isAdmin ? handleAdminUpdateUserQuota(request, env) : json({ok:false,error:'Unauthorized'},401);
    if (m === 'GET' && p === '/admin/api/user-files') return isAdmin ? handleAdminUserFiles(request, env) : json({ok:false,error:'Unauthorized'},401);
    // Bot API routes (no auth needed, verified by Telegram)
    if (m === 'POST' && p === '/bot/sendMessage') return handleBotSendMessage(request, env);
    if (m === 'POST' && p === '/bot/sendPhoto') return handleBotSendPhoto(request, env);
    if (m === 'POST' && p === '/bot/sendDocument') return handleBotSendDocument(request, env);
    if (m === 'POST' && p === '/bot/sendVideo') return handleBotSendVideo(request, env);
    if (m === 'POST' && p === '/bot/getFile') return handleBotGetFile(request, env);
    if (m === 'POST' && p === '/bot/getMe') return handleBotGetMe(request, env);
    if (m === 'POST' && p === '/bot/getWebhookInfo') return handleBotGetWebhookInfo(request, env);
    if (m === 'POST' && p === '/bot/setWebhook') return handleBotSetWebhook(request, env);
    if (m === 'POST' && p === '/bot/getUpdates') return handleBotGetUpdates(request, env);
    if (m === 'POST' && p === '/bot/getChat') return handleBotGetChat(request, env);
    if (m === 'POST' && p === '/bot/getChatMemberCount') return handleBotGetChatMemberCount(request, env);
    if (m === 'POST' && p === '/bot/banChatMember') return handleBotBanChatMember(request, env);
    if (m === 'POST' && p === '/bot/unbanChatMember') return handleBotUnbanChatMember(request, env);
    if (m === 'POST' && p === '/bot/deleteMessage') return handleBotDeleteMessage(request, env);
    if (m === 'POST' && p === '/bot/forwardMessage') return handleBotForwardMessage(request, env);
    if (m === 'POST' && p === '/bot/copyMessage') return handleBotCopyMessage(request, env);
    if (m === 'POST' && p === '/bot/answerInlineQuery') return handleBotAnswerInlineQuery(request, env);
    if (m === 'POST' && p === '/bot/sendMediaGroup') return handleBotSendMediaGroup(request, env);
    if (m === 'POST' && p === '/bot/editMessageText') return handleBotEditMessageText(request, env);
    if (m === 'POST' && p === '/bot/editMessageCaption') return handleBotEditMessageCaption(request, env);
    if (m === 'POST' && p === '/bot/pinChatMessage') return handleBotPinChatMessage(request, env);
    if (m === 'POST' && p === '/bot/unpinChatMessage') return handleBotUnpinChatMessage(request, env);
    if (m === 'POST' && p === '/bot/sendChatAction') return handleBotSendChatAction(request, env);

    // Public JSON API for third-party programs (auth via api_keys table)
    if (m === 'GET' && (p === '/api/v1/files' || p === '/api/v1/random')) {
      const k = await checkApiKey(request, env);
      if (!k) return json({ ok: false, error: 'Unauthorized or invalid API key' }, 401);
      if (k.limited) return json({ ok: false, error: 'Rate limit exceeded' }, 429);
      const keyLevel = (k.rec && k.rec.level) || 'pt';
      if (p === '/api/v1/random') return handlePublicRandom(request, env, keyLevel);
      // files 列表：CDN 边缘缓存 30s（同一 URL 30s 内秒回）。
      // 早期用 Worker 内 caches.default 缓存，实测冷启动 caches API 耗时 45-60s，
      // 而 CDN 层 CF-Cache-Status HIT 已生效，改为仅设置 Cache-Control 交由边缘缓存。
      const resp = await handlePublicFiles(request, env, keyLevel);
      const hd = new Headers(resp.headers);
      if (resp.status === 200 && !hd.has('Cache-Control')) hd.set('Cache-Control', 'public, s-maxage=30, max-age=0');
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: hd });
    }
    // Public upload API for third-party programs (auth via api_keys table)
    // POST /api/v1/upload?api_key=xxx&pool=1&tags=风景&title=xxx&level=pt&is_private=1
    // Body: multipart/form-data with a file field named "file"
    if (m === 'POST' && p === '/api/v1/upload') {
      const k = await checkApiKey(request, env);
      if (!k) return json({ ok: false, error: 'Unauthorized or invalid API key' }, 401);
      if (k.limited) return json({ ok: false, error: 'Rate limit exceeded' }, 429);
      // 权限检查：上传需要 files:write 或 upload scope
      if (!hasScope(k.rec, 'files:write') && !hasScope(k.rec, 'upload')) {
        return json({ ok: false, error: '权限不足：上传文件需要 files:write 或 upload 权限', hint: '请联系管理员为您的密钥添加上传权限' }, 403);
      }
      const keyLevel = (k.rec && k.rec.level) || 'pt';
      return handlePublicUpload(request, env, keyLevel);
    }
    // 诊断端点：帮助排查 API key 问题（不需要完整鉴权，只检查 key 是否存在）
    if (m === 'GET' && p === '/api/v1/diagnose-key') {
      return handleDiagnoseKey(request, env);
    }
    // 用户门户：当前密钥的统计信息 + 公开接口生成所需标签（key + key-pass 鉴权）
    if (m === 'POST' && p === '/api/user/stats') {
      const rec = await checkUserPortal(request, env);
      if (!rec) return json({ ok: false, error: 'Invalid key or key-pass' }, 401);
      // 用户门户限流
      if (await applyUserRateLimit(env, rec.key)) {
        return json({ ok: false, error: '请求过于频繁，请稍后再试' }, 429);
      }
      const today = cnTodayStr();
      const exp = rec.expires_at || '';
      rec.expired = exp ? (exp < today ? 1 : 0) : 0;
      return json({ ok: true, data: { id: rec.id, key: rec.key, name: rec.name, username: rec.username || '', scopes: rec.scopes, level: rec.level, enabled: rec.enabled, expires_at: rec.expires_at, expired: rec.expired, created_at: rec.created_at, last_used_at: rec.last_used_at, usage_count: rec.usage_count } });
    }
    if (m === 'POST' && p === '/api/user/tags') {
      const rec = await checkUserPortal(request, env);
      if (!rec) return json({ ok: false, error: 'Invalid key or key-pass' }, 401);
      // 用户门户限流
      if (await applyUserRateLimit(env, rec.key)) {
        return json({ ok: false, error: '请求过于频繁，请稍后再试' }, 429);
      }
      return handleAdminTags(env);
    }
    // 用户门户：当前密钥的调用日志（最近 200 条）+ 最近 1h/6h/24h 调用统计
    if (m === 'POST' && p === '/api/user/logs') {
      const rec = await checkUserPortal(request, env);
      if (!rec) return json({ ok: false, error: 'Invalid key or key-pass' }, 401);
      // 用户门户限流
      if (await applyUserRateLimit(env, rec.key)) {
        return json({ ok: false, error: '请求过于频繁，请稍后再试' }, 429);
      }
      return handleUserCallLogs(rec, env);
    }
    if (m === 'POST' && p === '/api/user/log-stats') {
      const rec = await checkUserPortal(request, env);
      if (!rec) return json({ ok: false, error: 'Invalid key or key-pass' }, 401);
      // 用户门户限流
      if (await applyUserRateLimit(env, rec.key)) {
        return json({ ok: false, error: '请求过于频繁，请稍后再试' }, 429);
      }
      return handleUserCallStats(rec, env);
    }

    // App 安装统计（无需认证，APP 直接调用）
    if (m === 'POST' && p === '/api/app/stats/install') return handleAppInstall(request, env);
    if (m === 'POST' && p === '/api/app/stats/heartbeat') return handleAppHeartbeat(request, env);
    if (m === 'GET' && p === '/api/app/update') return handleAppUpdate(env);

    // API routes (require auth)
    const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('api_key');
    if (!apiKey || apiKey !== env.API_KEY) return json({ ok: false, error: 'Unauthorized' }, 401);

    if (m === 'GET' && p === '/api/files') return handleFiles(request, env, { admin: false });
    if (m === 'GET' && p === '/api/file') return handleFile(request, env);
    if (m === 'GET' && p === '/api/stats') return handleStats(env);
    if (m === 'GET' && p === '/api/by-chat') return handleByChat(request, env);
    if (m === 'GET' && p === '/api/by-user') return handleByUser(request, env);
    if (m === 'GET' && p === '/api/by-date') return handleByDate(request, env);
    if (m === 'GET' && p === '/api/search') return handleSearch(request, env);
    if (m === 'GET' && p === '/api/latest') return handleLatest(request, env);
    if (m === 'GET' && p === '/api/stream') return handleStream(request, env);
    if (m === 'DELETE' && p === '/api/file') return handleDeleteFile(request, env);
    if (m === 'GET' && p === '/api/bots') return handleListBots(env);
    if (m === 'POST' && p === '/api/bots') return handleAddBot(request, env);
    if (m === 'DELETE' && p === '/api/bots') return handleRemoveBot(request, env);
    if (m === 'GET' && p === '/api/config') return handleGetConfig(env);
    if (m === 'POST' && p === '/api/config') return handleSetConfig(request, env);
    if (m === 'GET' && p === '/api/bot-info') return handleBotGetMeApi(env);

    return json({ ok: false, error: 'Not Found' }, 404);
    } catch (e) {
      // 兜底：把未捕获异常转成 JSON（否则 Cloudflare 返回非 JSON 的 HTML 500，前端只能显示“服务响应异常”）
      try { console.error('unhandled fetch error:', e && e.message); } catch (e2) {}
      return json({ ok: false, error: 'Unhandled: ' + ((e && e.message) || String(e)) }, 500);
    }
  },

  // Queue consumer: handles file processing in background (up to 15 min)
  async queue(batch, env) {
    if (env.D1_DB) { try { await ensureTablesOnce(env.D1_DB); } catch (e) {} }
    for (const msg of batch.messages) {
      try {
        await handleQueueMessage(msg.body, env);
      } catch (e) {
        console.error('queue message error:', e.message);
      }
    }
  },

  // Cron trigger: poll getUpdates from Local Bot API (Local file_id, bypasses 20MB limit)
  async scheduled(event, env, ctx) {
    // 日报：UTC 01:00（北京 09:00）推送昨日汇总
    if (event.cron === '0 1 * * *') {
      try { await sendDailyReport(env); } catch (e) { console.error('scheduled daily:', e.message); }
    }
    // webhook 自愈：每 5 分钟确认 webhook 还在，丢了自动恢复
    try {
      await ensureWebhook(env, ctx);
    } catch (e) {
      console.error('scheduled ensureWebhook:', e.message);
    }
    try {
      await handlePollUpdates(env, ctx);
    } catch (e) {
      console.error('scheduled:', e.message);
    }
    // 兜底转存：每 5 分钟重试几条未完成记录（先入库、异步转存策略的定时触发）
    try {
      await retryUnsavedCron(env, ctx);
    } catch (e) {
      console.error('scheduled retryUnsaved:', e.message);
    }
    // 查重后台化：每 5 分钟算 3 个缺失 MD5（scheduled 子请求预算有限，不清理留给手动/后台）
    try {
      await runDedupBatch(env, 3, 0, 10000, false);
    } catch (e) {
      console.error('scheduled dedup:', e.message);
    }
    // 存储维护：回收站超期文件自动硬清（24h 一次，含 R2 对象）
    try {
      await storageMaintenanceCron(env);
    } catch (e) {
      console.error('scheduled storage:', e.message);
    }
    // WebP 压缩后台化：每 5 分钟自动压 2 张（scheduled 预算有限，大头留给手动点击）
    try {
      await compressCronBatch(env);
    } catch (e) {
      console.error('scheduled compress:', e.message);
    }
    // 内置命令入库同步：把代码里的内置命令登记到 bot_commands（INSERT OR IGNORE，不覆盖用户修改）
    try {
      await syncBuiltinCommands(env);
    } catch (e) {
      console.error('scheduled syncBuiltinCommands:', e.message);
    }
    // 节目组定时换图：mode='daily_random' 的节目按 roll_time + weekdays 自动从随机库轮换
    try {
      await rotateProgramImages(env);
    } catch (e) {
      console.error('scheduled rotateProgramImages:', e.message);
    }
  },
};

async function handleQueueMessage(body, env) {
  const d = typeof body === 'string' ? JSON.parse(body) : body;
  console.log('queue msg received, body keys:', d ? Object.keys(d).join(',') : 'null');
  if (!d) return;
  const date = new Date(d.date);
  // Share-link task (parse-video service)
  if (d.link) {
    await processShareLinkAsync(d.dbId, d.link, d.chatId, d.msgId, d.chat || {}, d.from || {}, date, env);
    return;
  }
  if (!d.fi) { console.log('queue msg missing fi:', JSON.stringify(d).slice(0, 200)); return; }
  // 校验 dbId：INSERT 失败时 dbId 为 null，跳过处理避免幽灵转存
  if (!d.dbId) {
    console.log('queue msg missing dbId (INSERT likely failed), skipping file:', d.fi.fileName);
    return;
  }
  await processFileAsync(d.dbId, d.fi, d.chatId, d.msgId, d.chat || {}, d.from || {}, date, env, d.ref || '');
}

// ==================== DB ====================
// ensureTablesOnce 已移入 src/db.js，由顶部 import 引入（冷启动每 isolate 一次，复用避免每次请求多秒 D1 开销）。

// D1 降级模式：GET 查当前模式 / POST 手动切换（d1|mysql|auto）
async function handleDbModeGet(env) {
  try {
    const m = await currentMode(env);
    const fs = await mysqlFailoverGet(env);
    // 真实连通测试：直接执行 SELECT 1，暴露 Hyperdrive 实际错误
    let ping = { ok: false, error: 'not attempted' };
    try {
      const r = await mysqlRows(env, 'SELECT 1 AS one', []);
      ping = { ok: true, one: r && r[0] && r[0].one };
    } catch (e) { ping = { ok: false, error: String(e && e.message || e), name: e && e.name }; }
    const hd = env.telequnphoto;
    // 探测 nodejs_compat 是否生效（process/globalThis 特征）
    let runtime = {};
    try { runtime = { hasProcess: typeof process !== 'undefined', nodeVer: typeof process !== 'undefined' && process.versions ? process.versions.node : null }; } catch (e) {}
    // 动态探测 node:net 是否提供真实 connect
    try {
      const nm = await import('node:net');
      runtime.hasNet = !!nm && typeof nm.connect === 'function';
      runtime.netKeys = nm ? Object.keys(nm).slice(0, 20) : [];
    } catch (e) { runtime.netErr = String(e && e.message || e); }
    return json({ ok: true, data: { current: m.mode, source: m.source, manual: fs, hd: !!hd, hdFields: hd ? { host: hd.host, port: hd.port, user: hd.user, database: hd.database } : null, runtime: runtime, ping: ping } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleDbModeSet(request, env) {
  try {
    const b = await request.json().catch(function(){ return {}; });
    const r = await setMode(env, b.mode, b.reason || '');
    return r.ok ? json({ ok: true, data: r }) : json(r, 400);
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleDbTestMysql(env) {
  try {
    const { withConn } = await import('./src/mysql.js');
    const result = await withConn(env, async (c) => {
      const [rows] = await c.query('SELECT 1 as ok');
      const [ver] = await c.query('SELECT VERSION() as v');
      const [tables] = await c.query('SHOW TABLES');
      return { ok: rows[0]?.ok === 1, version: ver[0]?.v || 'unknown', tables: tables.map(r => Object.values(r)[0]) };
    });
    return json({ ok: true, data: result });
  } catch (e) {
    return json({ ok: false, error: e.message, hint: '检查 Hyperdrive 绑定和 MySQL 服务是否正常' });
  }
}

async function handleDbRebuildMysql(env) {
  try {
    const { ensureMySQLTables, resetMySQLTablesEnsured } = await import('./src/mysql.js');
    resetMySQLTablesEnsured();
    const ok = await ensureMySQLTables(env);
    // 获取实际表数量
    const { withConn } = await import('./src/mysql.js');
    const result = await withConn(env, async (c) => {
      const [tables] = await c.query('SHOW TABLES');
      return { count: tables.length, tables: tables.map(r => Object.values(r)[0]) };
    });
    return json({ ok: true, data: { ...result, ensureOk: ok } });
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
}

// 强制同步：逐表从 D1 读取 → INSERT 到 MySQL，返回详细结果
async function handleDbForceSync(request, env) {
  try {
    const b = await request.json().catch(() => ({}));
    const table = b.table || 'files';
    const limit = Math.min(parseInt(b.limit) || 50, 200);
    const TABLE_MAP = {
      files: { d1: "SELECT * FROM files WHERE deleted_at IS NULL LIMIT ?", mysql: "INSERT INTO files (id,storage_key,r2_url,chat_id,chat_title,chat_type,chat_username,user_id,username,full_name,telegram_file_id,file_name,file_size,file_type,mime_type,width,height,caption,message_id,md5_hash,processing_state,created_at,tags,group_ref,media_group_id,level,is_private,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE storage_key=VALUES(storage_key)", fields: 28 },
      random_pool: { d1: "SELECT * FROM random_pool LIMIT ?", mysql: "INSERT INTO random_pool (id,url,thumb_url,title,tags,file_type,width,height,file_size,source,tg_file_id,enabled,created_at,level,is_private) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE url=VALUES(url)", fields: 15 },
      user_uploads: { d1: "SELECT * FROM user_uploads WHERE deleted_at IS NULL LIMIT ?", mysql: "INSERT INTO user_uploads (id,user_id,url,thumb_url,file_name,file_size,file_type,width,height,tags,created_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE url=VALUES(url)", fields: 12 },
      settings: { d1: "SELECT * FROM settings LIMIT ?", mysql: "INSERT INTO settings (`key`,`value`) VALUES (?,?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)", fields: 2 },
      api_keys: { d1: "SELECT * FROM api_keys LIMIT ?", mysql: "INSERT INTO api_keys (id,`key`,name,scopes,enabled,created_at,last_used_at,usage_count,expires_at,level,key_pass,username) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)", fields: 12 },
      known_chats: { d1: "SELECT * FROM known_chats LIMIT ?", mysql: "INSERT INTO known_chats (chat_id,chat_type,chat_title,chat_username,last_active_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE chat_title=VALUES(chat_title)", fields: 5 },
      bot_commands: { d1: "SELECT * FROM bot_commands LIMIT ?", mysql: "INSERT INTO bot_commands (id,command,response,description,enabled,created_at,menu) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE response=VALUES(response)", fields: 7 },
      bot_config: { d1: "SELECT * FROM bot_config LIMIT ?", mysql: "INSERT INTO bot_config (`key`,`value`) VALUES (?,?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)", fields: 2 },
      redeem_codes: { d1: "SELECT * FROM redeem_codes LIMIT ?", mysql: "INSERT INTO redeem_codes (id,code,level,quota,used_count,note,enabled,created_at,expires_at,type,extend_days) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE code=VALUES(code)", fields: 11 },
      show_groups: { d1: "SELECT * FROM show_groups LIMIT ?", mysql: "INSERT INTO show_groups (id,name,images,created_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),images=VALUES(images)", fields: 4 },
      tags: { d1: "SELECT * FROM tags LIMIT ?", mysql: "INSERT INTO tags (id,name,color,category,sort_order,created_at) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)", fields: 6 },
      user_stats: { d1: "SELECT * FROM user_stats LIMIT ?", mysql: "INSERT INTO user_stats (user_id,username,full_name,messages,commands,files,inline_queries,callback_clicks,last_active_at) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE messages=VALUES(messages),commands=VALUES(commands)", fields: 9 },
      rate_limits: { d1: "SELECT * FROM rate_limits LIMIT ?", mysql: "INSERT INTO rate_limits (id,`key`,window,count) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE count=VALUES(count)", fields: 4 },
      worker_stats: { d1: "SELECT * FROM worker_stats LIMIT ?", mysql: "INSERT INTO worker_stats (day,requests,errors,updated_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE requests=VALUES(requests),errors=VALUES(errors)", fields: 4 },
      api_call_logs: { d1: "SELECT * FROM api_call_logs LIMIT ?", mysql: "INSERT INTO api_call_logs (id,key_id,api_key,path,method,ip,status,created_at) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status)", fields: 8 },
      folders: { d1: "SELECT * FROM folders LIMIT ?", mysql: "INSERT INTO folders (id,name,parent_id,created_at,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)", fields: 5 },
      webhook_logs: { d1: "SELECT * FROM webhook_logs LIMIT ?", mysql: "INSERT INTO webhook_logs (id,status,ok,source,error,created_at) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status)", fields: 6 },
    };
    const cfg = TABLE_MAP[table];
    if (!cfg) return json({ ok: false, error: '未知表: ' + table + '，可选: ' + Object.keys(TABLE_MAP).join(',') });
    
    // 读 D1
    const d1Result = await env.D1_DB.prepare(cfg.d1).bind(limit).all();
    const rows = d1Result.results || [];
    if (rows.length === 0) return json({ ok: true, data: { table, d1Count: 0, synced: 0, errors: [] } });
    
    // 逐条 INSERT 到 MySQL，收集错误
    const { mysqlExec } = await import('./src/mysql.js');
    let synced = 0;
    const errors = [];
    for (const row of rows) {
      try {
        const vals = Object.values(row);
        await mysqlExec(env, cfg.mysql, vals);
        synced++;
      } catch (e) {
        if (errors.length < 5) errors.push({ id: row.id, error: e.message });
      }
    }
    return json({ ok: true, data: { table, d1Count: rows.length, synced, errorCount: rows.length - synced, errors } });
  } catch (e) { return json({ ok: false, error: e.message }); }
}

async function handleDbStats(env) {
  try {
    const stats = { sync_status: '正常', last_sync: '-', diff_count: '0', d1: {}, mysql: {} };
    const TABLES = ['files', 'random_pool', 'user_uploads', 'settings', 'api_keys', 'known_chats', 'user_stats', 'bot_commands', 'bot_config', 'redeem_codes', 'show_groups', 'tags', 'rate_limits', 'worker_stats', 'api_call_logs', 'folders', 'webhook_logs'];
    
    // D1 统计
    for (const t of TABLES) {
      try {
        const q = (t === 'files' || t === 'user_uploads') ? `SELECT COUNT(*) as c FROM ${t} WHERE deleted_at IS NULL` : `SELECT COUNT(*) as c FROM ${t}`;
        const r = await env.D1_DB.prepare(q).first();
        stats.d1[t] = r?.c || 0;
      } catch (e) { stats.d1[t] = 0; }
    }
    
    // MySQL 统计
    for (const t of TABLES) {
      try {
        const q = (t === 'files' || t === 'user_uploads') ? `SELECT COUNT(*) as c FROM ${t} WHERE deleted_at IS NULL` : `SELECT COUNT(*) as c FROM ${t}`;
        const r = await mysqlRows(env, q, []);
        stats.mysql[t] = r[0]?.c || 0;
      } catch (e) { stats.mysql[t] = 0; }
    }
    
    // 同步状态（计算所有表差异）
    let totalDiff = 0;
    for (const t of TABLES) {
      totalDiff += Math.abs((stats.d1[t] || 0) - (stats.mysql[t] || 0));
    }
    stats.diff_count = totalDiff;
    stats.sync_status = totalDiff === 0 ? '正常' : '有差异';
    
    // 获取最后同步时间
    try {
      const syncInfo = await env.D1_DB.prepare("SELECT value FROM settings WHERE key='db_sync_info'").first();
      if (syncInfo && syncInfo.value) {
        const info = JSON.parse(syncInfo.value);
        stats.last_sync = info.last_sync || '-';
      }
    } catch (e) {}
    
    return json({ ok: true, data: stats });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

async function handleDbSync(env) {
  try {
    let syncedFiles = 0, syncedPool = 0, syncedUploads = 0;
    let errors = [];
    
    // 记录同步开始时间
    const syncStart = Date.now();
    
    if (env.D1_DB) {
      // 批量同步 files 表（每次 100 条）
      try {
        const d1Files = await env.D1_DB.prepare("SELECT id, storage_key, r2_url, chat_id, chat_title, chat_type, chat_username, user_id, username, full_name, telegram_file_id, file_name, file_size, file_type, mime_type, width, height, caption, message_id, md5_hash, processing_state, created_at, tags, group_ref, media_group_id, level, is_private, deleted_at FROM files WHERE deleted_at IS NULL").all();
        const files = d1Files.results || [];
        
        // 分批处理
        for (let i = 0; i < files.length; i += 100) {
          const batch = files.slice(i, i + 100);
          const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
          const params = [];
          for (const f of batch) {
            params.push(f.id, f.storage_key, f.r2_url, f.chat_id, f.chat_title, f.chat_type, f.chat_username,
              f.user_id, f.username, f.full_name, f.telegram_file_id, f.file_name, f.file_size,
              f.file_type, f.mime_type, f.width, f.height, f.caption, f.message_id, f.md5_hash,
              f.processing_state, f.created_at, f.tags, f.group_ref, f.media_group_id, f.level, f.is_private, f.deleted_at);
          }
          try {
            await mysqlExec(env, `INSERT INTO files (id, storage_key, r2_url, chat_id, chat_title, chat_type, chat_username, user_id, username, full_name, telegram_file_id, file_name, file_size, file_type, mime_type, width, height, caption, message_id, md5_hash, processing_state, created_at, tags, group_ref, media_group_id, level, is_private, deleted_at) VALUES ${values} ON DUPLICATE KEY UPDATE storage_key=VALUES(storage_key), r2_url=VALUES(r2_url), processing_state=VALUES(processing_state), deleted_at=VALUES(deleted_at)`, params);
            syncedFiles += batch.length;
          } catch (e) { errors.push('files batch ' + (i/100+1) + ': ' + e.message); }
        }
      } catch (e) { errors.push('files: ' + e.message); }
      
      // 批量同步 random_pool 表
      try {
        const d1Pool = await env.D1_DB.prepare("SELECT id, url, thumb_url, title, tags, file_type, width, height, file_size, source, tg_file_id, enabled, created_at, level, is_private FROM random_pool").all();
        const pool = d1Pool.results || [];
        if (pool.length > 0) {
          const values = pool.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
          const params = [];
          for (const p of pool) {
            params.push(p.id, p.url, p.thumb_url, p.title, p.tags, p.file_type, p.width, p.height,
              p.file_size, p.source, p.tg_file_id, p.enabled, p.created_at, p.level, p.is_private);
          }
          try {
            await mysqlExec(env, `INSERT INTO random_pool (id, url, thumb_url, title, tags, file_type, width, height, file_size, source, tg_file_id, enabled, created_at, level, is_private) VALUES ${values} ON DUPLICATE KEY UPDATE url=VALUES(url), thumb_url=VALUES(thumb_url), tags=VALUES(tags), enabled=VALUES(enabled), level=VALUES(level), is_private=VALUES(is_private)`, params);
            syncedPool = pool.length;
          } catch (e) { errors.push('pool: ' + e.message); }
        }
      } catch (e) { errors.push('pool: ' + e.message); }
      
      // 批量同步 user_uploads 表
      try {
        const d1Uploads = await env.D1_DB.prepare("SELECT id, user_id, url, thumb_url, file_name, file_size, file_type, width, height, tags, created_at, deleted_at FROM user_uploads WHERE deleted_at IS NULL").all();
        const uploads = d1Uploads.results || [];
        if (uploads.length > 0) {
          const values = uploads.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
          const params = [];
          for (const u of uploads) {
            params.push(u.id, u.user_id, u.url, u.thumb_url, u.file_name, u.file_size, u.file_type,
              u.width, u.height, u.tags, u.created_at, u.deleted_at);
          }
          try {
            await mysqlExec(env, `INSERT INTO user_uploads (id, user_id, url, thumb_url, file_name, file_size, file_type, width, height, tags, created_at, deleted_at) VALUES ${values} ON DUPLICATE KEY UPDATE url=VALUES(url), thumb_url=VALUES(thumb_url), tags=VALUES(tags), deleted_at=VALUES(deleted_at)`, params);
            syncedUploads = uploads.length;
          } catch (e) { errors.push('uploads: ' + e.message); }
        }
      } catch (e) { errors.push('uploads: ' + e.message); }
    }
    
    const elapsed = ((Date.now() - syncStart) / 1000).toFixed(1);
    const total = syncedFiles + syncedPool + syncedUploads;
    
    // 记录同步时间到 settings
    try {
      const syncInfo = JSON.stringify({ last_sync: cnNowISO(), synced: total, elapsed: elapsed + 's' });
      await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('db_sync_info', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(syncInfo).run();
    } catch (e) {}
    
    const msg = '同步完成（' + elapsed + 's）：files=' + syncedFiles + ', pool=' + syncedPool + ', uploads=' + syncedUploads + (errors.length ? '，错误：' + errors.slice(0, 3).join('; ') : '');
    return json({ ok: true, data: { message: msg, synced: total, files: syncedFiles, pool: syncedPool, uploads: syncedUploads, elapsed: elapsed + 's', errors: errors.slice(0, 10) } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// 全量同步：同步所有表到 MySQL（批量优化版）
async function handleDbFullSync(env) {
  try {
    const syncStart = Date.now();
    let counts = { files: 0, pool: 0, uploads: 0, settings: 0, api_keys: 0, known_chats: 0, bot_commands: 0, bot_config: 0, redeem_codes: 0, show_groups: 0, tags: 0, user_stats: 0, rate_limits: 0, worker_stats: 0, api_call_logs: 0, folders: 0, webhook_logs: 0 };
    let errors = [];
    
    if (!env.D1_DB) return json({ ok: false, error: 'D1 not available' }, 500);
    
    // 批量同步辅助函数
    async function batchSync(tableName, d1Query, mysqlInsert, fieldCount) {
      try {
        const result = await env.D1_DB.prepare(d1Query).all();
        const rows = result.results || [];
        if (rows.length === 0) return 0;
        
        // 分批处理，每批 50 条
        for (let i = 0; i < rows.length; i += 50) {
          const batch = rows.slice(i, i + 50);
          const placeholders = batch.map(() => '(' + Array(fieldCount).fill('?').join(',') + ')').join(',');
          const params = [];
          for (const row of batch) {
            params.push(...mysqlInsert.getParams(row));
          }
          try {
            await mysqlExec(env, mysqlInsert.sql(placeholders), params);
          } catch (e) { errors.push(tableName + ' batch: ' + e.message); }
        }
        return rows.length;
      } catch (e) { errors.push(tableName + ': ' + e.message); return 0; }
    }
    
    // 同步 files
    counts.files = await batchSync('files',
      "SELECT id, storage_key, r2_url, chat_id, chat_title, chat_type, chat_username, user_id, username, full_name, telegram_file_id, file_name, file_size, file_type, mime_type, width, height, caption, message_id, md5_hash, processing_state, created_at, tags, group_ref, media_group_id, level, is_private, deleted_at FROM files WHERE deleted_at IS NULL",
      {
        sql: (ph) => `INSERT INTO files (id, storage_key, r2_url, chat_id, chat_title, chat_type, chat_username, user_id, username, full_name, telegram_file_id, file_name, file_size, file_type, mime_type, width, height, caption, message_id, md5_hash, processing_state, created_at, tags, group_ref, media_group_id, level, is_private, deleted_at) VALUES ${ph} ON DUPLICATE KEY UPDATE storage_key=VALUES(storage_key), r2_url=VALUES(r2_url), processing_state=VALUES(processing_state)`,
        getParams: (f) => [f.id, f.storage_key, f.r2_url, f.chat_id, f.chat_title, f.chat_type, f.chat_username, f.user_id, f.username, f.full_name, f.telegram_file_id, f.file_name, f.file_size, f.file_type, f.mime_type, f.width, f.height, f.caption, f.message_id, f.md5_hash, f.processing_state, f.created_at, f.tags, f.group_ref, f.media_group_id, f.level, f.is_private, f.deleted_at]
      }, 28);
    
    // 同步 random_pool
    counts.pool = await batchSync('pool',
      "SELECT id, url, thumb_url, title, tags, file_type, width, height, file_size, source, tg_file_id, enabled, created_at, level, is_private FROM random_pool",
      {
        sql: (ph) => `INSERT INTO random_pool (id, url, thumb_url, title, tags, file_type, width, height, file_size, source, tg_file_id, enabled, created_at, level, is_private) VALUES ${ph} ON DUPLICATE KEY UPDATE url=VALUES(url), tags=VALUES(tags), enabled=VALUES(enabled)`,
        getParams: (p) => [p.id, p.url, p.thumb_url, p.title, p.tags, p.file_type, p.width, p.height, p.file_size, p.source, p.tg_file_id, p.enabled, p.created_at, p.level, p.is_private]
      }, 15);
    
    // 同步 user_uploads
    counts.uploads = await batchSync('uploads',
      "SELECT id, user_id, url, thumb_url, file_name, file_size, file_type, width, height, tags, created_at, deleted_at FROM user_uploads WHERE deleted_at IS NULL",
      {
        sql: (ph) => `INSERT INTO user_uploads (id, user_id, url, thumb_url, file_name, file_size, file_type, width, height, tags, created_at, deleted_at) VALUES ${ph} ON DUPLICATE KEY UPDATE url=VALUES(url), tags=VALUES(tags)`,
        getParams: (u) => [u.id, u.user_id, u.url, u.thumb_url, u.file_name, u.file_size, u.file_type, u.width, u.height, u.tags, u.created_at, u.deleted_at]
      }, 12);
    
    // 同步 settings
    counts.settings = await batchSync('settings',
      "SELECT key, value FROM settings",
      {
        sql: (ph) => `INSERT INTO settings (\`key\`, value) VALUES ${ph} ON DUPLICATE KEY UPDATE value=VALUES(value)`,
        getParams: (s) => [s.key, s.value]
      }, 2);
    
    // 同步 api_keys
    counts.api_keys = await batchSync('api_keys',
      "SELECT id, key, name, scopes, enabled, created_at, last_used_at, usage_count, expires_at, level, key_pass, username FROM api_keys",
      {
        sql: (ph) => `INSERT INTO api_keys (id, \`key\`, name, scopes, enabled, created_at, last_used_at, usage_count, expires_at, level, key_pass, username) VALUES ${ph} ON DUPLICATE KEY UPDATE name=VALUES(name), scopes=VALUES(scopes), enabled=VALUES(enabled)`,
        getParams: (k) => [k.id, k.key, k.name, k.scopes, k.enabled, k.created_at, k.last_used_at, k.usage_count, k.expires_at, k.level, k.key_pass, k.username]
      }, 12);
    
    // 同步 known_chats
    counts.known_chats = await batchSync('chats',
      "SELECT chat_id, chat_type, chat_title, chat_username, last_active_at FROM known_chats",
      {
        sql: (ph) => `INSERT INTO known_chats (chat_id, chat_type, chat_title, chat_username, last_active_at) VALUES ${ph} ON DUPLICATE KEY UPDATE chat_type=VALUES(chat_type), chat_title=VALUES(chat_title)`,
        getParams: (c) => [c.chat_id, c.chat_type, c.chat_title, c.chat_username, c.last_active_at]
      }, 5);
    
    // 同步 bot_commands
    counts.bot_commands = await batchSync('commands',
      "SELECT id, command, response, description, enabled, created_at, menu FROM bot_commands",
      {
        sql: (ph) => `INSERT INTO bot_commands (id, command, response, description, enabled, created_at, menu) VALUES ${ph} ON DUPLICATE KEY UPDATE command=VALUES(command), response=VALUES(response), enabled=VALUES(enabled)`,
        getParams: (cmd) => [cmd.id, cmd.command, cmd.response, cmd.description, cmd.enabled, cmd.created_at, cmd.menu]
      }, 7);
    
    // 同步 bot_config
    counts.bot_config = await batchSync('config',
      "SELECT key, value FROM bot_config",
      {
        sql: (ph) => `INSERT INTO bot_config (\`key\`, value) VALUES ${ph} ON DUPLICATE KEY UPDATE value=VALUES(value)`,
        getParams: (c) => [c.key, c.value]
      }, 2);
    
    // 同步 redeem_codes
    counts.redeem_codes = await batchSync('codes',
      "SELECT id, code, level, quota, used_count, note, enabled, created_at, expires_at, type, extend_days FROM redeem_codes",
      {
        sql: (ph) => `INSERT INTO redeem_codes (id, code, level, quota, used_count, note, enabled, created_at, expires_at, type, extend_days) VALUES ${ph} ON DUPLICATE KEY UPDATE code=VALUES(code), level=VALUES(level), enabled=VALUES(enabled)`,
        getParams: (c) => [c.id, c.code, c.level, c.quota, c.used_count, c.note, c.enabled, c.created_at, c.expires_at, c.type, c.extend_days]
      }, 11);
    
    // 同步 show_groups
    counts.show_groups = await batchSync('groups',
      "SELECT id, name, images, created_at FROM show_groups",
      {
        sql: (ph) => `INSERT INTO show_groups (id, name, images, created_at) VALUES ${ph} ON DUPLICATE KEY UPDATE name=VALUES(name), images=VALUES(images)`,
        getParams: (g) => [g.id, g.name, g.images, g.created_at]
      }, 4);
    
    // 同步 tags
    counts.tags = await batchSync('tags',
      "SELECT id, name, color, category, sort_order, created_at FROM tags",
      {
        sql: (ph) => `INSERT INTO tags (id, name, color, category, sort_order, created_at) VALUES ${ph} ON DUPLICATE KEY UPDATE name=VALUES(name), color=VALUES(color), category=VALUES(category)`,
        getParams: (t) => [t.id, t.name, t.color, t.category, t.sort_order, t.created_at]
      }, 6);
    
    // 同步 user_stats
    counts.user_stats = await batchSync('user_stats',
      "SELECT user_id, username, full_name, messages, commands, files, inline_queries, callback_clicks, last_active_at FROM user_stats",
      {
        sql: (ph) => `INSERT INTO user_stats (user_id, username, full_name, messages, commands, files, inline_queries, callback_clicks, last_active_at) VALUES ${ph} ON DUPLICATE KEY UPDATE username=VALUES(username), messages=VALUES(messages), files=VALUES(files)`,
        getParams: (s) => [s.user_id, s.username, s.full_name, s.messages, s.commands, s.files, s.inline_queries, s.callback_clicks, s.last_active_at]
      }, 9);
    
    const elapsed = ((Date.now() - syncStart) / 1000).toFixed(1);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    
    // 记录同步时间
    try {
      const syncInfo = JSON.stringify({ last_sync: cnNowISO(), synced: total, elapsed: elapsed + 's', type: 'full' });
      await env.D1_DB.prepare("INSERT INTO settings (key, value) VALUES ('db_sync_info', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(syncInfo).run();
    } catch (e) {}
    
    const msg = '全量同步完成（' + elapsed + 's）：' + Object.entries(counts).map(([k,v]) => k + '=' + v).join(', ') + (errors.length ? '，错误：' + errors.slice(0, 5).join('; ') : '');
    return json({ ok: true, data: { message: msg, counts: counts, elapsed: elapsed + 's', errors: errors.slice(0, 20) } });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}


// 剩余区块（WEBHOOK/API HANDLERS/Public slideshow/事件通知/ADMIN API/ADMIN PAGE/DOCS/DASHBOARD/群资源编号/批量编号/告警限流配置）
// 已分别拆分到 src/webhook.js、src/api.js、src/public.js、src/events.js、src/admin.js、src/pages.js、src/batch.js、src/notify.js，
// 由顶部 import 引入。本文件仅保留入口路由与队列消息处理。

