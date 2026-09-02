<?php
/**
 * TeleQunPhoto VPS API - PHP 后端
 * 供 Python userbot 调用，将相册数据存入 VPS 本地 MySQL
 * 
 * 端点：
 *   POST /api.php?action=albums.report   批量上报相册元数据
 *   GET  /api.php?action=albums.existing  获取已有 grouped_id 列表
 *   POST /api.php?action=albums.select    保存选中的 msg_ids
 *   GET  /api.php?action=albums.filemap   获取 file_id 映射
 *   POST /api.php?action=progress.update  更新扫描进度
 *   GET  /api.php?action=task.config      获取任务配置
 *   POST /api.php?action=task.progress    回写断点
 *   GET  /api.php?action=health           健康检查
 */

header('Content-Type: application/json; charset=utf-8');

// MySQL 配置
define('DB_HOST', '127.0.0.1');
define('DB_PORT', 3306);
define('DB_NAME', 'telequnphoto');
define('DB_USER', 'telequnphoto');
define('DB_PASS', 'telequnphoto');

// 简易 token 鉴权（从 Worker 同步）
$UB_TOKEN = getenv('UB_TOKEN') ?: '';

function db() {
    static $pdo = null;
    if ($pdo === null) {
        $dsn = "mysql:host=" . DB_HOST . ";port=" . DB_PORT . ";dbname=" . DB_NAME . ";charset=utf8mb4";
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    }
    return $pdo;
}

function ok($data = [], $code = 200) {
    http_response_code($code);
    echo json_encode(array_merge(['ok' => true], $data));
    exit;
}

function fail($error, $code = 400) {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $error]);
    exit;
}

function checkToken() {
    global $UB_TOKEN;
    if (!$UB_TOKEN) return; // 未配置 token 时跳过鉴权（本地调用）
    $tok = $_GET['token'] ?? $_SERVER['HTTP_X_UB_TOKEN'] ?? '';
    if ($tok !== $UB_TOKEN) fail('Unauthorized', 401);
}

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body = null;
if ($method === 'POST') {
    $raw = file_get_contents('php://input');
    $body = json_decode($raw, true) ?: [];
}

switch ($action) {

// ==================== 健康检查 ====================
case 'health':
    try {
        db()->query('SELECT 1');
        ok(['data' => ['mysql' => 'ok', 'time' => date('c')]]);
    } catch (Exception $e) {
        fail('MySQL error: ' . $e->getMessage(), 500);
    }
    break;

// ==================== 批量上报相册 ====================
case 'albums.report':
    checkToken();
    $albums = $body['albums'] ?? [];
    $append = ($body['append'] ?? 0) == 1;
    $cursor = intval($body['cursor'] ?? 0);
    $taskId = intval($body['task_id'] ?? 0);
    if (!$taskId) fail('task_id required');
    if (!$albums) ok(['data' => ['stored' => 0]]);

    $pdo = db();
    if (!$append) {
        $stmt = $pdo->prepare('DELETE FROM ubot_albums WHERE task_id = ?');
        $stmt->execute([$taskId]);
    }

    $stmt = $pdo->prepare('INSERT IGNORE INTO ubot_albums (task_id, grouped_id, msg_ids, mcount, sizes, cover_url, first_ts, has_oversize, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())');
    $stored = 0;
    foreach ($albums as $a) {
        $gid = substr($a['grouped_id'] ?? '', 0, 64);
        if (!$gid) continue;
        $msgIds = array_filter(array_map('strval', $a['msg_ids'] ?? []), function($x) { return preg_match('/^\d+$/', $x); });
        $msgIds = array_slice($msgIds, 0, 500);
        if (!$msgIds) continue;
        $sizes = $a['sizes'] ?? [];
        $sizesArr = [];
        foreach (array_slice($sizes, 0, 500) as $s) {
            $fid = substr($s['file_id'] ?? '', 0, 200);
            $sizesArr[] = [
                'id' => intval($s['id'] ?? 0),
                'size' => intval($s['size'] ?? 0),
                'w' => intval($s['w'] ?? 0),
                'h' => intval($s['h'] ?? 0),
                'thumb_url' => substr($s['thumb_url'] ?? ($fid ? '/api/tg-proxy?file_id=' . $fid : ''), 0, 500),
                'type' => $s['type'] ?? 'photo',
                'duration' => intval($s['duration'] ?? 0),
                'file_id' => $fid,
            ];
        }
        $stmt->execute([
            $taskId, $gid, implode(',', $msgIds), count($msgIds),
            json_encode($sizesArr), substr($a['cover_url'] ?? '', 0, 500),
            intval($a['first_ts'] ?? 0), ($a['has_oversize'] ?? false) ? 1 : 0
        ]);
        $stored++;
    }

    // 回写游标
    $upd = $pdo->prepare("UPDATE userbot_tasks SET mode='normal', album_cursor=?, updated_at=NOW() WHERE id=? AND mode='list'");
    $upd->execute([$cursor, $taskId]);

    ok(['data' => ['stored' => $stored, 'cursor' => $cursor]]);
    break;

// ==================== 获取已有 grouped_id ====================
case 'albums.existing':
    checkToken();
    $taskId = intval($_GET['task_id'] ?? 0);
    if (!$taskId) fail('task_id required');

    $pdo = db();
    $stmt = $pdo->prepare('SELECT grouped_id FROM ubot_albums WHERE task_id = ? LIMIT 50000');
    $stmt->execute([$taskId]);
    $gids = array_column($stmt->fetchAll(), 'grouped_id');
    ok(['data' => ['grouped_ids' => $gids, 'total' => count($gids)]]);
    break;

// ==================== 获取 file_id 映射 ====================
case 'albums.filemap':
    checkToken();
    $taskId = intval($_GET['task_id'] ?? 0);
    $selectedStr = $_GET['selected'] ?? '';
    if (!$taskId) fail('task_id required');

    $selected = array_filter(explode(',', $selectedStr), function($x) { return preg_match('/^\d+$/', trim($x)); });
    $selSet = array_flip($selected);

    $pdo = db();
    $stmt = $pdo->prepare('SELECT sizes FROM ubot_albums WHERE task_id = ?');
    $stmt->execute([$taskId]);
    $fileMap = [];
    foreach ($stmt->fetchAll() as $row) {
        $sizes = json_decode($row['sizes'] ?? '[]', true) ?: [];
        foreach ($sizes as $s) {
            $sid = strval($s['id'] ?? '');
            if (isset($selSet[$sid]) && !empty($s['file_id'])) {
                $fileMap[$sid] = $s['file_id'];
            }
        }
    }
    ok(['data' => $fileMap]);
    break;

// ==================== 更新扫描进度 ====================
case 'progress.update':
    checkToken();
    $taskId = intval($body['task_id'] ?? 0);
    if (!$taskId) fail('task_id required');

    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO ubot_scan_progress (task_id, phase, scanned_msgs, media_count, video_count, albums_count, elapsed_s, scan_limit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE phase=VALUES(phase), scanned_msgs=VALUES(scanned_msgs), media_count=VALUES(media_count), video_count=VALUES(video_count), albums_count=VALUES(albums_count), elapsed_s=VALUES(elapsed_s), scan_limit=VALUES(scan_limit), updated_at=NOW()');
    $stmt->execute([
        $taskId, $body['phase'] ?? '', intval($body['scanned_msgs'] ?? 0),
        intval($body['media_count'] ?? 0), intval($body['video_count'] ?? 0),
        intval($body['albums_count'] ?? 0), intval($body['elapsed_s'] ?? 0),
        intval($body['scan_limit'] ?? 100000)
    ]);
    ok(['data' => ['saved' => true]]);
    break;

// ==================== 获取任务配置 ====================
case 'task.config':
    checkToken();
    $taskId = intval($_GET['task_id'] ?? 0);
    if (!$taskId) fail('task_id required');

    $pdo = db();
    $stmt = $pdo->prepare('SELECT * FROM ubot_tasks WHERE id = ?');
    $stmt->execute([$taskId]);
    $task = $stmt->fetch();
    if (!$task) fail('task not found', 404);
    ok(['data' => ['task' => $task]]);
    break;

// ==================== 回写断点 ====================
case 'task.progress':
    checkToken();
    $taskId = intval($body['task_id'] ?? 0);
    if (!$taskId) fail('task_id required');

    $pdo = db();
    $sets = ['last_id=?', 'done=?', 'skipped=?', 'updated_at=NOW()'];
    $vals = [
        intval($body['last_id'] ?? 0),
        intval($body['done'] ?? 0),
        intval($body['skipped'] ?? 0),
    ];
    if (isset($body['scan_progress'])) {
        $sets[] = 'scan_progress=?';
        $vals[] = substr($body['scan_progress'], 0, 1000);
    }
    if (isset($body['mode'])) {
        $sets[] = 'mode=?';
        $vals[] = in_array($body['mode'], ['normal', 'list', 'selected']) ? $body['mode'] : 'normal';
    }
    $vals[] = $taskId;
    $stmt = $pdo->prepare('UPDATE userbot_tasks SET ' . implode(',', $sets) . ' WHERE id=?');
    $stmt->execute($vals);
    ok(['data' => ['saved' => true]]);
    break;

default:
    fail('Unknown action: ' . $action, 404);
}
