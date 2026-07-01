'use strict';
// ========== Playwright 浏览器控制 ==========
const fs          = require('fs');
const path        = require('path');
const logger      = require('./logger');
const fingerprint = require('./fingerprint');
const behavior    = require('./behavior');
const config      = require('../lib/config');
const secureProxy = require('../lib/secure-proxy');

// ===== 多账号 / 指纹隔离 =====
// 通过 V2EX_PROFILE（或默认 'default'）区分账号。每个 profile 拥有：
//   - 独立 Cookie 文件：~/.v2ex_cookie（default）或 ~/.v2ex_cookie.<profile>
//   - 独立 Chrome 用户数据目录：data/chrome-profile/<profile>
//   - 独立且确定性的浏览器指纹（基于 profile 名做种子）
const cfg = config.getConfig();
const PROFILE = cfg.profile;
const HOST    = 'www.v2ex.com';

const COOKIE_FILE   = cfg.cookieFile;
const USER_DATA_DIR = cfg.chromeProfileDir;

// 为当前 profile 生成确定性指纹
const FP = fingerprint.generate(PROFILE);
const BEHAVIOR = behavior.resolve(PROFILE);

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
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    };
  }).filter(Boolean);
}

// Playwright cookies 数组 → Cookie 字符串（写回文件）
function serializeCookies(cookies) {
  return cookies
    .filter(c => c.domain && c.domain.includes('v2ex'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

let ctx      = null;   // BrowserContext（persistent context）
let page     = null;
let isDryRun = false;

async function launch(dryRun = false) {
  isDryRun = dryRun;

  // 检查 Cookie 文件（dry-run 也需要读取用于 fetcher/balance）
  const cookieStr = fs.existsSync(COOKIE_FILE)
    ? fs.readFileSync(COOKIE_FILE, 'utf8').trim()
    : '';
  if (!cookieStr) {
    throw new Error(`Cookie 文件不存在或为空: ${COOKIE_FILE}`);
  }

  if (dryRun) {
    logger.info('[DRY-RUN] 跳过浏览器启动');
    return;
  }

  const { chromium } = require('playwright');

  // 确保 Chrome profile 目录存在
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  logger.info('浏览器启动中...');
  logger.info('浏览器指纹已按当前 profile 注入');
  logger.info(`行为参数 profile=${PROFILE} dwell=${BEHAVIOR.dwellMin}-${BEHAVIOR.dwellMax}/${BEHAVIOR.dwellLong}ms gap=${BEHAVIOR.humanGapMin}-${BEHAVIOR.humanGapMax}ms settle=${BEHAVIOR.memorySettleMs}ms`);
  if (BEHAVIOR.usesLegacyGap) {
    logger.warn('检测到 READ_GAP_MIN/MAX 旧变量，已作为 READ_HUMAN_GAP_MIN/MAX 兼容处理');
  }

  const launchOptions = {
    executablePath: process.env.CHROME_BIN || undefined,
    headless: process.env.HEADLESS !== 'false',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--memory-pressure-off',
      '--js-flags=--max-old-space-size=256',
      '--disable-extensions',
      '--disable-default-apps',
      '--single-process',
      `--lang=${FP.locale}`,
    ],
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
  await ctx.addCookies(cookies);
  logger.info(`已注入 ${cookies.length} 条 Cookie`);

  // 使用已有 page 或新建
  const pages = ctx.pages();
  page = pages.length > 0 ? pages[0] : await ctx.newPage();

  logger.ok('浏览器已就绪');
}

// 读取一篇帖子（随机偏态停留 + 随机滚动 + 帖子间随机间隔）
async function readPost(url) {
  if (isDryRun) {
    logger.info(`[DRY-RUN] → ${url}`);
    await sleep(200);
    return true;
  }

  try {
    logger.info(`→ ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 检测 Cloudflare 挑战页面
    const isCF = await detectCloudflareChallenge();
    if (isCF) {
      logger.warn('Cloudflare 挑战中，等待最多 60 秒...');
      const passed = await waitForCloudflare();
      if (!passed) return false;
    }

    // 检测是否登录
    const content = await page.content();
    if (content.includes('你要查看的页面需要先登录') || content.includes('需要先登录')) {
      logger.error('Cookie 已失效，请重新获取');
      return false;
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

    return true;
  } catch (e) {
    logger.warn(`读帖失败: ${e.message} → ${url}`);
    if (shouldResetPage(e)) {
      await resetPage();
    }
    return false;
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
  return msg.includes('ERR_TOO_MANY_REDIRECTS') ||
         msg.includes('ERR_HTTP_RESPONSE_CODE_FAILURE') ||
         msg.includes('Navigation to') ||
         msg.includes('chrome-error://');
}

async function resetPage() {
  if (!ctx) return;
  try {
    if (page && !page.isClosed()) {
      await page.close({ runBeforeUnload: false });
    }
  } catch (_) {}
  try {
    page = await ctx.newPage();
    logger.warn('已重建浏览器页面，后续将换帖继续');
  } catch (e) {
    logger.warn(`重建浏览器页面失败: ${e.message}`);
  }
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
async function syncCookies() {
  if (!ctx) return;
  try {
    const cookies = await ctx.cookies();
    const str     = serializeCookies(cookies);
    if (!str) return;
    if (!hasCookieKey(str, 'A2')) {
      logger.warn('Cookie 同步跳过：浏览器上下文缺少 A2，避免覆盖现有登录态');
      return;
    }
    atomicWriteCookie(str);
  } catch (e) {
    logger.warn(`Cookie 同步失败: ${e.message}`);
  }
}

function hasCookieKey(cookieStr, key) {
  return cookieStr.split(';').some(part => {
    const i = part.trim().indexOf('=');
    return i > 0 && part.trim().slice(0, i) === key;
  });
}

function atomicWriteCookie(cookieStr) {
  const dir = path.dirname(COOKIE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${COOKIE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, cookieStr, { mode: 0o600 });
  fs.renameSync(tmp, COOKIE_FILE);
}

// 获取当前 Cookie 字符串（供 balance.js / fetcher.js 使用）
async function getCurrentCookie() {
  if (ctx) {
    try {
      const cookies = await ctx.cookies();
      const str = serializeCookies(cookies);
      if (str && hasCookieKey(str, 'A2')) return str;
      if (str) {
        logger.warn('当前浏览器上下文缺少 A2，回退读取 Cookie 文件');
      }
    } catch (_) {}
  }
  // fallback: 直接读文件
  return fs.existsSync(COOKIE_FILE)
    ? fs.readFileSync(COOKIE_FILE, 'utf8').trim()
    : '';
}

async function close() {
  try {
    if (ctx) {
      await syncCookies();
      await ctx.close();
    }
    logger.info('浏览器已关闭');
  } catch (e) {
    logger.warn(`关闭浏览器时出错: ${e.message}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getProfileInfo() {
  return { profile: PROFILE, cookieFile: COOKIE_FILE, fingerprint: FP, behavior: BEHAVIOR };
}

module.exports = { launch, readPost, getCurrentCookie, syncCookies, close, getProfileInfo };
