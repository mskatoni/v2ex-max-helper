'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const bot = fs.readFileSync(path.join(root, 'reader', 'bot.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'reader', 'main.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

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
  assert.match(bot, /凭据更新失败且回滚不完整/);
  assert.match(bot, /rollbackFailures\.push\('Chromium 状态'\)/);
});

test('interrupted Chromium credential rotation restores its newest backup', () => {
  const start = bot.indexOf('function cleanupStaleChromeBackups');
  const end = bot.indexOf('\nfunction commitProfileCredentials', start);
  const body = bot.slice(start, end);
  assert.match(body, /!fs\.existsSync\(target\) && backups\.length > 0/);
  assert.match(body, /backups\.sort\(\(a, b\) => b\.mtimeMs - a\.mtimeMs\)/);
  assert.match(body, /fs\.renameSync\(recovered\.candidate, target\)/);
});

test('likely Telegram cookie messages are deleted before parsing, verification, or storage', () => {
  const deleteStart = bot.indexOf('async function deleteCookieSourceMessage');
  const importStart = bot.indexOf('async function handleCookieImport');
  const importEnd = bot.indexOf('// ========== 内置调度器', importStart);
  const body = bot.slice(importStart, importEnd);

  assert.ok(deleteStart >= 0, 'cookie message deletion helper must exist');
  assert.match(bot.slice(deleteStart, importStart), /tgRequest\('deleteMessage'/);
  assert.ok(body.indexOf('deleteCookieSourceMessage(sourceMessage)') < body.indexOf('extractCookie(text)'));
  assert.ok(body.indexOf('deleteCookieSourceMessage(sourceMessage)') < body.indexOf('importCookieResult'));
  const messageStart = bot.indexOf('async function handleMessage');
  const messageEnd = bot.indexOf('async function handleCallbackQuery', messageStart);
  const messageBody = bot.slice(messageStart, messageEnd);
  assert.ok(messageBody.indexOf('deleteCookieSourceMessage(msg)') >= 0);
  assert.ok(messageBody.indexOf('deleteCookieSourceMessage(msg)') < messageBody.indexOf('handleCookieImport(remaining, profile, null)'));
  assert.match(bot, /handleCookieImport\(text, null, msg\)/);
});

test('startup backlog is skipped without leaving cookie or binding secrets in chat', () => {
  assert.match(bot, /getUpdates', \{ offset: -100, limit: 100, timeout: 0 \}/);
  assert.match(bot, /await scrubSkippedSensitiveUpdates\(init\.result\)/);
  const scrubStart = bot.indexOf('async function scrubSkippedSensitiveUpdates');
  const scrubEnd = bot.indexOf('// ========== 内置调度器', scrubStart);
  const scrub = bot.slice(scrubStart, scrubEnd);
  assert.match(scrub, /message\.chat\.type !== 'private'/);
  assert.match(scrub, /deleteCookieSourceMessage\(message\)/);
  assert.match(scrub, /deleteBindingSourceMessage\(message\)/);
});

test('binding secrets are deleted and compared without ordinary string equality', () => {
  const start = bot.indexOf('async function handleUnboundMessage');
  const end = bot.indexOf('async function poll', start);
  const body = bot.slice(start, end);
  assert.match(body, /deleteBindingSourceMessage\(msg\)/);
  assert.match(body, /safeSecretEqual\(bindCommand\.argsText, SETUP_CODE\)/);
  assert.doesNotMatch(body, /bindCommand\.argsText !== SETUP_CODE/);
  assert.match(bot, /function loadAuthorizedChatId\(\) \{\s*return cfg\.telegram\.chatId;\s*\}/);
  const boundStart = bot.indexOf('async function handleMessage');
  const boundEnd = bot.indexOf('async function handleCallbackQuery', boundStart);
  const boundBody = bot.slice(boundStart, boundEnd);
  assert.match(boundBody, /cmd === '\/bind'[\s\S]{0,160}deleteBindingSourceMessage\(msg\)/);
  const deleteStart = bot.indexOf('async function deleteBindingSourceMessage');
  const deleteEnd = bot.indexOf('function setPendingCookieImport', deleteStart);
  const deleteBody = bot.slice(deleteStart, deleteEnd);
  assert.match(deleteBody, /tgRequest\('deleteMessage'/);
  assert.match(deleteBody, /result && result\.ok/);
  assert.match(deleteBody, /请立即在 Telegram 中手动删除/);
});

test('Bot reports failed local writes and expired callback actions', () => {
  const debugStart = bot.indexOf('async function handleDebug');
  const debugEnd = bot.indexOf('function getDebugKeyboardMarkup', debugStart);
  const debugBody = bot.slice(debugStart, debugEnd);
  assert.match(debugBody, /const previousLevel = currentLogLevel/);
  assert.match(debugBody, /currentLogLevel = previousLevel/);
  assert.match(debugBody, /日志级别保存失败，原设置未改变/);

  const callbackStart = bot.indexOf('async function handleCallbackQuery');
  const callbackEnd = bot.indexOf('async function handleUnboundMessage', callbackStart);
  const callbackBody = bot.slice(callbackStart, callbackEnd);
  assert.match(callbackBody, /else \{\s*await sendOrEdit\(messageId, '⚠️ 操作已失效，请重新打开面板'/);
});

test('Bot startup logging respects the configured OFF level', () => {
  assert.match(bot, /if \(shouldWriteLog\('INFO'\)\) \{\s*fs\.appendFileSync\(READER_LOG/);
});

test('Bot bounds callback state and rejects a mistyped explicit cookie profile', () => {
  assert.match(bot, /const MAX_INTERACTION_SESSIONS = 128/);
  assert.match(bot, /while \(interactionSessions\.size >= MAX_INTERACTION_SESSIONS\)/);
  assert.match(bot, /const startsWithCookieHeader = \/\^cookie:\$\/i\.test\(firstToken\)/);
  assert.match(bot, /!profile && tail && !startsWithCookieHeader/);
  assert.match(bot, /await sendUnknownProfile\(firstToken\)/);
});

test('expected reader stops are not reported as task failures', () => {
  assert.match(bot, /const stoppedByRequest = result\.status !== 'timed_out'/);
  assert.match(main, /shutdown\(sig, stats, exitCode, \{ expectedStop: true \}\)/);
  assert.match(main, /exitCode !== 0 && !options\.expectedStop/);
});

test('scheduler avoids lock-wait children and reports corrupt state only once', () => {
  assert.match(bot, /profileSequenceRunning \|\| runningTask \|\| hasActiveReaderLock\(\)/);
  assert.match(bot, /let invalidStateReported = false/);
  assert.match(bot, /if \(!invalidStateReported\)/);
});

test('manual tasks reject an active external credential owner before spawning', () => {
  const start = bot.indexOf('function getTaskStartError');
  const end = bot.indexOf('\nfunction reportManualTaskResult', start);
  const source = bot.slice(start, end);
  assert.match(bot, /function getActiveCredentialLock\(profile\)/);
  assert.match(source, /getActiveCredentialLock\(profile\)/);
  assert.match(source, /正在执行/);
});

test('manual checkin reports a successful child exit', () => {
  const start = bot.indexOf('function reportManualTaskResult');
  const end = bot.indexOf('\nasync function startProfileCheckin', start);
  const source = bot.slice(start, end);
  assert.match(source, /result\.status === 'ok'/);
  assert.match(source, /taskLabel === '签到'/);
  assert.match(source, /手动签到已完成/);
});

test('account panel switches occupied slots and sends empty slots to cookie import', () => {
  assert.match(bot, /当前操作账号/);
  assert.match(bot, /text: '👤 切换账号'/);
  assert.match(bot, /请从面板选择「切换账号」进入空位置/);
  assert.doesNotMatch(bot, /请选择「导入 Cookie」/);
  assert.match(bot, /const account = getProfileAccountState\(profile\);[\s\S]{0,180}!account\.occupied[\s\S]{0,100}beginCookieImport\(profile, messageId\)/);
  assert.match(bot, /setActiveControlProfile\(profile\);[\s\S]{0,180}buildMainPanelText/);
  assert.match(bot, /空（位置 <code>/);
  assert.match(bot, /有任务/);
});

test('manual Bot reads use only the four supported counts without profile ambiguity', () => {
  assert.match(bot, /return \[5, 10, 50, 250\]\.includes\(limit\) \? limit : null/);
  assert.match(bot, /阅读数量仅支持 5、10、50、250/);
  assert.match(bot, /clearPendingCookieImport\(\);\s*const staged = setPendingCookieImport\(\{ profile: null, candidate/);
});

test('main panel actions keep the profile snapshot shown by that panel', () => {
  assert.match(bot, /createInteractionSession\('m',[\s\S]{0,80}\[profile\]\)/);
  assert.match(bot, /callback_data: `ma:\$\{sessionId\}:r`/);
  assert.match(bot, /session\.action === 'm' \? session\.profiles\[0\] : null/);
  assert.match(bot, /旧版主面板未绑定账号位置，已拒绝执行/);
});

test('text and panel help share one complete command reference', () => {
  const help = (bot.match(/function buildHelpText\(\)[\s\S]*?\n}\n\nasync function handleHelp/) || [])[0] || '';
  for (const command of ['/start', '/help', '/sou', '/tasks', '/checkin', '/read', '/stop', '/cookie', '/debug', '/bind']) {
    assert.equal(help.includes(command), true, `help should include ${command}`);
    assert.equal(readme.includes(`\`${command}`), true, `README should include ${command}`);
  }
  assert.match(bot, /handleHelp\(\)[\s\S]{0,100}buildHelpText\(\)/);
  assert.match(bot, /data === 'show_help'[\s\S]{0,100}buildHelpText\(\)/);
});

test('text and panel task status use the same state builder', () => {
  assert.match(bot, /async function handleTasks\(\) \{\s*return sendMsg\(buildTaskStatusView\(\)\.text\);/);
  const callbackStart = bot.indexOf("else if (data === 'query_tasks')");
  const callbackEnd = bot.indexOf("else if (data.startsWith('st:'))", callbackStart);
  assert.match(bot.slice(callbackStart, callbackEnd), /const status = buildTaskStatusView\(\)/);
});

test('Telegram command aliases, bot mentions, and command menu stay compatible', () => {
  assert.ok(bot.includes("'/balance': '/sou'"));
  assert.ok(bot.includes("'/status': '/tasks'"));
  assert.ok(bot.includes("'/stats': '/tasks'"));
  assert.match(bot, /const parsedCommand = parseTelegramCommand\(text\)/);
  assert.match(bot, /\(\?:@\[a-z0-9_\]\+\)\?/i);
  for (const command of ['start', 'help', 'sou', 'tasks', 'checkin', 'read', 'stop', 'cookie', 'debug', 'bind']) {
    assert.ok(bot.includes(`{ command: '${command}'`), `menu should include ${command}`);
  }
  assert.match(bot, /tgRequest\('deleteMyCommands'/);
  assert.match(bot, /tgRequest\('setMyCommands'/);
  assert.match(bot, /scope: \{ type: 'chat', chat_id: ALLOWED_CHAT_ID \}/);

  const aliasesStart = bot.indexOf('const TELEGRAM_COMMAND_ALIASES');
  const aliasesEnd = bot.indexOf('\n\nif (!TOKEN)', aliasesStart);
  const parserStart = bot.indexOf('function parseTelegramCommand');
  const parserEnd = bot.indexOf('\n\nasync function handleReadCommand', parserStart);
  const sandbox = {};
  vm.runInNewContext(
    `${bot.slice(aliasesStart, aliasesEnd)}\n${bot.slice(parserStart, parserEnd)}\n` +
    'result = { parseTelegramCommand };',
    sandbox
  );
  const parse = sandbox.result.parseTelegramCommand;
  assert.equal(parse('/stats').command, '/tasks');
  assert.equal(parse('/status@v2ex_reader_bot').command, '/tasks');
  assert.equal(parse('/balance 1').command, '/sou');
  assert.deepEqual(Array.from(parse('/balance 1').args), ['1']);
  assert.equal(parse('/cookie@v2ex_reader_bot A2=secret; PB3_SESSION=session').argsText, 'A2=secret; PB3_SESSION=session');
  assert.equal(parse('A2=secret'), null);
});

test('every emitted callback has a current handler and mutating panels expire', () => {
  const callbackStart = bot.indexOf('async function handleCallbackQuery');
  const callbackEnd = bot.indexOf('async function handleUnboundMessage', callbackStart);
  const callbackBody = bot.slice(callbackStart, callbackEnd);
  const staticCallbacks = new Set(
    [...bot.matchAll(/callback_data:\s*'([^']+)'/g)].map(match => match[1])
  );
  for (const callback of staticCallbacks) {
    assert.ok(callbackBody.includes(`data === '${callback}'`), `missing handler for ${callback}`);
  }
  const dynamicPrefixes = new Set(
    [...bot.matchAll(/callback_data:\s*`([a-z]+):/g)].map(match => match[1])
  );
  for (const prefix of dynamicPrefixes) {
    assert.ok(callbackBody.includes(`data.startsWith('${prefix}:')`), `missing handler for ${prefix}:*`);
  }
  assert.equal(bot.includes("callback_data: 'run_profile_sequence'"), false);
  assert.equal(bot.includes("callback_data: 'set_debug_off'"), false);
  assert.match(bot, /callback_data: `sq:\$\{sessionId\}`/);
  assert.match(bot, /callback_data: `ds:\$\{sessionId\}:off`/);
  assert.match(callbackBody, /data === 'run_profile_sequence'[\s\S]{0,220}已拒绝执行/);
  assert.match(callbackBody, /data\.startsWith\('set_debug_'\)[\s\S]{0,220}原设置未改变/);
});

test('Bot escapes user-controlled values in HTML error replies', () => {
  assert.match(bot, /无效的级别 <code>\$\{escapeHtml\(levelArg\)\}<\/code>/);
  assert.match(bot, /绑定失败: \$\{escapeHtml\(e\.message\)\}/);
});

test('container entrypoint does not write V2EX_COOKIE directly', () => {
  const entrypoint = fs.readFileSync(path.join(root, 'scripts', 'entrypoint.sh'), 'utf8');
  assert.equal(entrypoint.includes('printf \'%s\' "$V2EX_COOKIE"'), false);
  assert.match(entrypoint, /入口脚本不直接触碰登录凭证/);
  assert.match(bot, /delete process\.env\.V2EX_COOKIE/);
  assert.match(entrypoint, /^exec node reader\/bot\.js$/m);
  assert.match(bot, /let STARTUP_COOKIE = process\.env\.V2EX_COOKIE \|\| '';\s*delete process\.env\.V2EX_COOKIE;/);
  assert.match(bot, /STARTUP_COOKIE = '';/);
});

test('Bot health wall shares the Docker default port without a second Node process', () => {
  assert.match(bot, /process\.env\.PORT \|\| '8080'/);
  const entrypoint = fs.readFileSync(path.join(root, 'scripts', 'entrypoint.sh'), 'utf8');
  assert.match(entrypoint, /^exec node reader\/bot\.js$/m);
});

test('a stop request for another profile cannot cancel the serial sequence', () => {
  const start = bot.indexOf('async function requestTaskStop');
  const end = bot.indexOf('\n// /stop [profile]', start);
  assert.ok(start >= 0 && end > start, 'requestTaskStop source must be present');
  const handler = bot.slice(start, end);
  const taskMismatch = handler.indexOf('runningTask.profile !== profile');
  const lockMismatch = handler.indexOf('lock.profile !== profile');
  const firstCancel = handler.indexOf('sequenceCancelRequested = true');
  assert.ok(taskMismatch >= 0 && firstCancel > taskMismatch);
  assert.ok(lockMismatch >= 0 && handler.indexOf('sequenceCancelRequested = true', lockMismatch) > lockMismatch);
});

test('stop buttons are bound to task identity and managed children stop as a process group', () => {
  assert.match(bot, /createInteractionSession\('m', getActiveTaskSnapshot\(\)/);
  assert.match(bot, /callback_data: `ma:\$\{sessionId\}:x`/);
  assert.match(bot, /createInteractionSession\(\s*'x',\s*getActiveTaskSnapshot\(\)/);
  assert.match(bot, /expectedSnapshot !== currentSnapshot/);
  assert.match(bot, /旧版停止按钮未绑定具体任务/);
  assert.match(bot, /detached: process\.platform !== 'win32'/);
  assert.match(bot, /process\.kill\(-task\.child\.pid, signal\)/);
  assert.match(bot, /task\.completion = completion/);
  assert.match(bot, /await stopManagedTask\(task\)/);
  assert.match(bot, /lock\.processStartToken[\s\S]{0,100}profileLock\.isLockOwnerAlive\(lock\)/);
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
  const shutdownStart = reader.indexOf('async function shutdown');
  const shutdownEnd = reader.indexOf('async function verifyAndBindProfile', shutdownStart);
  const shutdownBody = reader.slice(shutdownStart, shutdownEnd);
  assert.ok(shutdownBody.indexOf('await browser.close()') < shutdownBody.indexOf('await notify.notifyReaderError(stats)'));
  assert.ok(shutdownBody.indexOf('queue.close()') < shutdownBody.indexOf('await notify.notifyReaderError(stats)'));
  assert.match(shutdownBody, /Queue close failed:[\s\S]{0,180}exitCode = 1/);
});

test('queue refills cannot silently loop forever after every source fails', () => {
  const fetcher = fs.readFileSync(path.join(root, 'reader', 'fetcher.js'), 'utf8');
  assert.match(fetcher, /e\.code === 'SESSION_EXPIRED'/);
  assert.match(fetcher, /Fetcher all \$\{failedSources\} sources failed/);
  assert.match(fetcher, /Fetcher found no topic URLs/);
});

test('single-profile scheduler catches missed minutes and persists restart state', () => {
  const start = bot.indexOf('function startScheduler');
  const end = bot.indexOf('// ========== 铁墙 HTTP', start);
  const scheduler = bot.slice(start, end);
  assert.match(scheduler, /mode === 'single'/);
  assert.match(scheduler, /persistSingleState/);
  assert.match(scheduler, /localMinutes >= PROFILE_SEQUENCE_START_LOCAL_MINUTES/);
  assert.match(scheduler, /localMinutes >= PROFILE_SEQUENCE_START_LOCAL_MINUTES \+ 5/);
  assert.doesNotMatch(scheduler, /h === 9 && m === 10/);
  assert.doesNotMatch(scheduler, /h === 9 && m === 15/);
  assert.match(bot, /return \{ invalid: true \}/);
  assert.match(scheduler, /saved && saved\.invalid[\s\S]{0,180}自动调度已停用/);
});
