// 部署时自动注入后台版本号：v1.0.<GitHub run number>（每次 push 自动 +0.0.1）
// 不改仓库内容（只影响上传到 R2 的 admin.html 产物），避免触发循环构建
const fs = require('fs');
const ver = 'v1.0.' + (process.env.GITHUB_RUN_NUMBER || '0');
let h = fs.readFileSync('admin.html', 'utf8');
if (h.indexOf('APP_VERSION') === -1) {
  h = h.replace('</head>', '<meta name="app-version" content="' + ver + '"></head>');
} else {
  h = h.replace(/var APP_VERSION\s*=\s*"[^"]*"/, 'var APP_VERSION = "' + ver + '"');
}
fs.writeFileSync('admin.html', h);
console.log('bumped admin version -> ' + ver);
