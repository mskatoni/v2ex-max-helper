'use strict';
// ========== Telegram 推送通知 ==========
const https  = require('https');
const config = require('../lib/config');

const cfg = config.getConfig();

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

function sendTelegram(text) {
  if (!isTelegramConfigured()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
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
          warnPushFailure('Telegram', 'response too large');
          req.destroy();
          finish();
          return;
        }
        data += chunk;
      });
      res.on('aborted', () => {
        warnPushFailure('Telegram', 'response aborted');
        finish();
      });
      res.on('error', () => {
        warnPushFailure('Telegram', 'response error');
        finish();
      });
      res.on('end', () => {
        if (settled) return;
        if (!isSuccessStatus(res.statusCode)) {
          warnPushFailure('Telegram', `HTTP ${res.statusCode || 'unknown'}`);
        } else {
          try {
            if (!JSON.parse(data || '{}').ok) warnPushFailure('Telegram', 'API rejected request');
          } catch (_) {
            warnPushFailure('Telegram', 'invalid API response');
          }
        }
        finish();
      });
    });
    req.on('error', () => {
      if (settled) return;
      warnPushFailure('Telegram', 'network error');
      finish();
    });
    req.setTimeout(10000, () => {
      if (settled) return;
      warnPushFailure('Telegram', 'timeout');
      req.destroy();
      finish();
    });
    req.write(body);
    req.end();
  });
}

function sendFeishu(text) {
  if (!isFeishuConfigured()) return Promise.resolve();
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(cfg.feishu.webhook);
      if (target.protocol !== 'https:' || target.username || target.password) throw new Error('unsafe URL');
    } catch (_) {
      warnPushFailure('Feishu', 'invalid webhook URL');
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
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
          warnPushFailure('Feishu', 'response too large');
          req.destroy();
          finish();
          return;
        }
        data += chunk;
      });
      res.on('aborted', () => {
        warnPushFailure('Feishu', 'response aborted');
        finish();
      });
      res.on('error', () => {
        warnPushFailure('Feishu', 'response error');
        finish();
      });
      res.on('end', () => {
        if (settled) return;
        if (!isSuccessStatus(res.statusCode)) {
          warnPushFailure('Feishu', `HTTP ${res.statusCode || 'unknown'}`);
        } else {
          try {
            const parsed = JSON.parse(data);
            const code = parsed.code !== undefined ? parsed.code : parsed.StatusCode;
            if (code === undefined || Number(code) !== 0) warnPushFailure('Feishu', 'API rejected request');
          } catch (_) {
            warnPushFailure('Feishu', 'invalid API response');
          }
        }
        finish();
      });
    });
    req.on('error', () => {
      if (settled) return;
      warnPushFailure('Feishu', 'network error');
      finish();
    });
    req.setTimeout(10000, () => {
      if (settled) return;
      warnPushFailure('Feishu', 'timeout');
      req.destroy();
      finish();
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
    : '已跳过异常帖子，请查看日志确认网络/CF/重定向状态';
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
