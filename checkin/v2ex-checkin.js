#!/usr/bin/env node
/**
 * V2EX 每日签到 - Node.js 独立版（含保活机制）
 * Version: v1.3.2
 *
 * 用法：
 *   保存 Cookie：
 *     V2EX_COOKIE="..." node v2ex-checkin.js --save-cookie
 *
 *   每日签到（crontab 01:10 UTC = 北京 09:10）：
 *     10 1 * * * /usr/bin/node /path/to/v2ex-checkin.js >> /var/log/v2ex.log 2>&1
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
const path  = require('path');
const url   = require('url');
const config = require('../lib/config');

// ========== 配置 ==========
const SCRIPT_VERSION = 'v1.3.2';
const HOST           = 'www.v2ex.com';
const MAX_RETRY      = 3;

const cfg = config.getConfig();
const COOKIE_FILE = cfg.cookieFile;

// 推送配置（从环境变量或 ~/.v2ex_env 读取，不硬编码）
const BARK_URL       = cfg.barkUrl;                 // e.g. https://api.day.app/YOUR_KEY
const TG_BOT_TOKEN   = cfg.telegram.checkinToken;   // TG_BOT_TOKEN 优先，TG_TOKEN 兼容 fallback
const TG_CHAT_ID     = cfg.telegram.chatId;

const COMMON_HEADERS = {
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en,zh-CN;q=0.9,zh;q=0.8',
  'cache-control':   'max-age=0',
  'pragma':          'no-cache',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer':         'https://www.v2ex.com/'
};

// ========== Cookie 存储 ==========
function readCookie() {
  // 如果 Cookie 文件不存在，但环境变量里有，则自动初始化
  if (process.env.V2EX_COOKIE && !fs.existsSync(COOKIE_FILE)) {
    writeCookie(process.env.V2EX_COOKIE);
  }
  try {
    if (fs.existsSync(COOKIE_FILE)) return fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  } catch (e) {}
  return '';
}

function writeCookie(cookie) {
  try {
    const dir = path.dirname(COOKIE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(COOKIE_FILE, cookie.trim(), { mode: 0o600 });
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
    // 每条 Set-Cookie 形如 "A2=xxx; Path=/; Expires=...; HttpOnly"
    const first = sc.split(';')[0];
    const i = first.indexOf('=');
    if (i < 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (!name) continue;
    // 删除型 set-cookie（值为空或 deleted）跳过，避免把登录态清掉
    if (value === '' || value === 'deleted') continue;
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
    writeCookie(cookie);
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
function fetchUrlFull(reqUrl, cookie, _redirects = 0, _acc = []) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, COMMON_HEADERS, { Cookie: cookie });
    const parsed  = new url.URL(reqUrl);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(reqUrl, { headers }, (res) => {
      const sc = res.headers['set-cookie'] || [];
      const acc = _acc.concat(sc);
      // 跟随重定向（最多3次）
      if ([301, 302, 303].includes(res.statusCode) && res.headers.location && _redirects < 3) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${HOST}${res.headers.location}`;
        res.resume();
        return fetchUrlFull(loc, cookie, _redirects + 1, acc).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ body, setCookies: acc }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
  });
}

// 兼容旧调用：只取 body
function fetchUrl(reqUrl, cookie) {
  return fetchUrlFull(reqUrl, cookie).then(r => r.body);
}

// ========== 推送通知 ==========
function sendBark(title, msg) {
  if (!BARK_URL) return Promise.resolve();
  const target = `${BARK_URL.replace(/\/$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(msg)}`;
  return fetchUrl(target, '').catch(() => {});
}

function sendTelegram(title, msg) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return Promise.resolve();
  const text = `*${title}*\n${msg}`;
  const target = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage?chat_id=${TG_CHAT_ID}&text=${encodeURIComponent(text)}&parse_mode=Markdown`;
  return fetchUrl(target, '').catch(() => {});
}

function notify(title, msg) {
  return Promise.all([sendBark(title, msg), sendTelegram(title, msg)]);
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
  if (html.includes('你要查看的页面需要先登录') || html.includes('需要先登录')) {
    return { logged_in: false };
  }
  return { logged_in: true };
}

async function getOnce(cookie) {
  const { body: html, setCookies } = await fetchUrlFull('https://www.v2ex.com/mission/daily', cookie);
  const status = parseLoginStatus(html);
  if (!status.logged_in) return { once: '', logged_in: false, already: false, days: '?' };
  // 签到访问也会触发登录态续期，写回刷新后的 Cookie
  refreshCookieFromResponse(cookie, setCookies);
  const days = (html.match(/已连续登录\s*(\d+)\s*天/) || [])[1] || '?';
  if (html.includes('每日登录奖励已领取')) return { once: '', logged_in: true, already: true, days };
  const once = (html.match(/once=(\d+)/) || [])[1] || '';
  return { once, logged_in: true, already: false, days };
}

async function queryBalance(cookie) {
  return formatBalance(await fetchUrl('https://www.v2ex.com/balance', cookie));
}

// ========== Logger ==========
function pad(n) { return String(n).padStart(2, '0'); }
function tsNow() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} UTC`;
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
    return;
  }
  try {
    const { body: html, setCookies } = await fetchUrlFull('https://www.v2ex.com/', cookie);
    const status = parseLoginStatus(html);
    if (!status.logged_in) {
      log('❌ Cookie 已失效（保活检测）');
      await notify('V2EX ⚠️ Cookie 失效', '请重新登录 V2EX 并更新 Cookie，签到将中断！');
      log('📢 告警已发送（如已配置推送）');
    } else {
      // 关键：把服务端下发的续期 Cookie 写回，实现登录态自动刷新
      refreshCookieFromResponse(cookie, setCookies);
      log('✅ Session 正常，保活成功');
    }
  } catch (e) {
    log(`⚠️  保活请求失败: ${e.message}`);
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

    if (!info.logged_in) {
      logField('Status', '❌ Cookie 已失效');
      log('📢 发送失效告警...');
      await notify('V2EX ❌ Cookie 失效', '签到失败，请重新登录 V2EX 更新 Cookie！连续天数将中断。');
      sep();
      log('📊 Summary\nFailed     : 1\n🎯 Result  : Cookie 已失效');
      process.exit(1);
    }

    if (info.already) {
      const balance = await queryBalance(cookie);
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

    await fetchUrl(`https://www.v2ex.com/mission/daily/redeem?once=${info.once}`, cookie);
    const balance = await queryBalance(cookie);

    log(`👤 Account | ${HOST}`);
    logField('Status',    '✅ 签到成功');
    logField('Days left', `连续 ${info.days} 天`);
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

if (args.includes('--save-cookie')) {
  const cookie = process.env.V2EX_COOKIE || '';
  if (!cookie) {
    console.error('请设置环境变量 V2EX_COOKIE="your_cookie_here"');
    process.exit(1);
  }
  if (writeCookie(cookie)) console.log(`✅ Cookie 已保存到 ${COOKIE_FILE}`);
} else if (args.includes('--ping')) {
  doPing().catch(e => { console.error(e.message); process.exit(1); });
} else {
  doCheckin().catch(e => { console.error('未捕获错误:', e.message); process.exit(1); });
}
