'use strict';
// ========== Telegram 推送通知 ==========
const https  = require('https');
const config = require('../lib/config');

const cfg = config.getConfig();
const PUSH_RETRY_COUNT = 3;
const PUSH_RETRY_BASE_MS = 100;

function isTelegramConfigured() {
  // 未配置 Token / Chat ID 时静默跳过推送，不影响主流程
  return Boolean(cfg.telegram.token && cfg.telegram.chatId);
}

function isFeishuConfigured() {
  return Boolean(cfg.feishu.enabled && cfg.feishu.webhook);
}

function isConfigured() {
  return isTelegramConfigured() || isFeishuConfigured();
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(b|code|i|em|strong)>/gi, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function withProfile(text) {
  if (cfg.profile === 'default') return text;
  return `👤 <b>Profile</b>: <code>${escapeHtml(cfg.profile)}</code>\n${text}`;
}

function warnPushFailure(channel, detail) {
  console.warn(`[notify] ${channel} 推送失败: ${detail}`);
}

function isSuccessStatus(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300;
}

function isRetryableStatus(statusCode) {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendWithRetries(channel, operation) {
  for (let attempt = 0; attempt <= PUSH_RETRY_COUNT; attempt++) {
    let result;
    try {
      result = await operation();
    } catch (_) {
      result = { ok: false, retryable: true, detail: 'network error' };
    }
    if (result.ok) return;
    if (!result.retryable || attempt === PUSH_RETRY_COUNT) {
      warnPushFailure(channel, result.detail);
      return;
    }
    const delay = PUSH_RETRY_BASE_MS * (2 ** attempt);
    warnPushFailure(channel, `${result.detail}; retry ${attempt + 1}/${PUSH_RETRY_COUNT}`);
    await sleep(delay);
  }
}

function sendTelegram(text) {
  if (!isTelegramConfigured()) return Promise.resolve();
  return sendWithRetries('Telegram', () => sendTelegramOnce(text));
}

function sendTelegramOnce(text) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const body = JSON.stringify({ chat_id: cfg.telegram.chatId, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${cfg.telegram.token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      let received = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (settled) return;
        received += Buffer.byteLength(chunk);
        if (received > 64 * 1024) {
          finish({ ok: false, retryable: true, detail: 'response too large' });
          req.destroy();
          return;
        }
        data += chunk;
      });
      res.on('aborted', () => {
        finish({ ok: false, retryable: true, detail: 'response aborted' });
      });
      res.on('error', () => {
        finish({ ok: false, retryable: true, detail: 'response error' });
      });
      res.on('end', () => {
        if (settled) return;
        if (!isSuccessStatus(res.statusCode)) {
          finish({
            ok: false,
            retryable: isRetryableStatus(res.statusCode),
            detail: `HTTP ${res.statusCode || 'unknown'}`,
          });
          return;
        }
        try {
          if (!JSON.parse(data || '{}').ok) {
            finish({ ok: false, retryable: false, detail: 'API rejected request' });
            return;
          }
        } catch (_) {
          finish({ ok: false, retryable: true, detail: 'invalid API response' });
          return;
        }
        finish({ ok: true, retryable: false, detail: '' });
      });
    });
    req.on('error', () => {
      if (settled) return;
      finish({ ok: false, retryable: true, detail: 'network error' });
    });
    req.setTimeout(10000, () => {
      if (settled) return;
      finish({ ok: false, retryable: true, detail: 'timeout' });
      req.destroy();
    });
    req.write(body);
    req.end();
  });
}

function sendFeishu(text) {
  if (!isFeishuConfigured()) return Promise.resolve();
  return sendWithRetries('Feishu', () => sendFeishuOnce(text));
}

function sendFeishuOnce(text) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(cfg.feishu.webhook);
      if (target.protocol !== 'https:' || target.username || target.password) throw new Error('unsafe URL');
    } catch (_) {
      resolve({ ok: false, retryable: false, detail: 'invalid webhook URL' });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const body = JSON.stringify({
      msg_type: 'text',
      content: { text: `V2EX | ${stripHtml(text)}` },
    });
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      let received = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (settled) return;
        received += Buffer.byteLength(chunk);
        if (received > 64 * 1024) {
          finish({ ok: false, retryable: true, detail: 'response too large' });
          req.destroy();
          return;
        }
        data += chunk;
      });
      res.on('aborted', () => {
        finish({ ok: false, retryable: true, detail: 'response aborted' });
      });
      res.on('error', () => {
        finish({ ok: false, retryable: true, detail: 'response error' });
      });
      res.on('end', () => {
        if (settled) return;
        if (!isSuccessStatus(res.statusCode)) {
          finish({
            ok: false,
            retryable: isRetryableStatus(res.statusCode),
            detail: `HTTP ${res.statusCode || 'unknown'}`,
          });
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const code = parsed.code !== undefined ? parsed.code : parsed.StatusCode;
          if (code === undefined || Number(code) !== 0) {
            finish({ ok: false, retryable: false, detail: 'API rejected request' });
            return;
          }
        } catch (_) {
          finish({ ok: false, retryable: true, detail: 'invalid API response' });
          return;
        }
        finish({ ok: true, retryable: false, detail: '' });
      });
    });
    req.on('error', () => {
      if (settled) return;
      finish({ ok: false, retryable: true, detail: 'network error' });
    });
    req.setTimeout(10000, () => {
      if (settled) return;
      finish({ ok: false, retryable: true, detail: 'timeout' });
      req.destroy();
    });
    req.write(body);
    req.end();
  });
}

function sendMessage(text) {
  const profiledText = withProfile(text);
  return Promise.all([sendTelegram(profiledText), sendFeishu(profiledText)]).then(() => undefined);
}

// ========== 预定义通知模板 ==========

// 阅读完成
async function notifyReaderDone(stats) {
  const emoji = stats.changed >= 2 ? '🎉' : '✅';
  await sendMessage(
    `${emoji} <b>V2EX 阅读完成</b>\n` +
    `📖 阅读: ${escapeHtml(stats.read)} 篇\n` +
    `💰 余额变化: ${escapeHtml(stats.changed)} 次\n` +
    `⏱ 耗时: ${escapeHtml(stats.elapsed)}\n` +
    `🛑 原因: ${escapeHtml(stats.reason || '达到上限')}`
  );
}

// 连续错误停止
async function notifyReaderError(stats) {
  const reason = stats.reason || '连续 3 次失败';
  const hint = reason.includes('Cookie')
    ? 'Cookie 已确认失效，请更新'
    : '已完成单帖和登录探针重试，请查看日志确认网络/CF/重定向状态';
  await sendMessage(
    `⚠️ <b>V2EX 阅读中止</b>\n` +
    `❌ ${escapeHtml(reason)}\n` +
    `📖 已读: ${escapeHtml(stats.read)} 篇\n` +
    `💡 ${escapeHtml(hint)}`
  );
}

// Cookie / 登录失效
async function notifySessionExpired() {
  await sendMessage(
    `🔴 <b>V2EX Session 失效</b>\n` +
    `Cookie 已过期，请重新登录并更新 Cookie\n` +
    `更新方式：通过 Telegram 面板为 profile <code>${escapeHtml(cfg.profile)}</code> 重新导入 Cookie`
  );
}

// 余额变化（活跃度奖励）
async function notifyBalanceChanged(from, to, count) {
  await sendMessage(
    `💰 <b>V2EX 活跃度奖励</b>\n` +
    `铜币: ${escapeHtml(from)} → ${escapeHtml(to)} (+${escapeHtml(to - from)})\n` +
    `今日第 ${escapeHtml(count)} 次奖励`
  );
}

// 签到结果（供 checkin 复用）
async function notifyCheckin(result) {
  const ok = result.success;
  await sendMessage(
    `${ok ? '✅' : '❌'} <b>V2EX 签到${ok ? '成功' : '失败'}</b>\n` +
    `${escapeHtml(result.message || '')}`
  );
}

module.exports = {
  isConfigured,
  sendMessage,
  notifyReaderDone,
  notifyReaderError,
  notifySessionExpired,
  notifyBalanceChanged,
  notifyCheckin,
};
