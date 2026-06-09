#!/usr/bin/env node
'use strict';
// ========== V2EX Telegram Bot 命令处理器 ==========
// 常驻进程，长轮询 Telegram，响应：
//   /sou   — 今日最后一次余额查询 & 昨日余额
//   /debug — 最新报错（日志末尾 ERROR/WARN 行）
//   /stop  — 停止正在运行的阅读脚本
//
// 配置（环境变量或 ~/.v2ex_env 文件）：
//   TG_TOKEN    — Telegram Bot Token
//   TG_CHAT_ID  — 唯一授权用户的 Chat ID（硬锁，只响应该用户）
//   READER_LOG  — 阅读脚本日志路径（默认 /var/log/v2ex-reader.log）

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

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
const LOCK_FILE       = path.join(os.tmpdir(), 'v2ex_reader.lock');
const BALANCE_LOG     = path.join(__dirname, 'data', 'balance_log.json');
const READER_LOG      = process.env.READER_LOG || '/var/log/v2ex-reader.log';

if (!TOKEN)           { console.error('TG_TOKEN 未设置'); process.exit(1); }
if (!ALLOWED_CHAT_ID) { console.error('TG_CHAT_ID 未设置'); process.exit(1); }

function maskId(id) {
  const s = String(id || '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

// ========== Telegram API ==========
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
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
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

// ========== 长轮询主循环 ==========
let offset = 0;

async function poll() {
  try {
    const res = await tgRequest('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
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

      const cmd = msg.text.trim().split(/\s+/)[0].toLowerCase();
      console.log(`[BOT] 收到命令: ${cmd}`);

      try {
        if      (cmd === '/sou')   await handleSou();
        else if (cmd === '/debug') await handleDebug();
        else if (cmd === '/stop')  await handleStop();
        else await sendMsg('可用命令：\n/sou — 余额记录\n/debug — 最新报错\n/stop — 停止阅读脚本');
      } catch (e) {
        console.error(`[BOT] 命令处理出错: ${e.message}`);
      }
    }
  } catch (e) {
    if (e.message !== 'timeout') {
      console.error(`[BOT] 轮询出错: ${e.message}`);
    }
  }
}

// 主循环
console.log(`[BOT] V2EX Bot 启动，授权 Chat ID: ${maskId(ALLOWED_CHAT_ID)}`);
(async () => {
  // 先清空历史消息（offset 设为最新）
  try {
    const init = await tgRequest('getUpdates', { offset: -1, timeout: 0 });
    if (init.ok && init.result.length > 0) {
      offset = init.result[init.result.length - 1].update_id + 1;
    }
  } catch (_) {}

  // 通知已启动
  await sendMsg('🤖 Bot 已上线，可用命令：\n/sou — 余额记录\n/debug — 最新报错\n/stop — 停止阅读脚本');

  while (true) {
    await poll();
  }
})();
