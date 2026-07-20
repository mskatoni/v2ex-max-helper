#!/usr/bin/env node
'use strict';
// ========== V2EX 自动阅读 - 主调度器 ==========
//
// 用法：
//   正式运行：node main.js
//   干跑测试：node main.js --dry-run
//
// 停止条件（任意一个）：
//   1. 余额变化 >= 2 次（活跃度奖励已触发两轮）
//   2. 阅读数量 >= MAX_READ_COUNT（安全兜底）
//   3. 超过本机时间 14:00

const fs      = require('fs');
const https   = require('https');
const logger  = require('./logger');
const queue   = require('./queue');
const fetcher = require('./fetcher');
const balance = require('./balance');
const browser = require('./browser');
const notify  = require('./notify');
const behavior = require('./behavior');
const fingerprint = require('./fingerprint');
const config  = require('../lib/config');
const profileAuth = require('../lib/profile-auth');
const profileLock = require('../lib/profile-lock');

// ========== 配置 ==========
const MAX_READ_COUNT    = 1000;   // 每日阅读上限（安全兜底）
const MIN_READ_COUNT    = 250;    // 每日最低阅读量（且需两次余额变化才退出）
const MAX_CHANGE_COUNT  = 2;      // 余额变化上限（活跃度两次）
const QUEUE_REFILL_THRESHOLD = 150;// 队列低于此数时补充
const DEADLINE_LOCAL_HOUR = 14;   // 本机时间 14:00 超时退出
const RECOVERABLE_RETRY_COUNT = 3;
const RECOVERABLE_RETRY_BASE_MS = 3000;
const LOGIN_PROBE_RETRY_COUNT = 3;
const LOGIN_PROBE_RETRY_BASE_MS = 5000;
const cfg = config.getConfig();
const PROFILE_LIST = config.parseProfileList();
const BEHAVIOR = behavior.resolve(cfg.profile);
const FP = fingerprint.generate(cfg.profile);
const BALANCE_CHECK_INTERVAL = BEHAVIOR.balanceCheckInterval; // 每读多少篇检查一次余额

const isDryRun = process.argv.includes('--dry-run');

function intEnv(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const READ_MAX_RUNTIME_MS = intEnv('READ_MAX_RUNTIME_MS', 0);
const READ_DISABLE_DEADLINE = /^(1|true|yes|on)$/i.test(String(process.env.READ_DISABLE_DEADLINE || '').trim());

// --limit N 覆盖最大阅读数（测试用）
function parseLimit() {
  const idx = process.argv.indexOf('--limit');
  if (idx >= 0) {
    const raw = String(process.argv[idx + 1] || '').trim();
    if (!/^\d+$/.test(raw)) throw new Error('--limit 必须是正整数');
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_READ_COUNT) {
      throw new Error(`--limit 必须在 1 到 ${MAX_READ_COUNT} 之间`);
    }
    return n;
  }
  return isDryRun ? 10 : MAX_READ_COUNT;
}
const EFFECTIVE_LIMIT = parseLimit();

const LOCK_FILE = cfg.readerLockFile;
let readerLockHandle = null;
let credentialLockHandle = null;
let queueInitialized = false;
let browserStarted = false;
let activeStats = null;
let activeStartTime = 0;

async function requireBrowserCookie(options = {}) {
  const retryCount = options.retryCount === undefined
    ? RECOVERABLE_RETRY_COUNT
    : options.retryCount;
  return retryRecoverable('读取 Chromium 登录态', async () => {
    const cookie = await browser.getCurrentCookie({ requireContextAuth: true });
    if (cookie) return cookie;
    const error = new Error('Chromium 上下文缺少认证 Cookie');
    error.code = 'SESSION_EXPIRED';
    throw error;
  }, { retryCount });
}

// ========== 锁文件 ==========
function acquireLock() {
  readerLockHandle = profileLock.acquireLock(LOCK_FILE, { profile: cfg.profile, task: 'reader' });
  try {
    credentialLockHandle = profileLock.acquireLock(cfg.credentialLockFile, { profile: cfg.profile, task: 'reader' });
  } catch (e) {
    readerLockHandle.release();
    readerLockHandle = null;
    throw e;
  }
}

function releaseLock() {
  if (credentialLockHandle) {
    try { credentialLockHandle.release(); } catch (e) { logger.warn(`释放凭证锁失败: ${e.message}`); }
    credentialLockHandle = null;
  }
  if (readerLockHandle) {
    try { readerLockHandle.release(); } catch (e) { logger.warn(`释放阅读锁失败: ${e.message}`); }
    readerLockHandle = null;
  }
}

// ========== 截止时间检查 ==========
const hasExplicitLimit = process.argv.includes('--limit');
function isPastDeadline() {
  // dry-run 或手动指定 --limit 时不检查截止时间
  if (READ_DISABLE_DEADLINE || isDryRun || hasExplicitLimit) return false;
  const h = new Date().getHours();
  // 只在本机时间 14:00~23:59 判定超时，避免午夜后误判。
  return h >= DEADLINE_LOCAL_HOUR;
}

function isPastRuntime(startTime) {
  return READ_MAX_RUNTIME_MS > 0 && Date.now() - startTime >= READ_MAX_RUNTIME_MS;
}

// ========== 优雅退出 ==========
let isShuttingDown = false;
async function shutdown(reason, stats, exitCode = 0, options = {}) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  let cleanupFailed = false;
  // 退出前最后一次余额检查（保证余额日志始终最新）
  if (exitCode === 0 && !isDryRun && browserStarted) {
    try {
      const result = await checkBalanceWithRetries('退出前余额更新');
      stats.changed = result.changes;
      if (result.status && result.status.ok) {
        logger.info('退出前余额已更新');
      } else {
        logger.warn(`退出前余额未更新: ${(result.status && result.status.message) || '状态未知'}`);
      }
    } catch (e) {
      logger.warn(`退出前余额更新失败: ${e.message}`);
    }
  }
  if (browserStarted) {
    try {
      await browser.close({ throwOnError: true });
    } catch (e) {
      logger.error(`浏览器关闭或状态保存失败: ${e.message}`);
      reason = `${reason}；浏览器状态保存失败`;
      exitCode = 1;
      cleanupFailed = true;
    }
  }
  browserStarted = false;
  let queueStats = null;
  if (!isDryRun && queueInitialized) {
    try {
      queueStats = queue.stats();
    } catch (e) {
      logger.warn(`读取队列统计失败: ${e.message}`);
    }
    try {
      queue.close();
    } catch (e) {
      logger.error(`Queue close failed: ${e.message}`);
      reason = `${reason}；队列保存失败`;
      exitCode = 1;
      cleanupFailed = true;
    }
    queueInitialized = false;
  }
  logger.sep();
  if (exitCode === 0) {
    logger.ok(`停止原因: ${reason}`);
    logger.ok(`📊 统计: 阅读 ${stats.read} 篇 | 余额变化 ${stats.changed} 次 | 耗时 ${stats.elapsed}`);
  } else {
    logger.warn(`停止原因: ${reason}`);
    logger.warn(`📊 统计: 阅读 ${stats.read} 篇 | 余额变化 ${stats.changed} 次 | 耗时 ${stats.elapsed}`);
  }
  if (queueStats) {
    logger.ok(`📦 队列: 可读 ${queueStats.readable} | 已读满 ${queueStats.exhausted} | 总计 ${queueStats.total}`);
  }
  logger.sep();
  stats.reason = reason;
  releaseLock();
  if (!isDryRun) {
    if (cleanupFailed || stats.consecutiveErrors >= 3 || (exitCode !== 0 && !options.expectedStop)) {
      await notify.notifyReaderError(stats);
    } else if (!options.expectedStop) {
      await notify.notifyReaderDone(stats);
    }
  }
  process.exit(exitCode);
}

async function verifyAndBindProfile(cookie) {
  const result = await retryRecoverable('验证 Profile 登录态', () => profileAuth.verifyAndCompare(cfg, cookie, {
    userAgent: FP.userAgent,
    acceptLanguage: FP.acceptLanguage,
  }), {
    shouldRetryResult: value => !value.ok,
    getResultCode: value => value.code || 'auth_unverified',
    isRetryableError: isRecoverableNetworkError,
  });
  if (!result.ok) throw new Error(`Profile ${cfg.profile} 认证失败: ${result.message}`);
  if (result.identityState === 'different') {
    throw new Error(`Profile ${cfg.profile} 的 Cookie 与已绑定 V2EX 账号不一致，请通过 Telegram 显式换绑`);
  }
  if (result.identityState === 'unbound') {
    profileAuth.safeRemoveChromeProfile(cfg);
  }
  profileAuth.writeIdentity(cfg.identityFile, profileAuth.createIdentityRecord(result.identity, result.current));
  logger.info(`Profile ${cfg.profile} 身份认证通过 (${result.identityState === 'unbound' ? '首次绑定' : '已匹配'})`);
}

// ========== 主流程 ==========
async function main() {
  if (process.env.SKIP_READER === '1') {
    logger.info('[main] SKIP_READER=1, reader scheduler disabled.');
    process.exit(0);
  }
  if (!isDryRun && PROFILE_LIST.length > 0 && !cfg.profileExplicit) {
    throw new Error('多账号模式运行 reader 必须显式设置 V2EX_PROFILE');
  }
  if (!isDryRun) acquireLock();

  const stats = { read: 0, changed: 0, elapsed: '0s', consecutiveErrors: 0 };
  const startTime = Date.now();
  activeStats = stats;
  activeStartTime = startTime;

  // 注册退出信号处理
  const onExit = async (sig, exitCode) => {
    logger.warn(`收到 ${sig}，正在退出...`);
    stats.elapsed = elapsed(startTime);
    await shutdown(sig, stats, exitCode, { expectedStop: true });
  };
  process.once('SIGTERM', () => onExit('SIGTERM', 143).catch(e => logger.error(`SIGTERM 退出失败: ${e.message}`)));
  process.once('SIGINT',  () => onExit('SIGINT', 130).catch(e => logger.error(`SIGINT 退出失败: ${e.message}`)));

  logger.sep();
  logger.info(`🚀 V2EX Reader 启动 (dry-run=${isDryRun})`);
  logger.info(`限制: 最低 ${MIN_READ_COUNT} 篇且余额变化 ${MAX_CHANGE_COUNT} 次退出 | 最多 ${EFFECTIVE_LIMIT} 篇 | 截止本机时间 ${DEADLINE_LOCAL_HOUR}:00`);
  if (READ_MAX_RUNTIME_MS > 0) {
    logger.info(`运行时长上限: ${Math.round(READ_MAX_RUNTIME_MS / 60000)} 分钟`);
  }
  logger.info(`行为参数: profile=${cfg.profile} balanceInterval=${BALANCE_CHECK_INTERVAL} humanGap=${BEHAVIOR.humanGapMin}-${BEHAVIOR.humanGapMax}ms memorySettle=${BEHAVIOR.memorySettleMs}ms`);
  if (BEHAVIOR.usesLegacyGap) {
    logger.warn('检测到 READ_GAP_MIN/MAX 旧变量，已按 READ_HUMAN_GAP_MIN/MAX 兼容处理');
  }
  logger.sep();

  if (isDryRun) {
    await browser.launch(true);
    logger.info(`[DRY-RUN] 使用 ${EFFECTIVE_LIMIT} 条内存模拟帖子，不读取 Cookie、不访问网络、不写入队列`);
  } else {
    const cookie = fs.existsSync(cfg.cookieFile) ? fs.readFileSync(cfg.cookieFile, 'utf8').trim() : '';
    if (!cookie) {
      logger.error('无法获取 Cookie，退出');
      await notify.notifySessionExpired();
      releaseLock();
      process.exit(1);
    }
    await verifyAndBindProfile(cookie);

    // 初始化队列（async for sql.js）
    await queue.init();
    queueInitialized = true;
    queue.cleanup();

    await retryRecoverable('启动 Chromium', () => browser.launch(false), {
      isRetryableError: isRecoverableBrowserStartError,
    });
    browserStarted = true;
    await requireBrowserCookie();

    const balanceState = await retryRecoverable('读取余额基线', async () => {
      const freshCookie = await requireBrowserCookie({ retryCount: 0 });
      return balance.init(freshCookie);
    }, {
      shouldRetryResult: value => !value.ok,
      getResultCode: value => value.code || 'balance_unavailable',
    });
    if (!balanceState.ok && balanceState.fatal) {
      logger.error(`无法获取余额基线: ${balanceState.message}`);
      await notify.notifySessionExpired();
      await browser.close();
      browserStarted = false;
      try { queue.close(); } catch (e) { logger.warn(`Queue close failed: ${e.message}`); }
      queueInitialized = false;
      releaseLock();
      process.exit(1);
    }
    if (!balanceState.ok) {
      logger.warn(`余额基线暂不可用，将继续阅读并在后续检查中重试: ${balanceState.message}`);
    }

    // 初始填充队列（忽略冷却）
    if (queue.size() < QUEUE_REFILL_THRESHOLD) {
      logger.info('初始填充队列...');
      const urls = await fetchQueueUrls(true, '初始队列抓取');
      queue.add(urls);
    }

    logger.info(`队列就绪: ${queue.size()} 条可读`);
  }

  // ========== 主阅读循环 ==========
  while (true) {
    if (isShuttingDown) return;

    // 检查截止时间
    if (isPastDeadline()) {
      stats.elapsed = elapsed(startTime);
      await shutdown(`超过本机截止时间 ${DEADLINE_LOCAL_HOUR}:00`, stats);
    }

    if (isPastRuntime(startTime)) {
      stats.elapsed = elapsed(startTime);
      await shutdown(`达到运行时长上限 ${Math.round(READ_MAX_RUNTIME_MS / 60000)} 分钟`, stats);
    }

    // 取帖子
    let url = isDryRun ? `dry-run://post/${stats.read + 1}` : queue.pop();

    // 队列为空时才补充（fetchAll 内部有 5 分钟冷却）
    if (!isDryRun && !url) {
      logger.info('队列为空，尝试补充...');
      const urls = await fetchQueueUrls(false, '空队列补充');
      if (urls.length > 0) queue.add(urls);
      url = queue.pop();
    }

    if (!url) {
      logger.warn('队列为空，等待 30 秒后重试...');
      await sleep(30000);
      continue;
    }

    // 阅读帖子
    const ok = await browser.readPost(url);
    // 信号退出可能与当前导航并发；此时不得再更新队列或继续取下一帖。
    if (isShuttingDown) return;
    if (ok) {
      if (!isDryRun) queue.increment(url);
      stats.read++;
      stats.consecutiveErrors = 0;  // 成功则重置连续报错计数
    } else {
      if (!isDryRun) queue.skip(url);
      stats.consecutiveErrors = (stats.consecutiveErrors || 0) + 1;
      logger.warn(`读帖失败 (连续 ${stats.consecutiveErrors}/3 次): ${safePostLabel(url)}`);
      logger.warn('当前失败 URL 已跳过，避免重复触发同一异常帖');

      if (stats.consecutiveErrors >= 3) {
        const loginState = isDryRun ? 'unknown' : await probeLogin();

        if (loginState === 'logged_in') {
          logger.warn('连续读帖失败，但登录探针通过；重置错误计数并继续换帖');
          stats.consecutiveErrors = 0;
          continue;
        }

        stats.elapsed = elapsed(startTime);
        const probeAttempts = LOGIN_PROBE_RETRY_COUNT + 1;
        const reason = loginState === 'logged_out'
          ? `连续读帖失败，登录探针连续 ${probeAttempts} 次确认 Cookie 已失效`
          : `连续读帖失败，登录探针经 ${probeAttempts} 次尝试仍无法确认状态`;
        await shutdown(reason, stats, 1);
      }
    }

    // 每 BALANCE_CHECK_INTERVAL 篇检查一次余额
    if (!isDryRun && stats.read > 0 && stats.read % BALANCE_CHECK_INTERVAL === 0) {
      const balanceResult = await checkBalanceWithRetries('定期余额检查');
      const changes = balanceResult.changes;
      stats.changed = changes;
      if (!balanceResult.status || !balanceResult.status.ok) {
        logger.warn(`余额检查经 ${RECOVERABLE_RETRY_COUNT} 次重试后仍不可用，将继续阅读`);
      }

      // 停止条件 1：余额变化足够且已读满最低阅读量
      if (changes >= MAX_CHANGE_COUNT && stats.read >= MIN_READ_COUNT) {
        stats.elapsed = elapsed(startTime);
        await shutdown(`余额已变化 ${changes} 次且已阅读超过最低标准 ${MIN_READ_COUNT} 篇（当前已读 ${stats.read} 篇），活跃度奖励已全部触发，自动退出`, stats);
      }

      const s = queue.stats();
      logger.info(`队列: 可读 ${s.readable} | 已读满 ${s.exhausted} | 总计 ${s.total}`);
    }

    // 每 200 篇主动补充队列（避免等到完全空了）
    if (!isDryRun && stats.read > 0 && stats.read % 200 === 0) {
      const urls = await fetchQueueUrls(false, '主动队列补充');
      if (urls.length > 0) queue.add(urls);
    }

    // 停止条件 2：阅读量达到上限
    if (stats.read >= EFFECTIVE_LIMIT) {
      stats.elapsed = elapsed(startTime);
      await shutdown(`已读 ${EFFECTIVE_LIMIT} 篇，达到上限`, stats);
    }
  }
}

function elapsed(start) {
  const s = Math.floor((Date.now() - start) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeRetryCode(error) {
  const code = String(error && (error.code || error.name) || 'temporary_error');
  return /^[0-9A-Za-z_.-]{1,64}$/.test(code) ? code : 'temporary_error';
}

function isRecoverableNetworkError(error) {
  const code = String(error && error.code || '').toUpperCase();
  if (['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE'].includes(code)) {
    return true;
  }
  const message = String(error && error.message || '');
  if (/拒绝跨|不安全|路径|身份记录|invalid url/i.test(message)) return false;
  return true;
}

function isRecoverableBrowserStartError(error) {
  const code = String(error && error.code || '').toUpperCase();
  if (['EACCES', 'EPERM', 'ENOENT', 'EINVAL'].includes(code)) return false;
  const message = String(error && error.message || '');
  return !/Cookie 文件不存在或为空|executable doesn't exist|拒绝|不安全|路径无效/i.test(message);
}

async function retryRecoverable(label, operation, options = {}) {
  const retryCount = Number.isInteger(options.retryCount) && options.retryCount >= 0
    ? options.retryCount
    : RECOVERABLE_RETRY_COUNT;
  const totalAttempts = retryCount + 1;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    let retryCode = '';
    try {
      const value = await operation(attempt);
      if (!options.shouldRetryResult || !options.shouldRetryResult(value) || attempt === retryCount) {
        return value;
      }
      retryCode = options.getResultCode ? String(options.getResultCode(value) || 'temporary_result') : 'temporary_result';
    } catch (error) {
      const retryable = !options.isRetryableError || options.isRetryableError(error);
      if (!retryable || attempt === retryCount) throw error;
      retryCode = safeRetryCode(error);
    }

    const retryNumber = attempt + 1;
    const delay = Math.min(RECOVERABLE_RETRY_BASE_MS * (2 ** attempt), 12000);
    logger.warn(`${label}第 ${attempt + 1}/${totalAttempts} 次尝试失败 (${retryCode})，${delay / 1000} 秒后进行第 ${retryNumber}/${retryCount} 次重试`);
    if (options.onRetry) await options.onRetry(attempt);
    await sleep(delay);
  }

  throw new Error(`${label}重试状态异常`);
}

async function fetchQueueUrls(force, label) {
  return retryRecoverable(label, async (attempt) => {
    const cookie = await requireBrowserCookie({ retryCount: 0 });
    return force || attempt > 0
      ? fetcher.fetchAllForce(cookie)
      : fetcher.fetchAll(cookie);
  });
}

async function checkBalanceWithRetries(label) {
  const result = await retryRecoverable(label, async () => {
    const cookie = await requireBrowserCookie({ retryCount: 0 });
    const changes = await balance.check(cookie);
    return { changes, status: balance.getLastStatus() };
  }, {
    shouldRetryResult: value => !value.status || !value.status.ok,
    getResultCode: value => value.status && value.status.code || 'balance_status_missing',
  });
  if (result.status && result.status.code === 'logged_out') {
    const error = new Error('余额页连续确认 V2EX 登录态已失效');
    error.code = 'SESSION_EXPIRED';
    throw error;
  }
  return result;
}

function safePostLabel(value) {
  try {
    const parsed = new URL(value);
    return parsed.origin === 'https://www.v2ex.com' && /^\/t\/\d+$/.test(parsed.pathname)
      ? parsed.pathname
      : '[invalid post URL]';
  } catch (_) {
    return '[invalid post URL]';
  }
}

function probeLoginOnce(cookie) {
  if (!cookie) return Promise.resolve('logged_out');

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.v2ex.com',
      path: '/',
      method: 'GET',
      headers: {
        Cookie: cookie,
        'User-Agent': FP.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en,zh-CN;q=0.9,zh;q=0.8',
      },
    }, (res) => {
      let body = '';
      let received = 0;
      let settled = false;
      const finish = (state) => {
        if (settled) return;
        settled = true;
        resolve(state);
      };
      res.on('data', (c) => {
        received += Buffer.byteLength(c);
        if (received > 2 * 1024 * 1024) {
          req.destroy();
          finish('unknown');
          return;
        }
        body += c;
      });
      res.on('aborted', () => finish('unknown'));
      res.on('error', () => finish('unknown'));
      res.on('end', () => {
        if (settled || res.statusCode !== 200) return finish('unknown');
        const diagnosis = profileAuth.diagnoseHomePage({ statusCode: res.statusCode, body });
        if (diagnosis.ok) return finish('logged_in');
        if (diagnosis.code === 'logged_out') return finish('logged_out');
        finish('unknown');
      });
    });
    req.on('error', () => resolve('unknown'));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve('unknown');
    });
    req.end();
  });
}

async function probeLogin(retryCount = LOGIN_PROBE_RETRY_COUNT) {
  const totalAttempts = retryCount + 1;
  const states = [];

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    let state = 'unknown';
    try {
      const cookie = await requireBrowserCookie({ retryCount: 0 });
      state = await probeLoginOnce(cookie);
    } catch (e) {
      state = e.code === 'SESSION_EXPIRED' ? 'logged_out' : 'unknown';
      logger.warn(`登录探针第 ${attempt}/${totalAttempts} 次执行异常 (${e.code || 'unknown'})`);
    }

    states.push(state);
    const label = state === 'logged_in'
      ? '已确认登录'
      : state === 'logged_out' ? '疑似未登录' : '状态未知';
    logger.warn(`登录探针第 ${attempt}/${totalAttempts} 次: ${label}`);

    if (state === 'logged_in') return 'logged_in';
    if (attempt < totalAttempts) {
      const delay = Math.min(LOGIN_PROBE_RETRY_BASE_MS * (2 ** (attempt - 1)), 20000);
      logger.warn(`登录状态尚未确认，${delay / 1000} 秒后重试`);
      await sleep(delay);
    }
  }

  return profileAuth.resolveLoginProbeStates(states);
}

main().catch(async (e) => {
  logger.error(`未捕获错误: ${e.message}`);
  logger.error(e.stack || '');
  try { await browser.close(); } catch (_) {}
  if (!isDryRun) {
    try { queue.close(); } catch (closeErr) { logger.warn(`Queue close failed: ${closeErr.message}`); }
  }
  releaseLock();
  if (!isDryRun) {
    const stats = activeStats || { read: 0, changed: 0, consecutiveErrors: 0 };
    stats.elapsed = activeStartTime ? elapsed(activeStartTime) : '0s';
    stats.reason = e.code === 'SESSION_EXPIRED'
      ? 'Chromium 登录态已失效，请更新 Cookie'
      : '阅读进程遇到未捕获错误，请查看服务器日志';
    try { await notify.notifyReaderError(stats); } catch (_) {}
  }
  process.exit(1);
});
