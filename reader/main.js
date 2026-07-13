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
const cfg = config.getConfig();
const PROFILE_LIST = config.parseProfileList();
const BEHAVIOR = behavior.resolve(cfg.profile);
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
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = parseInt(process.argv[idx + 1], 10);
    if (n > 0) return n;
  }
  return isDryRun ? 10 : MAX_READ_COUNT;
}
const EFFECTIVE_LIMIT = parseLimit();

const LOCK_FILE = cfg.readerLockFile;
let readerLockHandle = null;
let credentialLockHandle = null;
let queueInitialized = false;
let browserStarted = false;

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
async function shutdown(reason, stats, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.sep();
  if (exitCode === 0) {
    logger.ok(`停止原因: ${reason}`);
    logger.ok(`📊 统计: 阅读 ${stats.read} 篇 | 余额变化 ${stats.changed} 次 | 耗时 ${stats.elapsed}`);
  } else {
    logger.warn(`停止原因: ${reason}`);
    logger.warn(`📊 统计: 阅读 ${stats.read} 篇 | 余额变化 ${stats.changed} 次 | 耗时 ${stats.elapsed}`);
  }
  if (!isDryRun && queueInitialized) {
    try {
      const s = queue.stats();
      logger.ok(`📦 队列: 可读 ${s.readable} | 已读满 ${s.exhausted} | 总计 ${s.total}`);
    } catch (e) {
      logger.warn(`读取队列统计失败: ${e.message}`);
    }
  }
  logger.sep();
  // Telegram 通知：仅报错时推送
  stats.reason = reason;
  if (!isDryRun) {
    if (exitCode !== 0 || stats.consecutiveErrors >= 3) {
      await notify.notifyReaderError(stats);
    } else {
      await notify.notifyReaderDone(stats);
    }
  }
  // 退出前最后一次余额检查（保证余额日志始终最新）
  if (!isDryRun && browserStarted) {
    try {
      const cookie = await browser.getCurrentCookie();
      if (cookie) {
        await balance.check(cookie);
        logger.info('退出前余额已更新');
      }
    } catch (e) {
      logger.warn(`退出前余额更新失败: ${e.message}`);
    }
  }
  if (browserStarted) await browser.close();
  browserStarted = false;
  if (!isDryRun && queueInitialized) {
    try { queue.close(); } catch (e) { logger.warn(`Queue close failed: ${e.message}`); }
    queueInitialized = false;
  }
  releaseLock();
  process.exit(exitCode);
}

async function verifyAndBindProfile(cookie) {
  const fp = fingerprint.generate(cfg.profile);
  const result = await profileAuth.verifyAndCompare(cfg, cookie, {
    userAgent: fp.userAgent,
    acceptLanguage: fp.acceptLanguage,
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

  // 注册退出信号处理
  const onExit = async (sig, exitCode) => {
    logger.warn(`收到 ${sig}，正在退出...`);
    stats.elapsed = elapsed(startTime);
    await shutdown(sig, stats, exitCode);
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

    await browser.launch(false);
    browserStarted = true;
    const browserCookie = await browser.getCurrentCookie();

    const balanceState = await balance.init(browserCookie);
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
      const urls = await fetcher.fetchAllForce(browserCookie);
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
      const freshCookie = await browser.getCurrentCookie();
      const urls = await fetcher.fetchAll(freshCookie);
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
      logger.warn(`读帖失败 (连续 ${stats.consecutiveErrors}/3 次): ${url}`);
      logger.warn('当前失败 URL 已跳过，避免重复触发同一异常帖');

      if (stats.consecutiveErrors >= 3) {
        const freshCookie = await browser.getCurrentCookie();
        const loginState = isDryRun ? 'unknown' : await probeLogin(freshCookie);

        if (loginState === 'logged_in') {
          logger.warn('连续读帖失败，但登录探针通过；重置错误计数并继续换帖');
          stats.consecutiveErrors = 0;
          continue;
        }

        stats.elapsed = elapsed(startTime);
        const reason = loginState === 'logged_out'
          ? '连续读帖失败，登录探针确认 Cookie 已失效'
          : '连续读帖失败，登录探针无法确认状态';
        await shutdown(reason, stats, 1);
      }
    }

    // 每 BALANCE_CHECK_INTERVAL 篇检查一次余额
    if (!isDryRun && stats.read > 0 && stats.read % BALANCE_CHECK_INTERVAL === 0) {
      const freshCookie = await browser.getCurrentCookie();
      const changes = await balance.check(freshCookie);
      stats.changed = changes;

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
      const freshCookie = await browser.getCurrentCookie();
      const urls = await fetcher.fetchAll(freshCookie);
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

function probeLogin(cookie) {
  if (!cookie) return Promise.resolve('logged_out');

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.v2ex.com',
      path: '/',
      method: 'GET',
      headers: {
        Cookie: cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en,zh-CN;q=0.9,zh;q=0.8',
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 500) return resolve('unknown');
        const loggedOut = body.includes('你要查看的页面需要先登录') ||
                          body.includes('需要先登录') ||
                          body.includes('/signin');
        if (loggedOut) return resolve('logged_out');
        const loggedIn = body.includes('/notifications') && body.includes('/signout');
        if (loggedIn) return resolve('logged_in');
        resolve('unknown');
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

main().catch(async (e) => {
  logger.error(`未捕获错误: ${e.message}`);
  logger.error(e.stack || '');
  try { await browser.close(); } catch (_) {}
  if (!isDryRun) {
    try { queue.close(); } catch (closeErr) { logger.warn(`Queue close failed: ${closeErr.message}`); }
  }
  releaseLock();
  process.exit(1);
});
