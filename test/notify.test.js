'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const runner = String.raw`
const https = require('https');
const { EventEmitter } = require('events');
const mode = process.env.MOCK_NOTIFY_MODE;
let requestCount = 0;

https.request = (options, callback) => {
  requestCount++;
  const req = new EventEmitter();
  let timeoutHandler = null;
  req.write = () => {};
  req.destroy = () => {};
  req.setTimeout = (_ms, handler) => { timeoutHandler = handler; };
  req.end = () => {
    if (mode === 'network') {
      setImmediate(() => req.emit('error', new Error('private upstream detail')));
      return;
    }
    if (mode === 'timeout') {
      setImmediate(() => timeoutHandler && timeoutHandler());
      return;
    }
    const res = new EventEmitter();
    res.statusCode = Number(mode);
    res.resume = () => {};
    res.setEncoding = () => {};
    callback(res);
    setImmediate(() => {
      if (mode === 'large') {
        res.emit('data', 'x'.repeat(64 * 1024 + 1));
      } else if (mode === '200') {
        res.emit('data', options.hostname === 'api.telegram.org' ? '{"ok":true}' : '{"code":0}');
      } else if (mode === 'object') {
        res.emit('data', '{}');
      }
      res.emit('end');
    });
  };
  return req;
};

require('./reader/notify').sendMessage('local notification test')
  .then(() => console.log('done\nrequests:' + requestCount))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
`;

function notifyEnv(channel, mode) {
  const env = {
    ...process.env,
    MOCK_NOTIFY_MODE: mode,
    V2EX_PROXY_ENABLE: '0',
    V2EX_PROFILE: 'acc1',
    TG_TOKEN: '',
    TG_CHAT_ID: '',
    FEISHU_ENABLE: '0',
    FEISHU_WEBHOOK: '',
  };
  if (channel === 'Telegram') {
    env.TG_TOKEN = 'test-token-private';
  env.TG_CHAT_ID = ['123', '456', '789'].join('');
  } else {
    env.FEISHU_ENABLE = '1';
    env.FEISHU_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/x';
  }
  return env;
}

function run(channel, mode) {
  return childProcess.spawnSync(process.execPath, ['-e', runner], {
    cwd: repoRoot,
    env: notifyEnv(channel, mode),
    encoding: 'utf8',
    timeout: 10000,
  });
}

function assertNoCredentialEcho(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(output, /test-token-private|123456789|open-apis\/bot\/v2\/hook/);
}

function requestCount(result) {
  const match = result.stdout.match(/requests:(\d+)/);
  assert.ok(match, result.stdout);
  return Number(match[1]);
}

test('Telegram notification handles 2xx, 4xx, 5xx, timeout, and network errors locally', () => {
  for (const mode of ['200', '400', '500', 'timeout', 'network', 'large']) {
    const result = run('Telegram', mode);
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
    assert.match(result.stdout, /done/);
    assertNoCredentialEcho(result);
    if (mode === '200') assert.doesNotMatch(result.stderr, /推送失败/);
    else assert.match(result.stderr, /Telegram 推送失败/);
    assert.equal(requestCount(result), ['500', 'timeout', 'network', 'large'].includes(mode) ? 4 : 1);
  }
});

test('Feishu notification handles 2xx and failure paths without leaking its webhook', () => {
  for (const mode of ['200', 'empty', 'object', '500', 'timeout', 'network', 'large']) {
    const result = run('Feishu', mode);
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
    assert.match(result.stdout, /done/);
    assertNoCredentialEcho(result);
    if (mode === '200') assert.doesNotMatch(result.stderr, /推送失败/);
    else assert.match(result.stderr, /Feishu 推送失败/);
    assert.equal(requestCount(result), ['500', 'timeout', 'network', 'large'].includes(mode) ? 4 : 1);
  }
});

test('notification templates escape dynamic Telegram HTML fields', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(repoRoot, 'reader', 'notify.js'), 'utf8');
  assert.match(source, /function escapeHtml\(value\)/);
  assert.match(source, /escapeHtml\(stats\.reason \|\| '达到上限'\)/);
  assert.match(source, /escapeHtml\(result\.message \|\| ''\)/);
});
