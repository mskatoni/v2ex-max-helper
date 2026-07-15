'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const bot = fs.readFileSync(path.join(root, 'reader', 'bot.js'), 'utf8');

test('legacy read callbacks cannot launch the first profile', () => {
  assert.equal(bot.includes('await handleRead(getOnlyProfile(), count'), false);
  assert.match(bot, /旧版按钮未携带可靠的账号信息/);
  assert.match(bot, /callback_data: `ps:\$\{sessionId\}/);
});

test('cookie import verifies before committing and never advertises old-field merge', () => {
  const start = bot.indexOf('async function importCookieResult');
  const end = bot.indexOf('async function applyPendingCookie', start);
  const body = bot.slice(start, end);
  assert.ok(body.indexOf('verifyAndCompare') >= 0);
  assert.ok(body.indexOf('commitProfileCredentials') > body.indexOf('verifyAndCompare'));
  assert.equal(body.includes('已保留旧值'), false);
});

test('recognized Telegram cookie messages are deleted before verification or storage', () => {
  const deleteStart = bot.indexOf('async function deleteCookieSourceMessage');
  const importStart = bot.indexOf('async function handleCookieImport');
  const importEnd = bot.indexOf('// ========== 内置调度器', importStart);
  const body = bot.slice(importStart, importEnd);

  assert.ok(deleteStart >= 0, 'cookie message deletion helper must exist');
  assert.match(bot.slice(deleteStart, importStart), /tgRequest\('deleteMessage'/);
  assert.ok(body.indexOf('extractCookie(text)') < body.indexOf('deleteCookieSourceMessage(sourceMessage)'));
  assert.ok(body.indexOf('deleteCookieSourceMessage(sourceMessage)') < body.indexOf('importCookieResult'));
  assert.match(bot, /handleCookieImport\(remaining, profile, msg\)/);
  assert.match(bot, /handleCookieImport\(text, null, msg\)/);
});

test('container entrypoint does not write V2EX_COOKIE directly', () => {
  const entrypoint = fs.readFileSync(path.join(root, 'scripts', 'entrypoint.sh'), 'utf8');
  assert.equal(entrypoint.includes('printf \'%s\' "$V2EX_COOKIE"'), false);
  assert.match(entrypoint, /入口脚本不直接触碰登录凭证/);
  assert.match(bot, /delete process\.env\.V2EX_COOKIE/);
});

test('a stop request for another profile cannot cancel the serial sequence', () => {
  const start = bot.indexOf('async function handleStop');
  const end = bot.indexOf('\nfunction escapeHtml', start);
  assert.ok(start >= 0 && end > start, 'handleStop source must be present');
  const handler = bot.slice(start, end);
  const taskMismatch = handler.indexOf('runningTask.profile !== profile');
  const lockMismatch = handler.indexOf('lock.profile !== profile');
  const firstCancel = handler.indexOf('sequenceCancelRequested = true');
  assert.ok(taskMismatch >= 0 && firstCancel > taskMismatch);
  assert.ok(lockMismatch >= 0 && handler.indexOf('sequenceCancelRequested = true', lockMismatch) > lockMismatch);
});

test('first identity binding clears unknown legacy browser credentials', () => {
  const reader = fs.readFileSync(path.join(root, 'reader', 'main.js'), 'utf8');
  const checkin = fs.readFileSync(path.join(root, 'checkin', 'v2ex-checkin.js'), 'utf8');
  assert.match(bot, /replaceIdentity \|\| verification\.identityState === 'unbound'/);
  assert.match(reader, /identityState === 'unbound'[\s\S]{0,120}safeRemoveChromeProfile/);
  assert.match(checkin, /identityState === 'unbound'[\s\S]{0,120}safeRemoveChromeProfile/);
});

test('reader shutdown cannot mark more queue entries after a signal', () => {
  const reader = fs.readFileSync(path.join(root, 'reader', 'main.js'), 'utf8');
  const readStart = reader.indexOf('const ok = await browser.readPost(url)');
  const shutdownGuard = reader.indexOf('if (isShuttingDown) return;', readStart);
  const queueSkip = reader.indexOf('queue.skip(url)', readStart);
  assert.ok(readStart >= 0 && shutdownGuard > readStart && queueSkip > shutdownGuard);
  assert.match(reader, /process\.once\('SIGTERM'/);
  assert.match(reader, /exitCode === 0[\s\S]{0,260}logger\.warn\(`停止原因/);
});
