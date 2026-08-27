// 通用工具函数（纯函数，无依赖）
export function json(d, s) { return new Response(JSON.stringify(d), { status: s || 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-API-Key' } }); }
export function cors(d, s) { return new Response(d ? JSON.stringify(d) : null, { status: s || 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-API-Key' } }); }
export function fmtSize(b) { if (!b) return '0 B'; const k = 1024, s = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.floor(Math.log(b) / Math.log(k)); return (b / Math.pow(k, i)).toFixed(1) + ' ' + s[i]; }
export function genHash() { const c = 'abcdef0123456789'; const b = new Uint8Array(16); crypto.getRandomValues(b); let r = ''; for (let i = 0; i < b.length; i++) r += c[b[i] & 15]; return r; }
