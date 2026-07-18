'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const config = require('./config');

const V2EX_ORIGIN = 'https://www.v2ex.com';
const MAX_COOKIE_BYTES = 16 * 1024;
const MAX_COOKIE_PAIRS = 64;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function parseCookieInput(input) {
  let text = String(input || '').trim();
  if (/^cookie\s*:/i.test(text)) text = text.replace(/^cookie\s*:/i, '').trim();
  if (!text || Buffer.byteLength(text) > MAX_COOKIE_BYTES || /[\r\n\0]/.test(text)) {
    throw new Error('Cookie 内容为空、过长或包含非法控制字符');
  }

  const values = new Map();
  for (const rawPart of text.split(';')) {
    const part = rawPart.trim();
    if (!part) continue;
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!COOKIE_NAME_PATTERN.test(name) || /[\r\n\0;]/.test(value)) {
      throw new Error(`Cookie 字段 ${name || '(empty)'} 格式非法`);
    }
    if (/^_ga(?:_|$)|^_gid$|^_gat(?:_|$)/i.test(name)) continue;
    values.set(name, value);
    if (values.size > MAX_COOKIE_PAIRS) throw new Error('Cookie 字段数量过多');
  }
  if (!values.get('A2')) throw new Error('Cookie 必须包含非空 A2 字段');
  return values;
}

function serializeCookieMap(values) {
  return Array.from(values.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
}

function extractTopIdentity(html) {
  const source = String(html || '');
  const topIdentities = new Set();
  const topLink = /<a\b(?=[^>]*\bclass=["'][^"']*\btop\b[^"']*["'])(?=[^>]*\bhref=["']\/member\/([^"'/?#]+)["'])[^>]*>/gi;
  let topMatch;
  while ((topMatch = topLink.exec(source)) !== null) {
    try {
      const value = decodeURIComponent(topMatch[1]).trim().toLowerCase();
      if (value) topIdentities.add(value);
    } catch (_) {}
  }
  return topIdentities.size === 1 ? Array.from(topIdentities)[0] : '';
}

function extractIdentity(html) {
  const source = String(html || '');
  const topIdentity = extractTopIdentity(source);
  if (topIdentity) return topIdentity;

  const identities = new Set();
  const re = /href=["']\/member\/([^"'/?#]+)["']/gi;
  let match;
  while ((match = re.exec(source)) !== null) {
    try {
      const value = decodeURIComponent(match[1]).trim().toLowerCase();
      if (value) identities.add(value);
    } catch (_) {}
  }
  return identities.size === 1 ? Array.from(identities)[0] : '';
}

function looksLoggedOut(html) {
  const body = String(html || '');
  const hasSignin = /\b(?:href|action)=["']\/signin(?:\?[^"']*)?["']/i.test(body);
  const hasSignout = /<a\b[^>]*\bhref=["']\/signout(?:\?[^"']*)?["'][^>]*>/i.test(body);
  return body.includes('需要先登录') || body.includes('你要查看的页面需要先登录') ||
    (hasSignin && !hasSignout);
}

function hasAuthenticatedNavigation(html) {
  const body = String(html || '');
  const hasSignout = /<a\b[^>]*\bhref=["']\/signout(?:\?[^"']*)?["'][^>]*>/i.test(body);
  const hasNotifications = /<a\b[^>]*\bhref=["']\/notifications(?:\?[^"']*)?["'][^>]*>/i.test(body);
  // Topic pages expose the private notifications link and account link, but
  // currently omit signout. A unique top account is verified separately.
  return hasNotifications && (hasSignout || Boolean(extractTopIdentity(body)));
}

function requestBalance(cookie, options = {}, target = `${V2EX_ORIGIN}/balance`, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(target, V2EX_ORIGIN);
    if (parsed.origin !== V2EX_ORIGIN || parsed.protocol !== 'https:') {
      reject(new Error('认证请求拒绝跨 V2EX HTTPS 源重定向'));
      return;
    }
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const req = https.request({
      protocol: 'https:',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        Cookie: cookie,
        'User-Agent': options.userAgent || 'Mozilla/5.0',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': options.acceptLanguage || 'en,zh-CN;q=0.9,zh;q=0.8',
      },
    }, (res) => {
      let body = '';
      let received = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        received += Buffer.byteLength(chunk);
        if (received > 2 * 1024 * 1024) {
          req.destroy(new Error('认证响应过大'));
          return;
        }
        body += chunk;
      });
      res.on('aborted', () => finish(new Error('认证响应被中断')));
      res.on('error', finish);
      res.on('end', () => {
        if (settled) return;
        const statusCode = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
          if (redirects >= 3) return finish(new Error('认证请求重定向次数过多'));
          let next;
          try { next = new URL(res.headers.location, parsed); } catch (e) { return finish(e); }
          if (next.origin !== V2EX_ORIGIN || next.protocol !== 'https:') {
            return finish(new Error('认证请求拒绝跨 V2EX HTTPS 源重定向'));
          }
          return requestBalance(cookie, options, next.toString(), redirects + 1).then(
            value => finish(null, value),
            finish
          );
        }
        finish(null, { statusCode, body, finalUrl: parsed.toString() });
      });
    });
    req.on('error', finish);
    req.setTimeout(options.timeoutMs || 20000, () => req.destroy(new Error('认证请求超时')));
    req.end();
  });
}

function diagnoseAuthPage(response) {
  if (response.statusCode !== 200) {
    return {
      ok: false,
      code: 'auth_http_status',
      message: `认证页返回异常状态 (HTTP ${response.statusCode || 'unknown'})`,
      statusCode: response.statusCode,
    };
  }
  if (looksLoggedOut(response.body)) {
    return { ok: false, code: 'logged_out', message: 'V2EX 登录态无效', statusCode: response.statusCode };
  }
  if (!/balance_area\s+bigger/i.test(response.body)) {
    return { ok: false, code: 'auth_page_unrecognized', message: '认证页未包含余额区域', statusCode: response.statusCode };
  }
  const identity = extractTopIdentity(response.body);
  if (!identity) {
    return { ok: false, code: 'identity_unverified', message: '无法从认证导航确认当前 V2EX 账号', statusCode: response.statusCode };
  }
  return { ok: true, code: 'ok', identity, statusCode: response.statusCode };
}

function diagnoseHomePage(response) {
  const body = String(response && response.body || '');
  const statusCode = response && response.statusCode || 0;
  if (statusCode !== 200) {
    return {
      ok: false,
      code: 'auth_home_http_status',
      message: `首页认证探针返回异常状态 (HTTP ${statusCode || 'unknown'})`,
      statusCode,
    };
  }
  if (looksLoggedOut(body) || !hasAuthenticatedNavigation(body)) {
    return { ok: false, code: 'logged_out', message: 'V2EX 登录态无效', statusCode };
  }
  const identity = extractTopIdentity(body);
  if (!identity) {
    return { ok: false, code: 'identity_unverified', message: '无法从首页唯一确认当前 V2EX 账号', statusCode };
  }
  return { ok: true, code: 'ok', identity, statusCode };
}

async function verifyCookie(cookie, options = {}) {
  const requestPage = typeof options.requestPage === 'function' ? options.requestPage : requestBalance;
  let balanceResult = null;
  let balanceError = null;
  try {
    balanceResult = diagnoseAuthPage(await requestPage(cookie, options, `${V2EX_ORIGIN}/balance`));
    if (balanceResult.ok) return { ...balanceResult, verificationSource: 'balance' };
  } catch (e) {
    balanceError = e;
  }

  try {
    const homeResult = diagnoseHomePage(await requestPage(cookie, options, `${V2EX_ORIGIN}/`));
    if (homeResult.ok) {
      return {
        ...homeResult,
        verificationSource: 'home_fallback',
        fallbackCode: balanceResult ? balanceResult.code : 'balance_request_failed',
      };
    }
    return homeResult;
  } catch (homeError) {
    if (balanceResult) return balanceResult;
    throw balanceError || homeError;
  }
}

function readIdentity(file, options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.version !== 1 || !parsed.salt || !parsed.identityHash) {
      if (options.strict) throw new Error('身份记录格式无效');
      return null;
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (options.strict) {
      throw new Error(`身份记录存在但无法读取或校验 (${error.code || 'invalid data'})`);
    }
    return null;
  }
}

function hashIdentity(identity, salt) {
  return crypto.createHash('sha256').update(`${salt}\0${String(identity).trim().toLowerCase()}`).digest('hex');
}

function maskIdentity(identity) {
  const value = String(identity || '').trim();
  if (value.length <= 2) return '**';
  return `${value.slice(0, 1)}***${value.slice(-1)}`;
}

function getIdentityHint(record) {
  const value = record && typeof record.identityHint === 'string' ? record.identityHint.trim() : '';
  return /^(?:\*\*|[0-9A-Za-z_-]\*{3}[0-9A-Za-z_-])$/.test(value) ? value : '';
}

function createIdentityRecord(identity, existing = null) {
  const now = new Date().toISOString();
  const salt = existing && existing.salt ? existing.salt : crypto.randomBytes(16).toString('hex');
  return {
    version: 1,
    salt,
    identityHash: hashIdentity(identity, salt),
    identityHint: maskIdentity(identity),
    boundAt: existing && existing.boundAt ? existing.boundAt : now,
    verifiedAt: now,
  };
}

function identityMatches(record, identity) {
  return Boolean(record && record.identityHash === hashIdentity(identity, record.salt));
}

function writeIdentity(file, record) {
  config.writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

async function verifyAndCompare(cfg, cookie, options = {}) {
  const verification = await verifyCookie(cookie, options);
  if (!verification.ok) return { ...verification, identityState: 'unverified' };
  const current = readIdentity(cfg.identityFile, { strict: true });
  if (!current) return { ...verification, identityState: 'unbound', current: null };
  return {
    ...verification,
    identityState: identityMatches(current, verification.identity) ? 'same' : 'different',
    current,
  };
}

function safeRemoveChromeProfile(cfg) {
  const target = path.resolve(cfg.chromeProfileDir);
  const root = path.resolve(path.join(cfg.readerDataDir, 'chrome-profile'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('拒绝清理不安全的 Chromium profile 路径');
  }
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: false });
}

module.exports = {
  createIdentityRecord,
  diagnoseAuthPage,
  diagnoseHomePage,
  extractIdentity,
  extractTopIdentity,
  getIdentityHint,
  hashIdentity,
  identityMatches,
  looksLoggedOut,
  maskIdentity,
  parseCookieInput,
  readIdentity,
  safeRemoveChromeProfile,
  serializeCookieMap,
  verifyAndCompare,
  verifyCookie,
  writeIdentity,
};
