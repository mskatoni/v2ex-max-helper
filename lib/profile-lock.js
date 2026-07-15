'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function readLock(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      return { version: 0, pid: parseInt(raw, 10), profile: null, task: 'reader', token: null };
    }
    const parsed = JSON.parse(raw);
    const pid = parseInt(parsed.pid, 10);
    if (!pid) return null;
    return {
      version: parsed.version || 1,
      pid,
      profile: parsed.profile || null,
      task: parsed.task || 'unknown',
      startedAt: parsed.startedAt || null,
      token: parsed.token || null,
    };
  } catch (_) {
    return null;
  }
}

class LockBusyError extends Error {
  constructor(file, lock) {
    const detail = lock && lock.profile ? `profile=${lock.profile}, task=${lock.task}` : 'unknown owner';
    super(`lock busy: ${detail}`);
    this.name = 'LockBusyError';
    this.code = 'LOCK_BUSY';
    this.file = file;
    this.lock = lock || null;
  }
}

function acquireLock(file, details = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const lock = {
      version: 1,
      pid: process.pid,
      profile: details.profile || null,
      task: details.task || 'unknown',
      startedAt: new Date().toISOString(),
      token: crypto.randomBytes(16).toString('hex'),
    };
    try {
      fs.writeFileSync(file, `${JSON.stringify(lock)}\n`, { flag: 'wx', mode: 0o600 });
      let released = false;
      return {
        lock,
        release() {
          if (released) return;
          released = true;
          const current = readLock(file);
          if (current && current.pid === process.pid && current.token === lock.token) {
            try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    const current = readLock(file);
    if (current && isProcessAlive(current.pid)) throw new LockBusyError(file, current);
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error(`failed to acquire lock after retries: ${file}`);
}

async function acquireLockWithWait(file, details = {}, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
  const retryMs = Math.max(1, Number(options.retryMs) || 30000);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      return acquireLock(file, details);
    } catch (e) {
      if (e.code !== 'LOCK_BUSY' || Date.now() >= deadline) throw e;
      const remainingMs = Math.max(0, deadline - Date.now());
      if (typeof options.onWait === 'function') options.onWait(e, remainingMs);
      await new Promise(resolve => setTimeout(resolve, Math.min(retryMs, remainingMs)));
    }
  }
}

function clearStaleLock(file) {
  if (!fs.existsSync(file)) return false;
  const current = readLock(file);
  if (current && isProcessAlive(current.pid)) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

module.exports = {
  LockBusyError,
  acquireLock,
  acquireLockWithWait,
  clearStaleLock,
  isProcessAlive,
  readLock,
};
