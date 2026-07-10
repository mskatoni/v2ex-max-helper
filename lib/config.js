'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const secureProxy = require('./secure-proxy');

const REPO_ROOT = path.resolve(__dirname, '..');
const READER_DIR = path.join(REPO_ROOT, 'reader');
const CHECKIN_DIR = path.join(REPO_ROOT, 'checkin');
const ENV_FILE = path.join(os.homedir(), '.v2ex_env');

function stripQuotes(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(envFile = ENV_FILE) {
  if (!fs.existsSync(envFile)) return false;
  const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    process.env[key] = stripQuotes(match[2]);
  }
  return true;
}

loadEnvFile();
secureProxy.installGlobalHttpsProxy();

function boolEnv(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim());
}

function readFileTrim(file) {
  try {
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function writeFileAtomic(file, data, options = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, data, options);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
    throw e;
  }
}

function resolveProfile() {
  return (process.env.V2EX_PROFILE || 'default').trim() || 'default';
}

function resolveCookieFile(profile, cookieBaseDir) {
  if (process.env.COOKIE_FILE) return process.env.COOKIE_FILE;
  const base = path.join(cookieBaseDir, '.v2ex_cookie');
  return profile === 'default' ? base : `${base}.${profile}`;
}

function getConfig() {
  const profile = resolveProfile();
  const externalDataDir = process.env.V2EX_DATA_DIR || '';
  const readerDataDir = externalDataDir || path.join(READER_DIR, 'data');
  const queueDataDir = externalDataDir ? path.join(externalDataDir, 'reader') : readerDataDir;
  const cookieBaseDir = externalDataDir || os.homedir();
  const authChatFile = path.join(readerDataDir, '.telegram_chat_id');
  const cookieFile = resolveCookieFile(profile, cookieBaseDir);
  const envChatId = (process.env.TG_CHAT_ID || '').trim();
  const fileChatId = envChatId ? '' : readFileTrim(authChatFile);

  return {
    repoRoot: REPO_ROOT,
    readerDir: READER_DIR,
    checkinDir: CHECKIN_DIR,
    envFile: ENV_FILE,
    profile,
    dataDir: externalDataDir,
    readerDataDir,
    queueDataDir,
    cookieBaseDir,
    cookieFile,
    chromeProfileDir: externalDataDir
      ? path.join(externalDataDir, 'chrome-profile', profile)
      : path.join(readerDataDir, 'chrome-profile', profile),
    authChatFile,
    balanceLog: path.join(readerDataDir, 'balance_log.json'),
    balanceStatus: path.join(readerDataDir, 'balance_status.json'),
    readerLog: process.env.READER_LOG || path.join(readerDataDir, 'v2ex-reader.log'),
    logLevelFile: path.join(readerDataDir, 'log_level.txt'),
    dbPath: process.env.DB_PATH || path.join(queueDataDir, 'queue.db'),
    telegram: {
      token: process.env.TG_TOKEN || '',
      checkinToken: process.env.TG_BOT_TOKEN || process.env.TG_TOKEN || '',
      chatId: envChatId || fileChatId,
      chatIdSource: envChatId ? 'env' : (fileChatId ? 'file' : ''),
      setupCode: process.env.TG_SETUP_CODE || '',
    },
    feishu: {
      enabled: boolEnv('FEISHU_ENABLE'),
      webhook: process.env.FEISHU_WEBHOOK || '',
      botEnabled: boolEnv('FEISHU_BOT_ENABLE'),
      appId: process.env.FEISHU_APP_ID || '',
      appSecret: process.env.FEISHU_APP_SECRET || '',
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
      chatId: (process.env.FEISHU_CHAT_ID || '').trim(),
      port: parseInt(process.env.FEISHU_BOT_PORT || '6700', 10) || 6700,
    },
    barkUrl: process.env.BARK_URL || '',
  };
}

function saveAuthorizedChatId(chatId, config = getConfig()) {
  const id = String(chatId || '').trim();
  if (!id) throw new Error('empty chat id');
  writeFileAtomic(config.authChatFile, `${id}\n`, { mode: 0o600 });
  process.env.TG_CHAT_ID = id;
  return id;
}

module.exports = {
  getConfig,
  loadEnvFile,
  saveAuthorizedChatId,
  writeFileAtomic,
  boolEnv,
};
