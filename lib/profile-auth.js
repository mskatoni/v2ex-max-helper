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

function extractIdentity(html) {
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
  if (topIdentities.size === 1) return Array.from(topIdentities)[0];

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
  return body.includes('需要先登录') || body.includes('/signin') || body.includes('你要查看的页面需要先登录');
}

function requestBalance(cookie, options = {}, target = `${V2EX_ORIGIN}/balance`, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(target, V2EX_ORIGIN);
    if (parsed.origin !== V2EX_ORIGIN || parsed.protocol !== 'https:') {
      reject(new Error('认证请求拒绝跨 V2EX HTTPS 源重定向'));
      return;
    }
    const req = https.request({
      protocol: 'https:',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        Cookie: cookie,
        'User-Agent': options.userAgent || 'Mozilla/5.0 AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': options.acceptLanguage || 'en,zh-CN;q=0.9,zh;q=0.8',
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) req.destroy(new Error('认证响应过大'));
      });
      res.on('end', () => {
        const statusCode = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
          if (redirects >= 3) return reject(new Error('认证请求重定向次数过多'));
          let next;
          try { next = new URL(res.headers.location, parsed); } catch (e) { return reject(e); }
          if (next.origin !== V2EX_ORIGIN || next.protocol !== 'https:') {
            return reject(new Error('认证请求拒绝跨 V2EX HTTPS 源重定向'));
          }
          return requestBalance(cookie, options, next.toString(), redirects + 1).then(resolve, reject);
        }
        resolve({ statusCode, body, finalUrl: parsed.toString() });
      });
    });
    req.on('error', reject);
    req.setTimeout(options.timeoutMs || 20000, () => req.destroy(new Error('认证请求超时')));
    req.end();
  });
}

function diagnoseAuthPage(response) {
  if (response.statusCode !== 200 || looksLoggedOut(response.body)) {
    return { ok: false, code: 'logged_out', message: 'V2EX 登录态无效', statusCode: response.statusCode };
  }
  if (!/balance_area\s+bigger/i.test(response.body)) {
    return { ok: false, code: 'auth_page_unrecognized', message: '认证页未包含余额区域', statusCode: response.statusCode };
  }
  const identity = extractIdentity(response.body);
  if (!identity) {
    return { ok: false, code: 'identity_unverified', message: '无法唯一确认当前 V2EX 账号', statusCode: response.statusCode };
  }
  return { ok: true, code: 'ok', identity, statusCode: response.statusCode };
}

async function verifyCookie(cookie, options = {}) {
  return diagnoseAuthPage(await requestBalance(cookie, options));
}

function readIdentity(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.version !== 1 || !parsed.salt || !parsed.identityHash) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function hashIdentity(identity, salt) {
  return crypto.createHash('sha256').update(`${salt}\0${String(identity).trim().toLowerCase()}`).digest('hex');
}

function createIdentityRecord(identity, existing = null) {
  const now = new Date().toISOString();
  const salt = existing && existing.salt ? existing.salt : crypto.randomBytes(16).toString('hex');
  return {
    version: 1,
    salt,
    identityHash: hashIdentity(identity, salt),
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
  const current = readIdentity(cfg.identityFile);
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
  extractIdentity,
  hashIdentity,
  identityMatches,
  parseCookieInput,
  readIdentity,
  safeRemoveChromeProfile,
  serializeCookieMap,
  verifyAndCompare,
  verifyCookie,
  writeIdentity,
};
