#!/usr/bin/env node
'use strict';
// ========== Feishu interactive bot (experimental, opt-in only) ==========

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../lib/config');
const profileLock = require('../lib/profile-lock');

const cfg = config.getConfig();
const LOCK_FILE = cfg.readerLockFile;

let tenantToken = '';
let tokenExpiresAt = 0;
const MAX_API_RESPONSE_BYTES = 64 * 1024;
const MAX_CALLBACK_BYTES = 1024 * 1024;
const MAX_DEBUG_READ_BYTES = 64 * 1024;
const MAX_DEBUG_REPLY_CHARS = 6000;

function maskId(id) {
  const s = String(id || '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function readJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function formatCoins(entry) {
  if (!entry) return '暂无记录';
  const parts = [];
  if (entry.gold) parts.push(`${entry.gold} 金币`);
  if (entry.silver) parts.push(`${entry.silver} 银币`);
  const copper = entry.copper !== undefined ? entry.copper : entry.last;
  parts.push(`${copper || 0} 铜币`);
  return parts.join(', ');
}

function buildBalanceText() {
  const status = readJsonFile(cfg.balanceStatus);
  const log = readJsonFile(cfg.balanceLog);
  const days = log
    ? Object.keys(log).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().reverse()
    : [];

  const lines = ['V2EX 余额记录'];
  if (!log || days.length === 0) {
    lines.push('今日：暂无记录');
  } else {
    const today = days[0];
    const yesterday = days[1];
    lines.push(`今日 (${today})：${formatCoins(log[today])}`);
    if (yesterday) lines.push(`昨日 (${yesterday})：${formatCoins(log[yesterday])}`);
  }

  if (status) {
    const ok = status.ok ? '成功' : '失败';
    const httpStatus = status.statusCode ? ` / HTTP ${status.statusCode}` : '';
    lines.push(`最近一次余额检查：${ok}${httpStatus}`);
    if (status.message || status.code) lines.push(`状态：${status.message || status.code}`);
  }
  return lines.join('\n');
}

function buildStatusText() {
  const lines = [`V2EX Helper 状态 (profile=${cfg.profile})`];
  lines.push(`Cookie：${fs.existsSync(cfg.cookieFile) ? '已存在' : '未找到'}`);
  lines.push(`余额日志：${fs.existsSync(cfg.balanceLog) ? '已存在' : '未找到'}`);
  if (!fs.existsSync(LOCK_FILE)) {
    lines.push('阅读任务：空闲');
    return lines.join('\n');
  }

  const lock = profileLock.readLock(LOCK_FILE);
  const active = lock && (lock.processStartToken
    ? profileLock.isLockOwnerAlive(lock)
    : isProcessAlive(lock.pid));
  if (active) {
    lines.push(`阅读任务：运行中 (profile=${lock.profile || 'unknown'}, PID ${lock.pid})`);
  } else {
    lines.push('阅读任务：残留或无效锁文件');
  }
  return lines.join('\n');
}

function readDebugText() {
  let fd = null;
  try {
    if (!fs.existsSync(cfg.readerLog)) return '暂无 reader 日志';
    fd = fs.openSync(cfg.readerLog, 'r');
    const stat = fs.fstatSync(fd);
    const length = Math.min(stat.size, MAX_DEBUG_READ_BYTES);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    if (length > 0) fs.readSync(fd, buffer, 0, length, start);
    let data = buffer.toString('utf8');
    if (start > 0) data = data.replace(/^[^\r\n]*(?:\r?\n|$)/, '');
    const lines = data.split(/\r?\n/).filter(Boolean).slice(-8);
    const result = lines.map(line => line.slice(0, 1000)).join('\n');
    return result ? result.slice(-MAX_DEBUG_REPLY_CHARS) : '暂无 reader 日志';
  } catch (e) {
    return `读取日志失败：${e.message}`;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function stopReaderText() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return '阅读脚本未在运行（锁文件不存在）';
    const lock = profileLock.readLock(LOCK_FILE);
    if (!lock || !lock.pid) return '锁文件内容无效';
    if (!isProcessAlive(lock.pid)) {
      try { profileLock.clearStaleLock(LOCK_FILE); } catch (_) {}
      return '进程已不存在，锁文件已清理';
    }
    if (lock.profile && lock.profile !== cfg.profile) {
      return `当前运行的是 profile=${lock.profile}，实验性飞书 Bot 只允许操作 profile=${cfg.profile}`;
    }
    if (!profileLock.isLockOwnerAlive(lock)) {
      return '锁文件中的进程身份无法安全确认，未发送停止信号；请在服务器检查任务状态';
    }
    process.kill(lock.pid, 'SIGTERM');
    return `已向 profile=${lock.profile || cfg.profile} 的阅读进程发送停止请求`;
  } catch (e) {
    return `停止失败：${e.message}`;
  }
}

function readApiResponse(res, label, callback) {
  let settled = false;
  let size = 0;
  const chunks = [];
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    callback(error, value);
  };

  res.on('data', (chunk) => {
    if (settled) return;
    size += chunk.length;
    if (size > MAX_API_RESPONSE_BYTES) {
      finish(new Error(`${label} response too large`));
      res.destroy();
      return;
    }
    chunks.push(chunk);
  });
  res.on('aborted', () => finish(new Error(`${label} response aborted`)));
  res.on('error', () => finish(new Error(`${label} response error`)));
  res.on('end', () => {
    if (settled) return;
    if (!Number.isInteger(res.statusCode) || res.statusCode < 200 || res.statusCode >= 300) {
      finish(new Error(`${label} HTTP ${res.statusCode || 'unknown'}`));
      return;
    }
    try {
      finish(null, JSON.parse(Buffer.concat(chunks, size).toString('utf8') || '{}'));
    } catch (_) {
      finish(new Error(`${label} invalid JSON response`));
    }
  });
}

function getTenantToken() {
  if (tenantToken && Date.now() < tokenExpiresAt) return Promise.resolve(tenantToken);
  const body = JSON.stringify({
    app_id: cfg.feishu.appId,
    app_secret: cfg.feishu.appSecret,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      readApiResponse(res, 'feishu tenant token', (error, parsed) => {
        if (error) return reject(error);
        if (parsed.code !== 0 || !parsed.tenant_access_token) {
          reject(new Error(`feishu tenant token rejected (${parsed.code ?? 'missing token'})`));
          return;
        }
        tenantToken = parsed.tenant_access_token;
        tokenExpiresAt = Date.now() + Math.max(60, (parsed.expire || 7200) - 60) * 1000;
        resolve(tenantToken);
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('feishu token timeout')));
    req.write(body);
    req.end();
  });
}

async function sendFeishuMessage(chatId, text) {
  if (!chatId) return;
  const token = await getTenantToken();
  const body = JSON.stringify({
    receive_id: chatId,
    msg_type: 'text',
    content: JSON.stringify({ text }),
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: '/open-apis/im/v1/messages?receive_id_type=chat_id',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      readApiResponse(res, 'feishu message', (error, parsed) => {
        if (error) return reject(error);
        if (parsed.code === undefined || Number(parsed.code) !== 0) {
          reject(new Error(`feishu message rejected (${parsed.code ?? 'missing code'})`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('feishu message timeout')));
    req.write(body);
    req.end();
  });
}

function verifyToken(body) {
  const token = cfg.feishu.verificationToken;
  if (!token) return false;
  const received = body.token || (body.header && body.header.token) || '';
  const expectedBuffer = Buffer.from(token);
  const receivedBuffer = Buffer.from(String(received));
  return expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function isAuthorizedChat(chatId, chatType) {
  return Boolean(
    cfg.feishu.chatId &&
    String(chatId || '') === cfg.feishu.chatId &&
    String(chatType || '').toLowerCase() === 'p2p'
  );
}

function parseMessage(body) {
  const event = body.event || {};
  const msg = event.message || {};
  let content = {};
  try {
    content = JSON.parse(msg.content || '{}');
  } catch (_) {}
  const text = String(content.text || '')
    .replace(/@\S+/g, '')
    .replace(/@_user_\d+/g, '')
    .trim();
  return {
    text,
    chatId: msg.chat_id || event.chat_id || '',
    chatType: msg.chat_type || '',
    senderId: ((event.sender || {}).sender_id || {}).open_id || '',
  };
}

async function handleCommand(text, chatId, senderId, chatType) {
  if (!isAuthorizedChat(chatId, chatType)) {
    console.log(`[feishu-bot] ignored unauthorized chat: ${maskId(chatId)}`);
    return { skipped: 'unauthorized_chat' };
  }

  const command = String(text || '').split(/\s+/)[0].toLowerCase();
  const prefix = senderId ? `@${maskId(senderId)}\n` : '';
  switch (command) {
    case '/help':
      return sendFeishuMessage(chatId,
        `${prefix}可用命令：\n` +
        '/sou - 查询余额记录\n' +
        '/status - 查看运行状态\n' +
        '/debug - 查看最近 reader 日志\n' +
        '/stop - 停止正在运行的阅读脚本'
      );
    case '/sou':
    case '/balance':
      return sendFeishuMessage(chatId, `${prefix}${buildBalanceText()}`);
    case '/status':
      return sendFeishuMessage(chatId, `${prefix}${buildStatusText()}`);
    case '/debug':
      return sendFeishuMessage(chatId, `${prefix}${readDebugText()}`);
    case '/stop':
      return sendFeishuMessage(chatId, `${prefix}${stopReaderText()}`);
    default:
      return sendFeishuMessage(chatId, `${prefix}未知命令：${command || '(empty)'}\n发送 /help 查看可用命令。`);
  }
}

function createServer() {
  const server = http.createServer((req, res) => {
    const sendJson = (statusCode, value = {}) => {
      if (res.destroyed || res.writableEnded) return;
      const payload = JSON.stringify(value);
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
        'Connection': 'close',
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(payload);
    };

    if (req.method !== 'POST' || req.url !== '/feishu/callback') {
      sendJson(404);
      return;
    }

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CALLBACK_BYTES) {
      sendJson(413);
      req.resume();
      return;
    }

    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('aborted', () => {
      tooLarge = true;
      if (!res.headersSent) sendJson(400);
    });
    req.on('error', () => {
      tooLarge = true;
      if (!res.headersSent) sendJson(400);
      else res.destroy();
    });
    req.on('data', chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_CALLBACK_BYTES) {
        tooLarge = true;
        sendJson(413);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (tooLarge) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks, size).toString('utf8') || '{}');
      } catch (_) {
        sendJson(400);
        return;
      }

      if (!verifyToken(body)) {
        sendJson(401);
        return;
      }

      if (body.type === 'url_verification' && body.challenge) {
        sendJson(200, { challenge: body.challenge });
        return;
      }

      sendJson(200);

      if (body.header && body.header.event_type === 'im.message.receive_v1') {
        const message = parseMessage(body);
        if (message.text.startsWith('/')) {
          try {
            await handleCommand(message.text, message.chatId, message.senderId, message.chatType);
          } catch (e) {
            console.error(`[feishu-bot] command failed: ${e.message}`);
          }
        }
      }
    });
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 1;
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}

function main() {
  if (!cfg.feishu.botEnabled) {
    console.log('[feishu-bot] disabled. Set FEISHU_BOT_ENABLE=1 to start the experimental Feishu bot.');
    return;
  }
  const required = [
    ['FEISHU_APP_ID', cfg.feishu.appId],
    ['FEISHU_APP_SECRET', cfg.feishu.appSecret],
    ['FEISHU_VERIFICATION_TOKEN', cfg.feishu.verificationToken],
    ['FEISHU_CHAT_ID', cfg.feishu.chatId],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    console.error(`[feishu-bot] missing required config when FEISHU_BOT_ENABLE=1: ${missing.join(', ')}`);
    process.exit(1);
  }

  const rawPort = String(process.env.FEISHU_BOT_PORT || '6700').trim();
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    console.error('[feishu-bot] FEISHU_BOT_PORT must be an integer between 1 and 65535');
    process.exit(1);
  }
  const port = Number(rawPort);

  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`[feishu-bot] listening on 127.0.0.1:${port} for private chat ${maskId(cfg.feishu.chatId)} (callback path: /feishu/callback; expose only through HTTPS reverse proxy)`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  createServer,
  parseMessage,
  isAuthorizedChat,
  buildBalanceText,
  buildStatusText,
};
