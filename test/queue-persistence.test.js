'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

function runQueue(dir, profile, code) {
  return childProcess.spawnSync(process.execPath, ['-e', code], {
    cwd: repoRoot,
    env: {
      ...process.env,
      V2EX_DATA_DIR: dir,
      V2EX_PROFILE: profile,
      V2EX_PROFILE_LIST: '',
      COOKIE_FILE: '',
      DB_PATH: '',
      V2EX_PROXY_ENABLE: '0',
    },
    encoding: 'utf8',
    timeout: 20000,
  });
}

const writer = urls => `(async()=>{const q=require('./reader/queue');await q.init();q.add(${JSON.stringify(urls)});q.increment(${JSON.stringify(urls[0])});${urls[1] ? `q.skip(${JSON.stringify(urls[1])});` : ''}q.close()})().catch(e=>{console.error(e);process.exit(1)})`;
const reader = `(async()=>{const q=require('./reader/queue');await q.init();console.log('STATS:'+JSON.stringify(q.stats()));q.close()})().catch(e=>{console.error(e);process.exit(1)})`;

function readStats(result) {
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/STATS:(\{[^\n]+\})/);
  assert.ok(match, result.stdout);
  return JSON.parse(match[1]);
}

test('queue mutations persist immediately and reload independently per profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-queue-test-'));
  try {
    const baseWrite = runQueue(dir, 'default', writer(['https://example.invalid/default']));
    const namedWrite = runQueue(dir, 'acc1', writer([
      'https://example.invalid/acc1-a',
      'https://example.invalid/acc1-b',
    ]));
    assert.equal(baseWrite.status, 0, baseWrite.stderr);
    assert.equal(namedWrite.status, 0, namedWrite.stderr);

    const baseDb = path.join(dir, 'reader', 'queue.db');
    const namedDb = path.join(dir, 'reader', 'queue.acc1.db');
    assert.equal(fs.existsSync(baseDb), true);
    assert.equal(fs.existsSync(namedDb), true);
    assert.deepEqual(readStats(runQueue(dir, 'default', reader)), { total: 1, readable: 1, exhausted: 0 });
    assert.deepEqual(readStats(runQueue(dir, 'acc1', reader)), { total: 2, readable: 1, exhausted: 1 });
    assert.equal(fs.readdirSync(path.dirname(baseDb)).some(name => name.endsWith('.tmp')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queue save failures are reported and a later flush can recover the committed data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-queue-test-'));
  try {
    const failureScript = `(async()=>{
      const fs=require('fs');
      const q=require('./reader/queue');
      await q.init();
      const rename=fs.renameSync;
      let attempts=0;
      fs.renameSync=()=>{attempts++;throw new Error('simulated rename failure')};
      try { q.add(['https://example.invalid/recover']); }
      catch (e) { console.log('EXPECTED:'+e.message); }
      finally { fs.renameSync=rename; }
      console.log('ATTEMPTS:'+attempts);
      q.flush();
      q.close();
    })().catch(e=>{console.error(e);process.exit(1)})`;
    const failed = runQueue(dir, 'acc1', failureScript);
    assert.equal(failed.status, 0, failed.stderr);
    assert.match(`${failed.stdout}\n${failed.stderr}`, /Queue DB save failed: simulated rename failure/);
    assert.match(failed.stdout, /EXPECTED:simulated rename failure/);
    assert.match(failed.stdout, /ATTEMPTS:4/);
    assert.deepEqual(readStats(runQueue(dir, 'acc1', reader)), { total: 1, readable: 1, exhausted: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
