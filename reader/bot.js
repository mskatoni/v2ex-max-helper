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
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');
const config = require('../lib/config');
const fingerprint = require('./fingerprint');
const profileAuth = require('../lib/profile-auth');
const profileLock = require('../lib/profile-lock');
const profileSchedule = require('../lib/profile-schedule');

// ========== 配置 ==========
const cfg            = config.getConfig();
const TOKEN          = cfg.telegram.token;
const SETUP_CODE     = cfg.telegram.setupCode;
const DATA_DIR       = cfg.readerDataDir;
const LOCK_FILE       = cfg.readerLockFile;
const READER_LOG      = cfg.readerLog;
const AUTH_CHAT_FILE  = cfg.authChatFile;
const INTERNAL_SCHEDULER_DISABLED = config.boolEnv('V2EX_DISABLE_INTERNAL_SCHEDULER');
const MAX_PROFILE_COUNT = config.MAX_PROFILE_COUNT;
const PROFILE_LIST = config.parseProfileList();
const MULTI_PROFILE_MODE = PROFILE_LIST.length > 0;
const CONTROL_PROFILES = MULTI_PROFILE_MODE ? PROFILE_LIST : [cfg.profile];
const PROFILE_SELECTION_REQUIRED = CONTROL_PROFILES.length > 1;

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

// 当前进程的 Cookie 路径；多账号子任务通过 getProfileConfig() 解析独立路径。
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
  return profileLock.isProcessAlive(pid);
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

function getProfileConfig(profile) {
  if (!MULTI_PROFILE_MODE && profile === cfg.profile) return cfg;
  return config.getProfileConfig(profile);
}

function getProfileIndex(profile) {
  return CONTROL_PROFILES.indexOf(profile);
}

function getOnlyProfile() {
  return CONTROL_PROFILES[0];
}

function profileTitle(profile) {
  return profile === 'default' ? 'default' : profile;
}

function hasUsableCookie(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch (_) {
    return false;
  }
}

const INTERACTION_TTL_MS = 10 * 60 * 1000;
const interactionSessions = new Map();

function createInteractionSession(action, extraValue = null, messageId = null, profiles = CONTROL_PROFILES) {
  const id = crypto.randomBytes(9).toString('base64url');
  const session = {
    action,
    extraValue,
    messageId,
    profiles: profiles.slice(),
    expiresAt: Date.now() + INTERACTION_TTL_MS,
  };
  interactionSessions.set(id, session);
  setTimeout(() => {
    if (interactionSessions.get(id) === session) interactionSessions.delete(id);
  }, INTERACTION_TTL_MS).unref();
  return id;
}

function getInteractionSession(id, messageId = null) {
  const session = interactionSessions.get(id);
  if (!session) return null;
  if (session.expiresAt <= Date.now() || (session.messageId && messageId && session.messageId !== messageId)) {
    interactionSessions.delete(id);
    return null;
  }
  return session;
}

function clearInteractionSessions() {
  interactionSessions.clear();
}

function getProfilePickerMarkup(action, extraValue = null, messageId = null) {
  const sessionId = createInteractionSession(action, extraValue, messageId);
  const rows = CONTROL_PROFILES.map((profile, index) => {
    const hasCookie = hasUsableCookie(getProfileConfig(profile).cookieFile);
    return [{
      text: `${hasCookie ? '✅' : '⚠️'} ${profile}`,
      callback_data: `ps:${sessionId}:${index}`,
    }];
  });
  rows.push([{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]);
  return { inline_keyboard: rows };
}

function showProfilePicker(action, prompt, messageId = null, extraValue = null) {
  const text = `👥 <b>${escapeHtml(prompt)}</b>\n\n请选择 profile：`;
  const markup = getProfilePickerMarkup(action, extraValue, messageId);
  return messageId
    ? editMsgText(messageId, text, markup)
    : sendMsgWithKeyboard(text, markup);
}

function sendOrEdit(messageId, text, replyMarkup = null) {
  if (messageId) return editMsgText(messageId, text, replyMarkup || undefined);
  return replyMarkup ? sendMsgWithKeyboard(text, replyMarkup) : sendMsg(text);
}

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
  clearPendingCookieImport();
  clearInteractionSessions();
  const text = `🤖 <b>V2EX Max Helper 遥控中心</b>\n\n欢迎回来！你可以直接使用下方按钮完成常用操作；也可以直接粘贴 Cookie 文本，Bot 会自动识别并导入。`;
  return sendMsgWithKeyboard(text, getMainKeyboardMarkup());
}

async function handleHelp() {
  const text = `ℹ️ <b>V2EX Max Helper 命令帮助说明</b>\n\n` +
               `🤖 <b>主控制面板</b>: \n` +
               `- <code>/start</code>: 打开主交互遥控面板\n` +
               `- <code>/help</code>: 显示当前命令说明\n\n` +
               `💰 <b>数据与状态</b>: \n` +
               `- <code>/sou [profile]</code>: 查询今日与昨日的 V2EX 余额记录\n` +
               `- <code>/tasks</code>: 实时查询后台签到 / 阅读的运行状态\n\n` +
               `⚙️ <b>脚本控制</b>: \n` +
               `- <code>/checkin [profile]</code>: 立刻开跑手动签到测试\n` +
               `- <code>/read [数量]</code> 或 <code>/read profile [数量]</code>: 触发手动阅读测试（默认 5 篇）\n` +
               `- 面板「时段分块」: 查看多账号窗口，并手动启动串行签到 + 阅读\n` +
               `- <code>/stop [profile]</code>: 打断当前任务；串行运行时取消后续账号\n\n` +
               `🔧 <b>日志与设置</b>: \n` +
               `- <code>/debug [级别]</code>: 查看/修改日志级别（OFF / ERROR / WARN / INFO）\n` +
               `- <code>/cookie [profile] [内容]</code>: 手动识别并导入新的 V2EX Cookie\n\n` +
               `💡 <b>小提示</b>：你也可以直接粘贴完整 Cookie；验证通过后才会原子替换目标 profile。`;
  return sendMsgWithKeyboard(text, getMainKeyboardMarkup());
}

async function handleCookieHelp(messageId = null, profile = null) {
  if (!profile && PROFILE_SELECTION_REQUIRED) {
    return showProfilePicker('k', '导入 Cookie', messageId);
  }
  return beginCookieImport(profile || getOnlyProfile(), messageId);
}

async function handleTasks() {
  const lock = getActiveReaderLock();
  if (!runningTask && !profileSequenceRunning && !lock) {
    return sendMsg('ℹ️ <b>当前任务状态</b>: 🟢 <b>空闲</b> (无后台任务在运行)');
  }
  const taskName = runningTaskName() || (profileSequenceRunning ? '多账号串行队列' : '外部阅读任务');
  const profile = (runningTask && runningTask.profile) || (lock && lock.profile);
  const pid = (runningTask && runningTask.child && runningTask.child.pid) || (lock && lock.pid);
  return sendMsg(
    `ℹ️ <b>当前任务状态</b>: 🟡 <b>正在运行中</b>\n` +
    `- 当前任务: <code>${escapeHtml(taskName)}</code>` +
    `${profile ? `\n- Profile: <code>${escapeHtml(profile)}</code>` : ''}` +
    `${pid ? `\n- PID: <code>${pid}</code>` : ''}` +
    `\n- 使用 <code>/stop${profile ? ` ${escapeHtml(profile)}` : ''}</code> 可停止当前任务。`
  );
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

function localDateKey(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatBalanceStatus(status) {
  if (!status) return '';
  const ok = status.ok ? '成功' : '失败';
  const time = status.time ? new Date(status.time).toLocaleString('zh-CN', { hour12: false }) : '--';
  const detail = status.message || status.code || '未知状态';
  const http = status.statusCode ? ` / HTTP ${status.statusCode}` : '';
  return `\n\n最近一次余额检查：<b>${ok}</b>${http}\n时间：<code>${escapeHtml(time)}</code>\n状态：${escapeHtml(detail)}`;
}

function buildBalanceMessage(profile = getOnlyProfile()) {
  const profileCfg = getProfileConfig(profile);
  const status = readJsonFile(profileCfg.balanceStatus);
  const log = readJsonFile(profileCfg.balanceLog);
  const days = log ? Object.keys(log).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)) : [];
  const profileSuffix = profile === 'default' && !MULTI_PROFILE_MODE
    ? ''
    : ` · ${escapeHtml(profileTitle(profile))}`;

  if (!log || days.length === 0) {
    return `⚠️ <b>余额记录${profileSuffix}</b>\n\n尚无余额记录，脚本至少需成功读取一次余额后才有数据` + formatBalanceStatus(status);
  }

  const now = new Date();
  const previousDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const today = localDateKey(now);
  const yesterday = localDateKey(previousDay);

  const todayEntry = log[today] || null;
  const yesterdayEntry = log[yesterday] || null;

  const todayTime = todayEntry
    ? new Date(todayEntry.lastTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : '--';

  let msg = `💰 <b>余额记录${profileSuffix}</b>\n`;
  msg += todayEntry
    ? `今日 (${today})：${formatCoins(todayEntry, true)}  最后查询 ${todayTime}（本机时间）\n`
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
async function handleSou(profile = getOnlyProfile()) {
  return sendMsg(buildBalanceMessage(profile));
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

function parseReadLimit(value) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) return null;
  const limit = Number(text);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
}

function getReadCountPickerMarkup(profile, messageId = null) {
  const profileIndex = getProfileIndex(profile);
  const sessionId = createInteractionSession('r', null, messageId);
  return {
    inline_keyboard: [
      [
        { text: '5 篇', callback_data: `ps:${sessionId}:${profileIndex}:5` },
        { text: '10 篇', callback_data: `ps:${sessionId}:${profileIndex}:10` },
      ],
      [
        { text: '50 篇', callback_data: `ps:${sessionId}:${profileIndex}:50` },
        { text: '250 篇', callback_data: `ps:${sessionId}:${profileIndex}:250` },
      ],
      [{ text: '◀️ 返回面板', callback_data: 'go_to_start' }],
    ],
  };
}

function showReadCountPicker(profile, messageId = null) {
  const text = `📖 <b>手动阅读控制面板</b>\n\nProfile：<code>${escapeHtml(profileTitle(profile))}</code>\n请选择本次阅读的文章篇数：`;
  return sendOrEdit(messageId, text, getReadCountPickerMarkup(profile, messageId));
}

function hasActiveReaderLock() {
  if (!fs.existsSync(LOCK_FILE)) return false;
  const lock = profileLock.readLock(LOCK_FILE);
  if (lock && isProcessAlive(lock.pid)) return true;
  try { profileLock.clearStaleLock(LOCK_FILE); } catch (_) {}
  return fs.existsSync(LOCK_FILE);
}

function getActiveReaderLock() {
  const lock = profileLock.readLock(LOCK_FILE);
  if (lock && isProcessAlive(lock.pid)) return lock;
  try { profileLock.clearStaleLock(LOCK_FILE); } catch (_) {}
  return null;
}

function getTaskStartError(profile, readerTask = false) {
  if (!CONTROL_PROFILES.includes(profile)) return `未知 profile: ${profile}`;
  if (profileSequenceRunning) return '多账号串行任务正在运行';
  if (runningTask) return `任务 ${runningTaskName()} 正在运行`;
  if (readerTask && hasActiveReaderLock()) return '已有阅读进程正在运行';
  const profileCfg = getProfileConfig(profile);
  if (!hasUsableCookie(profileCfg.cookieFile)) {
    return `Profile ${profile} 缺少 Cookie，请先导入`;
  }
  return '';
}

function reportManualTaskResult(profile, taskLabel, result) {
  if (!result) return;
  let detail = '';
  if (result.skipped) {
    const reasons = {
      busy: '已有任务正在运行',
      profile_sequence: '多账号串行任务正在运行',
      missing_cookie: 'Cookie 文件不存在或为空',
    };
    detail = reasons[result.reason] || '启动条件不满足';
  } else if (result.error) {
    detail = '进程启动失败';
  } else if (result.status === 'timed_out') {
    detail = '任务运行超时并已结束';
  } else if (Number.isInteger(result.code) && result.code !== 0) {
    detail = `进程以 code ${result.code} 退出`;
  }
  if (!detail) return;
  sendMsg(`❌ Profile <code>${escapeHtml(profile)}</code> ${taskLabel}未完成：${escapeHtml(detail)}`).catch(() => {});
}

async function startProfileCheckin(profile, messageId = null) {
  const blocked = getTaskStartError(profile);
  if (blocked) {
    return sendOrEdit(messageId, `⚠️ ${escapeHtml(blocked)}`, getMainKeyboardMarkup());
  }

  const profileCfg = getProfileConfig(profile);
  const name = `手动签到(${profile})`;
  const task = runScript(name, process.execPath, ['../checkin/v2ex-checkin.js'], __dirname, {
    env: childEnvForProfile(profile),
    cookieFile: profileCfg.cookieFile,
    timeoutMs: 15 * 60 * 1000,
    profile,
    type: 'checkin',
  });
  await sendOrEdit(messageId, `⏳ 正在为 <code>${escapeHtml(profileTitle(profile))}</code> 启动手动签到...`);
  task.then(result => reportManualTaskResult(profile, '签到', result));
}

async function startProfileRead(profile, limit, messageId = null) {
  const blocked = getTaskStartError(profile, true);
  if (blocked) {
    return sendOrEdit(messageId, `⚠️ ${escapeHtml(blocked)}`, getMainKeyboardMarkup());
  }

  const profileCfg = getProfileConfig(profile);
  const name = `手动阅读(${profile})`;
  const task = runScript(name, process.execPath, ['main.js', '--limit', String(limit)], __dirname, {
    env: childEnvForProfile(profile),
    cookieFile: profileCfg.cookieFile,
    profile,
    type: 'reader',
  });
  await sendOrEdit(
    messageId,
    `⏳ 正在为 <code>${escapeHtml(profileTitle(profile))}</code> 启动手动阅读（限制 ${limit} 篇）...`
  );
  task.then(result => reportManualTaskResult(profile, '阅读', result));
}

async function handleRead(profile, limitArg = null, messageId = null) {
  if (limitArg !== null && limitArg !== undefined && String(limitArg).trim() !== '') {
    const limit = parseReadLimit(limitArg);
    if (!limit) {
      return sendOrEdit(messageId, '❌ 阅读数量必须是大于 0 的整数', getMainKeyboardMarkup());
    }
    return startProfileRead(profile, limit, messageId);
  }
  return showReadCountPicker(profile, messageId);
}

// /stop [profile] — 停止当前子任务，并取消尚未运行的串行账号。
async function handleStop(profile = null) {
  if (profile && !CONTROL_PROFILES.includes(profile)) return sendUnknownProfile(profile);

  if (runningTask && runningTask.child) {
    if (profile && runningTask.profile && runningTask.profile !== profile) {
      return sendMsg(`⚠️ 当前运行的是 <code>${escapeHtml(runningTask.profile)}</code>，未停止其他账号任务`);
    }
    if (profileSequenceRunning) sequenceCancelRequested = true;
    try {
      runningTask.child.kill('SIGTERM');
      return sendMsg(
        `🛑 已停止 <code>${escapeHtml(runningTaskName())}</code>` +
        `${profileSequenceRunning ? '，并取消后续串行账号' : ''}`
      );
    } catch (e) {
      return sendMsg(`停止失败: ${escapeHtml(e.message)}`);
    }
  }

  const lock = getActiveReaderLock();
  if (profile && lock && lock.profile && lock.profile !== profile) {
    return sendMsg(`⚠️ 当前阅读账号是 <code>${escapeHtml(lock.profile)}</code>，未停止 <code>${escapeHtml(profile)}</code>`);
  }
  if (profileSequenceRunning) sequenceCancelRequested = true;
  if (!lock) {
    return sendMsg(profileSequenceRunning
      ? '🛑 已取消多账号串行队列，当前没有活动子进程'
      : 'ℹ️ 阅读脚本未在运行');
  }
  try {
    process.kill(lock.pid, 'SIGTERM');
    await sendMsg(`🛑 已停止阅读任务${lock.profile ? `（<code>${escapeHtml(lock.profile)}</code>）` : ''}`);
  } catch (e) {
    if (e.code === 'ESRCH') {
      try { profileLock.clearStaleLock(LOCK_FILE); } catch (_) {}
      return sendMsg('ℹ️ 进程已不存在，锁文件已清理');
    }
    return sendMsg(`停止失败: ${e.message}`);
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ========== Cookie 智能识别导入 ==========

const COOKIE_IMPORT_TTL_MS = 5 * 60 * 1000;
const pendingCookieImports = new Map();
let activeCookieInputId = null;

function extractCookie(text) {
  try { return profileAuth.parseCookieInput(text); } catch (_) { return null; }
}

async function deleteCookieSourceMessage(message) {
  const chatId = message && message.chat && message.chat.id;
  const messageId = message && message.message_id;
  if (!chatId || !Number.isInteger(messageId)) return;

  try {
    const result = await tgRequest('deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    });
    if (result && result.ok) return;
  } catch (_) {}

  console.warn('[BOT] Cookie 来源消息自动删除失败，未记录消息内容');
  try {
    await sendMsg('⚠️ 已识别 Cookie，但未能自动删除原消息，请立即在 Telegram 中手动删除。');
  } catch (_) {}
}

function setPendingCookieImport(state) {
  const id = crypto.randomBytes(12).toString('base64url');
  const pending = { id, ...state, expiresAt: Date.now() + COOKIE_IMPORT_TTL_MS };
  pendingCookieImports.set(id, pending);
  setTimeout(() => {
    const current = pendingCookieImports.get(id);
    if (current && current.expiresAt <= Date.now()) pendingCookieImports.delete(id);
    if (!pendingCookieImports.has(id) && activeCookieInputId === id) activeCookieInputId = null;
  }, COOKIE_IMPORT_TTL_MS).unref();
  return pending;
}

function getPendingCookieImport(id = activeCookieInputId) {
  const pending = id ? pendingCookieImports.get(id) : null;
  if (!pending) return null;
  if (pending.expiresAt <= Date.now()) {
    pendingCookieImports.delete(id);
    if (activeCookieInputId === id) activeCookieInputId = null;
    return null;
  }
  return pending;
}

function clearPendingCookieImport(id = null) {
  if (id) pendingCookieImports.delete(id);
  else pendingCookieImports.clear();
  if (!id || activeCookieInputId === id) activeCookieInputId = null;
}

async function beginCookieImport(profile, messageId = null) {
  if (!CONTROL_PROFILES.includes(profile)) {
    return sendOrEdit(messageId, '❌ 未知或已失效的 profile', getMainKeyboardMarkup());
  }
  const pending = setPendingCookieImport({ profile, candidate: null, state: 'awaiting_cookie' });
  activeCookieInputId = pending.id;
  const text = `🍪 <b>导入 Cookie</b>\n\nProfile：<code>${escapeHtml(profileTitle(profile))}</code>\n请在 5 分钟内粘贴完整 V2EX Cookie。候选凭证会先验证，成功后才原子替换，不会与旧账号字段混合。\n\n也可以使用：<code>/cookie ${escapeHtml(profile)} 你的Cookie内容</code>`;
  return sendOrEdit(messageId, text, {
    inline_keyboard: [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]],
  });
}

function readOptionalFile(file) {
  try { return fs.existsSync(file) ? fs.readFileSync(file) : null; } catch (_) { return null; }
}

function restoreOptionalFile(file, content) {
  if (content === null) {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
  } else {
    config.writeFileAtomic(file, content, { mode: 0o600 });
  }
}

function stageChromeProfileReset(profileCfg) {
  const target = path.resolve(profileCfg.chromeProfileDir);
  const root = path.resolve(path.join(profileCfg.readerDataDir, 'chrome-profile'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('拒绝操作不安全的 Chromium profile 路径');
  }
  if (!fs.existsSync(target)) return null;
  const backup = `${target}.rebind.${process.pid}.${Date.now()}`;
  fs.renameSync(target, backup);
  return { target, backup };
}

function commitProfileCredentials(profileCfg, candidate, verification, replaceIdentity) {
  const oldCookie = readOptionalFile(profileCfg.cookieFile);
  const oldIdentity = readOptionalFile(profileCfg.identityFile);
  let chromeBackup = null;
  try {
    if (replaceIdentity || verification.identityState === 'unbound') {
      chromeBackup = stageChromeProfileReset(profileCfg);
    }
    config.writeFileAtomic(profileCfg.cookieFile, candidate, { mode: 0o600 });
    const record = profileAuth.createIdentityRecord(
      verification.identity,
      replaceIdentity ? null : verification.current
    );
    profileAuth.writeIdentity(profileCfg.identityFile, record);
    if (chromeBackup) fs.rmSync(chromeBackup.backup, { recursive: true, force: false });
  } catch (e) {
    try { restoreOptionalFile(profileCfg.cookieFile, oldCookie); } catch (_) {}
    try { restoreOptionalFile(profileCfg.identityFile, oldIdentity); } catch (_) {}
    if (chromeBackup && fs.existsSync(chromeBackup.backup) && !fs.existsSync(chromeBackup.target)) {
      try { fs.renameSync(chromeBackup.backup, chromeBackup.target); } catch (_) {}
    }
    throw e;
  }
}

function maskAccount(identity) {
  const value = String(identity || '');
  if (value.length <= 2) return '**';
  return `${value.slice(0, 1)}***${value.slice(-1)}`;
}

async function importCookieResult(candidateMap, profile, pendingId = null, forceReplace = false) {
  if (!CONTROL_PROFILES.includes(profile)) {
    if (pendingId) clearPendingCookieImport(pendingId);
    await sendMsg('❌ 未知或已失效的 profile');
    return true;
  }
  const profileCfg = getProfileConfig(profile);
  const candidate = profileAuth.serializeCookieMap(candidateMap);
  let lockHandle;
  try {
    lockHandle = profileLock.acquireLock(profileCfg.credentialLockFile, { profile, task: 'cookie-import' });
  } catch (e) {
    if (pendingId) clearPendingCookieImport(pendingId);
    const owner = e.lock && e.lock.task ? `${e.lock.task}${e.lock.profile ? `(${e.lock.profile})` : ''}` : '其他任务';
    await sendMsg(`⚠️ Profile <code>${escapeHtml(profile)}</code> 正被 ${escapeHtml(owner)} 使用，暂不能导入 Cookie`);
    return true;
  }

  try {
    const fp = fingerprint.generate(profile);
    const verification = await profileAuth.verifyAndCompare(profileCfg, candidate, {
      userAgent: fp.userAgent,
      acceptLanguage: fp.acceptLanguage,
    });
    if (!verification.ok) {
      if (pendingId) clearPendingCookieImport(pendingId);
      await sendMsg(`❌ Profile <code>${escapeHtml(profile)}</code> Cookie 未写入：${escapeHtml(verification.message)}`);
      return true;
    }

    if (verification.identityState === 'different' && !forceReplace) {
      const pending = pendingId ? getPendingCookieImport(pendingId) : null;
      const state = pending || setPendingCookieImport({ profile, candidate: candidateMap, state: 'replace_confirmation' });
      state.profile = profile;
      state.candidate = candidateMap;
      state.state = 'replace_confirmation';
      pendingCookieImports.set(state.id, state);
      await sendMsgWithKeyboard(
        `⚠️ <b>检测到账号换绑</b>\n\nProfile：<code>${escapeHtml(profile)}</code>\n新账号：<code>${escapeHtml(maskAccount(verification.identity))}</code>\n\n确认后会替换整套 Cookie，并清空该 profile 的旧 Chromium 登录状态。`,
        { inline_keyboard: [[
          { text: '确认换绑', callback_data: `ci:${state.id}:replace` },
          { text: '取消', callback_data: `ci:${state.id}:cancel` },
        ]] }
      );
      return true;
    }

    commitProfileCredentials(profileCfg, candidate, verification, verification.identityState === 'different');
    if (pendingId) clearPendingCookieImport(pendingId);
    const fields = Array.from(candidateMap.keys()).filter(key => V2EX_COOKIE_KEYS.includes(key));
    await sendMsg(
      `✅ <b>Cookie 已验证并原子更新</b>\n\n` +
      `Profile：<code>${escapeHtml(profile)}</code>\n` +
      `账号：<code>${escapeHtml(maskAccount(verification.identity))}</code>\n` +
      `字段：<code>${escapeHtml(fields.join(', ') || 'A2')}</code>`
    );
    return true;
  } catch (e) {
    if (pendingId) clearPendingCookieImport(pendingId);
    await sendMsg(`❌ Profile <code>${escapeHtml(profile)}</code> Cookie 导入失败：${escapeHtml(e.message)}`);
    return true;
  } finally {
    try { lockHandle.release(); } catch (_) {}
  }
}

async function applyPendingCookie(profile, messageId, pendingId) {
  const pending = getPendingCookieImport(pendingId);
  if (!pending || !pending.candidate) {
    return sendOrEdit(messageId, '⚠️ Cookie 选择已过期，请重新粘贴 Cookie', getMainKeyboardMarkup());
  }
  await sendOrEdit(messageId, `⏳ 正在把 Cookie 保存到 <code>${escapeHtml(profile)}</code>...`);
  return importCookieResult(pending.candidate, profile, pending.id);
}

async function handleCookieImport(text, profile = null, sourceMessage = null) {
  const candidate = extractCookie(text);
  if (!candidate) return false;
  if (sourceMessage) await deleteCookieSourceMessage(sourceMessage);

  if (profile) return importCookieResult(candidate, profile);

  const pending = getPendingCookieImport(activeCookieInputId);
  if (pending && pending.profile) {
    activeCookieInputId = null;
    pending.candidate = candidate;
    pending.state = 'verifying';
    return importCookieResult(candidate, pending.profile, pending.id);
  }

  if (PROFILE_SELECTION_REQUIRED) {
    const staged = setPendingCookieImport({ profile: null, candidate, state: 'choose_profile' });
    await showProfilePicker('kp', 'Cookie 已识别，请选择保存账号', null, staged.id);
    return true;
  }

  return importCookieResult(candidate, getOnlyProfile());
}

// ========== 内置调度器（替代 Docker cron，Render 友好）==========

let runningTask = null; // { name, profile, type, child, startedAt }
let profileSequenceRunning = false;
let sequenceCancelRequested = false;

function runningTaskName() {
  return runningTask ? runningTask.name : '';
}

const PROFILE_TIME_SLOT_HOURS = profileSchedule.validateSlotHours(
  parseFloat(process.env.PROFILE_TIME_SLOT_HOURS || '4'),
  PROFILE_LIST.length
);
const PROFILE_TIME_SLOT_MS = Math.round(PROFILE_TIME_SLOT_HOURS * 60 * 60 * 1000);
const PROFILE_SEQUENCE_START_LOCAL_MINUTES = 9 * 60 + 10;

function getProfileCookieFile(profile) {
  return getProfileConfig(profile).cookieFile;
}

function childEnvForProfile(profile, extra = {}) {
  const env = { ...process.env, ...extra, V2EX_PROFILE: profile };
  if (MULTI_PROFILE_MODE) {
    delete env.COOKIE_FILE;
    delete env.DB_PATH;
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
    console.log(`[调度器] 跳过 ${name}，上一个任务 ${runningTaskName()} 还在运行`);
    return Promise.resolve({ skipped: true, reason: 'busy' });
  }
  if (profileSequenceRunning && !options.partOfProfileSequence) {
    console.log(`[调度器] 跳过 ${name}，多账号串行任务正在运行`);
    return Promise.resolve({ skipped: true, reason: 'profile_sequence' });
  }

  // 检查 Cookie 文件是否存在（无 cookie 时跳过，不崩溃）
  const cookieFile = options.cookieFile || COOKIE_FILE;
  if (options.requireCookie !== false && !hasUsableCookie(cookieFile)) {
    console.log(`[调度器] 跳过 ${name}，Cookie 文件不存在: ${cookieFile}`);
    return Promise.resolve({ skipped: true, reason: 'missing_cookie' });
  }

  console.log(`[调度器] 启动 ${name}`);
  const task = {
    name,
    profile: options.profile || null,
    type: options.type || 'task',
    child: null,
    startedAt: new Date().toISOString(),
  };
  runningTask = task;

  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env: options.env || { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    task.child = child;
  } catch (e) {
    if (runningTask === task) runningTask = null;
    return Promise.resolve({ error: e, status: 'spawn_failed' });
  }

  pipeTaskOutput(child, name);

  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;
    let forceKillTimeout = null;
    let timedOut = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      if (runningTask === task) runningTask = null;
      resolve(result);
    }

    if (options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        console.warn(`[调度器] ${name} 超过 ${Math.round(options.timeoutMs / 60000)} 分钟，发送 SIGTERM`);
        try { child.kill('SIGTERM'); } catch (_) {}
        forceKillTimeout = setTimeout(() => {
          console.warn(`[调度器] ${name} 在 SIGTERM 后 30 秒仍未退出，强制结束`);
          try { child.kill('SIGKILL'); } catch (_) {}
        }, 30000);
      }, options.timeoutMs);
    }

    child.on('close', (code, signal) => {
      console.log(`[调度器] ${name} 退出 (code ${code}, signal ${signal || 'none'})`);
      finish({
        code,
        signal: signal || null,
        status: timedOut ? 'timed_out' : (code === 0 ? 'ok' : 'failed'),
      });
    });

    child.on('error', (err) => {
      console.error(`[调度器] ${name} 启动失败: ${err.message}`);
      finish({ error: err, status: 'spawn_failed' });
    });
  });
}

function runScript(name, command, args, cwd, options = {}) {
  return runScriptAsync(name, command, args, cwd, options).catch(err => {
    console.error(`[调度器] ${name} 执行失败: ${err.message}`);
    return { error: err };
  });
}

function waitUntil(targetMs) {
  return new Promise(resolve => {
    const tick = () => {
      if (sequenceCancelRequested || Date.now() >= targetMs) return resolve();
      setTimeout(tick, Math.min(1000, targetMs - Date.now()));
    };
    tick();
  });
}

function readScheduleState() {
  try { return JSON.parse(fs.readFileSync(cfg.scheduleStateFile, 'utf8')); } catch (_) { return null; }
}

function writeScheduleState(state) {
  config.writeFileAtomic(cfg.scheduleStateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function summarizeTaskResult(result) {
  if (!result) return 'failed';
  if (result.skipped) return `skipped:${result.reason || 'unknown'}`;
  return result.status || (result.code === 0 ? 'ok' : 'failed');
}

async function runProfileDailySequence(options = {}) {
  if (!MULTI_PROFILE_MODE) {
    console.log('[调度器] 跳过多账号串行，未配置 V2EX_PROFILE_LIST');
    return { skipped: true, reason: 'no_profiles' };
  }
  const activeReader = hasActiveReaderLock();
  if (profileSequenceRunning || runningTask || activeReader) {
    const busy = profileSequenceRunning ? '多账号串行任务' : (runningTaskName() || '已有阅读进程');
    console.log(`[调度器] 跳过多账号串行，当前已有任务运行: ${busy}`);
    return { skipped: true, reason: 'busy' };
  }

  profileSequenceRunning = true;
  sequenceCancelRequested = false;
  const results = [];
  const sequenceStartMs = Number.isFinite(options.startTimeMs) ? options.startTimeMs : Date.now();
  const cycleId = options.cycleId || null;
  let scheduleState = cycleId && readScheduleState();
  if (!scheduleState || scheduleState.cycleId !== cycleId) {
    scheduleState = {
      version: 1,
      cycleId,
      startTime: new Date(sequenceStartMs).toISOString(),
      profileOrder: PROFILE_LIST.slice(),
      profiles: {},
      cancelled: false,
      completed: false,
    };
  }
  try {
    if (cycleId && scheduleState.profileOrder && scheduleState.profileOrder.join(',') !== PROFILE_LIST.join(',')) {
      scheduleState.cancelled = true;
      scheduleState.completed = true;
      scheduleState.cancelReason = 'profile_list_changed';
      writeScheduleState(scheduleState);
      console.warn('[调度器] 当前周期的 profile 列表已变化，拒绝按旧时段继续运行');
      return { skipped: true, reason: 'profile_list_changed', results: [] };
    }
    scheduleState.profileOrder = PROFILE_LIST.slice();
    console.log(`[调度器] 多账号串行开始: ${PROFILE_LIST.join(', ')} | 每账号窗口约 ${PROFILE_TIME_SLOT_HOURS} 小时`);
    if (process.env.COOKIE_FILE || process.env.DB_PATH || process.env.V2EX_COOKIE) {
      console.warn('[调度器] 多账号子任务会忽略 COOKIE_FILE / DB_PATH / V2EX_COOKIE，改用按 profile 分隔的状态文件');
    }

    for (let index = 0; index < PROFILE_LIST.length; index++) {
      const profile = PROFILE_LIST[index];
      if (sequenceCancelRequested) break;
      if (cycleId && scheduleState.profiles[profile] && scheduleState.profiles[profile].completed) continue;

      const slotWindow = profileSchedule.getSlotWindow(sequenceStartMs, PROFILE_TIME_SLOT_MS, index);
      const slotStart = slotWindow.startTimeMs;
      const slotEnd = slotWindow.endTimeMs;
      if (Date.now() < slotStart) await waitUntil(slotStart);
      if (sequenceCancelRequested) break;
      if (Date.now() >= slotEnd) {
        const missed = { skipped: true, reason: 'slot_expired', status: 'missed' };
        results.push({ profile, checkin: missed, read: missed });
        if (cycleId) {
          scheduleState.profiles[profile] = { completed: true, status: 'missed', finishedAt: new Date().toISOString() };
          writeScheduleState(scheduleState);
        }
        continue;
      }

      const env = childEnvForProfile(profile);
      const cookieFile = getProfileCookieFile(profile);
      if (cycleId) {
        scheduleState.activeProfile = profile;
        scheduleState.activeIndex = index;
        scheduleState.profiles[profile] = { completed: false, status: 'running', startedAt: new Date().toISOString() };
        writeScheduleState(scheduleState);
      }
      const checkinBudget = Math.max(1000, Math.min(15 * 60 * 1000, slotEnd - Date.now()));
      const checkin = await runScriptAsync(`签到(${profile})`, process.execPath, ['../checkin/v2ex-checkin.js'], __dirname, {
        env,
        cookieFile,
        timeoutMs: checkinBudget,
        partOfProfileSequence: true,
        profile,
        type: 'checkin',
      });
      if (sequenceCancelRequested) {
        results.push({ profile, checkin, read: { skipped: true, reason: 'cancelled', status: 'cancelled' } });
        break;
      }
      const remaining = slotEnd - Date.now();
      let read;
      if (remaining <= 1000) {
        read = { skipped: true, reason: 'slot_expired', status: 'missed' };
      } else {
        const readerBudget = Math.max(1000, remaining - 30000);
        const readResult = await runScriptAsync(`阅读(${profile})`, process.execPath, ['main.js'], __dirname, {
        env: childEnvForProfile(profile, {
          READ_DISABLE_DEADLINE: '1',
            READ_MAX_RUNTIME_MS: String(readerBudget),
        }),
        cookieFile,
          timeoutMs: remaining,
        partOfProfileSequence: true,
        profile,
        type: 'reader',
      });
        read = readResult;
      }
      results.push({ profile, checkin, read });
      if (cycleId) {
        scheduleState.profiles[profile] = {
          completed: true,
          status: `${summarizeTaskResult(checkin)}/${summarizeTaskResult(read)}`,
          finishedAt: new Date().toISOString(),
        };
        scheduleState.activeProfile = null;
        scheduleState.activeIndex = null;
        writeScheduleState(scheduleState);
      }
    }
    if (cycleId) {
      scheduleState.cancelled = sequenceCancelRequested;
      scheduleState.completed = sequenceCancelRequested || PROFILE_LIST.every(profile =>
        scheduleState.profiles[profile] && scheduleState.profiles[profile].completed
      );
      scheduleState.finishedAt = new Date().toISOString();
      writeScheduleState(scheduleState);
    }
    console.log('[调度器] 多账号串行结束');
    return { profiles: PROFILE_LIST.length, results, cancelled: sequenceCancelRequested };
  } finally {
    profileSequenceRunning = false;
    sequenceCancelRequested = false;
  }
}

async function runProfilePingSequence() {
  if (profileSequenceRunning || runningTask) {
    console.log('[调度器] 跳过多账号保活，已有任务运行');
    return { skipped: true, reason: 'busy' };
  }

  profileSequenceRunning = true;
  sequenceCancelRequested = false;
  const results = [];
  try {
    for (const profile of PROFILE_LIST) {
      if (sequenceCancelRequested) break;
      const cookieFile = getProfileCookieFile(profile);
      const result = await runScriptAsync(`保活(${profile})`, process.execPath, ['../checkin/v2ex-checkin.js', '--ping'], __dirname, {
        env: childEnvForProfile(profile),
        cookieFile,
        timeoutMs: 10 * 60 * 1000,
        partOfProfileSequence: true,
        profile,
        type: 'ping',
      });
      results.push({ profile, result });
    }
    return { profiles: PROFILE_LIST.length, results };
  } finally {
    profileSequenceRunning = false;
    sequenceCancelRequested = false;
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

function formatLocalClock(totalLocalMinutes) {
  const dayOffset = Math.floor(totalLocalMinutes / (24 * 60));
  const minuteOfDay = ((totalLocalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const m = String(minuteOfDay % 60).padStart(2, '0');
  return `${h}:${m}${formatDayOffset(dayOffset)}`;
}

function buildProfileSlotMessage() {
  const busyText = profileSequenceRunning
    ? '🟡 多账号串行中'
    : runningTask
      ? `🟡 ${escapeHtml(runningTaskName())} 运行中`
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
    const start = PROFILE_SEQUENCE_START_LOCAL_MINUTES + index * slotMinutes;
    const end = start + slotMinutes;
    const cookieStatus = hasUsableCookie(getProfileCookieFile(profile)) ? '✅ Cookie' : '⚠️ 缺 Cookie';
    return `${index + 1}. <code>${escapeHtml(profile)}</code> | 本机时间 ${formatLocalClock(start)}-${formatLocalClock(end)} | ${cookieStatus}`;
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

function buildSequenceResultMessage(result) {
  if (!result || result.skipped) return 'ℹ️ 多账号串行任务未启动，当前配置或运行状态不满足条件。';
  const lines = result.results.map(item =>
    `${summarizeTaskResult(item.checkin) === 'ok' && summarizeTaskResult(item.read) === 'ok' ? '✅' : '⚠️'} ` +
    `<code>${escapeHtml(item.profile)}</code>：签到 ${escapeHtml(summarizeTaskResult(item.checkin))} / 阅读 ${escapeHtml(summarizeTaskResult(item.read))}`
  );
  const title = result.cancelled ? '🛑 多账号串行任务已取消' : '📋 多账号串行任务已结束';
  return `${title}\n\n${lines.join('\n') || '没有执行任何 profile'}`;
}

async function startProfileSequenceFromPanel(messageId) {
  if (!MULTI_PROFILE_MODE) {
    return editMsgText(messageId, buildProfileSlotMessage(), getProfileSlotKeyboard());
  }
  if (profileSequenceRunning || runningTask || hasActiveReaderLock()) {
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
      return sendMsgWithKeyboard(buildSequenceResultMessage(result), getMainKeyboardMarkup());
    })
    .catch(err => {
      console.error(`[调度器] 面板启动多账号串行失败: ${err.message}`);
      sendMsgWithKeyboard(`❌ 多账号串行任务异常: ${escapeHtml(err.message)}`, getMainKeyboardMarkup()).catch(() => {});
    });
}

function getProfileCycle(now = new Date()) {
  return profileSchedule.getDailyCycle(
    now,
    PROFILE_LIST.length,
    PROFILE_TIME_SLOT_MS,
    PROFILE_SEQUENCE_START_LOCAL_MINUTES
  );
}

function startScheduler() {
  let lastCheckinDate = '';
  let lastReadDate = '';
  let lastPingSlot = '';
  let tickActive = false;

  const tick = async () => {
    if (tickActive) return;
    tickActive = true;
    try {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const dateKey = localDateKey(now);

    if (MULTI_PROFILE_MODE) {
      const cycle = getProfileCycle(now);
      const state = readScheduleState();
      const cycleDone = state && state.cycleId === cycle.id && (state.completed || state.cancelled);
      if (now.getTime() >= cycle.startTimeMs && now.getTime() < cycle.endTimeMs &&
          !cycleDone && !profileSequenceRunning && !runningTask && !hasActiveReaderLock()) {
        runProfileDailySequence({ startTimeMs: cycle.startTimeMs, cycleId: cycle.id })
          .catch(e => console.error(`[调度器] 多账号串行失败: ${e.message}`));
      }

      const pingSlot = `${dateKey}:${h}`;
      if ([0, 6, 12, 18].includes(h) && m < 10 && pingSlot !== lastPingSlot && !profileSequenceRunning && !runningTask) {
        const result = await runProfilePingSequence().catch(e => ({ error: e }));
        if (!result.skipped && !result.error) lastPingSlot = pingSlot;
      }
      return;
    }

    // 每天本机时间 09:10 签到（当天只执行一次）
    if (h === 9 && m === 10 && dateKey !== lastCheckinDate) {
      lastCheckinDate = dateKey;
      const result = await runScript('签到', process.execPath, ['../checkin/v2ex-checkin.js'], __dirname, {
        profile: cfg.profile,
        type: 'checkin',
      });
      if (result.skipped || result.error) lastCheckinDate = '';
    }

    // 每天本机时间 09:15 阅读（当天只执行一次）
    if (h === 9 && m === 15 && dateKey !== lastReadDate) {
      lastReadDate = dateKey;
      // Render 环境下直接 node，VPS Docker 里可以用 xvfb-run
      const result = await runScript('阅读', process.execPath, ['main.js'], __dirname, {
        profile: cfg.profile,
        type: 'reader',
      });
      if (result.skipped || result.error) lastReadDate = '';
    }

    // 每 6 小时保活（V2EX session 保活，非 Render 保活）
    const pingSlot = `${dateKey}:${h}`;
    if ([0, 6, 12, 18].includes(h) && m === 0 && pingSlot !== lastPingSlot) {
      const result = await runScript('保活', process.execPath, ['../checkin/v2ex-checkin.js', '--ping'], __dirname, {
        profile: cfg.profile,
        type: 'ping',
      });
      if (!result.skipped && !result.error) lastPingSlot = pingSlot;
    }
    } finally {
      tickActive = false;
    }
  };

  tick().catch(e => console.error(`[调度器] 初始检查失败: ${e.message}`));
  setInterval(() => tick().catch(e => console.error(`[调度器] 检查失败: ${e.message}`)), 60 * 1000);

  if (MULTI_PROFILE_MODE) {
    console.log(`[调度器] 内置定时任务已启动 (本机时区 ${getLocalTimeZoneInfo()}，多账号串行: ${PROFILE_LIST.join(', ')})`);
  } else {
    console.log(`[调度器] 内置定时任务已启动 (本机时区 ${getLocalTimeZoneInfo()})`);
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
let pollConflictCount = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let botShuttingDown = false;
async function shutdownBot(reason, exitCode) {
  if (botShuttingDown) return;
  botShuttingDown = true;
  sequenceCancelRequested = true;
  console.warn(`[BOT] 正在退出: ${reason}`);
  const child = runningTask && runningTask.child;
  if (child) {
    try { child.kill('SIGTERM'); } catch (_) {}
    await Promise.race([
      new Promise(resolve => child.once('close', resolve)),
      sleep(30000).then(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
      }),
    ]);
  } else {
    await sleep(100);
  }
  process.exit(exitCode);
}

process.once('SIGTERM', () => shutdownBot('SIGTERM', 143).catch(() => process.exit(143)));
process.once('SIGINT', () => shutdownBot('SIGINT', 130).catch(() => process.exit(130)));

function resolveControlProfile(value) {
  const profile = String(value || '').trim();
  return CONTROL_PROFILES.includes(profile) ? profile : null;
}

function sendUnknownProfile(value) {
  return sendMsg(
    `❌ 未知 profile：<code>${escapeHtml(value || '')}</code>\n可用 profile：<code>${CONTROL_PROFILES.map(escapeHtml).join(', ')}</code>`
  );
}

async function handleReadCommand(args) {
  if (args.length === 0) {
    return PROFILE_SELECTION_REQUIRED
      ? showProfilePicker('r', '运行阅读')
      : handleRead(getOnlyProfile());
  }

  if (args.length === 1) {
    const limit = parseReadLimit(args[0]);
    if (limit) {
      return PROFILE_SELECTION_REQUIRED
        ? showProfilePicker('r', `运行阅读（限制 ${limit} 篇）`, null, limit)
        : handleRead(getOnlyProfile(), limit);
    }
    const profile = resolveControlProfile(args[0]);
    if (!profile) return sendUnknownProfile(args[0]);
    return handleRead(profile);
  }

  if (args.length === 2) {
    const profile = resolveControlProfile(args[0]);
    if (!profile) return sendUnknownProfile(args[0]);
    return handleRead(profile, args[1]);
  }

  return sendMsg('❌ 用法：<code>/read [数量]</code> 或 <code>/read profile [数量]</code>');
}

async function handleMessage(msg) {
  const text = msg.text.trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const arg = args[0];
  
  if (cmd === '/start') {
    await handleStart();
  }
  else if (cmd === '/help') {
    await handleHelp();
  }
  else if (cmd === '/sou') {
    if (arg) {
      const profile = resolveControlProfile(arg);
      if (!profile) await sendUnknownProfile(arg);
      else await handleSou(profile);
    } else if (PROFILE_SELECTION_REQUIRED) {
      await showProfilePicker('b', '查询余额');
    } else {
      await handleSou(getOnlyProfile());
    }
  }
  else if (cmd === '/debug') {
    await handleDebug(arg);
  }
  else if (cmd === '/stop') {
    await handleStop(arg || null);
  }
  else if (cmd === '/checkin') {
    if (arg) {
      const profile = resolveControlProfile(arg);
      if (!profile) await sendUnknownProfile(arg);
      else await startProfileCheckin(profile);
    } else if (PROFILE_SELECTION_REQUIRED) {
      await showProfilePicker('c', '运行签到');
    } else {
      await startProfileCheckin(getOnlyProfile());
    }
  }
  else if (cmd === '/read') {
    await handleReadCommand(args);
  }
  else if (cmd === '/tasks') {
    await handleTasks();
  }
  else if (cmd === '/cookie') {
    const cookieText = text.slice(cmd.length).trim();
    if (!cookieText) {
      await handleCookieHelp();
    } else {
      const firstToken = cookieText.split(/\s+/, 1)[0];
      const profile = resolveControlProfile(firstToken);
      const remaining = profile ? cookieText.slice(firstToken.length).trim() : cookieText;
      if (profile && !remaining) {
        await beginCookieImport(profile);
        return;
      }
      const handled = await handleCookieImport(remaining, profile, msg);
      if (!handled) {
        await sendMsg('❌ 未能从中识别出有效的 V2EX Cookie（如 A2 字段）。请确认格式。');
      }
    }
  }
  else if (cmd.startsWith('/')) {
    await sendMsgWithKeyboard('未识别命令。常用操作都在下方交互面板里，也可以发送 <code>/help</code> 查看文本命令。', getMainKeyboardMarkup());
  } else {
    // 非命令消息：尝试智能识别 Cookie
    const hadPendingImport = Boolean(getPendingCookieImport());
    const handled = await handleCookieImport(text, null, msg);
    if (!handled) {
      if (hadPendingImport) {
        await sendMsg('❌ 未识别到有效 V2EX Cookie（必须包含 A2 字段），请重新粘贴或返回面板取消');
      } else {
        console.log('[BOT] 未识别到有效 Cookie，忽略');
      }
    }
  }
}

async function handleCallbackQuery(query) {
  const data = query.data;
  const messageId = query.message ? query.message.message_id : null;
  
  console.log(`[BOT] 收到 Callback: ${data}`);
  await tgRequest('answerCallbackQuery', { callback_query_id: query.id });
  
  try {
    if (data.startsWith('ps:')) {
      const [, sessionId, indexValue, callbackExtra] = data.split(':');
      const session = getInteractionSession(sessionId, messageId);
      const index = Number(indexValue);
      const profile = session && Number.isInteger(index) ? session.profiles[index] : null;
      const action = session && session.action;
      const extraValue = callbackExtra || (session && session.extraValue) || null;
      if (!session || !profile || !CONTROL_PROFILES.includes(profile)) {
        await sendOrEdit(messageId, '⚠️ Profile 选择已失效，请重新打开面板', getMainKeyboardMarkup());
      } else if (action === 'c') {
        await startProfileCheckin(profile, messageId);
      } else if (action === 'r') {
        await handleRead(profile, extraValue || null, messageId);
      } else if (action === 'b') {
        await editMsgText(messageId, buildBalanceMessage(profile), {
          inline_keyboard: [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]],
        });
      } else if (action === 'k') {
        await beginCookieImport(profile, messageId);
      } else if (action === 'kp') {
        await applyPendingCookie(profile, messageId, extraValue);
      } else {
        await sendOrEdit(messageId, '⚠️ 操作已失效，请重新打开面板', getMainKeyboardMarkup());
      }
    }
    else if (data.startsWith('ci:')) {
      const [, pendingId, action] = data.split(':');
      const pending = getPendingCookieImport(pendingId);
      if (!pending || pending.state !== 'replace_confirmation' || !pending.profile || !pending.candidate) {
        await sendOrEdit(messageId, '⚠️ Cookie 换绑确认已过期，请重新导入', getMainKeyboardMarkup());
      } else if (action === 'cancel') {
        clearPendingCookieImport(pendingId);
        await sendOrEdit(messageId, 'ℹ️ 已取消账号换绑，原 Cookie 和 Chromium 状态未修改', getMainKeyboardMarkup());
      } else if (action === 'replace') {
        await sendOrEdit(messageId, `⏳ 正在重新验证并换绑 <code>${escapeHtml(pending.profile)}</code>...`);
        await importCookieResult(pending.candidate, pending.profile, pendingId, true);
      } else {
        await sendOrEdit(messageId, '⚠️ Cookie 换绑操作无效', getMainKeyboardMarkup());
      }
    }
    else if (data.startsWith('p:') || data.startsWith('trigger_read_')) {
      await sendOrEdit(messageId, '⚠️ 旧版按钮未携带可靠的账号信息，请重新打开面板', getMainKeyboardMarkup());
    }
    else if (data === 'run_checkin') {
      if (PROFILE_SELECTION_REQUIRED) {
        await showProfilePicker('c', '运行签到', messageId);
      } else {
        await startProfileCheckin(getOnlyProfile(), messageId);
      }
    }
    else if (data === 'run_read_panel') {
      if (PROFILE_SELECTION_REQUIRED) {
        await showProfilePicker('r', '运行阅读', messageId);
      } else {
        await handleRead(getOnlyProfile(), null, messageId);
      }
    }
    else if (data === 'query_balance') {
      if (PROFILE_SELECTION_REQUIRED) {
        await showProfilePicker('b', '查询余额', messageId);
      } else {
        await editMsgText(messageId, buildBalanceMessage(getOnlyProfile()), {
          inline_keyboard: [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]],
        });
      }
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
                   `<code>/sou [profile]</code> 查询余额\n` +
                   `<code>/tasks</code> 查看任务状态\n` +
                   `<code>/checkin [profile]</code> 手动签到\n` +
                   `<code>/read [数量]</code> 或 <code>/read profile [数量]</code> 手动阅读\n` +
                   `面板「时段分块」查看/启动多账号串行\n` +
                   `<code>/debug [级别]</code> 日志级别\n` +
                   `<code>/stop [profile]</code> 停止任务并取消后续串行账号\n` +
                   `<code>/cookie [profile] [内容]</code> 导入 Cookie`;
      await editMsgText(messageId, text, {
        inline_keyboard: [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]]
      });
    }
    else if (data.startsWith('set_debug_')) {
      const level = data.replace('set_debug_', '');
      await handleDebug(level, messageId);
    }
    else if (data === 'query_tasks') {
      const lock = getActiveReaderLock();
      const taskName = runningTaskName() || (profileSequenceRunning ? '多账号串行队列' : (lock ? '外部阅读任务' : ''));
      const profile = (runningTask && runningTask.profile) || (lock && lock.profile);
      const pid = (runningTask && runningTask.child && runningTask.child.pid) || (lock && lock.pid);
      let statusText = taskName
        ? `ℹ️ <b>当前任务状态</b>: 🟡 <b>正在运行中</b>\n- 当前任务: <code>${escapeHtml(taskName)}</code>` +
          `${profile ? `\n- Profile: <code>${escapeHtml(profile)}</code>` : ''}` +
          `${pid ? `\n- PID: <code>${pid}</code>` : ''}`
        : 'ℹ️ <b>当前任务状态</b>: 🟢 <b>空闲</b> (无后台任务在运行)';
      let keyboard = [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]];
      if (taskName) {
        keyboard = [
          [{ text: '🛑 停止任务', callback_data: 'stop_task' }],
          [{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]
        ];
      }
      await editMsgText(messageId, statusText, { inline_keyboard: keyboard });
    }
    else if (data === 'stop_task') {
      if (profileSequenceRunning) sequenceCancelRequested = true;
      const lock = getActiveReaderLock();
      const pid = (runningTask && runningTask.child && runningTask.child.pid) || (lock && lock.pid);
      let statusText = profileSequenceRunning ? '🛑 已取消多账号串行队列。' : 'ℹ️ 当前没有运行任务。';
      if (pid) {
        try {
          if (runningTask && runningTask.child) runningTask.child.kill('SIGTERM');
          else process.kill(pid, 'SIGTERM');
          const profile = (runningTask && runningTask.profile) || (lock && lock.profile);
          statusText = `🛑 已停止当前任务${profile ? `（<code>${escapeHtml(profile)}</code>）` : ''}。` +
            `${profileSequenceRunning ? '\n后续串行账号也已取消。' : ''}`;
        } catch (e) {
          statusText = `❌ 停止失败: ${escapeHtml(e.message)}`;
        }
      }
      await editMsgText(messageId, statusText, {
        inline_keyboard: [[{ text: '◀️ 返回面板', callback_data: 'go_to_start' }]]
      });
    }
    else if (data === 'go_to_start') {
      clearPendingCookieImport();
      clearInteractionSessions();
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
      pollConflictCount++;
      if (pollConflictCount >= 3) {
        console.error('[BOT] Telegram 409 连续冲突，终止本实例以避免重复调度');
        await shutdownBot('telegram_conflict', 1);
        return;
      }
      await sleep(pollRetryDelay);
      pollRetryDelay = Math.min(pollRetryDelay * 2, 10000);
      return;
    }

    pollRetryDelay = 1000;
    pollConflictCount = 0;

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
      if (profileLock.clearStaleLock(LOCK_FILE)) {
        console.log('[BOT] 已清除残留锁文件');
      }
    } catch (_) {}
  }

  // 跳过历史消息（offset 设为最新，带重试）
  let telegramOwnershipConfirmed = false;
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
      if (init.ok) telegramOwnershipConfirmed = true;
      break;
    } catch (e) {
      console.error(`[BOT] 初始化失败: ${e.message}，重试中...`);
      await sleep(2000 * (attempt + 1));
    }
  }
  if (!telegramOwnershipConfirmed) {
    throw new Error('无法取得 Telegram getUpdates 所有权，拒绝启动内部调度器');
  }

  // 仅由取得 Telegram 所有权的实例处理环境启动凭证。
  const startupCookie = process.env.V2EX_COOKIE || '';
  try {
    if (startupCookie) {
      if (MULTI_PROFILE_MODE && (!cfg.profileExplicit || !CONTROL_PROFILES.includes(cfg.profile))) {
        console.warn('[BOT] 多账号模式下 V2EX_COOKIE 必须同时显式指定列表内的 V2EX_PROFILE，已忽略该启动凭证');
      } else if (!hasUsableCookie(getProfileConfig(cfg.profile).cookieFile)) {
        const candidate = extractCookie(startupCookie);
        if (!candidate) console.error('[BOT] V2EX_COOKIE 格式无效，未写入任何 profile');
        else await importCookieResult(candidate, cfg.profile);
      }
    }
  } finally {
    delete process.env.V2EX_COOKIE;
  }

  // 检查 Cookie 状态，构建启动消息
  const readyProfiles = CONTROL_PROFILES.filter(profile => hasUsableCookie(getProfileConfig(profile).cookieFile));
  const missingProfiles = CONTROL_PROFILES.filter(profile => !readyProfiles.includes(profile));
  let startupMsg = '🤖 Bot 已上线';
  if (CONTROL_PROFILES.length > 1) {
    startupMsg += `\n✅ Cookie 已就绪 ${readyProfiles.length}/${CONTROL_PROFILES.length}`;
    if (missingProfiles.length > 0) {
      startupMsg += `\n⚠️ 缺少 Cookie：<code>${missingProfiles.map(escapeHtml).join(', ')}</code>`;
    }
  } else if (readyProfiles.length === 0) {
    startupMsg += '\n\n⚠️ 未检测到 Cookie 文件\n💡 请从面板选择「导入 Cookie」或直接粘贴 Cookie 文本';
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

  // systemd timer 部署时只保留 Bot 交互，避免同一任务被两套调度器重复触发。
  if (INTERNAL_SCHEDULER_DISABLED) {
    console.log('[调度器] 内置定时任务已禁用，由外部 timer/cron 负责调度');
  } else {
    startScheduler();
  }

  // 启动自保活
  startKeepAlive();

  // 主轮询循环（永不退出）
  while (true) {
    await poll();
  }
})().catch(e => {
  console.error(`[BOT] 启动失败: ${e.message}`);
  process.exit(1);
});
