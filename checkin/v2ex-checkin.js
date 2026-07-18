#!/usr/bin/env node
/**
 * V2EX 每日签到 - Node.js 独立版（含保活机制）
 * Version: v1.4.9
 *
 * 用法：
 *   保存 Cookie：
 *     V2EX_COOKIE="..." node v2ex-checkin.js --save-cookie
 *
 *   每日签到（crontab 按本机时间 09:10）：
 *     10 9 * * * /usr/bin/node /path/to/v2ex-checkin.js >> /var/log/v2ex.log 2>&1
 *
 *   保活心跳，每6小时访问一次（防 Session 过期）：
 *     0 0,6,12,18 * * *  node /path/to/v2ex-checkin.js --ping
 *
 * 推送告警（Cookie 失效时通知）：
 *   Bark:     BARK_URL="https://api.day.app/你的KEY" node v2ex-checkin.js
 *   Telegram: TG_TOKEN="xxx" TG_CHAT_ID="xxx" node v2ex-checkin.js
 *
 * Cookie 存储位置：~/.v2ex_cookie（或 COOKIE_FILE 环境变量）
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const url   = require('url');
const config = require('../lib/config');
const profileAuth = require('../lib/profile-auth');
const profileLock = require('../lib/profile-lock');
const fingerprint = require('../reader/fingerprint');

// ========== 配置 ==========
const SCRIPT_VERSION = 'v1.4.9';
const HOST           = 'www.v2ex.com';
const COOKIE_ORIGIN  = `https://${HOST}`;
const MAX_RETRY      = 3;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const cfg = config.getConfig();
const FP = fingerprint.generate(cfg.profile);
const COOKIE_FILE = cfg.cookieFile;
const PROFILE_LIST = config.parseProfileList();

// 推送配置（从环境变量或 ~/.v2ex_env 读取，不硬编码）
const BARK_URL       = cfg.barkUrl;                 // e.g. https://api.day.app/YOUR_KEY
const TG_BOT_TOKEN   = cfg.telegram.checkinToken;   // TG_BOT_TOKEN 优先，TG_TOKEN 兼容 fallback
const TG_CHAT_ID     = cfg.telegram.chatId;
const FEISHU_ENABLED = cfg.feishu.enabled;
const FEISHU_WEBHOOK = cfg.feishu.webhook;

const COMMON_HEADERS = {
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en,zh-CN;q=0.9,zh;q=0.8',
  'cache-control':   'max-age=0',
  'pragma':          'no-cache',
  'User-Agent':      FP.userAgent,
  'Referer':         'https://www.v2ex.com/'
};

// ========== Cookie 存储 ==========
function readCookie() {
  if (!fs.existsSync(COOKIE_FILE)) return '';
  return fs.readFileSync(COOKIE_FILE, 'utf8').trim();
}

function writeCookie(cookie) {
  try {
    config.writeFileAtomic(COOKIE_FILE, cookie.trim(), { mode: 0o600 });
    // 同步更新进程内 env（跨模块复用）
    process.env.V2EX_COOKIE = cookie;
    return true;
  } catch (e) {
    console.error('写入 Cookie 失败:', e.message);
    return false;
  }
}

// 把 "a=1; b=2" 解析成 Map
function cookieToMap(str) {
  const map = new Map();
  for (const part of (str || '').split(';')) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    map.set(s.slice(0, i).trim(), s.slice(i + 1).trim());
  }
  return map;
}

function isRepresentableSetCookie(setCookie) {
  const parts = String(setCookie || '').split(';');
  const first = parts.shift() || '';
  const separator = first.indexOf('=');
  const name = separator >= 0 ? first.slice(0, separator).trim() : '';
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return false;

  for (const rawAttribute of parts) {
    const attribute = rawAttribute.trim();
    const index = attribute.indexOf('=');
    if (index < 0) continue;
    const key = attribute.slice(0, index).trim().toLowerCase();
    const value = attribute.slice(index + 1).trim().toLowerCase();
    if (key === 'path' && value !== '/') return false;
    if (key === 'domain') {
      const domain = value.replace(/^\./, '');
      if (domain !== HOST && domain !== 'v2ex.com') return false;
    }
  }
  return true;
}

// 把服务端响应的 Set-Cookie 数组合并进现有 cookie 字符串（新值覆盖同名旧值）。
// 注意：普通访问经常只刷新 A2O / V2EX_LANG 等辅助字段，不代表核心 A2 已续期。
function mergeSetCookies(currentCookie, setCookieArr) {
  if (!setCookieArr || setCookieArr.length === 0) {
    return { cookie: currentCookie, changed: false, changedKeys: [] };
  }
  const map = cookieToMap(currentCookie);
  let changed = false;
  const changedKeys = [];
  for (const sc of setCookieArr) {
    // 扁平 Cookie 文件无法表达 Path/Domain 作用域，显式非根路径或非 V2EX 域不能安全合并。
    if (!isRepresentableSetCookie(sc)) continue;
    // 每条 Set-Cookie 形如 "A2=xxx; Path=/; Expires=...; HttpOnly"
    const first = sc.split(';')[0];
    const i = first.indexOf('=');
    if (i < 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (!name) continue;
    const expiresMatch = String(sc).match(/(?:^|;)\s*Expires=([^;]+)/i);
    const expiresAt = expiresMatch ? Date.parse(expiresMatch[1]) : NaN;
    const deletesCookie = value === '' || /^deleted$/i.test(value) ||
      /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(sc) ||
      (Number.isFinite(expiresAt) && expiresAt <= Date.now());
    if (deletesCookie) {
      if (map.delete(name)) {
        changedKeys.push(name);
        changed = true;
      }
      continue;
    }
    if (map.get(name) !== value) {
      map.set(name, value);
      changedKeys.push(name);
      changed = true;
    }
  }
  const merged = Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  return { cookie: merged, changed, changedKeys };
}

// 用响应的 Set-Cookie 刷新本地 cookie 文件（仅在有变化时写盘）
function refreshCookieFromResponse(currentCookie, setCookieArr) {
  const { cookie, changed, changedKeys } = mergeSetCookies(currentCookie, setCookieArr);
  if (changed) {
    if (!writeCookie(cookie)) throw new Error('Cookie 续期写回失败');
    logCookieChanges(changedKeys);
  }
  return cookie;
}

function logCookieChanges(changedKeys) {
  const authKeys = new Set(['A2', 'PB3_SESSION', 'cf_clearance']);
  const uniqueKeys = [...new Set(changedKeys)];
  const authChanged = uniqueKeys.filter(k => authKeys.has(k));
  const auxChanged = uniqueKeys.filter(k => !authKeys.has(k));

  if (authChanged.length > 0) {
    log(`🔄 核心 Cookie 已更新: ${authChanged.join(', ')}`);
  }
  if (auxChanged.length > 0) {
    log(`🔄 辅助 Cookie 已更新: ${auxChanged.join(', ')}`);
  }
}

// ========== HTTP 请求 ==========
// 完整版：返回 { body, setCookies }。会累积重定向链路上每一跳的 Set-Cookie。
function fetchUrlFull(reqUrl, cookie, _redirects = 0, _acc = [], policy = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new url.URL(reqUrl);
    } catch (e) {
      reject(e);
      return;
    }

    const requiredOrigin = cookie ? COOKIE_ORIGIN : policy.allowedOrigin;
    if ((cookie || policy.requireHttps) && parsed.protocol !== 'https:') {
      reject(new Error('拒绝通过明文 HTTP 发送认证或推送数据'));
      return;
    }
    if (requiredOrigin && parsed.origin !== requiredOrigin) {
      reject(new Error('请求重定向到未授权 HTTPS 源'));
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      reject(new Error('不支持的请求协议'));
      return;
    }

    const headers = (cookie || parsed.origin === COOKIE_ORIGIN)
      ? Object.assign({}, COMMON_HEADERS)
      : { Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const lib     = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const req = lib.get(reqUrl, { headers }, (res) => {
      const sc = res.headers['set-cookie'] || [];
      const acc = _acc.concat(sc);
      // 跟随重定向（最多3次）
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (_redirects >= 3) {
          res.resume();
          finish(new Error('请求重定向次数过多'));
          return;
        }
        let loc;
        try {
          loc = new url.URL(res.headers.location, parsed).toString();
        } catch (e) {
          res.resume();
          finish(e);
          return;
        }
        res.resume();
        return fetchUrlFull(loc, cookie, _redirects + 1, acc, policy).then(
          value => finish(null, value),
          finish
        );
      }
      let body = '';
      let received = 0;
      res.on('data', (c) => {
        received += Buffer.byteLength(c);
        if (received > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('响应体过大'));
          return;
        }
        body += c;
      });
      res.on('aborted', () => finish(new Error('响应被中断')));
      res.on('error', finish);
      res.on('end', () => finish(null, { body, setCookies: acc, statusCode: res.statusCode }));
    });
    req.on('error', finish);
    req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
  });
}

// 兼容旧调用：只取 body
function fetchUrl(reqUrl, cookie, policy = {}) {
  return fetchUrlFull(reqUrl, cookie, 0, [], policy).then(r => r.body);
}

function requireSuccess(response, label) {
  const statusCode = response && response.statusCode || 0;
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`${label}返回 HTTP ${statusCode || 'unknown'}`);
  }
  return response;
}

// ========== 推送通知 ==========
function warnPushFailure(channel, detail) {
  log(`⚠️ ${channel} 推送失败: ${detail}`);
}

function isSuccessStatus(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300;
}

function escapeTelegramMarkdown(value) {
  return String(value || '').replace(/([_*`\[])/g, '\\$1');
}

function sendBark(title, msg) {
  if (!BARK_URL) return Promise.resolve();
  let base;
  try {
    base = new url.URL(BARK_URL);
    if (base.protocol !== 'https:' || base.username || base.password) throw new Error('unsafe URL');
  } catch (_) {
    warnPushFailure('Bark', 'invalid HTTPS URL');
    return Promise.resolve();
  }
  const target = `${BARK_URL.replace(/\/$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(msg)}`;
  return fetchUrlFull(target, '', 0, [], { requireHttps: true, allowedOrigin: base.origin })
    .then((response) => {
      if (!isSuccessStatus(response.statusCode)) warnPushFailure('Bark', `HTTP ${response.statusCode || 'unknown'}`);
    })
    .catch(() => warnPushFailure('Bark', 'network error'));
}

function sendTelegram(title, msg) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return Promise.resolve();
  const text = `*${escapeTelegramMarkdown(title)}*\n${escapeTelegramMarkdown(msg)}`;
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' });
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_BOT_TOKEN}/sendMessage`,
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
        received += Buffer.byteLength(chunk);
        if (received > 64 * 1024) {
          req.destroy(new Error('Telegram response too large'));
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
      if (!settled) warnPushFailure('Telegram', 'network error');
      finish();
    });
    req.setTimeout(10000, () => {
      if (!settled) warnPushFailure('Telegram', 'timeout');
      req.destroy();
      finish();
    });
    req.write(body);
    req.end();
  });
}

function sendFeishu(title, msg) {
  if (!FEISHU_ENABLED || !FEISHU_WEBHOOK) return Promise.resolve();
  return new Promise((resolve) => {
    let target;
    try {
      target = new url.URL(FEISHU_WEBHOOK);
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
      content: { text: `V2EX | ${title}\n${msg}` },
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

function notify(title, msg) {
  const profiledMsg = cfg.profile === 'default' ? msg : `Profile: ${cfg.profile}\n${msg}`;
  return Promise.all([
    sendBark(title, profiledMsg),
    sendTelegram(title, profiledMsg),
    sendFeishu(title, profiledMsg),
  ]);
}

// ========== 解析函数 ==========
function formatBalance(html) {
  if (!html) return '';
  const block = (html.match(/balance_area bigger[\s\S]*?<\/div>/) || [])[0];
  if (!block) return '';
  const parts = [];
  const re = /(\d+)\s+<img[^>]+alt="([A-Z])"/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    if (m[2] === 'G') parts.push(m[1] + ' 金币');
    if (m[2] === 'S') parts.push(m[1] + ' 银币');
    if (m[2] === 'B') parts.push(m[1] + ' 铜币');
  }
  return parts.join(', ');
}

function parseLoginStatus(html) {
  if (!html) return { logged_in: false };
  const hasSignout = /<a\b[^>]*\bhref=["']\/signout(?:\?[^"']*)?["'][^>]*>/i.test(html);
  const hasSignin = /<a\b[^>]*\bhref=["']\/signin(?:\?[^"']*)?["'][^>]*>/i.test(html);
  const loggedOutText = html.includes('你要查看的页面需要先登录') || html.includes('需要先登录');
  return { logged_in: hasSignout && !loggedOutText && !(hasSignin && !hasSignout) };
}

async function getOnce(cookie) {
  const response = requireSuccess(
    await fetchUrlFull('https://www.v2ex.com/mission/daily', cookie),
    '签到页'
  );
  const { body: html, setCookies } = response;
  const status = parseLoginStatus(html);
  if (!status.logged_in) return { once: '', logged_in: false, already: false, days: '?' };
  // 签到访问也会触发登录态续期，写回刷新后的 Cookie
  const refreshedCookie = refreshCookieFromResponse(cookie, setCookies);
  const days = (html.match(/已连续登录\s*(\d+)\s*天/) || [])[1] || '?';
  if (html.includes('每日登录奖励已领取')) return { once: '', logged_in: true, already: true, days, cookie: refreshedCookie };
  const once = (html.match(/once=(\d+)/) || [])[1] || '';
  return { once, logged_in: true, already: false, days, cookie: refreshedCookie };
}

async function queryBalance(cookie) {
  const response = requireSuccess(await fetchUrlFull('https://www.v2ex.com/balance', cookie), '余额页');
  refreshCookieFromResponse(cookie, response.setCookies);
  const balance = formatBalance(response.body);
  if (!balance) throw new Error('余额页结构无法识别');
  return balance;
}

// ========== Logger ==========
function pad(n) { return String(n).padStart(2, '0'); }
function utcOffset(d) {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
function tsNow() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${utcOffset(d)}`;
}
function log(msg) { console.log(msg); }
function logField(label, value) {
  const key = (label + '              ').substring(0, 14);
  log(`${key}: ${value}`);
}
function sep() { log('------------------------------------'); }

// ========== 保活心跳 ==========
async function doPing() {
  log(`🏓 V2EX Ping Start`);
  log(`Time     : ${tsNow()}`);
  sep();
  const cookie = readCookie();
  if (!cookie) {
    log('⚠️  无 Cookie，跳过保活');
    process.exitCode = 1;
    return;
  }
  try {
    const response = requireSuccess(await fetchUrlFull('https://www.v2ex.com/', cookie), '保活首页');
    const { body: html, setCookies } = response;
    const status = parseLoginStatus(html);
    if (!status.logged_in) {
      log('❌ Cookie 已失效（保活检测）');
      await notify('V2EX ⚠️ Cookie 失效', '请重新登录 V2EX 并更新 Cookie，签到将中断！');
      log('📢 告警已发送（如已配置推送）');
      process.exitCode = 1;
    } else {
      // 关键：把服务端下发的续期 Cookie 写回，实现登录态自动刷新
      refreshCookieFromResponse(cookie, setCookies);
      log('✅ Session 正常，保活成功');
    }
  } catch (e) {
    log(`⚠️  保活请求失败: ${e.message}`);
    process.exitCode = 1;
  }
  log('🏓 Ping End');
}

// ========== 主签到逻辑 ==========
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function doCheckin(attempt = 0) {
  const cookie = readCookie();
  if (!cookie) {
    log('⚠️  无 Cookie，请先运行：V2EX_COOKIE="..." node v2ex-checkin.js --save-cookie');
    process.exit(1);
  }

  if (attempt === 0) {
    log('🚀 V2EX Script Start');
    log(`Time     : ${tsNow()}`);
    log(`Version  : ${SCRIPT_VERSION}`);
    sep();
  }

  try {
    logField('Action', `签到尝试 ${attempt + 1}/${MAX_RETRY}`);
    const info = await getOnce(cookie);
    let activeCookie = info.cookie || readCookie() || cookie;

    if (!info.logged_in) {
      logField('Status', '❌ Cookie 已失效');
      log('📢 发送失效告警...');
      await notify('V2EX ❌ Cookie 失效', '签到失败，请重新登录 V2EX 更新 Cookie！连续天数将中断。');
      sep();
      log('📊 Summary\nFailed     : 1\n🎯 Result  : Cookie 已失效');
      process.exit(1);
    }

    if (info.already) {
      const balance = await queryBalance(activeCookie);
      log(`👤 Account | ${HOST}`);
      logField('Status',    '🔁 今日已签到');
      logField('Days left', `连续 ${info.days} 天`);
      if (balance) logField('Balance', balance);
      sep();
      log(`📊 Summary\nDuplicate  : 1\n🎯 Result  : 今日已签到`);
      return;
    }

    if (!info.once) {
      if (attempt + 1 < MAX_RETRY) {
        log('once 码未找到，3 秒后重试...');
        await sleep(3000);
        return doCheckin(attempt + 1);
      }
      logField('Status', '❌ 未找到 once 码');
      await notify('V2EX ❌ 签到失败', '未找到 once 码，请检查网络或 Cookie');
      process.exit(1);
    }

    const redeem = requireSuccess(
      await fetchUrlFull(`https://www.v2ex.com/mission/daily/redeem?once=${info.once}`, activeCookie),
      '签到兑换'
    );
    activeCookie = refreshCookieFromResponse(activeCookie, redeem.setCookies);
    const confirmation = await getOnce(activeCookie);
    if (!confirmation.logged_in || !confirmation.already) {
      throw new Error('签到兑换未通过服务端确认');
    }
    activeCookie = confirmation.cookie || activeCookie;
    const balance = await queryBalance(activeCookie);

    log(`👤 Account | ${HOST}`);
    logField('Status',    '✅ 签到成功');
    logField('Days left', `连续 ${confirmation.days} 天`);
    if (balance) logField('Balance', balance);
    sep();
    log(`📊 Summary\nSuccess    : 1\n🎯 Result  : 签到成功`);

  } catch (e) {
    if (attempt + 1 < MAX_RETRY) {
      log(`网络错误: ${e.message}，3 秒后重试...`);
      await sleep(3000);
      return doCheckin(attempt + 1);
    }
    logField('Status', `❌ 网络错误: ${e.message}`);
    await notify('V2EX ❌ 网络错误', e.message);
    process.exit(1);
  }
}

// ========== 入口 ==========
const args = process.argv.slice(2);

async function verifyExistingIdentity(cookie) {
  const result = await profileAuth.verifyAndCompare(cfg, cookie, {
    userAgent: COMMON_HEADERS['User-Agent'],
    acceptLanguage: COMMON_HEADERS['Accept-Language'],
  });
  if (!result.ok) throw new Error(`Profile ${cfg.profile} 认证失败: ${result.message}`);
  if (result.identityState === 'different') {
    throw new Error(`Profile ${cfg.profile} 的 Cookie 与已绑定账号不一致，请通过 Telegram 显式换绑`);
  }
  if (result.identityState === 'unbound') {
    profileAuth.safeRemoveChromeProfile(cfg);
  }
  profileAuth.writeIdentity(cfg.identityFile, profileAuth.createIdentityRecord(result.identity, result.current));
}

async function saveCookieSafely(rawCookie) {
  const candidate = profileAuth.serializeCookieMap(profileAuth.parseCookieInput(rawCookie));
  const verifyOptions = {
    userAgent: COMMON_HEADERS['User-Agent'],
    acceptLanguage: COMMON_HEADERS['Accept-Language'],
  };
  const result = await profileAuth.verifyAndCompare(cfg, candidate, verifyOptions);
  if (!result.ok) throw new Error(`Cookie 验证失败: ${result.message}`);
  if (result.identityState === 'different') {
    throw new Error(`Profile ${cfg.profile} 已绑定其他账号，请通过 Telegram 显式换绑`);
  }
  if (result.identityState === 'unbound' && fs.existsSync(COOKIE_FILE)) {
    const existingCookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
    if (existingCookie && existingCookie !== candidate) {
      let existingVerification = null;
      try {
        existingVerification = await profileAuth.verifyCookie(existingCookie, verifyOptions);
      } catch (_) {}
      if (!existingVerification || !existingVerification.ok || existingVerification.identity !== result.identity) {
        throw new Error(`Profile ${cfg.profile} 已有 Cookie 但身份记录缺失或无法确认，请通过 Telegram 显式换绑`);
      }
    }
  }
  if (result.identityState === 'unbound') {
    profileAuth.safeRemoveChromeProfile(cfg);
  }

  const oldCookie = fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8') : null;
  try {
    config.writeFileAtomic(COOKIE_FILE, candidate, { mode: 0o600 });
    profileAuth.writeIdentity(cfg.identityFile, profileAuth.createIdentityRecord(result.identity, result.current));
  } catch (e) {
    try {
      if (oldCookie === null) {
        if (fs.existsSync(COOKIE_FILE)) fs.unlinkSync(COOKIE_FILE);
      } else {
        config.writeFileAtomic(COOKIE_FILE, oldCookie, { mode: 0o600 });
      }
    } catch (_) {}
    throw e;
  }
  console.log(`✅ Cookie 已验证并保存到 ${COOKIE_FILE}`);
}

async function runEntry() {
  if (PROFILE_LIST.length > 0 && !cfg.profileExplicit) {
    throw new Error('多账号模式运行签到或保活必须显式设置 V2EX_PROFILE');
  }

  const lockDetails = {
    profile: cfg.profile,
    task: args.includes('--save-cookie') ? 'cookie-import' : (args.includes('--ping') ? 'ping' : 'checkin'),
  };
  let waitLogged = false;
  const lockHandle = args.includes('--save-cookie')
    ? profileLock.acquireLock(cfg.credentialLockFile, lockDetails)
    : await profileLock.acquireLockWithWait(cfg.credentialLockFile, lockDetails, {
      timeoutMs: 4 * 60 * 60 * 1000,
      retryMs: 30000,
      onWait(error) {
        if (waitLogged) return;
        waitLogged = true;
        const owner = error.lock && error.lock.task ? error.lock.task : 'unknown';
        log(`⏳ 当前 profile 正在执行 ${owner}，签到/保活将在锁释放后继续（最多等待 4 小时）`);
      },
    });
  const release = () => {
    try { lockHandle.release(); } catch (_) {}
  };
  process.once('exit', release);
  try {
    if (args.includes('--save-cookie')) {
      const cookie = process.env.V2EX_COOKIE || '';
      if (!cookie) throw new Error('请设置环境变量 V2EX_COOKIE="your_cookie_here"');
      await saveCookieSafely(cookie);
      return;
    }

    if (PROFILE_LIST.length === 0 && !fs.existsSync(COOKIE_FILE) && process.env.V2EX_COOKIE) {
      await saveCookieSafely(process.env.V2EX_COOKIE);
    }
    const cookie = readCookie();
    if (cookie) await verifyExistingIdentity(cookie);
    if (args.includes('--ping')) await doPing();
    else await doCheckin();
  } finally {
    process.removeListener('exit', release);
    release();
  }
}

if (require.main === module) {
  runEntry().catch(e => {
    console.error('未捕获错误:', e.message);
    process.exit(1);
  });
}

module.exports = {
  fetchUrlFull,
  formatBalance,
  mergeSetCookies,
  parseLoginStatus,
  requireSuccess,
};
