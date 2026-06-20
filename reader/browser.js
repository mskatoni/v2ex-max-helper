'use strict';
// ========== Playwright 浏览器控制 ==========
const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const logger      = require('./logger');
const fingerprint = require('./fingerprint');

// ===== 多账号 / 指纹隔离 =====
// 通过 V2EX_PROFILE（或默认 'default'）区分账号。每个 profile 拥有：
//   - 独立 Cookie 文件：~/.v2ex_cookie（default）或 ~/.v2ex_cookie.<profile>
//   - 独立 Chrome 用户数据目录：data/chrome-profile/<profile>
//   - 独立且确定性的浏览器指纹（基于 profile 名做种子）
const PROFILE = (process.env.V2EX_PROFILE || 'default').trim() || 'default';
const HOST    = 'www.v2ex.com';

// Cookie 文件：显式 COOKIE_FILE 优先；否则按 profile 区分
function resolveCookieFile() {
  if (process.env.COOKIE_FILE) return process.env.COOKIE_FILE;
  const base = path.join(os.homedir(), '.v2ex_cookie');
  return PROFILE === 'default' ? base : `${base}.${PROFILE}`;
}
const COOKIE_FILE   = resolveCookieFile();
const USER_DATA_DIR = path.join(__dirname, 'data', 'chrome-profile', PROFILE);

// 为当前 profile 生成确定性指纹
const FP = fingerprint.generate(PROFILE);

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

  ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    proxy: { server: 'http://127.0.0.1:7890' },
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
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
  });

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

    // 帖子之间的随机间隔（模拟切换 / 思考），让节奏更自然
    await sleep(randomBetweenMs());

    return true;
  } catch (e) {
    logger.warn(`读帖失败: ${e.message} → ${url}`);
    return false;
  }
}

// ===== 随机化参数（可用环境变量覆盖，单位毫秒）=====
const DWELL_MIN   = intEnv('READ_DWELL_MIN',   8000);   // 单篇停留最短
const DWELL_MAX   = intEnv('READ_DWELL_MAX',   22000);  // 单篇停留最长（常规）
const DWELL_LONG  = intEnv('READ_DWELL_LONG',  45000);  // 偶尔长读上限
const LONG_CHANCE = floatEnv('READ_LONG_CHANCE', 0.15); // 触发长读的概率
// 帖子间间隔：除了拟人化，也给 Chromium 留出 GC 回收上一页内存的时间，
// 降低低内存机器（如 1GB）快速翻页时的 OOM 风险。最短不低于 8 秒。
const GAP_MIN     = Math.max(8000, intEnv('READ_GAP_MIN', 8000));   // 帖子间间隔最短（≥8s）
const GAP_MAX     = intEnv('READ_GAP_MAX',     15000);  // 帖子间间隔最长

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}
function floatEnv(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : def;
}
function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// 单篇停留时长：偏态分布。多数落在 [MIN, MAX]，小概率拉长到 [MAX, LONG]
function randomDwellMs() {
  if (Math.random() < LONG_CHANCE) {
    return randInt(DWELL_MAX, DWELL_LONG);
  }
  // 用两次随机取较小值，使分布偏向短停留（更像快速浏览）
  const a = randInt(DWELL_MIN, DWELL_MAX);
  const b = randInt(DWELL_MIN, DWELL_MAX);
  return Math.min(a, b);
}

// 帖子之间的随机间隔（保证上限不小于下限）
function randomBetweenMs() {
  return randInt(GAP_MIN, Math.max(GAP_MIN, GAP_MAX));
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
    if (str) {
      fs.writeFileSync(COOKIE_FILE, str, { mode: 0o600 });
    }
  } catch (e) {
    logger.warn(`Cookie 同步失败: ${e.message}`);
  }
}

// 获取当前 Cookie 字符串（供 balance.js / fetcher.js 使用）
async function getCurrentCookie() {
  if (ctx) {
    try {
      const cookies = await ctx.cookies();
      return serializeCookies(cookies);
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
  return { profile: PROFILE, cookieFile: COOKIE_FILE, fingerprint: FP };
}

module.exports = { launch, readPost, getCurrentCookie, syncCookies, close, getProfileInfo };
