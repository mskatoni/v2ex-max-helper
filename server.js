// server.js — 轻量 HTTP 服务，供 Render 和外部 pinger 使用
const http = require('http');

const PORT = process.env.PORT || 8080;
const startTime = new Date();

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
    const mem = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime_seconds: uptime,
      service: 'v2ex-max-helper',
      timestamp: new Date().toISOString(),
      memory_mb: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heap_used: Math.round(mem.heapUsed / 1024 / 1024),
      }
    }));
    return;
  }

  // 拒绝其他路径（减少信息暴露）
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Health endpoint listening on port ${PORT}`);
});

// 优雅退出
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});
