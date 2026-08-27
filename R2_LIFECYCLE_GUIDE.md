# R2 生命周期规则配置指南（CF Console，零代码）

> 目的：自动清理 R2 中无法通过代码删除的残留，控制存储成本。

## 规则 1：清理未完成的分片上传（必配，价值最高）

大文件（>50MB）走流式分片上传，若上传中途失败/Worker 被中断，
R2 会残留未完成的分片（multipart upload），这些分片照常计费，
且**只能**通过生命周期规则删除（API 无法直接删）。

操作步骤：
1. 打开 Cloudflare Dashboard → R2 → 你的 Bucket → **Settings**
2. **Lifecycle Rules** → **Add rule**
3. 配置：
   - **Rule name**: `abort-stale-multipart`
   - **Scoped to objects with a prefix**: 留空（全部对象）
   - **Abort multipart uploads that are more than**: `7 days`（默认值即可）
4. 保存

## 规则 2（可选）：临时/失败文件自动过期

如果你的 Worker 曾产生 `tmp_` / `failed_` 前缀的对象，可加：

- **Rule name**: `expire-tmp`
- **Prefix**: `tmp_`
- **Delete objects that are more than**: `7 days`

> 当前代码不使用临时前缀，此规则可跳过；孤儿对象用 Admin 面板
> 「回收站 → R2 孤儿对象 → 清理孤儿」按钮清理即可。

## 注意

- 生命周期规则每小时检查一次，不是实时生效
- 软删除的文件（回收站）不要配过期规则——它们需要保留到用户
  手动「彻底删除」，恢复功能依赖这些对象
