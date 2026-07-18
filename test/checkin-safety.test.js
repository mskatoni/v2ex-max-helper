'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const checkin = require('../checkin/v2ex-checkin');

test('deletion Set-Cookie values remove stale credentials', () => {
  const merged = checkin.mergeSetCookies(
    'A2=old; PB3_SESSION=keep; V2EX_LANG=zhcn',
    ['A2=deleted; Max-Age=0; Path=/; Secure; HttpOnly', 'V2EX_LANG=en; Path=/']
  );
  assert.equal(merged.changed, true);
  assert.equal(merged.cookie.includes('A2='), false);
  assert.match(merged.cookie, /PB3_SESSION=keep/);
  assert.match(merged.cookie, /V2EX_LANG=en/);
});

test('flat cookie persistence ignores incompatible Path and Domain scopes', () => {
  const merged = checkin.mergeSetCookies(
    'A2=root; V2EX_LANG=zhcn',
    [
      'A2=deleted; Max-Age=0; Path=/mission; Secure; HttpOnly',
      'V2EX_LANG=evil; Domain=example.com; Path=/',
      'PB3_SESSION=fresh; Domain=.v2ex.com; Path=/; Secure; HttpOnly',
    ]
  );
  assert.equal(merged.changed, true);
  assert.match(merged.cookie, /A2=root/);
  assert.match(merged.cookie, /V2EX_LANG=zhcn/);
  assert.match(merged.cookie, /PB3_SESSION=fresh/);
});

test('login status requires real authenticated navigation', () => {
  assert.equal(checkin.parseLoginStatus('<script>const route="/signout"</script>').logged_in, false);
  assert.equal(checkin.parseLoginStatus('<a href="/signin">Sign in</a>').logged_in, false);
  assert.equal(checkin.parseLoginStatus('<a href="/signout?once=1">Sign out</a>').logged_in, true);
});

test('HTTP success guard rejects redirects and error pages', () => {
  assert.equal(checkin.requireSuccess({ statusCode: 204 }, 'test').statusCode, 204);
  assert.throws(() => checkin.requireSuccess({ statusCode: 302 }, 'test'), /HTTP 302/);
  assert.throws(() => checkin.requireSuccess({ statusCode: 500 }, 'test'), /HTTP 500/);
});

test('balance parser does not invent a value when the coin block changed', () => {
  assert.equal(checkin.formatBalance('<div class="balance_area bigger">no coins</div>'), '');
  assert.equal(
    checkin.formatBalance('<div class="balance_area bigger">1 <img alt="G"> 2 <img alt="S"> 3 <img alt="B"></div>'),
    '1 金币, 2 银币, 3 铜币'
  );
});

test('balance query and cookie refresh cannot silently report success', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'checkin', 'v2ex-checkin.js'), 'utf8');
  const queryStart = source.indexOf('async function queryBalance');
  const queryEnd = source.indexOf('// ========== Logger', queryStart);
  const queryBody = source.slice(queryStart, queryEnd);
  assert.match(queryBody, /refreshCookieFromResponse\(cookie, response\.setCookies\)/);
  assert.match(queryBody, /if \(!balance\) throw new Error\('余额页结构无法识别'\)/);

  const refreshStart = source.indexOf('function refreshCookieFromResponse');
  const refreshEnd = source.indexOf('function logCookieChanges', refreshStart);
  assert.match(source.slice(refreshStart, refreshEnd), /if \(!writeCookie\(cookie\)\) throw new Error\('Cookie 续期写回失败'\)/);
});

test('ping reports missing or invalid credentials as a failed process', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'checkin', 'v2ex-checkin.js'), 'utf8');
  const start = source.indexOf('async function doPing');
  const end = source.indexOf('// ========== 主签到逻辑', start);
  const body = source.slice(start, end);
  assert.match(body, /无 Cookie，跳过保活'\);\s*process\.exitCode = 1/);
  assert.match(body, /Cookie 已失效（保活检测）[\s\S]{0,300}process\.exitCode = 1/);
});

test('checkin notifications keep Telegram credentials out of query strings', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'checkin', 'v2ex-checkin.js'), 'utf8');
  const start = source.indexOf('function sendTelegram');
  const end = source.indexOf('function sendFeishu', start);
  const body = source.slice(start, end);
  assert.match(body, /method: 'POST'/);
  assert.match(body, /JSON\.stringify\(\{ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' \}\)/);
  assert.doesNotMatch(body, /\?chat_id=/);
  assert.match(source, /parsed\.origin === COOKIE_ORIGIN[\s\S]{0,120}Accept: 'application\/json'/);
});
