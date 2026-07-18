'use strict';
// ========== 帖子 URL 多源抓取 ==========
const https  = require('https');
const logger = require('./logger');
const fingerprint = require('./fingerprint');
const profileAuth = require('../lib/profile-auth');
require('../lib/config'); // 独立调用本模块时也先安装共享代理。

const HOST = 'www.v2ex.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FP = fingerprint.generate(process.env.V2EX_PROFILE || 'default');

// 多源配置
const SOURCES = [
  { path: '/?tab=hot',         name: '热帖' },
  { path: '/?tab=all',         name: '全部' },
  { path: '/?tab=tech',        name: '技术' },
  { path: '/go/programming',   name: '编程' },
  { path: '/go/python',        name: 'Python' },
  { path: '/go/linux',         name: 'Linux' },
  { path: '/go/cn',            name: '中文' },
];

// 多页抓取（/recent 支持翻页）
const RECENT_PAGES = [
  '/recent?p=1',
  '/recent?p=2',
  '/recent?p=3',
];

const COMMON_HEADERS = {
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'User-Agent':      FP.userAgent,
  'Referer':         'https://www.v2ex.com/',
};

function fetchPage(reqPath, cookie) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST,
      path: reqPath,
      method: 'GET',
      headers: Object.assign({}, COMMON_HEADERS, { Cookie: cookie }),
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
          req.destroy(new Error('fetcher response too large'));
          return;
        }
        body += c;
      });
      res.on('aborted', () => finish(new Error('fetcher response aborted')));
      res.on('error', finish);
      res.on('end', () => {
        if (settled) return;
        const statusCode = res.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          finish(new Error(`Fetcher returned HTTP ${statusCode || 'unknown'}`));
          return;
        }
        if (profileAuth.looksLoggedOut(body)) {
          const error = new Error('Fetcher detected an expired V2EX session');
          error.code = 'SESSION_EXPIRED';
          finish(error);
          return;
        }
        finish(null, body);
      });
    });
    req.on('error', finish);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// 从 HTML 中提取帖子 URL（/t/数字）
function extractPostUrls(html) {
  const urls = [];
  const seen = new Set();
  // 匹配 href="/t/数字" 格式
  const re = /href="\/t\/(\d+)[^"]*"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = `https://${HOST}/t/${m[1]}`;
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

// 冷却控制
let lastFetchTime = 0;
const FETCH_COOLDOWN = 5 * 60 * 1000; // 5 分钟冷却

// 从所有来源抓取帖子 URL
async function fetchAll(cookie) {
  const now = Date.now();
  if (now - lastFetchTime < FETCH_COOLDOWN && lastFetchTime > 0) {
    logger.info(`Fetcher 冷却中，跳过（${Math.ceil((FETCH_COOLDOWN - (now - lastFetchTime)) / 1000)}s 后可用）`);
    return [];
  }
  lastFetchTime = now;

  const allUrls = [];
  let successfulSources = 0;
  let failedSources = 0;

  // 多页 /recent
  for (const p of RECENT_PAGES) {
    try {
      const html = await fetchPage(p, cookie);
      successfulSources++;
      const urls = extractPostUrls(html);
      logger.info(`Fetcher ${p}: ${urls.length} posts`);
      allUrls.push(...urls);
      await sleep(2000);
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED') throw e;
      failedSources++;
      logger.warn(`Fetcher ${p} failed: ${e.message}`);
    }
  }

  // 其他来源
  for (const src of SOURCES) {
    try {
      const html = await fetchPage(src.path, cookie);
      successfulSources++;
      const urls = extractPostUrls(html);
      logger.info(`Fetcher ${src.name} (${src.path}): ${urls.length} posts`);
      allUrls.push(...urls);
      await sleep(2000);
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED') throw e;
      failedSources++;
      logger.warn(`Fetcher ${src.name} failed: ${e.message}`);
    }
  }

  // 去重
  const unique = [...new Set(allUrls)];
  if (successfulSources === 0) {
    throw new Error(`Fetcher all ${failedSources} sources failed`);
  }
  if (unique.length === 0) {
    throw new Error(`Fetcher found no topic URLs in ${successfulSources} successful responses`);
  }
  logger.info(`Fetcher total unique: ${unique.length}`);
  return unique;
}

// 强制抓取（忽略冷却，供初始化使用）
async function fetchAllForce(cookie) {
  lastFetchTime = 0;
  return fetchAll(cookie);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { fetchAll, fetchAllForce, fetchPage, extractPostUrls };
