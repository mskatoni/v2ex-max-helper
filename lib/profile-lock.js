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

function getProcessStartToken(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(Number(pid)) || Number(pid) < 1) return '';
  try {
    const stat = fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return '';
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTimeTicks = fields[19]; // /proc/<pid>/stat field 22; fields starts at field 3.
    return /^\d+$/.test(startTimeTicks || '') ? startTimeTicks : '';
  } catch (_) {
    return '';
  }
}

function isLockOwnerAlive(lock) {
  if (!lock || !lock.pid || !lock.processStartToken || !isProcessAlive(lock.pid)) return false;
  const current = getProcessStartToken(lock.pid);
  return Boolean(current && current === lock.processStartToken);
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
      processStartToken: parsed.processStartToken || null,
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

function lockProcessIsActive(lock) {
  if (!lock) return false;
  return lock.processStartToken ? isLockOwnerAlive(lock) : isProcessAlive(lock.pid);
}

function createLockRecord(details = {}) {
  return {
    version: 2,
    pid: process.pid,
    profile: details.profile || null,
    task: details.task || 'unknown',
    startedAt: new Date().toISOString(),
    token: crypto.randomBytes(16).toString('hex'),
    processStartToken: getProcessStartToken(process.pid) || null,
  };
}

function lockHandle(file, lock) {
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
}

function writeNewLock(file, lock) {
  fs.writeFileSync(file, `${JSON.stringify(lock)}\n`, { flag: 'wx', mode: 0o600 });
  return lockHandle(file, lock);
}

function acquireReclaimMarker(file) {
  const markerFile = `${file}.reclaim`;
  const marker = createLockRecord({ task: 'lock-reclaim' });
  try {
    return writeNewLock(markerFile, marker);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current = readLock(markerFile);
    if (lockProcessIsActive(current)) throw new LockBusyError(file, current);
    const staleError = new Error(`stale lock reclamation marker requires manual cleanup: ${markerFile}`);
    staleError.code = 'LOCK_RECLAIM_STALE';
    staleError.file = markerFile;
    throw staleError;
  }
}

function acquireLock(file, details = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = createLockRecord(details);
  try {
    return writeNewLock(file, lock);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const current = readLock(file);
  if (lockProcessIsActive(current)) throw new LockBusyError(file, current);

  const reclaim = acquireReclaimMarker(file);
  try {
    const latest = readLock(file);
    if (lockProcessIsActive(latest)) throw new LockBusyError(file, latest);
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      return writeNewLock(file, lock);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new LockBusyError(file, readLock(file));
    }
  } finally {
    reclaim.release();
  }
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
  if (lockProcessIsActive(current)) return false;
  const reclaim = acquireReclaimMarker(file);
  try {
    const latest = readLock(file);
    if (lockProcessIsActive(latest)) return false;
    try {
      fs.unlinkSync(file);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  } finally {
    reclaim.release();
  }
}

module.exports = {
  LockBusyError,
  acquireLock,
  acquireLockWithWait,
  clearStaleLock,
  getProcessStartToken,
  isLockOwnerAlive,
  isProcessAlive,
  readLock,
};
