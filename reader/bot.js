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
//   TG_CHAT_ID  — 唯一授权用户的 Chat ID（推荐直接配置）
//   TG_SETUP_CODE — 绑定口令；未配置 TG_CHAT_ID 时必须设置并发送 /bind <code>
//   READER_LOG  — 阅读脚本日志路径（默认运行时数据目录下的 v2ex-reader.log）

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');
const config = require('../lib/config');

// ========== 配置 ==========
const cfg            = config.getConfig();
const TOKEN          = cfg.telegram.token;
const SETUP_CODE     = cfg.telegram.setupCode;
const DATA_DIR       = cfg.readerDataDir;
const LOCK_FILE       = path.join(os.tmpdir(), 'v2ex_reader.lock');
const BALANCE_LOG     = cfg.balanceLog;
const BALANCE_STATUS  = cfg.balanceStatus;
const READER_LOG      = cfg.readerLog;
const AUTH_CHAT_FILE  = cfg.authChatFile;

let ALLOWED_CHAT_ID = loadAuthorizedChatId();   // 硬锁，唯一授权用户

const LOG_LEVEL_FILE  = cfg.logLevelFile;
let currentLogLevel = 'OFF';
try {
  if (fs.existsSync(LOG_LEVEL_FILE)) {
    currentLogLevel = fs.readFileSync(LOG_LEVEL_FILE, 'utf8').trim().toUpperCase();
  }
} catch (_) {}

function shouldWriteLog(lineLevel) {
  if (currentLogLevel === 'OFF') return false;
  if (currentLogLevel === 'ERROR') {
    return lineLevel === 'ERROR';
  }
  if (currentLogLevel === 'WARN') {
    return lineLevel === 'ERROR' || lineLevel === 'WARN';
  }
  if (currentLogLevel === 'INFO') {
    return true;
  }
  return false;
}

function loadAuthorizedChatId() {
  if (cfg.telegram.chatIdSource === 'env') return cfg.telegram.chatId;
  try {
    if (fs.existsSync(AUTH_CHAT_FILE)) {
      return fs.readFileSync(AUTH_CHAT_FILE, 'utf8').trim();
    }
  } catch (_) {}
  return '';
}

function saveAuthorizedChatId(chatId) {
  ALLOWED_CHAT_ID = config.saveAuthorizedChatId(chatId, cfg);
}

// Cookie 文件路径（与 browser.js / v2ex-checkin.js 保持一致）
const PROFILE     = cfg.profile;
const COOKIE_FILE = cfg.cookieFile;

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

if (!TOKEN) { console.error('TG_TOKEN 未设置'); process.exit(1); }

function maskId(id) {
  const s = String(id || '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
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
  if (!ALLOWED_CHAT_ID) return Promise.resolve({ ok: false, skipped: 'not_bound' });
  return tgRequest('sendMessage', {
    chat_id:    ALLOWED_CHAT_ID,
    text,
    parse_mode: 'HTML',
  });
}

function sendMsgWithKeyboard(text, replyMarkup) {
  if (!ALLOWED_CHAT_ID) return Promise.resolve({ ok: false, skipped: 'not_bound' });
  return tgRequest('sendMessage', {
    chat_id:      ALLOWED_CHAT_ID,
    text,
    parse_mode:   'HTML',
    reply_markup: replyMarkup,
  });
}

function editMsgText(messageId, text, replyMarkup) {
  if (!ALLOWED_CHAT_ID) return Promise.resolve({ ok: false, skipped: 'not_bound' });
  const params = {
    chat_id:    ALLOWED_CHAT_ID,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) params.reply_markup = replyMarkup;
  return tgRequest('editMessageText', params);
}

function sendDirectMsg(chatId, text) {
  return tgRequest('sendMessage', {
    chat_id:    String(chatId),
    text,
    parse_mode: 'HTML',
  });
}

// ========== 命令处理 ==========

function getMainKeyboardMarkup() {
  return {
    inline_keyboard: [
      [
        { text: '✅ 运行签到', callback_data: 'run_checkin' },
        { text: '📖 运行阅读', callback_data: 'run_read_panel' }
      ],
      [
        { text: '💰 余额查询', callback_data: 'query_balance' },
        { text: '📦 任务状态', callback_data: 'query_tasks' }
      ],
      [
        { text: '🧩 时段分块', callback_data: 'show_profile_slots' },
        { text: '⚙️ 日志级别', callback_data: 'config_debug' }
      ],
      [
        { text: '🛑 停止运行', callback_data: 'stop_task' },
        { text: '🍪 导入 Cookie', callback_data: 'show_cookie_help' }
      ],
      [
        { text: 'ℹ️ 命令帮助', callback_data: 'show_help' }
      ]
    ]
  };
}

async function handleStart() {
  const text = `🤖 <b>V2EX Max Helper 遥控中心</b>\n\n欢迎回来！你可以直接使用下方按钮完成常用操作；也可以直接粘贴 Cookie 文本，Bot 会自动识别并导入。`;
  return sendMsgWithKeyboard(text, getMainKeyboardMarkup());
}

async function handleHelp() {
  const text = `ℹ️ <b>V2EX Max Helper 命令帮助说明</b>\n\n` +
               `🤖 <b>主控制面板</b>: \n` +
               `- <code>/start</code>: 打开主交互遥控面板\n` +
               `- <code>/help</code>: 显示当前命令说明\n\n` +
               `💰 <b>数据与状态</b>: \n` +
               `- <code>/sou</code>: 查询今日与昨日的 V2EX 余额记录\n` +
               `- <code>/tasks</code>: 实时查询后台签到 / 阅读的运行状态\n\n` +
               `⚙️ <b>脚本控制</b>: \n` +
               `- <code>/checkin</code>: 立刻开跑手动签到测试\n` +
               `- <code>/read [数量]</code>: 触发手动阅读测试（默认 5 篇）\n` +
               `- 面板「时段分块」: 查看多账号窗口，并手动启动串行签到 + 阅读\n` +
               `- <code>/stop</code>: 紧急打断正在运行中的阅读/签到任务\n\n` +
               `🔧 <b>日志与设置</b>: \n` +
               `- <code>/debug [级别]</code>: 查看/修改日志级别（OFF / ERROR / WARN / INFO）\n` +
               `- <code>/cookie [内容]</code>: 手动识别并导入新的 V2EX Cookie\n\n` +
               `💡 <b>小提示</b>：你也可以直接把含有 Cookie 的文本粘贴给我，我会自动智能识别并合并导入。`;
  return sendMsgWithKeyboard(text, getMainKeyboardMarkup());
}

async function handleCookieHelp(messageId = null) {
  const text = `🍪 <b>导入 Cookie</b>\n\n请直接把完整 V2EX Cookie 文本粘贴到当前私聊，Bot 会自动识别、合并并验证登录态。\n\n也可以使用命令：<code>/cookie 你的Cookie内容</code>`;
  const replyMarkup = { inline_keyboard: [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]] };
  if (messageId) return editMsgText(messageId, text, replyMarkup);
  return sendMsgWithKeyboard(text, replyMarkup);
}

async function handleTasks() {
  if (!fs.existsSync(LOCK_FILE)) {
    if (runningTask || profileSequenceRunning) {
      const detail = runningTask || '多账号串行队列';
      return sendMsg(`ℹ️ <b>当前任务状态</b>: 🟡 <b>正在运行中</b>\n- 当前任务: <code>${escapeHtml(detail)}</code>`);
    }
    return sendMsg('ℹ️ <b>当前任务状态</b>: 🟢 <b>空闲</b> (无后台任务在运行)');
  }
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (!pid || isNaN(pid)) return sendMsg('⚠️ 发现残留锁文件，但 PID 无效');
    const alive = isProcessAlive(pid);
    if (alive) {
      return sendMsg(`ℹ️ <b>当前任务状态</b>: 🟡 <b>正在运行中</b>\n- 运行进程 PID: <code>${pid}</code>\n- 你可以使用 <code>/stop</code> 命令强制打断当前任务。`);
    } else {
      try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
      return sendMsg('ℹ️ <b>当前任务状态</b>: 🟢 <b>空闲</b> (已清理残留锁文件)');
    }
  } catch (e) {
    return sendMsg(`❌ 状态查询失败: ${e.message}`);
  }
}

// 格式化硬币显示，优先显示金币和银币
function formatCoins(entry, bold = true) {
  if (!entry) return '';
  const parts = [];
  const b = bold ? '<b>' : '';
  const eb = bold ? '</b>' : '';
  if (entry.gold) parts.push(`${b}${entry.gold}${eb} 金币`);
  if (entry.silver) parts.push(`${b}${entry.silver}${eb} 银币`);
  const copper = entry.copper !== undefined ? entry.copper : entry.last;
  if (copper || parts.length === 0) parts.push(`${b}${copper || 0}${eb} 铜币`);
  return parts.join(', ');
}

function readJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function formatBalanceStatus(status) {
  if (!status) return '';
  const ok = status.ok ? '成功' : '失败';
  const time = status.time ? new Date(status.time).toLocaleString('zh-CN', { hour12: false }) : '--';
  const detail = status.message || status.code || '未知状态';
  const http = status.statusCode ? ` / HTTP ${status.statusCode}` : '';
  return `\n\n最近一次余额检查：<b>${ok}</b>${http}\n时间：<code>${escapeHtml(time)}</code>\n状态：${escapeHtml(detail)}`;
}

function buildBalanceMessage() {
  const status = readJsonFile(BALANCE_STATUS);
  const log = readJsonFile(BALANCE_LOG);
  const days = log
    ? Object.keys(log).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().reverse()
    : [];

  if (!log || days.length === 0) {
    return '⚠️ 尚无余额记录，脚本至少需成功读取一次余额后才有数据' + formatBalanceStatus(status);
  }

  const today    = days[0];
  const yesterday = days[1];

  const todayEntry     = today     ? log[today]     : null;
  const yesterdayEntry = yesterday ? log[yesterday] : null;

  const todayTime = todayEntry
    ? new Date(todayEntry.lastTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
    : '--';

  let msg = `💰 <b>余额记录</b>\n`;
  msg += todayEntry
    ? `今日 (${today})：${formatCoins(todayEntry, true)}  最后查询 ${todayTime} EST\n`
    : `今日：暂无记录\n`;
  msg += yesterdayEntry
    ? `昨日 (${yesterday})：${formatCoins(yesterdayEntry, false)}`
    : `昨日：暂无记录`;

  if (status && !status.ok) {
    msg += formatBalanceStatus(status);
  }

  return msg;
}

// /sou — 从本地余额记录读取，不做实时请求
async function handleSou() {
  return sendMsg(buildBalanceMessage());
}

// /debug — 修改日志级别，默认不产生日志，一共四个级别
async function handleDebug(levelArg, messageId = null) {
  const levels = ['OFF', 'ERROR', 'WARN', 'INFO'];
  if (levelArg) {
    const targetLevel = levelArg.toUpperCase();
    if (!levels.includes(targetLevel)) {
      const errorMsg = `❌ 无效的级别 <code>${levelArg}</code>。请选择以下之一：<code>OFF</code>, <code>ERROR</code>, <code>WARN</code>, <code>INFO</code>`;
      if (messageId) return editMsgText(messageId, errorMsg);
      return sendMsg(errorMsg);
    }
    currentLogLevel = targetLevel;
    try {
      config.writeFileAtomic(LOG_LEVEL_FILE, currentLogLevel, 'utf8');
    } catch (_) {}
    if (messageId) {
      return renderDebugKeyboard(messageId);
    }
    return sendMsg(`✅ 日志级别已成功更改为: <code>${currentLogLevel}</code>`);
  }
  
  if (messageId) {
    return renderDebugKeyboard(messageId);
  } else {
    const text = `⚙️ <b>日志级别配置</b>\n\n当前设置: <code>${currentLogLevel}</code>\n\n请点击下方按钮快速切换日志输出等级：`;
    const replyMarkup = getDebugKeyboardMarkup();
    return sendMsgWithKeyboard(text, replyMarkup);
  }
}

function getDebugKeyboardMarkup() {
  const checked = (level) => currentLogLevel === level ? ' 🔹' : '';
  return {
    inline_keyboard: [
      [
        { text: `OFF${checked('OFF')}`, callback_data: 'set_debug_off' },
        { text: `ERROR${checked('ERROR')}`, callback_data: 'set_debug_error' }
      ],
      [
        { text: `WARN${checked('WARN')}`, callback_data: 'set_debug_warn' },
        { text: `INFO${checked('INFO')}`, callback_data: 'set_debug_info' }
      ],
      [
        { text: '◀️ 返回面板', callback_data: 'go_to_start' }
      ]
    ]
  };
}

async function renderDebugKeyboard(messageId) {
  const text = `⚙️ <b>日志级别配置</b>\n\n当前设置: <code>${currentLogLevel}</code>\n\n请点击下方按钮快速切换日志输出等级：`;
  const replyMarkup = getDebugKeyboardMarkup();
  return editMsgText(messageId, text, replyMarkup);
}

async function handleRead(limitArg, messageId = null) {
  if (limitArg) {
    let limit = 5;
    const parsed = parseInt(limitArg, 10);
    if (parsed > 0) limit = parsed;
    const startMsg = `⏳ 正在启动手动阅读（限制阅读 ${limit} 篇）...`;
    if (messageId) await editMsgText(messageId, startMsg);
    else await sendMsg(startMsg);
    const args = ['main.js', '--limit', String(limit)];
    runScript('手动阅读', process.execPath, args, __dirname);
    return;
  }
  
  const text = `📖 <b>手动阅读控制面板</b>\n\n请选择本次阅读的文章篇数：`;
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '5 篇', callback_data: 'trigger_read_5' },
        { text: '10 篇', callback_data: 'trigger_read_10' }
      ],
      [
        { text: '50 篇', callback_data: 'trigger_read_50' },
        { text: '250 篇', callback_data: 'trigger_read_250' }
      ],
      [
        { text: '◀️ 返回面板', callback_data: 'go_to_start' }
      ]
    ]
  };
  if (messageId) {
    return editMsgText(messageId, text, replyMarkup);
  } else {
    return sendMsgWithKeyboard(text, replyMarkup);
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
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    config.writeFileAtomic(COOKIE_FILE, finalCookie, { mode: 0o600 });
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
let profileSequenceRunning = false;

const MAX_PROFILE_COUNT = 6;

function parseProfileList() {
  const raw = (process.env.V2EX_PROFILE_LIST || '').trim();
  if (!raw) return [];
  const seen = new Set();
  const profiles = [];
  for (const item of raw.split(',')) {
    const profile = item.trim();
    if (!profile || seen.has(profile)) continue;
    seen.add(profile);
    if (profiles.length >= MAX_PROFILE_COUNT) {
      console.warn(`[调度器] V2EX_PROFILE_LIST 最多支持 ${MAX_PROFILE_COUNT} 个 profile，已忽略后续配置`);
      break;
    }
    profiles.push(profile);
  }
  return profiles;
}

const PROFILE_LIST = parseProfileList();
const MULTI_PROFILE_MODE = PROFILE_LIST.length > 0;
const PROFILE_TIME_SLOT_HOURS = Math.max(1, parseFloat(process.env.PROFILE_TIME_SLOT_HOURS || '4') || 4);
const PROFILE_TIME_SLOT_MS = Math.round(PROFILE_TIME_SLOT_HOURS * 60 * 60 * 1000);
const PROFILE_SEQUENCE_START_UTC_MINUTES = 70; // 01:10 UTC

function getProfileCookieFile(profile) {
  const base = path.join(cfg.cookieBaseDir, '.v2ex_cookie');
  return profile === 'default' ? base : `${base}.${profile}`;
}

function childEnvForProfile(profile, extra = {}) {
  const env = { ...process.env, ...extra, V2EX_PROFILE: profile };
  if (MULTI_PROFILE_MODE) {
    delete env.COOKIE_FILE;
    delete env.V2EX_COOKIE;
  }
  return env;
}

function appendTaskLog(name, lineLevel, line) {
  if (!shouldWriteLog(lineLevel)) return;
  try {
    fs.appendFileSync(READER_LOG, `[${new Date().toISOString()}] [${name}] [${lineLevel}] ${line}\n`);
  } catch (_) {}
}

function pipeTaskOutput(child, name) {
  child.stdout.on('data', d => {
    const dataStr = d.toString();
    const lines = dataStr.split('\n');
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      console.log(`[${name}] ${line}`);

      let lineLevel = 'INFO';
      if (line.includes('[ERROR]')) lineLevel = 'ERROR';
      else if (line.includes('[WARN ]') || line.includes('[WARN]')) lineLevel = 'WARN';

      appendTaskLog(name, lineLevel, line);
    }
  });

  child.stderr.on('data', d => {
    const dataStr = d.toString();
    const lines = dataStr.split('\n');
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      console.error(`[${name}] ${line}`);

      let lineLevel = 'ERROR';
      if (line.includes('[WARN ]') || line.includes('[WARN]')) lineLevel = 'WARN';
      else if (line.includes('[INFO ]') || line.includes('[INFO]')) lineLevel = 'INFO';

      appendTaskLog(name, lineLevel, line);
    }
  });
}

function runScriptAsync(name, command, args, cwd, options = {}) {
  if (runningTask) {
    console.log(`[调度器] 跳过 ${name}，上一个任务 ${runningTask} 还在运行`);
    return Promise.resolve({ skipped: true });
  }
  if (profileSequenceRunning && !options.partOfProfileSequence) {
    console.log(`[调度器] 跳过 ${name}，多账号串行任务正在运行`);
    return Promise.resolve({ skipped: true });
  }

  // 检查 Cookie 文件是否存在（无 cookie 时跳过，不崩溃）
  const cookieFile = options.cookieFile || COOKIE_FILE;
  if (options.requireCookie !== false && !fs.existsSync(cookieFile)) {
    console.log(`[调度器] 跳过 ${name}，Cookie 文件不存在: ${cookieFile}`);
    return Promise.resolve({ skipped: true });
  }

  console.log(`[调度器] 启动 ${name}`);
  runningTask = name;

  const child = spawn(command, args, {
    cwd,
    env: options.env || { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  pipeTaskOutput(child, name);

  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;
    function finish(result) {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      runningTask = null;
      resolve(result);
    }

    if (options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        console.warn(`[调度器] ${name} 超过 ${Math.round(options.timeoutMs / 60000)} 分钟，发送 SIGTERM`);
        try { child.kill('SIGTERM'); } catch (_) {}
      }, options.timeoutMs);
    }

    child.on('close', (code) => {
      console.log(`[调度器] ${name} 退出 (code ${code})`);
      finish({ code });
    });

    child.on('error', (err) => {
      console.error(`[调度器] ${name} 启动失败: ${err.message}`);
      finish({ error: err });
    });
  });
}

function runScript(name, command, args, cwd) {
  runScriptAsync(name, command, args, cwd).catch(err => {
    console.error(`[调度器] ${name} 执行失败: ${err.message}`);
  });
}

async function runProfileDailySequence() {
  if (!MULTI_PROFILE_MODE) {
    console.log('[调度器] 跳过多账号串行，未配置 V2EX_PROFILE_LIST');
    return { skipped: true, reason: 'no_profiles' };
  }
  if (profileSequenceRunning || runningTask) {
    const busy = profileSequenceRunning ? '多账号串行任务' : runningTask;
    console.log(`[调度器] 跳过多账号串行，当前已有任务运行: ${busy}`);
    return { skipped: true, reason: 'busy' };
  }

  profileSequenceRunning = true;
  const results = [];
  try {
    console.log(`[调度器] 多账号串行开始: ${PROFILE_LIST.join(', ')} | 每账号窗口约 ${PROFILE_TIME_SLOT_HOURS} 小时`);
    if (process.env.COOKIE_FILE || process.env.V2EX_COOKIE) {
      console.warn('[调度器] 多账号模式会忽略 COOKIE_FILE / V2EX_COOKIE，改用按 profile 分隔的 Cookie 文件');
    }

    for (const profile of PROFILE_LIST) {
      const env = childEnvForProfile(profile);
      const cookieFile = getProfileCookieFile(profile);
      const checkin = await runScriptAsync(`签到(${profile})`, process.execPath, ['../checkin/v2ex-checkin.js'], __dirname, {
        env,
        cookieFile,
        timeoutMs: 15 * 60 * 1000,
        partOfProfileSequence: true,
      });
      const read = await runScriptAsync(`阅读(${profile})`, process.execPath, ['main.js'], __dirname, {
        env: childEnvForProfile(profile, {
          READ_DISABLE_DEADLINE: '1',
          READ_MAX_RUNTIME_MS: String(PROFILE_TIME_SLOT_MS),
        }),
        cookieFile,
        timeoutMs: PROFILE_TIME_SLOT_MS + 5 * 60 * 1000,
        partOfProfileSequence: true,
      });
      results.push({ profile, checkin, read });
    }
    console.log('[调度器] 多账号串行结束');
    return { profiles: PROFILE_LIST.length, results };
  } finally {
    profileSequenceRunning = false;
  }
}

async function runProfilePingSequence() {
  if (profileSequenceRunning || runningTask) {
    console.log('[调度器] 跳过多账号保活，已有任务运行');
    return;
  }
  for (const profile of PROFILE_LIST) {
    const cookieFile = getProfileCookieFile(profile);
    await runScriptAsync(`保活(${profile})`, process.execPath, ['../checkin/v2ex-checkin.js', '--ping'], __dirname, {
      env: childEnvForProfile(profile),
      cookieFile,
      timeoutMs: 10 * 60 * 1000,
    });
  }
}

function formatHours(hours) {
  if (Number.isInteger(hours)) return String(hours);
  return hours.toFixed(2).replace(/\.?0+$/, '');
}

function formatDayOffset(dayOffset) {
  if (dayOffset === 0) return '';
  return dayOffset > 0 ? `+${dayOffset}d` : `${dayOffset}d`;
}

function getUtcOffsetLabel(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${h}:${m}`;
}

function getLocalTimeZoneInfo() {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const label = process.env.TZ || detected || '本机时区';
  return `${label} (${getUtcOffsetLabel()})`;
}

function formatLocalClockFromUtcMinutes(totalUtcMinutes) {
  const now = new Date();
  const baseMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0);
  const base = new Date(baseMs);
  const target = new Date(baseMs + totalUtcMinutes * 60 * 1000);
  const baseLocalDay = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
  const targetLocalDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const dayOffset = Math.round((targetLocalDay - baseLocalDay) / 86400000);
  const h = String(target.getHours()).padStart(2, '0');
  const m = String(target.getMinutes()).padStart(2, '0');
  return `${h}:${m}${formatDayOffset(dayOffset)}`;
}

function buildProfileSlotMessage() {
  const busyText = profileSequenceRunning
    ? '🟡 多账号串行中'
    : runningTask
      ? `🟡 ${escapeHtml(runningTask)} 运行中`
      : '🟢 空闲';

  if (!MULTI_PROFILE_MODE) {
    return `🧩 <b>多账号时段分块</b>\n\n` +
      `当前未启用多账号串行。\n\n` +
      `配置 <code>V2EX_PROFILE_LIST=acc1,acc2</code> 后，每个 profile 会按顺序执行：签到 → 阅读 → 下一个 profile。\n` +
      `最多支持 <b>${MAX_PROFILE_COUNT}</b> 个账户；每个账户默认窗口 <code>${formatHours(PROFILE_TIME_SLOT_HOURS)}</code> 小时，可用 <code>PROFILE_TIME_SLOT_HOURS</code> 调整。\n\n` +
      `状态：${busyText}`;
  }

  const slotMinutes = Math.max(60, Math.round(PROFILE_TIME_SLOT_HOURS * 60));
  const totalHours = formatHours((slotMinutes * PROFILE_LIST.length) / 60);
  const timeZoneLabel = getLocalTimeZoneInfo();
  const lines = PROFILE_LIST.map((profile, index) => {
    const start = PROFILE_SEQUENCE_START_UTC_MINUTES + index * slotMinutes;
    const end = start + slotMinutes;
    const cookieStatus = fs.existsSync(getProfileCookieFile(profile)) ? '✅ Cookie' : '⚠️ 缺 Cookie';
    return `${index + 1}. <code>${escapeHtml(profile)}</code> | 本机时间 ${formatLocalClockFromUtcMinutes(start)}-${formatLocalClockFromUtcMinutes(end)} | ${cookieStatus}`;
  });

  return `🧩 <b>多账号时段分块</b>\n\n` +
    `账户：<b>${PROFILE_LIST.length}/${MAX_PROFILE_COUNT}</b>\n` +
    `单账号窗口：<code>${formatHours(PROFILE_TIME_SLOT_HOURS)}</code> 小时\n` +
    `总串行窗口：约 <code>${totalHours}</code> 小时\n` +
    `本机时区：<code>${escapeHtml(timeZoneLabel)}</code>\n` +
    `状态：${busyText}\n\n` +
    `${lines.join('\n')}\n\n` +
    `流程：每个 profile 依次执行 <b>签到 → 阅读</b>，同一时间只启动一个子进程。`;
}

function getProfileSlotKeyboard() {
  const keyboard = [];
  if (MULTI_PROFILE_MODE) {
    keyboard.push([{ text: '▶️ 串行签到+阅读', callback_data: 'run_profile_sequence' }]);
  }
  keyboard.push([{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]);
  return { inline_keyboard: keyboard };
}

async function startProfileSequenceFromPanel(messageId) {
  if (!MULTI_PROFILE_MODE) {
    return editMsgText(messageId, buildProfileSlotMessage(), getProfileSlotKeyboard());
  }
  if (profileSequenceRunning || runningTask) {
    return editMsgText(messageId, buildProfileSlotMessage(), getProfileSlotKeyboard());
  }

  const text = `⏳ 已启动多账号串行任务。\n\n` +
    `本次将按时段依次执行 ${PROFILE_LIST.length} 个 profile：签到 → 阅读 → 下一个 profile。\n` +
    `单账号窗口约 ${formatHours(PROFILE_TIME_SLOT_HOURS)} 小时。`;
  await editMsgText(messageId, text, {
    inline_keyboard: [
      [{ text: '📦 查看任务状态', callback_data: 'query_tasks' }],
      [{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]
    ]
  });

  runProfileDailySequence()
    .then(result => {
      if (result && result.skipped) {
        return sendMsgWithKeyboard('ℹ️ 多账号串行任务未启动，当前配置或运行状态不满足条件。', getMainKeyboardMarkup());
      }
      return sendMsgWithKeyboard(`✅ 多账号串行任务已结束，共处理 ${PROFILE_LIST.length} 个 profile。`, getMainKeyboardMarkup());
    })
    .catch(err => {
      console.error(`[调度器] 面板启动多账号串行失败: ${err.message}`);
      sendMsgWithKeyboard(`❌ 多账号串行任务异常: ${escapeHtml(err.message)}`, getMainKeyboardMarkup()).catch(() => {});
    });
}

function startScheduler() {
  // 用 day-of-year 防止同一天重复执行
  let lastCheckinDOY = -1;
  let lastReadDOY = -1;
  let lastProfileRunDOY = -1;

  setInterval(() => {
    const now = new Date();
    const h = now.getUTCHours();
    const m = now.getUTCMinutes();
    // day-of-year 唯一标识每天
    const doy = Math.floor((now - new Date(now.getUTCFullYear(), 0, 0)) / 86400000);

    if (MULTI_PROFILE_MODE) {
      if (h === 1 && m === 10 && doy !== lastProfileRunDOY) {
        lastProfileRunDOY = doy;
        runProfileDailySequence().catch(e => console.error(`[调度器] 多账号串行失败: ${e.message}`));
      }

      if ([0, 6, 12, 18].includes(h) && m === 0) {
        runProfilePingSequence().catch(e => console.error(`[调度器] 多账号保活失败: ${e.message}`));
      }
      return;
    }

    // 每天 UTC 01:10 签到（当天只执行一次）
    if (h === 1 && m === 10 && doy !== lastCheckinDOY) {
      lastCheckinDOY = doy;
      runScript('签到', process.execPath, ['../checkin/v2ex-checkin.js'], __dirname);
    }

    // 每天 UTC 01:15 阅读（当天只执行一次）
    if (h === 1 && m === 15 && doy !== lastReadDOY) {
      lastReadDOY = doy;
      // Render 环境下直接 node，VPS Docker 里可以用 xvfb-run
      runScript('阅读', process.execPath, ['main.js'], __dirname);
    }

    // 每 6 小时保活（V2EX session 保活，非 Render 保活）
    if ([0, 6, 12, 18].includes(h) && m === 0) {
      runScript('保活', process.execPath, ['../checkin/v2ex-checkin.js', '--ping'], __dirname);
    }
  }, 60 * 1000); // 每分钟检查一次

  if (MULTI_PROFILE_MODE) {
    console.log(`[调度器] 内置定时任务已启动 (UTC 时钟，多账号串行: ${PROFILE_LIST.join(', ')})`);
  } else {
    console.log('[调度器] 内置定时任务已启动 (UTC 时钟)');
  }
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

async function handleMessage(msg) {
  const text = msg.text.trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts[1];
  
  if (cmd === '/start') {
    await handleStart();
  }
  else if (cmd === '/help') {
    await handleHelp();
  }
  else if (cmd === '/sou') {
    await handleSou();
  }
  else if (cmd === '/debug') {
    await handleDebug(arg);
  }
  else if (cmd === '/stop') {
    await handleStop();
  }
  else if (cmd === '/checkin') {
    await sendMsg('⏳ 正在启动手动签到...');
    runScript('手动签到', process.execPath, ['../checkin/v2ex-checkin.js'], __dirname);
  }
  else if (cmd === '/read') {
    await handleRead(arg);
  }
  else if (cmd === '/tasks') {
    await handleTasks();
  }
  else if (cmd === '/cookie') {
    const cookieText = text.slice(cmd.length).trim();
    if (!cookieText) {
      await handleCookieHelp();
    } else {
      const handled = await handleCookieImport(cookieText);
      if (!handled) {
        await sendMsg('❌ 未能从中识别出有效的 V2EX Cookie（如 A2 字段）。请确认格式。');
      }
    }
  }
  else if (cmd.startsWith('/')) {
    await sendMsgWithKeyboard('未识别命令。常用操作都在下方交互面板里，也可以发送 <code>/help</code> 查看文本命令。', getMainKeyboardMarkup());
  } else {
    // 非命令消息：尝试智能识别 Cookie
    const handled = await handleCookieImport(text);
    if (!handled) {
      console.log('[BOT] 未识别到有效 Cookie，忽略');
    }
  }
}

async function handleCallbackQuery(query) {
  const data = query.data;
  const messageId = query.message ? query.message.message_id : null;
  
  console.log(`[BOT] 收到 Callback: ${data}`);
  await tgRequest('answerCallbackQuery', { callback_query_id: query.id });
  
  try {
    if (data === 'run_checkin') {
      await editMsgText(messageId, '⏳ 正在启动手动签到...');
      runScript('手动签到', process.execPath, ['../checkin/v2ex-checkin.js'], __dirname);
    }
    else if (data === 'run_read_panel') {
      await handleRead(null, messageId);
    }
    else if (data.startsWith('trigger_read_')) {
      const count = data.replace('trigger_read_', '');
      await handleRead(count, messageId);
    }
    else if (data === 'query_balance') {
      await editMsgText(messageId, buildBalanceMessage(), {
        inline_keyboard: [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]]
      });
    }
    else if (data === 'show_profile_slots') {
      await editMsgText(messageId, buildProfileSlotMessage(), getProfileSlotKeyboard());
    }
    else if (data === 'run_profile_sequence') {
      await startProfileSequenceFromPanel(messageId);
    }
    else if (data === 'config_debug') {
      await handleDebug(null, messageId);
    }
    else if (data === 'show_cookie_help') {
      await handleCookieHelp(messageId);
    }
    else if (data === 'show_help') {
      const text = `ℹ️ <b>V2EX Max Helper 命令帮助说明</b>\n\n` +
                   `所有常用操作都已集成到主面板按钮；也可以继续使用文本命令：\n\n` +
                   `<code>/start</code> 打开主面板\n` +
                   `<code>/sou</code> 查询余额\n` +
                   `<code>/tasks</code> 查看任务状态\n` +
                   `<code>/checkin</code> 手动签到\n` +
                   `<code>/read [数量]</code> 手动阅读\n` +
                   `面板「时段分块」查看/启动多账号串行\n` +
                   `<code>/debug [级别]</code> 日志级别\n` +
                   `<code>/stop</code> 停止任务\n` +
                   `<code>/cookie [内容]</code> 导入 Cookie`;
      await editMsgText(messageId, text, {
        inline_keyboard: [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]]
      });
    }
    else if (data.startsWith('set_debug_')) {
      const level = data.replace('set_debug_', '');
      await handleDebug(level, messageId);
    }
    else if (data === 'query_tasks') {
      let statusText = '';
      let keyboard = [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]];
      if (!fs.existsSync(LOCK_FILE)) {
        if (runningTask || profileSequenceRunning) {
          const detail = runningTask || '多账号串行队列';
          statusText = `ℹ️ <b>当前任务状态</b>: 🟡 <b>正在运行中</b>\n- 当前任务: <code>${escapeHtml(detail)}</code>`;
        } else {
          statusText = 'ℹ️ <b>当前任务状态</b>: 🟢 <b>空闲</b> (无后台任务在运行)';
        }
      } else {
        const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
        if (pid && isProcessAlive(pid)) {
          statusText = `ℹ️ <b>当前任务状态</b>: 🟡 <b>正在运行中</b>\n- 运行进程 PID: <code>${pid}</code>`;
          keyboard = [
            [{ text: '🛑 停止任务', callback_data: 'stop_task' }],
            [{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]
          ];
        } else {
          try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
          statusText = 'ℹ️ <b>当前任务状态</b>: 🟢 <b>空闲</b> (已清理残留锁文件)';
        }
      }
      await editMsgText(messageId, statusText, { inline_keyboard: keyboard });
    }
    else if (data === 'stop_task') {
      if (!fs.existsSync(LOCK_FILE)) {
        await editMsgText(messageId, 'ℹ️ 阅读脚本未在运行。', {
          inline_keyboard: [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]]
        });
        return;
      }
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (pid && !isNaN(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
          await editMsgText(messageId, `🛑 已发送停止信号给 PID ${pid}。`, {
            inline_keyboard: [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]]
          });
        } catch (e) {
          if (e.code === 'ESRCH') {
            try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
            await editMsgText(messageId, 'ℹ️ 进程已结束，锁文件已清理。', {
              inline_keyboard: [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]]
            });
          } else {
            await editMsgText(messageId, `❌ 停止失败: ${e.message}`, {
              inline_keyboard: [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]]
            });
          }
        }
      }
    }
    else if (data === 'go_to_start') {
      const text = `🤖 <b>V2EX Max Helper 遥控中心</b>\n\n常用操作都在这里。你也可以直接粘贴 Cookie 文本，Bot 会自动识别并导入。`;
      await editMsgText(messageId, text, getMainKeyboardMarkup());
    }
  } catch (e) {
    console.error(`[BOT] Callback 处理出错: ${e.message}`);
  }
}

async function handleUnboundMessage(msg) {
  if (!msg.chat || msg.chat.type !== 'private') {
    console.log(`[BOT] 未绑定状态下忽略非私聊消息, 来源 chat_id: ${maskId(msg.chat && msg.chat.id)}`);
    return;
  }

  const text = (msg.text || '').trim();
  if (!SETUP_CODE) {
    await sendDirectMsg(
      msg.chat.id,
      '🔐 <b>Bot 尚未绑定授权用户</b>\n\n为避免被陌生人抢先绑定，已禁用无口令首次绑定。\n请先在环境变量或 <code>~/.v2ex_env</code> 中配置 <code>TG_CHAT_ID</code>，或设置 <code>TG_SETUP_CODE</code> 后重启 Bot，再发送 <code>/bind 你的绑定口令</code>。'
    );
    console.log(`[BOT] 拒绝无口令首次绑定尝试, 来源 chat_id: ${maskId(msg.chat.id)}`);
    return;
  }

  const bindMatch = text.match(/^\/bind\s+(.+)$/);
  if (!bindMatch || bindMatch[1].trim() !== SETUP_CODE) {
    await sendDirectMsg(
      msg.chat.id,
      '🔐 <b>Bot 尚未绑定授权用户</b>\n\n请发送 <code>/bind 你的绑定口令</code> 完成绑定。'
    );
    return;
  }

  try {
    saveAuthorizedChatId(msg.chat.id);
    console.log(`[BOT] 已绑定授权 Chat ID: ${maskId(ALLOWED_CHAT_ID)}`);
    await sendDirectMsg(
      ALLOWED_CHAT_ID,
      '✅ <b>授权绑定成功</b>\n\n你的 Telegram Chat ID 只保存在运行时数据目录，不会写入仓库或日志明文。'
    );
    await handleStart();
  } catch (e) {
    console.error(`[BOT] 绑定授权用户失败: ${e.message}`);
    await sendDirectMsg(msg.chat.id, `❌ 绑定失败: ${e.message}`);
  }
}

async function poll() {
  try {
    const res = await tgRequest('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });

    if (res.conflict) {
      await sleep(pollRetryDelay);
      pollRetryDelay = Math.min(pollRetryDelay * 2, 10000);
      return;
    }

    pollRetryDelay = 1000;

    if (!res.ok || !res.result) return;

    for (const update of res.result) {
      offset = update.update_id + 1;
      
      if (update.message) {
        const msg = update.message;
        if (!msg.text) continue;
        if (!ALLOWED_CHAT_ID) {
          await handleUnboundMessage(msg);
          continue;
        }
        if (String(msg.chat.id) !== ALLOWED_CHAT_ID) {
          console.log(`[BOT] 忽略非授权消息, 来源 chat_id: ${maskId(msg.chat.id)}`);
          continue;
        }
        await handleMessage(msg);
      }
      
      if (update.callback_query) {
        const query = update.callback_query;
        if (!ALLOWED_CHAT_ID) {
          console.log('[BOT] 未绑定状态下忽略 CallbackQuery');
          continue;
        }
        if (String(query.from.id) !== ALLOWED_CHAT_ID) {
          console.log(`[BOT] 忽略非授权 CallbackQuery, 来源 user_id: ${maskId(query.from.id)}`);
          continue;
        }
        await handleCallbackQuery(query);
      }
    }
  } catch (e) {
    if (e.message !== 'timeout') {
      console.error(`[BOT] 轮询出错: ${e.message}，${pollRetryDelay / 1000}秒后重试`);
      await sleep(pollRetryDelay);
      pollRetryDelay = Math.min(pollRetryDelay * 2, 30000);
    }
  }
}

// ========== 主启动逻辑（含重启恢复）==========
if (ALLOWED_CHAT_ID) {
  console.log(`[BOT] V2EX Bot 启动，授权 Chat ID: ${maskId(ALLOWED_CHAT_ID)}`);
} else {
  console.log('[BOT] V2EX Bot 启动，尚未绑定授权 Chat ID');
}

(async () => {
  // 确保 DATA_DIR 存在
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.appendFileSync(READER_LOG, `[${new Date().toISOString()}] [BOT] Bot started\n`);
  } catch (e) {
    console.error(`[BOT] 初始化 DATA_DIR / READER_LOG 失败: ${e.message}`);
  }

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
      config.writeFileAtomic(COOKIE_FILE, process.env.V2EX_COOKIE.trim(), { mode: 0o600 });
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
  startupMsg += '\n\n💡 发送 /start 打开交互遥控中心；常用操作已集成到按钮面板。';

  if (ALLOWED_CHAT_ID) {
    await sendMsgWithKeyboard(startupMsg, getMainKeyboardMarkup());
  } else if (SETUP_CODE) {
    console.log('[BOT] 未配置 TG_CHAT_ID；请在 Telegram 私聊 Bot 发送 /bind <TG_SETUP_CODE>');
  } else {
    console.log('[BOT] 未配置 TG_CHAT_ID / TG_SETUP_CODE；为安全起见不会自动绑定任何用户');
  }

  // 启动内置调度器
  startScheduler();

  // 启动自保活
  startKeepAlive();

  // 主轮询循环（永不退出）
  while (true) {
    await poll();
  }
})();
