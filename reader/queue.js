'use strict';
// ========== SQLite 队列管理（sql.js 纯 JS 版）==========
const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');
const config = require('../lib/config');

const cfg = config.getConfig();
const DB_PATH = cfg.dbPath;

let db = null;
let dirty = false;

async function init() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  // 确保数据库目录存在
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 如果数据库文件已存在，加载它
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
    logger.info(`Queue DB loaded: ${DB_PATH}`);
  } else {
    db = new SQL.Database();
    logger.info(`Queue DB created: ${DB_PATH}`);
  }

  const hadPostsTable = tableExists('posts');
  db.run(`
    CREATE TABLE IF NOT EXISTS posts (
      url        TEXT PRIMARY KEY,
      read_count INTEGER NOT NULL DEFAULT 0,
      last_read  INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  if (!hadPostsTable) {
    dirty = true;
    flush();
  }
}

function tableExists(name) {
  const safeName = String(name).replace(/'/g, "''");
  const result = db.exec(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${safeName}'`
  );
  return result.length > 0 && result[0].values.length > 0;
}

// 持久化到磁盘：先写临时文件，再原子替换目标文件。
function flush() {
  if (!dirty || !db) return false;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    const data = db.export();
    fs.writeFileSync(tmp, Buffer.from(data), { mode: 0o600 });
    fs.renameSync(tmp, DB_PATH);
    dirty = false;
    logger.info(`Queue DB saved: ${DB_PATH}`);
    return true;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    logger.error(`Queue DB save failed: ${e.message}`);
    throw e;
  }
}

function withTransaction(fn) {
  db.run('BEGIN TRANSACTION');
  try {
    const changed = fn();
    db.run('COMMIT');
    if (changed) {
      dirty = true;
      flush();
    }
    return changed;
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

// 批量插入新帖（已存在则忽略）
function add(urls) {
  let added = withTransaction(() => {
    let count = 0;
    const stmt = db.prepare('INSERT OR IGNORE INTO posts (url) VALUES (?)');
    try {
      for (const u of urls) {
        stmt.run([u]);
        if (db.getRowsModified() > 0) count++;
      }
    } finally {
      stmt.free();
    }
    return count;
  });
  if (added > 0) {
    logger.info(`Queue +${added} new posts (total available: ${size()})`);
  }
}

// 取一条可读帖子（read_count < 3）
function pop() {
  const result = db.exec(
    'SELECT url FROM posts WHERE read_count < 3 ORDER BY read_count ASC, created_at ASC LIMIT 1'
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return result[0].values[0][0];
}

// 读取计数 +1
function increment(url) {
  withTransaction(() => {
    db.run(
      "UPDATE posts SET read_count = read_count + 1, last_read = strftime('%s','now') WHERE url = ?",
      [url]
    );
    return db.getRowsModified() > 0;
  });
}

// 失败帖标记为已读满，避免同一个异常 URL 连续触发停机
function skip(url) {
  withTransaction(() => {
    db.run(
      "UPDATE posts SET read_count = 3, last_read = strftime('%s','now') WHERE url = ?",
      [url]
    );
    return db.getRowsModified() > 0;
  });
}

// 当前可读条数
function size() {
  const r = db.exec('SELECT COUNT(*) FROM posts WHERE read_count < 3');
  return (r.length > 0 && r[0].values.length > 0) ? r[0].values[0][0] : 0;
}

// 清理 read_count >= 3 且超过7天的旧记录
function cleanup() {
  const threshold = Math.floor(Date.now() / 1000) - 7 * 86400;
  const changed = withTransaction(() => {
    db.run('DELETE FROM posts WHERE read_count >= 3 AND last_read < ?', [threshold]);
    return db.getRowsModified();
  });
  if (changed > 0) {
    logger.info(`Queue cleanup: removed ${changed} old records`);
  }
}

// 统计信息
function stats() {
  const total     = (db.exec('SELECT COUNT(*) FROM posts')[0] || { values: [[0]] }).values[0][0];
  const readable  = size();
  const exhausted = (db.exec('SELECT COUNT(*) FROM posts WHERE read_count >= 3')[0] || { values: [[0]] }).values[0][0];
  return { total, readable, exhausted };
}

function close() {
  flush();
  if (db && typeof db.close === 'function') {
    db.close();
  }
  db = null;
}

module.exports = { init, add, pop, increment, skip, size, cleanup, stats, flush, close };
