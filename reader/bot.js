#!/usr/bin/env node
'use strict';
// ========== V2EX Telegram Bot 命令处理器 ==========
// 常驻进程，长轮询 Telegram，响应：
//   /sou   — 今日最后一次余额查询 & 昨日余额
//   /debug — 最新报错（日志末尾 ERROR/WARN 行）
//   /stop  — 停止正在运行的阅读脚本
//   直接粘贴 Cookie — 智能识别并导入
//
// 配置（环境变量或 ~/.v2ex_env 文件）：
//   TG_TOKEN    — Telegram Bot Token
//   TG_CHAT_ID  — 唯一授权用户的 Chat ID（硬锁，只响应该用户）
//   READER_LOG  — 阅读脚本日志路径（默认 /var/log/v2ex-reader.log）

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');

// ========== 加载配置 ==========
// 从 ~/.v2ex_env 加载键值对到 process.env（不覆盖已有变量）
function loadEnvFile() {
  const envFile = path.join(os.homedir(), '.v2ex_env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnvFile();

const TOKEN           = process.env.TG_TOKEN   || '';
const ALLOWED_CHAT_ID = process.env.TG_CHAT_ID || '';   // 硬锁，唯一授权用户
const DATA_DIR        = process.env.V2EX_DATA_DIR || path.join(__dirname, 'data');
const LOCK_FILE       = path.join(os.tmpdir(), 'v2ex_reader.lock');
const BALANCE_LOG     = path.join(DATA_DIR, 'balance_log.json');
const READER_LOG      = process.env.READER_LOG || path.join(DATA_DIR, 'v2ex-reader.log');

// Cookie 文件路径（与 browser.js / v2ex-checkin.js 保持一致）
const PROFILE     = (process.env.V2EX_PROFILE || 'default').trim() || 'default';
const COOKIE_FILE = process.env.COOKIE_FILE
  || (PROFILE === 'default'
      ? path.join(process.env.V2EX_DATA_DIR || os.homedir(), '.v2ex_cookie')
      : path.join(process.env.V2EX_DATA_DIR || os.homedir(), `.v2ex_cookie.${PROFILE}`));

// V2EX 关键 Cookie 字段白名单（按重要性排列）
const V2EX_COOKIE_KEYS = [
  'A2',              // 🔴 登录态核心 token
  'PB3_SESSION',     // 🟡 会话 session
  'cf_clearance',    // 🟡 Cloudflare 验证
  'V2EX_REFERRER',   // 🟢 来源追踪
  'A2O',             // 🟢 辅助登录态
  '_ga',             // ⚪ Google Analytics
  '_gid',            // ⚪ Google Analytics
];

if (!TOKEN)           { console.error('TG_TOKEN 未设置'); process.exit(1); }
if (!ALLOWED_CHAT_ID) { console.error('TG_CHAT_ID 未设置'); process.exit(1); }

function maskId(id) {
  const s = String(id || '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

// ========== Telegram API（含重启容错）==========
function tgRequest(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/${method}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // 处理 Telegram 409 冲突（上一个实例的长轮询还没断开）
          if (res.statusCode === 409) {
            console.warn('[BOT] Telegram 409 冲突，上一个实例连接未断开，1秒后重试...');
            resolve({ ok: false, conflict: true });
            return;
          }
          resolve(parsed);
        } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.setTimeout(40000, () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

function sendMsg(text) {
  return tgRequest('sendMessage', {
    chat_id:    ALLOWED_CHAT_ID,
    text,
    parse_mode: 'HTML',
  });
}

// ========== 命令处理 ==========

// /sou — 从本地余额记录读取，不做实时请求
async function handleSou() {
  if (!fs.existsSync(BALANCE_LOG)) {
    return sendMsg('⚠️ 尚无余额记录，脚本至少需运行一次后才有数据');
  }
  const log  = JSON.parse(fs.readFileSync(BALANCE_LOG, 'utf8'));
  const days = Object.keys(log).sort().reverse(); // 最新的在前

  const today    = days[0];
  const yesterday = days[1];

  const todayEntry     = today     ? log[today]     : null;
  const yesterdayEntry = yesterday ? log[yesterday] : null;

  const todayTime = todayEntry
    ? new Date(todayEntry.lastTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
    : '--';

  let msg = `💰 <b>余额记录</b>\n`;
  msg += todayEntry
    ? `今日 (${today})：<b>${todayEntry.last} 铜币</b>  最后查询 ${todayTime} EST\n`
    : `今日：暂无记录\n`;
  msg += yesterdayEntry
    ? `昨日 (${yesterday})：${yesterdayEntry.last} 铜币`
    : `昨日：暂无记录`;

  return sendMsg(msg);
}

// /debug — 从日志文件读取最近 ERROR/WARN 行
async function handleDebug() {
  if (!fs.existsSync(READER_LOG)) {
    return sendMsg('⚠️ 日志文件不存在: ' + READER_LOG);
  }
  try {
    // 读取最后 300 行，过滤 ERROR/WARN
    const content = fs.readFileSync(READER_LOG, 'utf8');
    const lines   = content.split('\n').filter(Boolean);
    const tail    = lines.slice(-300);
    const errors  = tail.filter(l => l.includes('[ERROR]') || l.includes('[WARN ]'));

    if (errors.length === 0) {
      return sendMsg('✅ 最近日志无报错');
    }
    // 取最新 10 条
    const recent = errors.slice(-10).join('\n');
    return sendMsg(`🔍 <b>最新报错（最多10条）</b>\n<pre>${escapeHtml(recent)}</pre>`);
  } catch (e) {
    return sendMsg(`读取日志失败: ${e.message}`);
  }
}

// /stop — 向阅读脚本发送 SIGTERM
async function handleStop() {
  if (!fs.existsSync(LOCK_FILE)) {
    return sendMsg('ℹ️ 阅读脚本未在运行（锁文件不存在）');
  }
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (!pid || isNaN(pid)) return sendMsg('⚠️ 锁文件 PID 无效');
    process.kill(pid, 'SIGTERM');
    await sendMsg(`🛑 已向 PID ${pid} 发送停止信号`);
  } catch (e) {
    if (e.code === 'ESRCH') {
      fs.unlinkSync(LOCK_FILE);
      return sendMsg('ℹ️ 进程已不存在，锁文件已清理');
    }
    return sendMsg(`停止失败: ${e.message}`);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ========== Cookie 智能识别导入 ==========

// 从任意文本中提取 V2EX 关键 Cookie 字段
// 返回 { found: Map<name, value>, missing: string[] } 或 null（未找到 A2）
function extractCookie(text) {
  const found = new Map();

  for (const key of V2EX_COOKIE_KEYS) {
    const re = new RegExp(
      key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '=("[^"]*"|[^;\\s\\n]+)',
      'g'
    );

    let match;
    while ((match = re.exec(text)) !== null) {
      let value = match[1].trim();
      // 去除尾部可能粘上的分号
      if (value.endsWith(';')) value = value.slice(0, -1);
      // 保留引号内容
      if (value) found.set(key, value);
    }
  }

  // A2 是必需字段
  if (!found.has('A2')) return null;

  const missing = V2EX_COOKIE_KEYS.slice(0, 3).filter(k => !found.has(k));
  return { found, missing };
}

// 用 Cookie 请求 V2EX 首页，检查登录状态
function verifyCookie(cookieStr) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.v2ex.com',
      path: '/',
      method: 'GET',
      headers: {
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const loggedIn = !body.includes('你要查看的页面需要先登录') &&
                         !body.includes('需要先登录') &&
                         (body.includes('/notifications') || body.includes('/member/'));
        resolve(loggedIn);
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(15000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// 处理 Cookie 导入
async function handleCookieImport(text) {
  const result = extractCookie(text);
  if (!result) return false;

  const { found, missing } = result;

  // 与旧 Cookie 合并
  let oldCookieMap = new Map();
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const oldStr = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
      for (const part of oldStr.split(';')) {
        const s = part.trim();
        if (!s) continue;
        const i = s.indexOf('=');
        if (i < 0) continue;
        oldCookieMap.set(s.slice(0, i).trim(), s.slice(i + 1).trim());
      }
    }
  } catch (_) {}

  // 新值覆盖旧值
  for (const [k, v] of found) {
    oldCookieMap.set(k, v);
  }

  // 组装最终 Cookie 字符串
  const finalCookie = Array.from(oldCookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  // 确保目录存在
  const cookieDir = path.dirname(COOKIE_FILE);
  if (!fs.existsSync(cookieDir)) {
    fs.mkdirSync(cookieDir, { recursive: true });
  }

  // 写入文件
  try {
    fs.writeFileSync(COOKIE_FILE, finalCookie, { mode: 0o600 });
  } catch (e) {
    await sendMsg(`❌ Cookie 写入失败: ${e.message}`);
    return true;
  }

  // 构建识别结果消息
  const fieldLines = [];
  for (const key of V2EX_COOKIE_KEYS) {
    if (found.has(key)) {
      const label = key === 'A2' ? '登录态' :
                    key === 'PB3_SESSION' ? '会话' :
                    key === 'cf_clearance' ? 'CF验证' :
                    key === 'V2EX_REFERRER' ? '来源' :
                    key === 'A2O' ? '辅助登录' : 'Analytics';
      fieldLines.push(`  ✅ ${key}（${label}）`);
    }
  }
  if (missing.length > 0) {
    for (const key of missing) {
      fieldLines.push(`  ⚠️ ${key}（未提供，已保留旧值）`);
    }
  }

  await sendMsg(
    `🍪 <b>Cookie 已更新</b>\n\n` +
    `识别到以下字段：\n${fieldLines.join('\n')}\n\n` +
    `⏳ 正在验证有效性...`
  );

  console.log('[BOT] 验证 Cookie 有效性...');
  const valid = await verifyCookie(finalCookie);
  if (valid) {
    await sendMsg('✅ Cookie 验证通过，登录态正常');
    console.log('[BOT] Cookie 验证通过');
  } else {
    await sendMsg('⚠️ Cookie 已保存，但验证未通过（可能已过期或 CF 拦截）\n请确认 Cookie 是最新的');
    console.log('[BOT] Cookie 验证未通过');
  }

  return true;
}

// ========== 内置调度器（替代 Docker cron，Render 友好）==========

let runningTask = null; // 防止任务重叠

function runScript(name, command, args, cwd) {
  if (runningTask) {
    console.log(`[调度器] 跳过 ${name}，上一个任务 ${runningTask} 还在运行`);
    return;
  }

  // 检查 Cookie 文件是否存在（无 cookie 时跳过，不崩溃）
  if (!fs.existsSync(COOKIE_FILE)) {
    console.log(`[调度器] 跳过 ${name}，Cookie 文件不存在，请先通过 TG 导入`);
    return;
  }

  console.log(`[调度器] 启动 ${name}`);
  runningTask = name;

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env }, // 继承所有环境变量
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', d => {
    const lines = d.toString().trim();
    if (lines) console.log(`[${name}] ${lines}`);
  });
  child.stderr.on('data', d => {
    const lines = d.toString().trim();
    if (lines) console.error(`[${name}] ${lines}`);
  });

  child.on('close', (code) => {
    console.log(`[调度器] ${name} 退出 (code ${code})`);
    runningTask = null;
  });

  child.on('error', (err) => {
    console.error(`[调度器] ${name} 启动失败: ${err.message}`);
    runningTask = null;
  });
}

function startScheduler() {
  // 用 day-of-year 防止同一天重复执行
  let lastCheckinDOY = -1;
  let lastReadDOY = -1;

  setInterval(() => {
    const now = new Date();
    const h = now.getUTCHours();
    const m = now.getUTCMinutes();
    // day-of-year 唯一标识每天
    const doy = Math.floor((now - new Date(now.getUTCFullYear(), 0, 0)) / 86400000);

    // 每天 UTC 01:10 签到（当天只执行一次）
    if (h === 1 && m === 10 && doy !== lastCheckinDOY) {
      lastCheckinDOY = doy;
      runScript('签到', process.execPath, ['../checkin/v2ex-checkin.js'], __dirname);
    }

    // 每天 UTC 01:15 阅读（当天只执行一次）
    if (h === 1 && m === 15 && doy !== lastReadDOY) {
      lastReadDOY = doy;
      // Render 环境下直接 node，VPS Docker 里可以用 xvfb-run
      const hasXvfb = fs.existsSync('/usr/bin/xvfb-run');
      if (hasXvfb) {
        runScript('阅读', '/usr/bin/xvfb-run', ['-a', process.execPath, 'main.js'], __dirname);
      } else {
        runScript('阅读', process.execPath, ['main.js'], __dirname);
      }
    }

    // 每 6 小时保活（V2EX session 保活，非 Render 保活）
    if ([0, 6, 12, 18].includes(h) && m === 0) {
      runScript('保活', process.execPath, ['../checkin/v2ex-checkin.js', '--ping'], __dirname);
    }
  }, 60 * 1000); // 每分钟检查一次

  console.log('[调度器] 内置定时任务已启动 (UTC 时钟)');
}

// ========== 铁墙 HTTP 服务器（满足 Render 端口要求 + 防扫描）==========

function startHttpWall() {
  if (process.env.DISABLE_HTTP_WALL === '1') {
    console.log('[HTTP] HTTP 铁墙服务器已被 DISABLE_HTTP_WALL=1 禁用');
    return;
  }
  const RENDER_PORT = process.env.PORT || 10000;

  const server = http.createServer((req, res) => {
    // 安全头
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'");

    // 唯一允许的路径
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }

    // 一切其他请求：404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.maxHeadersCount = 20;
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;

  server.listen(RENDER_PORT, () => {
    console.log(`[HTTP] 铁墙服务器已启动 (端口 ${RENDER_PORT})`);
  });
}

// ========== 自保活（防 Render 15 分钟休眠）==========

function startKeepAlive() {
  const extUrl = process.env.RENDER_EXTERNAL_URL;
  if (!extUrl) {
    console.log('[KEEP-ALIVE] 未检测到 RENDER_EXTERNAL_URL，跳过自保活（非 Render 环境）');
    return;
  }

  setInterval(() => {
    https.get(extUrl, (res) => {
      res.resume(); // 读完响应，不处理
    }).on('error', () => {
      // 保活 ping 失败不影响主流程
    });
  }, 10 * 60 * 1000); // 每 10 分钟

  console.log(`[KEEP-ALIVE] 自保活已启用，每 10 分钟 ping ${extUrl}`);
}

// ========== 长轮询主循环（含重启容错）==========
let offset = 0;
let pollRetryDelay = 1000; // 初始重试间隔 1 秒

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function poll() {
  try {
    const res = await tgRequest('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });

    // 处理 409 冲突（Render 重启后上一个实例的连接还没断）
    if (res.conflict) {
      await sleep(pollRetryDelay);
      pollRetryDelay = Math.min(pollRetryDelay * 2, 10000); // 指数退避，最多 10 秒
      return;
    }

    // 成功后重置重试间隔
    pollRetryDelay = 1000;

    if (!res.ok || !res.result) return;

    for (const update of res.result) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      // 硬锁：只响应授权 chat_id
      if (String(msg.chat.id) !== ALLOWED_CHAT_ID) {
        console.log('[BOT] 忽略非授权消息');
        continue;
      }

      const text = msg.text.trim();
      const cmd = text.split(/\s+/)[0].toLowerCase();
      console.log(`[BOT] 收到消息: ${cmd}`);

      try {
        if      (cmd === '/sou')   await handleSou();
        else if (cmd === '/debug') await handleDebug();
        else if (cmd === '/stop')  await handleStop();
        else if (cmd.startsWith('/')) {
          await sendMsg('可用命令：\n/sou — 余额记录\n/debug — 最新报错\n/stop — 停止阅读脚本\n\n💡 直接粘贴 Cookie 文本即可自动识别导入');
        } else {
          // 非命令消息：尝试智能识别 Cookie
          const handled = await handleCookieImport(text);
          if (!handled) {
            console.log('[BOT] 未识别到有效 Cookie，忽略');
          }
        }
      } catch (e) {
        console.error(`[BOT] 命令处理出错: ${e.message}`);
      }
    }
  } catch (e) {
    if (e.message !== 'timeout') {
      console.error(`[BOT] 轮询出错: ${e.message}，${pollRetryDelay / 1000}秒后重试`);
      await sleep(pollRetryDelay);
      pollRetryDelay = Math.min(pollRetryDelay * 2, 30000); // 网络错误最多等 30 秒
    }
  }
}

// ========== 主启动逻辑（含重启恢复）==========
console.log(`[BOT] V2EX Bot 启动，授权 Chat ID: ${maskId(ALLOWED_CHAT_ID)}`);

(async () => {
  // 启动铁墙 HTTP 服务器（必须在轮询之前，否则 Render 判定启动失败）
  startHttpWall();

  // 清除残留锁文件（重启后旧 PID 已无效）
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      try { process.kill(oldPid, 0); } catch (_) {
        // 旧进程已不存在，安全删除锁文件
        fs.unlinkSync(LOCK_FILE);
        console.log('[BOT] 已清除残留锁文件');
      }
    } catch (_) {}
  }

  // 从环境变量 V2EX_COOKIE 初始化 Cookie 文件 (用于 Render 等临时容器持久化)
  if (process.env.V2EX_COOKIE && !fs.existsSync(COOKIE_FILE)) {
    try {
      const cookieDir = path.dirname(COOKIE_FILE);
      if (!fs.existsSync(cookieDir)) {
        fs.mkdirSync(cookieDir, { recursive: true });
      }
      fs.writeFileSync(COOKIE_FILE, process.env.V2EX_COOKIE.trim(), { mode: 0o600 });
      console.log('[BOT] 从环境变量 V2EX_COOKIE 初始化 Cookie 文件成功');
    } catch (e) {
      console.error(`[BOT] 从环境变量 V2EX_COOKIE 初始化 Cookie 失败: ${e.message}`);
    }
  }

  // 跳过历史消息（offset 设为最新，带重试）
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const init = await tgRequest('getUpdates', { offset: -1, timeout: 0 });
      if (init.conflict) {
        console.log(`[BOT] 初始化遇到 409 冲突，${attempt + 1}/5 次重试...`);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (init.ok && init.result.length > 0) {
        offset = init.result[init.result.length - 1].update_id + 1;
      }
      break;
    } catch (e) {
      console.error(`[BOT] 初始化失败: ${e.message}，重试中...`);
      await sleep(2000 * (attempt + 1));
    }
  }

  // 检查 Cookie 状态，构建启动消息
  const hasCookie = fs.existsSync(COOKIE_FILE);
  let startupMsg = '🤖 Bot 已上线';
  if (!hasCookie) {
    startupMsg += '\n\n⚠️ 未检测到 Cookie 文件\n💡 请直接粘贴 Cookie 文本，Bot 会自动识别导入';
  } else {
    startupMsg += '\n✅ Cookie 文件已就绪';
  }
  startupMsg += '\n\n可用命令：\n/sou — 余额记录\n/debug — 最新报错\n/stop — 停止阅读脚本';

  await sendMsg(startupMsg);

  // 启动内置调度器
  startScheduler();

  // 启动自保活
  startKeepAlive();

  // 主轮询循环（永不退出）
  while (true) {
    await poll();
  }
})();
