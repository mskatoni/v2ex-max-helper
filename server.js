'use strict';
// server.js — 轻量 HTTP 服务，供 Render 和外部 pinger 使用
const http = require('http');

const PORT = Number(process.env.PORT || 8080);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
const startTime = new Date();

function send(res, statusCode, contentType, body, headOnly = false) {
  const payload = Buffer.from(body);
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'Connection': 'close',
    'Content-Security-Policy': "default-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(headOnly ? undefined : payload);
}

const server = http.createServer((req, res) => {
  req.on('error', () => {});
  req.resume();
  const headOnly = req.method === 'HEAD';
  if (req.method !== 'GET' && !headOnly) {
    send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed');
    return;
  }

  if (req.url === '/health' || req.url === '/') {
    const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
    send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
      status: 'ok',
      uptime_seconds: uptime,
      service: 'v2ex-max-helper',
      timestamp: new Date().toISOString(),
    }), headOnly);
    return;
  }

  // 拒绝其他路径（减少信息暴露）
  send(res, 404, 'text/plain; charset=utf-8', 'Not Found', headOnly);
});

server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 32;
server.maxConnections = 64;
server.maxRequestsPerSocket = 1;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Health endpoint listening on port ${PORT}`);
});

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
