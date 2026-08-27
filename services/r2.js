/**
 * R2 存储服务
 */

export async function uploadToR2(key, buffer, contentType, env) {
  try {
    await env.R2_BUCKET.put(key, buffer, {
      httpMetadata: {
        contentType,
        cacheControl: 'public, max-age=31536000',
      },
    });
    return `${env.R2_PUBLIC_URL || ''}/${key}`;
  } catch (e) {
    console.error('R2 上传失败:', e);
    return null;
  }
}

export async function getFromR2(storageKey, env) {
  try {
    return await env.R2_BUCKET.get(storageKey);
  } catch (e) {
    console.error('R2 获取失败:', e);
    return null;
  }
}
