'use strict';
// ========== 余额监控 ==========
const https  = require('https');
const fs     = require('fs');
const logger = require('./logger');
const notify = require('./notify');
const config = require('../lib/config');
const fingerprint = require('./fingerprint');

const cfg = config.getConfig();
const FP = fingerprint.generate(cfg.profile);
const DATA_DIR = cfg.readerDataDir;
const BALANCE_LOG = cfg.balanceLog;
const BALANCE_STATUS = cfg.balanceStatus;

const HOST = 'www.v2ex.com';
const BALANCE_ORIGIN = `https://${HOST}`;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
let lastStatus = null;

const HEADERS = {
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'User-Agent':      FP.userAgent,
  'Referer':         'https://www.v2ex.com/',
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function writeBalanceStatus(status) {
  lastStatus = {
    time: new Date().toISOString(),
    ...status,
  };
  try {
    ensureDataDir();
    config.writeFileAtomic(BALANCE_STATUS, JSON.stringify(lastStatus, null, 2), { mode: 0o600 });
  } catch (e) {
    logger.warn(`Balance status write failed: ${e.message}`);
  }
}

function getLastStatus() {
  if (lastStatus) return { ...lastStatus };
  try {
    if (!fs.existsSync(BALANCE_STATUS)) return null;
    lastStatus = JSON.parse(fs.readFileSync(BALANCE_STATUS, 'utf8'));
    return { ...lastStatus };
  } catch (_) {
    return null;
  }
}

function localDateKey(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fetchBalance(cookie, targetUrl = `https://${HOST}/balance`, redirects = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl, BALANCE_ORIGIN);
    if (url.origin !== BALANCE_ORIGIN || url.username || url.password) {
      reject(new Error(`Balance redirect refused outside V2EX HTTPS origin: ${url.origin}`));
      return;
    }
    const opts = {
      hostname: url.hostname,
      path:     `${url.pathname}${url.search}`,
      method:   'GET',
      headers:  Object.assign({}, HEADERS, { Cookie: cookie }),
    };
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const req = https.request(opts, (res) => {
      let body = '';
      let received = 0;
      res.on('data', (c) => {
        received += Buffer.byteLength(c);
        if (received > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('balance response too large'));
          return;
        }
        body += c;
      });
      res.on('aborted', () => finish(new Error('balance response aborted')));
      res.on('error', finish);
      res.on('end', () => {
        if (settled) return;
        const statusCode = res.statusCode || 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(statusCode) && location && redirects < 3) {
          let nextUrl;
          try {
            nextUrl = new URL(location, url).toString();
          } catch (_) {
            finish(new Error('Balance redirect URL is invalid'));
            return;
          }
          fetchBalance(cookie, nextUrl, redirects + 1).then(
            value => finish(null, value),
            finish
          );
          return;
        }
        finish(null, {
          statusCode,
          headers: res.headers,
          body,
          finalUrl: url.pathname,
          redirected: redirects > 0,
          redirectCount: redirects,
        });
      });
    });
    req.on('error', finish);
    req.setTimeout(20000, () => req.destroy(new Error('balance timeout')));
    req.end();
  });
}

function diagnoseResponse(resp) {
  if (!resp) {
    return { code: 'empty_response', message: '余额页无响应' };
  }
  const statusCode = resp.statusCode || 0;
  const body = resp.body || '';
  const finalUrl = resp.finalUrl || '';

  if (finalUrl.includes('/signin') ||
      body.includes('你要查看的页面需要先登录') ||
      body.includes('需要先登录') ||
      body.includes('href="/signin"')) {
    return { code: 'logged_out', message: 'V2EX 返回登录页，Cookie 可能已失效' };
  }

  if (/cf-challenge|cf-browser-verification|just a moment|attention required|cloudflare/i.test(body)) {
    return { code: 'cloudflare_challenge', message: 'V2EX 返回 Cloudflare/验证页面，暂时无法读取余额' };
  }

  if (statusCode === 401 || statusCode === 403) {
    return { code: 'access_denied', message: `余额页访问被拒绝 (HTTP ${statusCode})` };
  }

  if (statusCode === 429) {
    return { code: 'rate_limited', message: '余额页请求过于频繁 (HTTP 429)' };
  }

  if (statusCode >= 500) {
    return { code: 'server_error', message: `V2EX 余额页服务异常 (HTTP ${statusCode})` };
  }

  if (statusCode && statusCode !== 200) {
    return { code: 'http_status', message: `余额页返回异常状态 (HTTP ${statusCode})` };
  }

  return null;
}

function statusForIssue(issue, resp, extra = {}) {
  return {
    ok: false,
    code: issue.code,
    message: issue.message,
    statusCode: resp && resp.statusCode,
    finalUrl: resp && resp.finalUrl,
    redirected: !!(resp && resp.redirected),
    ...extra,
  };
}

// 解析所有硬币（金、银、铜）。余额判定必须基于完整快照：
// 只取铜币会漏掉以银币/金币发放的活跃度奖励。
function parseBalance(html) {
  if (!html) return null;
  const block = (html.match(/balance_area bigger[\s\S]*?<\/div>/) || [])[0];
  if (!block) return null;

  let gold = 0, silver = 0, copper = 0;
  let copperFound = false;
  const re = /(\d+)\s*<img[^>]+alt="([A-Z])"/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    const val = parseInt(m[1], 10);
    const coin = m[2].toUpperCase();
    if (coin === 'G') gold = val;
    else if (coin === 'S') silver = val;
    else if (coin === 'B') {
      copper = val;
      copperFound = true;
    }
  }
  return copperFound ? { gold, silver, copper } : null;
}

// ========== 余额快照与比较 ==========
// V2EX 的活跃度奖励可能以铜币、银币或金币任一面额发放；只盯铜币会漏掉
// 以银币/金币发放的那次奖励，而铜币本身还可能因兑换而下降，
// 于是「第二次活跃度奖励」永远识别不到，reader 会一直读到截止时间。
const COIN_KEYS = ['gold', 'silver', 'copper'];
const COIN_LABELS = { gold: '金币', silver: '银币', copper: '铜币' };

function coinSnapshot(balance) {
  if (!balance) return null;
  const snapshot = {};
  for (const key of COIN_KEYS) {
    const value = Number(balance[key]);
    snapshot[key] = Number.isFinite(value) ? value : 0;
  }
  return snapshot;
}

function formatCoins(balance) {
  const snapshot = coinSnapshot(balance);
  if (!snapshot) return '未知';
  const parts = [];
  for (const key of COIN_KEYS) {
    if (key === 'copper' || snapshot[key] !== 0) parts.push(`${snapshot[key]} ${COIN_LABELS[key]}`);
  }
  return parts.join(' ');
}

// 按面额从大到小做字典序比较：任一面额增加即视为余额增加（奖励到账）。
// 刻意不使用固定兑换比率 —— V2EX 未公开金银铜的兑换关系，
// 写死比率会在真实比率不同时给出错误结论。
function compareCoins(prev, next) {
  const from = coinSnapshot(prev);
  const to = coinSnapshot(next);
  if (!from || !to) return 'unknown';
  for (const key of COIN_KEYS) {
    if (to[key] > from[key]) return 'increase';
    if (to[key] < from[key]) return 'decrease';
  }
  return 'same';
}

// 状态
let baseline    = null;   // 余额基线快照 { gold, silver, copper }
let changeCount = 0;      // 余额变化次数

// 写余额日志（供 /sou 命令使用，不做实时查询）
function saveBalanceLog(html) {
  try {
    const balance = parseBalance(html);
    if (!balance) return;
    ensureDataDir();
    const today = localDateKey();
    let log = {};
    if (fs.existsSync(BALANCE_LOG)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(BALANCE_LOG, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) log = parsed;
        else logger.warn('Balance log format invalid; rebuilding current-day record');
      } catch (_) {
        logger.warn('Balance log is not valid JSON; rebuilding current-day record');
      }
    }
    log[today] = {
      last: balance.copper,
      gold: balance.gold,
      silver: balance.silver,
      copper: balance.copper,
      lastTime: new Date().toISOString()
    };
    // 先更新当天，再滚动；重复更新当天不能把 7 天记录误删成 6 天。
    const keys = Object.keys(log).filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key)).sort();
    while (keys.length > 7) { delete log[keys.shift()]; }
    config.writeFileAtomic(BALANCE_LOG, JSON.stringify(log, null, 2), { mode: 0o600 });
  } catch (e) {
    logger.warn(`Balance log write failed: ${e.message}`);
  }
}

async function init(cookie) {
  try {
    const resp = await fetchBalance(cookie);
    const issue = diagnoseResponse(resp);
    if (issue) {
      logger.warn(`Balance: ${issue.message}`);
      writeBalanceStatus(statusForIssue(issue, resp));
      return { ok: false, fatal: issue.code === 'logged_out', code: issue.code, message: issue.message };
    }

    const balance = parseBalance(resp.body);
    if (!balance) {
      const parseIssue = { code: 'parse_failed', message: '余额页已返回，但未找到余额区域，页面结构可能变化' };
      logger.warn(`Balance: ${parseIssue.message}`);
      writeBalanceStatus(statusForIssue(parseIssue, resp));
      return { ok: false, fatal: false, code: parseIssue.code, message: parseIssue.message };
    }
    baseline    = coinSnapshot(balance);
    changeCount = 0;
    logger.info(`Balance baseline: ${formatCoins(baseline)}`);
    saveBalanceLog(resp.body);
    writeBalanceStatus({
      ok: true,
      code: 'ok',
      message: '余额读取成功',
      statusCode: resp.statusCode,
      finalUrl: resp.finalUrl,
      ...baseline,
    });
    return { ok: true, fatal: false, code: 'ok', message: '余额读取成功', copper: baseline.copper, balance: { ...baseline } };
  } catch (e) {
    logger.error(`Balance init failed: ${e.message}`);
    writeBalanceStatus({ ok: false, code: 'network_error', message: e.message });
    return { ok: false, fatal: false, code: 'network_error', message: e.message };
  }
}

// 检查余额是否变化，返回当前变化次数
async function check(cookie) {
  try {
    const resp = await fetchBalance(cookie);
    const issue = diagnoseResponse(resp);
    if (issue) {
      logger.warn(`Balance: ${issue.message}`);
      writeBalanceStatus(statusForIssue(issue, resp));
      return changeCount;
    }

    const balance = parseBalance(resp.body);
    if (!balance) {
      const parseIssue = { code: 'parse_failed', message: '余额页已返回，但未找到余额区域，页面结构可能变化' };
      logger.warn(`Balance: ${parseIssue.message}`);
      writeBalanceStatus(statusForIssue(parseIssue, resp));
      return changeCount;
    }
    const snapshot = coinSnapshot(balance);

    saveBalanceLog(resp.body);
    writeBalanceStatus({
      ok: true,
      code: 'ok',
      message: '余额读取成功',
      statusCode: resp.statusCode,
      finalUrl: resp.finalUrl,
      ...snapshot,
    });

    if (baseline === null) {
      baseline = snapshot;
      logger.info(`Balance baseline restored: ${formatCoins(baseline)}`);
      return changeCount;
    }

    const verdict = compareCoins(baseline, snapshot);
    if (verdict === 'increase') {
      changeCount++;
      logger.ok(`Balance changed! ${formatCoins(baseline)} → ${formatCoins(snapshot)} (变化第 ${changeCount} 次)`);
      await notify.notifyBalanceChanged(baseline, snapshot, changeCount);
      baseline = snapshot;
    } else if (verdict === 'decrease') {
      logger.warn(`Balance decreased: ${formatCoins(baseline)} → ${formatCoins(snapshot)}（更新基线，不计入活跃度变化）`);
      baseline = snapshot;
    } else {
      logger.info(`Balance check: ${formatCoins(snapshot)}（无变化，已触发 ${changeCount} 次）`);
    }
    return changeCount;
  } catch (e) {
    logger.error(`Balance check failed: ${e.message}`);
    writeBalanceStatus({ ok: false, code: 'network_error', message: e.message });
    return changeCount;
  }
}

function getChangeCount() { return changeCount; }

module.exports = {
  init,
  check,
  getChangeCount,
  getLastStatus,
  fetchBalance,
  parseBalance,
  coinSnapshot,
  compareCoins,
  formatCoins,
  diagnoseResponse,
  saveBalanceLog,
  localDateKey,
};
