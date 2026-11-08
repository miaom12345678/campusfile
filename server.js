/**
 * server.js —— 本地开发服务器（等价于 Vercel 的运行方式）
 * 用法：node server.js  → http://localhost:3000
 * 只是把 api/[...path].js 这个函数挂到 http 上，生产环境由 Vercel 托管，不需要它。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const handler = require('./api/index.js');
const PUB = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(u.pathname);

  if (pathname.startsWith('/api/')) {
    req.pathname = pathname;
    req.query = {};
    u.searchParams.forEach((v, k) => {
      req.query[k] = v;
    });
    return handler(req, res);
  }

  let file = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUB, file);
  if (!full.startsWith(PUB) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    // 无扩展名时回退到对应 .html
    const alt = full + '.html';
    if (fs.existsSync(alt)) file = file + '.html';
    else {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('404 Not Found');
    }
  }
  const target = path.join(PUB, file);
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[path.extname(target)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(target).pipe(res);
});

server.listen(PORT, () => {
  console.log('本地服务已启动：http://localhost:' + PORT);
  console.log('存储后端：', require('./lib/store').status());
});
