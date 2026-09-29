# D1 与 MySQL 双写

D1 `telegram-url` 是主库。Hyperdrive 绑定 `telequnphoto` 连 VPS MySQL，作限额/故障备库。

## 1. 连接

`src/mysql.js`：`mysql2/promise`，`disableEval: true`（Workers 无 eval）。每次操作 `createConnection` 后关闭，连接池在 Hyperdrive。`wrangler.toml` `compatibility_date >= 2026-08-04` 才有真实 TCP。

## 2. 降级（dbaccess.js）

模式：`d1` / `mysql` / `auto`。管理员 `/admin/api/db-mode`。

auto：错误信息命中限额、502/503、timeout 等特征后进入 30s 降级窗口，避免每请求打坏 D1。手动模式 isolate 缓存 15s。

## 3. 双写

`dualInsertFiles` / `dualUpdateFiles` 在 webhook 入库路径调用。迁移：`GET /admin/api/migrate?table=&batch=`，MySQL `INSERT IGNORE`，游标存在 MySQL `settings`。`files` 每批 100，其它 500。

相关：`/admin/api/db-stats`、`db-test-mysql`、`db-rebuild-mysql`、`db-sync`、`db-full-sync`、`db-force-sync`。
