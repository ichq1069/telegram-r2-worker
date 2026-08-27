/**
 * 后端通知服务
 */

export async function notifyBackend(data, env) {
  if (!env.BACKEND_API_URL) return;

  try {
    await fetch(env.BACKEND_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch (e) {
    console.error('通知后端失败:', e);
  }
}
