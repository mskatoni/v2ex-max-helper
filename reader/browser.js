'use strict';
// ========== Playwright 浏览器控制 ==========
const fs          = require('fs');
const path        = require('path');
const logger      = require('./logger');
const fingerprint = require('./fingerprint');
const behavior    = require('./behavior');
const config      = require('../lib/config');
const secureProxy = require('../lib/secure-proxy');
const profileAuth = require('../lib/profile-auth');

// ===== 多账号 / 指纹隔离 =====
// 通过 V2EX_PROFILE（或默认 'default'）区分账号。每个 profile 拥有：
//   - 独立 Cookie 文件：~/.v2ex_cookie（default）或 ~/.v2ex_cookie.<profile>
//   - 独立 Chrome 用户数据目录：data/chrome-profile/<profile>
//   - 独立且确定性的浏览器指纹（基于 profile 名做种子）
const cfg = config.getConfig();
const PROFILE = cfg.profile;
const HOST    = 'www.v2ex.com';
const V2EX_ORIGIN = `https://${HOST}`;

const COOKIE_FILE   = cfg.cookieFile;
const USER_DATA_DIR = cfg.chromeProfileDir;

const MIB = 1024 * 1024;
const DISK_CACHE_LIMIT_BYTES = 64 * MIB;
const MEDIA_CACHE_LIMIT_BYTES = 16 * MIB;
const CACHE_PRUNE_THRESHOLD_BYTES = 128 * MIB;
const READ_POST_RETRY_COUNT = 3;
const READ_POST_RETRY_BASE_MS = 5000;
const BROWSER_IO_RETRY_COUNT = 3;
const BROWSER_IO_RETRY_BASE_MS = 1000;
const CACHE_PATHS = [
  path.join('Default', 'Cache'),
  path.join('Default', 'Code Cache'),
  path.join('Default', 'GPUCache'),
  path.join('Default', 'DawnCache'),
  path.join('Default', 'DawnGraphiteCache'),
  path.join('Default', 'DawnWebGPUCache'),
  path.join('Default', 'Service Worker', 'CacheStorage'),
  'GrShaderCache',
  'GraphiteDawnCache',
  'ShaderCache',
];

// 为当前 profile 生成确定性指纹
const FP = fingerprint.generate(PROFILE);
const BEHAVIOR = behavior.resolve(PROFILE);
const HTTP_ONLY_COOKIES = new Set(['A2', 'A2O', 'PB3_SESSION', 'cf_clearance']);

// Cookie 字符串 → Playwright cookies 数组
function parseCookieString(str) {
  return str.split(';').map(s => s.trim()).filter(Boolean).map(part => {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) return null;
    const name  = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    return {
      name,
      value,
      domain: `.${HOST}`,
      path:   '/',
      httpOnly: HTTP_ONLY_COOKIES.has(name),
      secure: true,
      sameSite: 'Lax',
    };
  }).filter(Boolean);
}

// Playwright cookies 数组 → Cookie 字符串（写回文件）
function serializeCookies(cookies) {
  const selected = new Map();
  for (const cookie of cookies) {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    if ((domain !== HOST && domain !== 'v2ex.com') || String(cookie.path || '/') !== '/') continue;
    const rank = domain === HOST ? 2 : 1;
    const existing = selected.get(cookie.name);
    if (!existing || rank >= existing.rank) selected.set(cookie.name, { cookie, rank });
  }
  return Array.from(selected.values()).map(({ cookie }) => `${cookie.name}=${cookie.value}`).join('; ');
}

function normalizePostUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error('帖子 URL 格式无效'); }
  if (parsed.username || parsed.password || parsed.origin !== V2EX_ORIGIN || !/^\/t\/\d+$/.test(parsed.pathname)) {
    throw new Error('拒绝访问非 V2EX 帖子 URL');
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed;
}

function isV2exOrigin(value) {
  try { return new URL(value).origin === V2EX_ORIGIN; } catch (_) { return false; }
}

let ctx      = null;   // BrowserContext（persistent context）
let page     = null;
let isDryRun = false;

function buildLaunchArgs() {
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    `--disk-cache-size=${DISK_CACHE_LIMIT_BYTES}`,
    `--media-cache-size=${MEDIA_CACHE_LIMIT_BYTES}`,
    '--js-flags=--max-old-space-size=256',
    '--disable-extensions',
    '--disable-default-apps',
    `--lang=${FP.locale}`,
  ];
  if (secureProxy.proxyEnabled()) args.push('--disable-quic');
  return args;
}

function cachePathSize(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (_) {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;

  let total = 0;
  for (const entry of fs.readdirSync(target)) {
    total += cachePathSize(path.join(target, entry));
  }
  return total;
}

function getCacheTargets(profileDir) {
  const root = path.resolve(profileDir);
  return CACHE_PATHS.map(relativePath => {
    const target = path.resolve(root, relativePath);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('拒绝清理不安全的 Chromium 缓存路径');
    }
    return target;
  });
}

function pruneBrowserCache(profileDir = USER_DATA_DIR, thresholdBytes = CACHE_PRUNE_THRESHOLD_BYTES) {
  if (!Number.isSafeInteger(thresholdBytes) || thresholdBytes < 0) {
    throw new Error('Chromium 缓存清理阈值无效');
  }
  const targets = getCacheTargets(profileDir);
  const sizeBefore = targets.reduce((sum, target) => sum + cachePathSize(target), 0);
  if (sizeBefore <= thresholdBytes) {
    return { pruned: false, sizeBefore, sizeAfter: sizeBefore, failed: 0 };
  }

  let failed = 0;
  for (const target of targets) {
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) continue;
      fs.rmSync(target, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'ENOENT') failed++;
    }
  }
  const sizeAfter = targets.reduce((sum, target) => sum + cachePathSize(target), 0);
  return { pruned: true, sizeBefore, sizeAfter, failed };
}

function pruneBrowserCacheWithLog() {
  try {
    const result = pruneBrowserCache();
    if (!result.pruned) return;
    const beforeMiB = (result.sizeBefore / MIB).toFixed(1);
    const afterMiB = (result.sizeAfter / MIB).toFixed(1);
    logger.info(`Chromium 缓存已按阈值裁剪: ${beforeMiB} MiB -> ${afterMiB} MiB`);
    if (result.failed > 0) logger.warn(`Chromium 缓存有 ${result.failed} 个目录清理失败`);
  } catch (e) {
    logger.warn(`Chromium 缓存检查失败: ${e.message}`);
  }
}

async function launch(dryRun = false) {
  isDryRun = dryRun;

  if (dryRun) {
    logger.info('[DRY-RUN] 跳过 Cookie 读取和浏览器启动');
    return;
  }

  // 正式运行前检查 Cookie 文件。
  const cookieStr = fs.existsSync(COOKIE_FILE)
    ? fs.readFileSync(COOKIE_FILE, 'utf8').trim()
    : '';
  if (!cookieStr) {
    throw new Error(`Cookie 文件不存在或为空: ${COOKIE_FILE}`);
  }

  try {
    const { chromium } = require('playwright');

    // 确保 Chrome profile 目录存在
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    pruneBrowserCacheWithLog();

    logger.info('浏览器启动中...');
    logger.info('浏览器指纹已按当前 profile 注入');
    logger.info(`行为参数 profile=${PROFILE} dwell=${BEHAVIOR.dwellMin}-${BEHAVIOR.dwellMax}/${BEHAVIOR.dwellLong}ms gap=${BEHAVIOR.humanGapMin}-${BEHAVIOR.humanGapMax}ms settle=${BEHAVIOR.memorySettleMs}ms`);
    if (BEHAVIOR.usesLegacyGap) {
      logger.warn('检测到 READ_GAP_MIN/MAX 旧变量，已作为 READ_HUMAN_GAP_MIN/MAX 兼容处理');
    }

    const launchOptions = {
      executablePath: process.env.CHROME_BIN || undefined,
      headless: process.env.HEADLESS !== 'false',
      args: buildLaunchArgs(),
      ignoreHTTPSErrors: false,
      userAgent:  FP.userAgent,
      locale:     FP.locale,
      timezoneId: FP.timezoneId,
      viewport:   FP.viewport,
      deviceScaleFactor: 1,
      extraHTTPHeaders: {
        'Accept-Language': FP.acceptLanguage,
      },
    };

    const proxy = secureProxy.getPlaywrightProxy();
    if (proxy) {
      launchOptions.proxy = proxy;
      logger.info(`浏览器启用本机代理: ${secureProxy.redactProxyUrl(proxy.server)}`);
    }

    ctx = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);

    // 注入指纹隔离脚本（webdriver 隐藏 + navigator/WebGL 伪装）
    await ctx.addInitScript(fingerprint.buildInitScript(FP), {
      navPlatform:         FP.navPlatform,
      hardwareConcurrency: FP.hardwareConcurrency,
      deviceMemory:        FP.deviceMemory,
      languages:           FP.languages,
      webglVendor:         FP.webglVendor,
      webglRenderer:       FP.webglRenderer,
    });

    // 注入 Cookies
    const cookies = parseCookieString(cookieStr);
    // Cookie 文件是当前 profile 登录态的唯一来源，避免 persistent context 残留旧账号凭证。
    await ctx.clearCookies();
    await ctx.addCookies(cookies);
    logger.info(`已注入 ${cookies.length} 条 Cookie`);

    // 使用已有 page 或新建
    const pages = ctx.pages();
    page = pages.length > 0 ? pages[0] : await ctx.newPage();

    logger.ok('浏览器已就绪');
  } catch (e) {
    await discardContext();
    throw e;
  }
}

// 读取一篇帖子（随机偏态停留 + 随机滚动 + 帖子间随机间隔）
async function readPost(url) {
  if (isDryRun) {
    logger.info(`[DRY-RUN] → ${url}`);
    await sleep(200);
    return true;
  }

  let target;
  try { target = normalizePostUrl(url); } catch (e) {
    logger.warn(`读帖失败: ${e.message} → [invalid post URL]`);
    return false;
  }

  for (let attempt = 0; attempt <= READ_POST_RETRY_COUNT; attempt++) {
    const result = await readPostOnce(target);
    if (result.ok) {
      if (attempt > 0) logger.ok(`读帖重试成功（第 ${attempt}/${READ_POST_RETRY_COUNT} 次重试）`);
      return true;
    }
    if (!result.retryable || attempt === READ_POST_RETRY_COUNT) {
      if (result.retryable) logger.warn(`当前帖子已完成 ${READ_POST_RETRY_COUNT} 次重试，准备跳过`);
      return false;
    }

    if (result.resetPage) await resetPage();
    const retryNumber = attempt + 1;
    const delay = Math.min(READ_POST_RETRY_BASE_MS * (2 ** attempt), 20000);
    logger.warn(`${result.reason}，${delay / 1000} 秒后进行第 ${retryNumber}/${READ_POST_RETRY_COUNT} 次重试`);
    await sleep(delay);
  }

  return false;
}

async function readPostOnce(target) {
  try {
    logger.info(`→ ${target.pathname}`);
    const navigationResponse = await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!isV2exOrigin(page.url())) throw new Error('导航离开 V2EX，已拒绝继续处理');

    // 检测 Cloudflare 挑战页面
    const isCF = await detectCloudflareChallenge();
    if (isCF) {
      logger.warn('Cloudflare 挑战中，等待最多 60 秒...');
      const passed = await waitForCloudflare();
      if (!passed) {
        return { ok: false, retryable: true, resetPage: true, reason: 'Cloudflare 挑战未通过' };
      }
    }
    const finalUrl = new URL(page.url());
    if (finalUrl.origin !== V2EX_ORIGIN || finalUrl.pathname !== target.pathname) {
      throw new Error('帖子导航未停留在目标页面');
    }
    if (!isCF && (!navigationResponse || !navigationResponse.ok())) {
      throw new Error(`帖子页面返回 HTTP ${navigationResponse ? navigationResponse.status() : 'unknown'}`);
    }

    // 检测是否登录
    const content = await page.content();
    const authState = profileAuth.diagnoseHomePage({ statusCode: 200, body: content });
    if (!authState.ok) {
      logger.error(`帖子页无法确认当前登录账号 (${authState.code || 'unknown'})`);
      return {
        ok: false,
        retryable: authState.code !== 'logged_out',
        resetPage: false,
        reason: '帖子页登录状态暂时无法确认',
      };
    }

    // 随机停留时长（偏态分布：多数偏短，偶尔长读）
    const dwell = randomDwellMs();
    logger.info(`停留 ${(dwell / 1000).toFixed(1)}s`);
    // 停留期间穿插随机滚动，模拟真实阅读
    await dwellWithScroll(dwell);

    // 同步 Cookie（cf_clearance 可能已刷新）
    await syncCookies();

    // 先给 Chromium 一段固定回收窗口，再加入拟人化切换间隔。
    if (BEHAVIOR.memorySettleMs > 0) await sleep(BEHAVIOR.memorySettleMs);
    await sleep(randomHumanGapMs());

    return { ok: true, retryable: false, resetPage: false, reason: '' };
  } catch (e) {
    logger.warn(`读帖失败: ${e.message} → ${target.pathname}`);
    return {
      ok: false,
      retryable: true,
      resetPage: shouldResetPage(e),
      reason: '网络或页面导航异常',
    };
  }
}

// ===== 随机化参数（可用环境变量覆盖，单位毫秒）=====
function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// 单篇停留时长：偏态分布。多数落在 [MIN, MAX]，小概率拉长到 [MAX, LONG]
function randomDwellMs() {
  if (Math.random() < BEHAVIOR.longChance) {
    return randInt(BEHAVIOR.dwellMax, BEHAVIOR.dwellLong);
  }
  // 用两次随机取较小值，使分布偏向短停留（更像快速浏览）
  const a = randInt(BEHAVIOR.dwellMin, BEHAVIOR.dwellMax);
  const b = randInt(BEHAVIOR.dwellMin, BEHAVIOR.dwellMax);
  return Math.min(a, b);
}

// 帖子之间的拟人随机间隔（保证上限不小于下限）
function randomHumanGapMs() {
  return randInt(BEHAVIOR.humanGapMin, Math.max(BEHAVIOR.humanGapMin, BEHAVIOR.humanGapMax));
}

function shouldResetPage(error) {
  const msg = String(error && error.message || '');
  return msg.includes('Timeout') ||
         msg.includes('ERR_TOO_MANY_REDIRECTS') ||
         msg.includes('ERR_HTTP_RESPONSE_CODE_FAILURE') ||
         msg.includes('net::ERR_') ||
         msg.includes('Navigation to') ||
         msg.includes('Target page, context or browser has been closed') ||
         msg.includes('page.goto:') ||
         msg.includes('chrome-error://');
}

async function resetPage() {
  if (!ctx) return;
  try {
    if (page && !page.isClosed()) {
      await page.close({ runBeforeUnload: false });
    }
  } catch (_) {}
  for (let attempt = 0; attempt <= BROWSER_IO_RETRY_COUNT; attempt++) {
    try {
      page = await ctx.newPage();
      logger.warn('已重建浏览器页面，后续将重试或换帖继续');
      return true;
    } catch (e) {
      if (attempt === BROWSER_IO_RETRY_COUNT) {
        logger.warn(`重建浏览器页面经 ${BROWSER_IO_RETRY_COUNT} 次重试后仍失败: ${e.message}`);
        return false;
      }
      const delay = BROWSER_IO_RETRY_BASE_MS * (2 ** attempt);
      logger.warn(`重建浏览器页面失败，${delay / 1000} 秒后重试 (${attempt + 1}/${BROWSER_IO_RETRY_COUNT})`);
      await sleep(delay);
    }
  }
  return false;
}

// 停留期间分多次随机向下滚动，模拟阅读时的视线移动
async function dwellWithScroll(totalMs) {
  const steps = randInt(2, 5);
  let remaining = totalMs;
  for (let i = 0; i < steps; i++) {
    const slice = i === steps - 1 ? remaining : Math.floor(remaining / (steps - i)) + randInt(-300, 300);
    const wait = Math.max(300, slice);
    remaining -= wait;
    await sleep(wait);
    try {
      const dy = randInt(150, 600);
      await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), dy);
    } catch (_) { /* 滚动失败不影响停留 */ }
    if (remaining <= 0) break;
  }
}

// 检测是否出现 Cloudflare 挑战
async function detectCloudflareChallenge() {
  try {
    const title = await page.title();
    const url   = page.url();
    return title.includes('Just a moment') ||
           title.includes('Attention Required') ||
           url.includes('challenge');
  } catch (_) { return false; }
}

// 等待 Cloudflare 挑战通过
async function waitForCloudflare(timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(3000);
    const isCF = await detectCloudflareChallenge();
    if (!isCF) {
      logger.ok('Cloudflare 挑战已通过');
      return true;
    }
  }
  logger.error('Cloudflare 挑战超时（60s）');
  return false;
}

// 将 Playwright context 的最新 Cookie 写回文件
async function syncCookies(options = {}) {
  if (!ctx) return false;
  for (let attempt = 0; attempt <= BROWSER_IO_RETRY_COUNT; attempt++) {
    try {
      const cookies = await ctx.cookies();
      const str     = serializeCookies(cookies);
      if (!str) return false;
      if (!hasCookieKey(str, 'A2')) {
        logger.warn('Cookie 同步跳过：浏览器上下文缺少 A2，避免覆盖现有登录态');
        return false;
      }
      atomicWriteCookie(str);
      return true;
    } catch (e) {
      if (attempt < BROWSER_IO_RETRY_COUNT) {
        const delay = BROWSER_IO_RETRY_BASE_MS * (2 ** attempt);
        logger.warn(`Cookie 同步失败，${delay / 1000} 秒后重试 (${attempt + 1}/${BROWSER_IO_RETRY_COUNT})`);
        await sleep(delay);
        continue;
      }
      if (options.throwOnError) throw e;
      logger.warn(`Cookie 同步经 ${BROWSER_IO_RETRY_COUNT} 次重试后仍失败: ${e.message}`);
      return false;
    }
  }
  return false;
}

function hasCookieKey(cookieStr, key) {
  return cookieStr.split(';').some(part => {
    const i = part.trim().indexOf('=');
    return i > 0 && part.trim().slice(0, i) === key;
  });
}

function atomicWriteCookie(cookieStr) {
  const current = fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8').trim() : '';
  if (current === cookieStr) return false;
  config.writeFileAtomic(COOKIE_FILE, cookieStr, { mode: 0o600 });
  return true;
}

// 获取当前 Cookie 字符串（供 balance.js / fetcher.js 使用）
async function getCurrentCookie(options = {}) {
  if (ctx) {
    try {
      const cookies = await ctx.cookies();
      const str = serializeCookies(cookies);
      if (str && hasCookieKey(str, 'A2')) return str;
      if (str) {
        logger.warn(`当前浏览器上下文缺少 A2${options.requireContextAuth ? '，不使用磁盘旧值' : '，回退读取 Cookie 文件'}`);
      }
    } catch (_) {}
    if (options.requireContextAuth) return '';
  }
  // fallback: 直接读文件
  return fs.existsSync(COOKIE_FILE)
    ? fs.readFileSync(COOKIE_FILE, 'utf8').trim()
    : '';
}

async function close(options = {}) {
  let failure = null;
  let closed = false;
  if (ctx) {
    try {
      await syncCookies({ throwOnError: true });
    } catch (e) {
      failure = e;
      logger.warn(`浏览器关闭前 Cookie 同步失败: ${e.message}`);
    }
    let closeFailure = null;
    for (let attempt = 0; attempt <= BROWSER_IO_RETRY_COUNT; attempt++) {
      try {
        await ctx.close();
        closed = true;
        closeFailure = null;
        break;
      } catch (e) {
        closeFailure = e;
        if (attempt === BROWSER_IO_RETRY_COUNT) {
          logger.warn(`关闭浏览器经 ${BROWSER_IO_RETRY_COUNT} 次重试后仍失败: ${e.message}`);
          break;
        }
        const delay = BROWSER_IO_RETRY_BASE_MS * (2 ** attempt);
        logger.warn(`关闭浏览器失败，${delay / 1000} 秒后重试 (${attempt + 1}/${BROWSER_IO_RETRY_COUNT})`);
        await sleep(delay);
      }
    }
    failure = failure || closeFailure;
  }
  ctx = null;
  page = null;
  if (closed) logger.info('浏览器已关闭');
  if (closed) pruneBrowserCacheWithLog();
  if (failure && options.throwOnError) throw failure;
}

async function discardContext() {
  const current = ctx;
  ctx = null;
  page = null;
  if (!current) return;
  try {
    await current.close();
  } catch (e) {
    logger.warn(`清理未完成的浏览器启动状态失败: ${e.message}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getProfileInfo() {
  return { profile: PROFILE, cookieFile: COOKIE_FILE, fingerprint: FP, behavior: BEHAVIOR };
}

module.exports = {
  launch,
  readPost,
  getCurrentCookie,
  syncCookies,
  close,
  getProfileInfo,
  buildLaunchArgs,
  pruneBrowserCache,
  shouldResetPage,
  serializeCookies,
  normalizePostUrl,
};
