'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../lib/config');

const repoRoot = path.resolve(__dirname, '..');
const envKeys = ['V2EX_DATA_DIR', 'V2EX_PROFILE', 'V2EX_PROFILE_LIST', 'COOKIE_FILE', 'DB_PATH', 'READER_LOG', 'TG_CHAT_ID'];

function withEnv(values, fn) {
  const before = new Map(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('default and named profiles isolate account state while sharing control files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-config-test-'));
  try {
    withEnv({ V2EX_DATA_DIR: dir }, () => {
      const base = config.getProfileConfig('default');
      const named = config.getProfileConfig('acc1');

      assert.equal(base.cookieFile, path.join(dir, '.v2ex_cookie'));
      assert.equal(named.cookieFile, path.join(dir, '.v2ex_cookie.acc1'));
      assert.equal(base.balanceLog, path.join(dir, 'balance_log.json'));
      assert.equal(named.balanceLog, path.join(dir, 'balance_log.acc1.json'));
      assert.equal(base.balanceStatus, path.join(dir, 'balance_status.json'));
      assert.equal(named.balanceStatus, path.join(dir, 'balance_status.acc1.json'));
      assert.equal(base.dbPath, path.join(dir, 'reader', 'queue.db'));
      assert.equal(named.dbPath, path.join(dir, 'reader', 'queue.acc1.db'));
      assert.equal(named.identityFile, path.join(dir, 'profile_identity.acc1.json'));
      assert.equal(named.chromeProfileDir, path.join(dir, 'chrome-profile', 'acc1'));

      assert.equal(base.authChatFile, named.authChatFile);
      assert.equal(base.readerLog, named.readerLog);
      assert.equal(base.logLevelFile, named.logLevelFile);
      assert.equal(base.readerLockFile, named.readerLockFile);
      assert.equal(base.scheduleStateFile, named.scheduleStateFile);
      assert.notEqual(base.credentialLockFile, named.credentialLockFile);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('single-profile explicit paths win, while Bot-derived profile paths ignore shared overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-config-test-'));
  try {
    withEnv({
      V2EX_DATA_DIR: dir,
      V2EX_PROFILE: 'acc1',
      COOKIE_FILE: 'custom/cookie.txt',
      DB_PATH: 'custom/queue.db',
    }, () => {
      const direct = config.getConfig();
      const derived = config.getProfileConfig('acc1');
      assert.equal(direct.cookieFile, path.join(repoRoot, 'custom', 'cookie.txt'));
      assert.equal(direct.dbPath, path.join(repoRoot, 'custom', 'queue.db'));
      assert.equal(derived.cookieFile, path.join(dir, '.v2ex_cookie.acc1'));
      assert.equal(derived.dbPath, path.join(dir, 'reader', 'queue.acc1.db'));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('profile parsing rejects path characters, de-duplicates, and caps the list at six', () => {
  for (const profile of ['../x', 'a/b', 'a:b']) {
    assert.throws(() => config.normalizeProfile(profile), /仅允许/);
  }
  assert.deepEqual(config.parseProfileList('acc1,acc1,acc2'), ['acc1', 'acc2']);
  assert.deepEqual(
    config.parseProfileList('a,b,c,d,e,f,g'),
    ['a', 'b', 'c', 'd', 'e', 'f']
  );
});

test('profile parsing rejects case-alias and Windows device path collisions', () => {
  for (const profile of ['Default', 'DEFAULT', 'CON', 'nul', 'COM1', 'LPT9']) {
    assert.throws(() => config.normalizeProfile(profile), /跨平台保留名称/);
  }
  assert.equal(config.normalizeProfile('default'), 'default');
  assert.equal(config.normalizeProfile('com10'), 'com10');
});

test('Telegram authorization accepts only a private numeric chat id', () => {
  withEnv({ TG_CHAT_ID: '123456789' }, () => {
    assert.equal(config.getConfig().telegram.chatId, '123456789');
  });
  for (const value of ['-100123', '0', '00123', 'user-name', '123 456']) {
    withEnv({ TG_CHAT_ID: value }, () => {
      assert.throws(() => config.getConfig(), /正整数 Chat ID/);
    });
  }
});

test('a corrupt persisted Telegram chat id fails closed instead of reopening binding', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-chat-test-'));
  try {
    fs.writeFileSync(path.join(dir, '.telegram_chat_id'), 'not-a-chat-id\n');
    withEnv({ V2EX_DATA_DIR: dir }, () => {
      assert.throws(() => config.getConfig(), /正整数 Chat ID/);
    });
    fs.writeFileSync(path.join(dir, '.telegram_chat_id'), '');
    withEnv({ V2EX_DATA_DIR: dir }, () => {
      assert.throws(() => config.getConfig(), /授权文件存在但内容为空/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
