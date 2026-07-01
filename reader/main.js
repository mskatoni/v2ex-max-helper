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
//   3. 超过运行时间窗口（UTC 06:00 = 北京 14:00）

const fs      = require('fs');
const https   = require('https');
const os      = require('os');
const path    = require('path');
const logger  = require('./logger');
const queue   = require('./queue');
const fetcher = require('./fetcher');
const balance = require('./balance');
const browser = require('./browser');
const notify  = require('./notify');
const behavior = require('./behavior');
const config  = require('../lib/config');

// ========== 配置 ==========
const MAX_READ_COUNT    = 1000;   // 每日阅读上限（安全兜底）
const MIN_READ_COUNT    = 250;    // 每日最低阅读量（且需两次余额变化才退出）
const MAX_CHANGE_COUNT  = 2;      // 余额变化上限（活跃度两次）
const QUEUE_REFILL_THRESHOLD = 150;// 队列低于此数时补充
// UTC 06:00 = 北京 14:00，超时强制退出
const DEADLINE_UTC_HOUR = 6;
const cfg = config.getConfig();
const BEHAVIOR = behavior.resolve(cfg.profile);
const BALANCE_CHECK_INTERVAL = BEHAVIOR.balanceCheckInterval; // 每读多少篇检查一次余额

const isDryRun = process.argv.includes('--dry-run');

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

// 跨平台锁文件
const LOCK_FILE = path.join(os.tmpdir(), 'v2ex_reader.lock');

// ========== 锁文件 ==========
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (pid && isProcessAlive(pid)) {
      logger.error(`已有实例在运行 (PID ${pid})，退出`);
      process.exit(1);
    }
    logger.warn(`发现残留锁文件 (PID ${pid} 已不存在)，清除`);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

// ========== 截止时间检查 ==========
const hasExplicitLimit = process.argv.includes('--limit');
function isPastDeadline() {
  // dry-run 或手动指定 --limit 时不检查截止时间
  if (isDryRun || hasExplicitLimit) return false;
  const h = new Date().getUTCHours();
  // 脚本预期 01:15 UTC 启动，06:00 UTC 截止
  // 只在 UTC 06:00~23:59 期间判定为超时（避免 00:xx~01:xx 启动前误判）
  return h >= DEADLINE_UTC_HOUR;
}

// ========== 优雅退出 ==========
let isShuttingDown = false;
async function shutdown(reason, stats) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.sep();
  logger.ok(`停止原因: ${reason}`);
  logger.ok(`📊 统计: 阅读 ${stats.read} 篇 | 余额变化 ${stats.changed} 次 | 耗时 ${stats.elapsed}`);
  const s = queue.stats();
  logger.ok(`📦 队列: 可读 ${s.readable} | 已读满 ${s.exhausted} | 总计 ${s.total}`);
  logger.sep();
  // Telegram 通知：仅报错时推送
  stats.reason = reason;
  if (stats.consecutiveErrors >= 3) {
    await notify.notifyReaderError(stats);
  }
  // 退出前最后一次余额检查（保证余额日志始终最新）
  if (!isDryRun) {
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
  await browser.close();
  try { queue.close(); } catch (e) { logger.warn(`Queue close failed: ${e.message}`); }
  releaseLock();
  process.exit(0);
}

// ========== 主流程 ==========
async function main() {
  if (process.env.SKIP_READER === '1') {
    logger.info('[main] SKIP_READER=1, reader scheduler disabled.');
    process.exit(0);
  }
  acquireLock();

  const stats = { read: 0, changed: 0, elapsed: '0s', consecutiveErrors: 0 };

  // 注册退出信号处理
  const onExit = async (sig) => {
    logger.warn(`收到 ${sig}，正在退出...`);
    stats.elapsed = elapsed(startTime);
    await shutdown(sig, stats);
  };
  process.on('SIGTERM', () => onExit('SIGTERM'));
  process.on('SIGINT',  () => onExit('SIGINT'));

  logger.sep();
  logger.info(`🚀 V2EX Reader 启动 (dry-run=${isDryRun})`);
  logger.info(`限制: 最低 ${MIN_READ_COUNT} 篇且余额变化 ${MAX_CHANGE_COUNT} 次退出 | 最多 ${EFFECTIVE_LIMIT} 篇 | 截止 UTC ${DEADLINE_UTC_HOUR}:00`);
  logger.info(`行为参数: profile=${cfg.profile} balanceInterval=${BALANCE_CHECK_INTERVAL} humanGap=${BEHAVIOR.humanGapMin}-${BEHAVIOR.humanGapMax}ms memorySettle=${BEHAVIOR.memorySettleMs}ms`);
  if (BEHAVIOR.usesLegacyGap) {
    logger.warn('检测到 READ_GAP_MIN/MAX 旧变量，已按 READ_HUMAN_GAP_MIN/MAX 兼容处理');
  }
  logger.sep();

  const startTime = Date.now();

  // 初始化队列（async for sql.js）
  await queue.init();
  queue.cleanup();

  // 启动浏览器（dry-run 下跳过真实启动）
  await browser.launch(isDryRun);

  // 获取初始 Cookie
  const cookie = await browser.getCurrentCookie();
  // Cookie 失效检测
  if (!cookie) {
    logger.error('无法获取 Cookie，退出');
    await notify.notifySessionExpired();
    await browser.close();
    try { queue.close(); } catch (e) { logger.warn(`Queue close failed: ${e.message}`); }
    releaseLock();
    process.exit(1);
  }

  // 初始化余额基线（dry-run 跳过真实请求）
  if (!isDryRun) {
    const balanceState = await balance.init(cookie);
    if (!balanceState.ok && balanceState.fatal) {
      logger.error(`无法获取余额基线: ${balanceState.message}`);
      await notify.notifySessionExpired();
      await browser.close();
      try { queue.close(); } catch (e) { logger.warn(`Queue close failed: ${e.message}`); }
      releaseLock();
      process.exit(1);
    }
    if (!balanceState.ok) {
      logger.warn(`余额基线暂不可用，将继续阅读并在后续检查中重试: ${balanceState.message}`);
    }
  } else {
    logger.info('[DRY-RUN] 跳过余额初始化');
  }

  // 初始填充队列（忽略冷却）
  if (queue.size() < QUEUE_REFILL_THRESHOLD) {
    logger.info('初始填充队列...');
    const urls = await fetcher.fetchAllForce(cookie);
    queue.add(urls);
  }

  logger.info(`队列就绪: ${queue.size()} 条可读`);

  // ========== 主阅读循环 ==========
  while (true) {

    // 检查截止时间
    if (isPastDeadline()) {
      stats.elapsed = elapsed(startTime);
      await shutdown(`超过截止时间 UTC ${DEADLINE_UTC_HOUR}:00`, stats);
    }

    // 取帖子
    let url = queue.pop();

    // 队列为空时才补充（fetchAll 内部有 5 分钟冷却）
    if (!url) {
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
    if (ok) {
      queue.increment(url);
      stats.read++;
      stats.consecutiveErrors = 0;  // 成功则重置连续报错计数
    } else {
      queue.skip(url);
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
        await shutdown(reason, stats);
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
    if (stats.read > 0 && stats.read % 200 === 0) {
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
        const loggedIn = body.includes('/notifications') ||
                         body.includes('/signout') ||
                         body.includes('/member/');
        if (loggedIn) return resolve('logged_in');
        if (loggedOut) return resolve('logged_out');
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
  try { queue.close(); } catch (closeErr) { logger.warn(`Queue close failed: ${closeErr.message}`); }
  releaseLock();
  process.exit(1);
});
