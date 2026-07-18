'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const secureProxy = require('./secure-proxy');

const REPO_ROOT = path.resolve(__dirname, '..');
const READER_DIR = path.join(REPO_ROOT, 'reader');
const CHECKIN_DIR = path.join(REPO_ROOT, 'checkin');
const ENV_FILE = path.join(os.homedir(), '.v2ex_env');
const PROFILE_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_PROFILE_COUNT = 6;
const WINDOWS_DEVICE_PROFILE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function resolveConfiguredPath(value, baseDir = REPO_ROOT) {
  const configured = String(value || '').trim();
  if (!configured) return '';
  return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(baseDir, configured);
}

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
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error(`无法读取 Telegram 授权文件 (${error.code || 'unknown error'})`);
  }
}

function normalizeTelegramChatId(value, source) {
  const id = String(value || '').trim();
  if (!id) return '';
  if (!/^[1-9]\d*$/.test(id)) throw new Error(`${source} 必须是 Telegram 私聊用户的正整数 Chat ID`);
  return id;
}

function writeFileAtomic(file, data, options = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const writeOptions = typeof options === 'string'
    ? { encoding: options, mode: 0o600 }
    : { mode: 0o600, ...options };
  try {
    fs.writeFileSync(tmp, data, writeOptions);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
    throw e;
  }
}

function normalizeProfile(value, source = 'V2EX_PROFILE') {
  const profile = String(value || '').trim() || 'default';
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error(`${source} 仅允许字母、数字、下划线和连字符`);
  }
  if ((profile !== 'default' && profile.toLowerCase() === 'default') ||
      WINDOWS_DEVICE_PROFILE_PATTERN.test(profile)) {
    throw new Error(`${source} 不能使用跨平台保留名称: ${profile}`);
  }
  return profile;
}

function resolveProfile() {
  return normalizeProfile(process.env.V2EX_PROFILE || 'default');
}

function hasExplicitProfile() {
  return Object.prototype.hasOwnProperty.call(process.env, 'V2EX_PROFILE') &&
    String(process.env.V2EX_PROFILE || '').trim() !== '';
}

function parseProfileList(raw = process.env.V2EX_PROFILE_LIST || '', limit = MAX_PROFILE_COUNT) {
  const value = String(raw || '').trim();
  if (!value) return [];

  const max = Math.max(1, parseInt(limit, 10) || MAX_PROFILE_COUNT);
  const seen = new Map();
  const profiles = [];
  for (const item of value.split(',')) {
    const candidate = item.trim();
    if (!candidate) continue;
    const profile = normalizeProfile(candidate, 'V2EX_PROFILE_LIST');
    const identity = profile.toLowerCase();
    if (seen.has(identity)) {
      if (seen.get(identity) !== profile) {
        throw new Error(`V2EX_PROFILE_LIST 中的 ${seen.get(identity)} 与 ${profile} 在不区分大小写的文件系统上会冲突`);
      }
      continue;
    }
    if (profiles.length >= max) {
      console.warn(`[config] V2EX_PROFILE_LIST 最多支持 ${max} 个 profile，已忽略后续配置`);
      break;
    }
    seen.set(identity, profile);
    profiles.push(profile);
  }
  return profiles;
}

function profileFilePath(file, profile) {
  if (profile === 'default') return file;
  const ext = path.extname(file);
  const stem = ext ? file.slice(0, -ext.length) : file;
  return `${stem}.${profile}${ext}`;
}

function resolveCookieFile(profile, cookieBaseDir, useExplicitPaths) {
  if (useExplicitPaths && process.env.COOKIE_FILE) return resolveConfiguredPath(process.env.COOKIE_FILE);
  const base = path.join(cookieBaseDir, '.v2ex_cookie');
  return profile === 'default' ? base : `${base}.${profile}`;
}

function buildConfig(profile, useExplicitPaths) {
  const externalDataDir = resolveConfiguredPath(process.env.V2EX_DATA_DIR || '');
  const readerDataDir = externalDataDir || path.join(READER_DIR, 'data');
  const queueDataDir = externalDataDir ? path.join(externalDataDir, 'reader') : readerDataDir;
  const cookieBaseDir = externalDataDir || os.homedir();
  const authChatFile = path.join(readerDataDir, '.telegram_chat_id');
  const cookieFile = resolveCookieFile(profile, cookieBaseDir, useExplicitPaths);
  const envChatId = normalizeTelegramChatId(process.env.TG_CHAT_ID || '', 'TG_CHAT_ID');
  let fileChatId = '';
  if (!envChatId && fs.existsSync(authChatFile)) {
    const storedChatId = readFileTrim(authChatFile);
    if (!storedChatId) throw new Error('Telegram 授权文件存在但内容为空，已拒绝重新开放绑定');
    fileChatId = normalizeTelegramChatId(storedChatId, 'Telegram 授权文件');
  }
  const defaultDbPath = path.join(queueDataDir, 'queue.db');

  return {
    repoRoot: REPO_ROOT,
    readerDir: READER_DIR,
    checkinDir: CHECKIN_DIR,
    envFile: ENV_FILE,
    profile,
    profileExplicit: useExplicitPaths ? hasExplicitProfile() : true,
    dataDir: externalDataDir,
    readerDataDir,
    queueDataDir,
    cookieBaseDir,
    cookieFile,
    chromeProfileDir: externalDataDir
      ? path.join(externalDataDir, 'chrome-profile', profile)
      : path.join(readerDataDir, 'chrome-profile', profile),
    authChatFile,
    balanceLog: profileFilePath(path.join(readerDataDir, 'balance_log.json'), profile),
    balanceStatus: profileFilePath(path.join(readerDataDir, 'balance_status.json'), profile),
    readerLog: process.env.READER_LOG
      ? resolveConfiguredPath(process.env.READER_LOG)
      : path.join(readerDataDir, 'v2ex-reader.log'),
    logLevelFile: path.join(readerDataDir, 'log_level.txt'),
    dbPath: useExplicitPaths && process.env.DB_PATH
      ? resolveConfiguredPath(process.env.DB_PATH)
      : profileFilePath(defaultDbPath, profile),
    identityFile: profileFilePath(path.join(readerDataDir, 'profile_identity.json'), profile),
    credentialLockFile: path.join(readerDataDir, '.locks', `credential.${profile}.lock`),
    readerLockFile: path.join(os.tmpdir(), 'v2ex_reader.lock'),
    scheduleStateFile: path.join(readerDataDir, 'profile_schedule_state.json'),
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

function getConfig() {
  return buildConfig(resolveProfile(), true);
}

function getProfileConfig(profile) {
  return buildConfig(normalizeProfile(profile), false);
}

function saveAuthorizedChatId(chatId, config = getConfig()) {
  const id = normalizeTelegramChatId(chatId, 'Telegram Chat ID');
  if (!id) throw new Error('empty chat id');
  writeFileAtomic(config.authChatFile, `${id}\n`, { mode: 0o600 });
  process.env.TG_CHAT_ID = id;
  return id;
}

module.exports = {
  getConfig,
  getProfileConfig,
  parseProfileList,
  normalizeProfile,
  hasExplicitProfile,
  profileFilePath,
  loadEnvFile,
  saveAuthorizedChatId,
  writeFileAtomic,
  boolEnv,
  MAX_PROFILE_COUNT,
};
