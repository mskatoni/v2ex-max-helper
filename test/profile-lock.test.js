'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const locks = require('../lib/profile-lock');

test('profile lock records task ownership and rejects a second owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-lock-test-'));
  const file = path.join(dir, 'credential.lock');
  try {
    const handle = locks.acquireLock(file, { profile: 'acc1', task: 'reader' });
    const current = locks.readLock(file);
    assert.equal(current.profile, 'acc1');
    assert.equal(current.task, 'reader');
    assert.throws(() => locks.acquireLock(file, { profile: 'acc1', task: 'cookie-import' }), error => {
      assert.equal(error.code, 'LOCK_BUSY');
      return true;
    });
    handle.release();
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy numeric reader locks remain readable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-lock-test-'));
  const file = path.join(dir, 'reader.lock');
  try {
    fs.writeFileSync(file, `${process.pid}\n`);
    const current = locks.readLock(file);
    assert.equal(current.version, 0);
    assert.equal(current.pid, process.pid);
    assert.equal(current.profile, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
