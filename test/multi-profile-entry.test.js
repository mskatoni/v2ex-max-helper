'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

function safeEnv(extra = {}) {
  return {
    ...process.env,
    TG_TOKEN: '',
    TG_BOT_TOKEN: '',
    TG_CHAT_ID: '',
    V2EX_COOKIE: '',
    COOKIE_FILE: '',
    DB_PATH: '',
    V2EX_PROXY_ENABLE: '0',
    ...extra,
  };
}

test('multi-profile reader refuses an implicit default before network access', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-entry-test-'));
  try {
    const result = childProcess.spawnSync(process.execPath, ['reader/main.js', '--limit', '1'], {
      cwd: repoRoot,
      env: safeEnv({ V2EX_DATA_DIR: dir, V2EX_PROFILE: '', V2EX_PROFILE_LIST: 'acc1,acc2' }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /必须显式设置 V2EX_PROFILE/);
    assert.equal(fs.existsSync(path.join(dir, 'reader', 'queue.default.db')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-profile checkin refuses an implicit default before credential access', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-entry-test-'));
  try {
    const result = childProcess.spawnSync(process.execPath, ['checkin/v2ex-checkin.js', '--ping'], {
      cwd: repoRoot,
      env: safeEnv({ V2EX_DATA_DIR: dir, V2EX_PROFILE: '', V2EX_PROFILE_LIST: 'acc1,acc2' }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /必须显式设置 V2EX_PROFILE/);
    assert.equal(fs.existsSync(path.join(dir, '.locks')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('profile list rejects case-insensitive path collisions', () => {
  const result = childProcess.spawnSync(process.execPath, ['-e', "require('./lib/config').parseProfileList('acc1,Acc1')"], {
    cwd: repoRoot,
    env: safeEnv(),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不区分大小写/);
});

test('relative data directory resolves consistently from the repository root', () => {
  const result = childProcess.spawnSync(process.execPath, ['-e', "console.log(require('./lib/config').getProfileConfig('acc1').cookieFile)"], {
    cwd: repoRoot,
    env: safeEnv({ V2EX_DATA_DIR: 'relative-data' }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(path.normalize(result.stdout.trim()), path.join(repoRoot, 'relative-data', '.v2ex_cookie.acc1'));
});

test('reader rejects malformed or excessive explicit limits before any network access', () => {
  for (const value of ['bad', '1001']) {
    const result = childProcess.spawnSync(process.execPath, ['reader/main.js', '--dry-run', '--limit', value], {
      cwd: repoRoot,
      env: safeEnv(),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /--limit/);
  }
});
