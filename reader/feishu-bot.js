#!/usr/bin/env node
'use strict';
// ========== Feishu interactive bot (experimental, opt-in only) ==========

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../lib/config');

const cfg = config.getConfig();
const LOCK_FILE = path.join(os.tmpdir(), 'v2ex_reader.lock');

let tenantToken = '';
let tokenExpiresAt = 0;

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

  const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
  if (pid && isProcessAlive(pid)) {
    lines.push(`阅读任务：运行中 (PID ${pid})`);
  } else {
    lines.push(`阅读任务：残留锁文件 (PID ${pid || 'unknown'} 不存在)`);
  }
  return lines.join('\n');
}

function readDebugText() {
  try {
    if (!fs.existsSync(cfg.readerLog)) return '暂无 reader 日志';
    const data = fs.readFileSync(cfg.readerLog, 'utf8');
    const lines = data.split(/\r?\n/).filter(Boolean).slice(-8);
    return lines.length > 0 ? lines.join('\n') : '暂无 reader 日志';
  } catch (e) {
    return `读取日志失败：${e.message}`;
  }
}

function stopReaderText() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return '阅读脚本未在运行（锁文件不存在）';
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (!pid || Number.isNaN(pid)) return '锁文件 PID 无效';
    if (!isProcessAlive(pid)) {
      try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
      return '进程已不存在，锁文件已清理';
    }
    process.kill(pid, 'SIGTERM');
    return `已向阅读进程 PID ${pid} 发送停止信号`;
  } catch (e) {
    return `停止失败：${e.message}`;
  }
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
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.code !== 0) {
            reject(new Error(parsed.msg || `tenant token error ${parsed.code}`));
            return;
          }
          tenantToken = parsed.tenant_access_token;
          tokenExpiresAt = Date.now() + Math.max(60, (parsed.expire || 7200) - 60) * 1000;
          resolve(tenantToken);
        } catch (e) {
          reject(e);
        }
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
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          if (parsed.code && parsed.code !== 0) {
            reject(new Error(parsed.msg || `send message error ${parsed.code}`));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
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
  if (!token) return true;
  const received = body.token || (body.header && body.header.token) || '';
  return received === token;
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
    senderId: ((event.sender || {}).sender_id || {}).open_id || '',
  };
}

async function handleCommand(text, chatId, senderId) {
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
    if (req.method !== 'POST' || req.url !== '/feishu/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    let rawBody = '';
    req.on('data', chunk => {
      rawBody += chunk;
      if (rawBody.length > 1024 * 1024) {
        req.destroy();
      }
    });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(rawBody || '{}');
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }

      if (!verifyToken(body)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }

      if (body.type === 'url_verification' && body.challenge) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ challenge: body.challenge }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');

      if (body.header && body.header.event_type === 'im.message.receive_v1') {
        const message = parseMessage(body);
        if (message.text.startsWith('/')) {
          try {
            await handleCommand(message.text, message.chatId, message.senderId);
          } catch (e) {
            console.error(`[feishu-bot] command failed: ${e.message}`);
          }
        }
      }
    });
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  return server;
}

function main() {
  if (!cfg.feishu.botEnabled) {
    console.log('[feishu-bot] disabled. Set FEISHU_BOT_ENABLE=1 to start the experimental Feishu bot.');
    return;
  }
  if (!cfg.feishu.appId || !cfg.feishu.appSecret) {
    console.error('[feishu-bot] FEISHU_APP_ID / FEISHU_APP_SECRET required when FEISHU_BOT_ENABLE=1');
    process.exit(1);
  }
  if (!cfg.feishu.verificationToken) {
    console.warn('[feishu-bot] FEISHU_VERIFICATION_TOKEN not set; callback token verification is disabled.');
  }

  const server = createServer();
  server.listen(cfg.feishu.port, '0.0.0.0', () => {
    console.log(`[feishu-bot] listening on :${cfg.feishu.port} (callback path: /feishu/callback)`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  createServer,
  parseMessage,
  buildBalanceText,
  buildStatusText,
};
