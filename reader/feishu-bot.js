'use strict';
// ========== 飞书应用机器人（L2：交互命令）==========
// 用户 @机器人 发送 /sou /debug /stop /status 命令
// 需要用户在飞书开放平台创建应用并配置事件订阅

const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

// ── 配置读取 ──
function loadConfig() {
  const envFile = process.env.V2EX_ENV_FILE || path.join(require('os').homedir(), '.v2ex_env');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
  return {
    appId:             process.env.FEISHU_APP_ID     || '',
    appSecret:         process.env.FEISHU_APP_SECRET || '',
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
    port:              parseInt(process.env.FEISHU_BOT_PORT || '6700', 10),
  };
}

let cfg;
let tenantToken = null;
let tokenExpiry = 0;

// ── 飞书 API：获取 tenant_access_token ──
function getTenantToken() {
  if (tenantToken && Date.now() < tokenExpiry) return Promise.resolve(tenantToken);
  if (!cfg.appId || !cfg.appSecret) return Promise.reject(new Error('未配置 FEISHU_APP_ID / FEISHU_APP_SECRET'));

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret });
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.code === 0) {
            tenantToken = j.tenant_access_token;
            tokenExpiry = Date.now() + (j.expire - 60) * 1000;
            resolve(tenantToken);
          } else reject(new Error(`Token error: ${j.msg} (${j.code})`));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy());
    req.write(body); req.end();
  });
}

// ── 飞书 API：发送消息到群 ──
function sendFeishuMessage(chatId, text) {
  return getTenantToken().then(token => new Promise((resolve, reject) => {
    const body = JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    });
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: `/open-apis/im/v1/messages?receive_id_type=chat_id`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.code === 0) resolve(j);
          else reject(new Error(`Send msg error: ${j.msg}`));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy());
    req.write(body); req.end();
  }));
}

// ── 命令处理 ──
async function handleCommand(cmd, chatId, senderName) {
  const nameTag = senderName ? `@${senderName} ` : '';
  try {
    switch (cmd) {
      case '/help':
        await sendFeishuMessage(chatId,
          `${nameTag}📋 V2EX Helper 命令：\n` +
          `• /sou — 查询余额\n` +
          `• /status — 查看运行状态\n` +
          `• /debug — 查看最近日志\n` +
          `• /stop — 停止阅读器`
        );
        break;

      case '/sou':
      case '/balance':
        try {
          const result = execSync(
            'cd /root/v2ex-max-helper/checkin && node --require /root/v2ex-max-helper/checkin/preload-proxy.js v2ex-checkin.js 2>&1',
            { timeout: 25000, encoding: 'utf8' }
          );
          const balance = (result.match(/Balance\s*:\s*[^\n]+/) || ['未知'])[0];
          const status  = (result.match(/Status\s*:\s*[^\n]+/) || ['未知'])[0];
          await sendFeishuMessage(chatId, `${nameTag}💰 ${balance}\n📊 ${status}`);
        } catch(e) {
          await sendFeishuMessage(chatId, `${nameTag}❌ 查询失败: ${e.message}`);
        }
        break;

      case '/status':
        try {
          const proxy = execSync('systemctl is-active mihomo 2>/dev/null', { encoding: 'utf8' }).trim();
          const checkin = execSync('systemctl is-enabled v2ex-checkin.timer 2>/dev/null || echo disabled', { encoding: 'utf8' }).trim();
          const reader = execSync('systemctl is-enabled v2ex-reader.timer 2>/dev/null || echo disabled', { encoding: 'utf8' }).trim();
          await sendFeishuMessage(chatId,
            `${nameTag}📊 V2EX Helper 状态：\n` +
            `• 代理: ${proxy === 'active' ? '✅' : '❌'}\n` +
            `• 签到定时器: ${checkin === 'enabled' ? '✅' : '❌'}\n` +
            `• 阅读定时器: ${reader === 'enabled' ? '✅' : '❌'}\n` +
            `• 服务器: 8.135.36.248`
          );
        } catch(e) {
          await sendFeishuMessage(chatId, `${nameTag}❌ 查询失败: ${e.message}`);
        }
        break;

      case '/debug':
        try {
          const logs = execSync(
            'journalctl -u v2ex-checkin -u v2ex-reader --no-pager -n 8 2>/dev/null',
            { timeout: 5000, encoding: 'utf8' }
          );
          const lines = logs.split('\n').filter(l => l.includes('node[') || l.includes('签到') || l.includes('ERROR')).slice(-5);
          await sendFeishuMessage(chatId, `${nameTag}🔍 最近日志：\n${lines.join('\n') || '(无)'}`);
        } catch(e) {
          await sendFeishuMessage(chatId, `${nameTag}❌ 查询失败: ${e.message}`);
        }
        break;

      case '/stop':
        try {
          execSync('systemctl stop v2ex-reader 2>/dev/null', { timeout: 5000 });
          await sendFeishuMessage(chatId, `${nameTag}🛑 阅读器已停止`);
        } catch(e) {
          await sendFeishuMessage(chatId, `${nameTag}❌ 停止失败: ${e.message}`);
        }
        break;

      default:
        await sendFeishuMessage(chatId, `${nameTag}未知命令: ${cmd}\n发送 /help 查看可用命令`);
    }
  } catch(e) {
    console.error('[feishu-bot] Command error:', e.message);
  }
}

// ── 签名校验 ──
function verifySignature(timestamp, nonce, bodyStr, signature) {
  if (!cfg.verificationToken) return true; // 未配 verification token 时跳过
  const raw = `${timestamp}${nonce}${cfg.verificationToken}${bodyStr}`;
  const expected = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  return signature === expected;
}

// ── 消息解析 ──
function parseMessage(body) {
  try {
    const event = body.event || {};
    const msg = event.message || {};
    const content = msg.content || '{}';
    let parsed;
    try { parsed = JSON.parse(content); } catch(e) { parsed = {}; }
    // 飞书消息文本（可能包含 @mention）
    const text = (parsed.text || '').replace(/@_user_\d+/g, '').trim();
    const chatId = msg.chat_id || event.chat_id || '';
    const senderName = (event.sender || {}).sender_id?.open_id || '';
    return { text, chatId, senderName };
  } catch(e) {
    return { text: '', chatId: '', senderName: '' };
  }
}

// ── HTTP 服务器 ──
function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/feishu/callback') {
      let rawBody = '';
      req.on('data', chunk => rawBody += chunk);
      req.on('end', async () => {
        try {
          const body = JSON.parse(rawBody);

          // URL 验证（飞书配置回调时）
          if (body.type === 'url_verification') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ challenge: body.challenge }));
            console.log('[feishu-bot] URL verification OK');
            return;
          }

          // 事件回调
          if (body.header && body.header.event_type) {
            const eventType = body.header.event_type;
            console.log('[feishu-bot] Event:', eventType);

            if (eventType === 'im.message.receive_v1') {
              const { text, chatId, senderName } = parseMessage(body);
              // 只响应 / 开头的命令
              if (text.startsWith('/')) {
                const spaceIdx = text.indexOf(' ');
                const cmd = spaceIdx > 0 ? text.substring(0, spaceIdx) : text;
                console.log(`[feishu-bot] Command: "${cmd}" from chat=${chatId}`);
                await handleCommand(cmd, chatId, senderName);
              }
            }
          }

          res.writeHead(200);
          res.end('{}');
        } catch(e) {
          console.error('[feishu-bot] Callback error:', e.message);
          res.writeHead(400);
          res.end('{}');
        }
      });
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('V2EX Feishu Bot OK');
    }
  });

  server.listen(cfg.port, '0.0.0.0', () => {
    console.log(`[feishu-bot] Listening on :${cfg.port}`);
    console.log(`[feishu-bot] Callback URL: http://YOUR_IP:${cfg.port}/feishu/callback`);
  });
}

// ── 启动 ──
cfg = loadConfig();
if (!cfg.appId || !cfg.appSecret) {
  console.warn('[feishu-bot] ⚠️  未配置 FEISHU_APP_ID / FEISHU_APP_SECRET');
  console.warn('[feishu-bot] L2 交互命令需要飞书应用凭据，详见 docs/飞书应用机器人配置.md');
  console.warn('[feishu-bot] 服务器仍会启动（可接收 webhook 推送），但不会响应交互命令');
}
if (!cfg.verificationToken) {
  console.warn('[feishu-bot] ⚠️  未配置 FEISHU_VERIFICATION_TOKEN（建议配置以启用签名校验）');
}
startServer();
