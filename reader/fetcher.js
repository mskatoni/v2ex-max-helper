'use strict';
// ========== 帖子 URL 多源抓取 ==========
const https  = require('https');
const logger = require('./logger');

const HOST = 'www.v2ex.com';

// 多源配置
const SOURCES = [
  { path: '/recent',           name: '最新' },
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
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const statusCode = res.statusCode || 0;
        if (statusCode >= 300) {
          logger.warn(`Fetcher ${reqPath} returned HTTP ${statusCode}`);
        }
        resolve(body);
      });
    });
    req.on('error', reject);
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

  // 多页 /recent
  for (const p of RECENT_PAGES) {
    try {
      const html = await fetchPage(p, cookie);
      const urls = extractPostUrls(html);
      logger.info(`Fetcher ${p}: ${urls.length} posts`);
      allUrls.push(...urls);
      await sleep(2000);
    } catch (e) {
      logger.warn(`Fetcher ${p} failed: ${e.message}`);
    }
  }

  // 其他来源
  for (const src of SOURCES) {
    try {
      const html = await fetchPage(src.path, cookie);
      const urls = extractPostUrls(html);
      logger.info(`Fetcher ${src.name} (${src.path}): ${urls.length} posts`);
      allUrls.push(...urls);
      await sleep(2000);
    } catch (e) {
      logger.warn(`Fetcher ${src.name} failed: ${e.message}`);
    }
  }

  // 去重
  const unique = [...new Set(allUrls)];
  logger.info(`Fetcher total unique: ${unique.length}`);
  return unique;
}

// 强制抓取（忽略冷却，供初始化使用）
async function fetchAllForce(cookie) {
  lastFetchTime = 0;
  return fetchAll(cookie);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { fetchAll, fetchAllForce };
