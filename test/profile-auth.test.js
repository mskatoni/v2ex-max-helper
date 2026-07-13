'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../lib/profile-auth');

test('cookie import is a replacement candidate and drops tracking fields', () => {
  const parsed = auth.parseCookieInput('A2=new; PB3_SESSION=session; cf_clearance=cf; _ga=shared; _gid=shared2');
  assert.equal(parsed.get('A2'), 'new');
  assert.equal(parsed.get('PB3_SESSION'), 'session');
  assert.equal(parsed.has('_ga'), false);
  assert.equal(parsed.has('_gid'), false);
  assert.equal(auth.serializeCookieMap(parsed), 'A2=new; PB3_SESSION=session; cf_clearance=cf');
});

test('cookie parser rejects missing A2 and control characters', () => {
  assert.throws(() => auth.parseCookieInput('PB3_SESSION=only'), /A2/);
  assert.throws(() => auth.parseCookieInput('A2=ok\r\nInjected=yes'), /控制字符/);
});

test('identity extraction requires one unique account', () => {
  assert.equal(auth.extractIdentity('<a href="/member/Alice">Alice</a>'), 'alice');
  assert.equal(auth.extractIdentity('<a href="/member/Alice">A</a><a href="/member/Bob">B</a>'), '');
  assert.equal(
    auth.extractIdentity('<a href="/member/Alice" class="top">Alice</a><a href="/member/Bob">history</a>'),
    'alice'
  );
});

test('authenticated home fallback requires private navigation and a unique top account', async () => {
  const home = [
    '<a href="/member/Alice" class="top">Alice</a>',
    '<a href="/notifications">Notifications</a>',
    '<a href="/signout">Sign out</a>',
    '<a href="/member/Bob">post author</a>',
  ].join('');
  const result = await auth.verifyCookie('A2=test', {
    requestPage: async (_cookie, _options, target) => {
      if (target.endsWith('/balance')) throw new Error('balance timeout');
      return { statusCode: 200, body: home };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.identity, 'alice');
  assert.equal(result.verificationSource, 'home_fallback');
  assert.equal(result.fallbackCode, 'balance_request_failed');
});

test('home fallback rejects public or logged-out pages', () => {
  const publicPage = auth.diagnoseHomePage({
    statusCode: 200,
    body: '<a href="/member/Alice">post author</a><a href="/signin">Sign in</a>',
  });
  assert.equal(publicPage.ok, false);
  assert.equal(publicPage.code, 'logged_out');

  const missingTopIdentity = auth.diagnoseHomePage({
    statusCode: 200,
    body: '<a href="/notifications">N</a><a href="/signout">S</a><a href="/member/Alice">post author</a>',
  });
  assert.equal(missingTopIdentity.ok, false);
  assert.equal(missingTopIdentity.code, 'identity_unverified');
});

test('a sign-in string does not override explicit authenticated navigation', () => {
  const page = auth.diagnoseHomePage({
    statusCode: 200,
    body: '<script>const help="/signin"</script><a class="top" href="/member/Alice">A</a><a href="/notifications">N</a><a href="/signout">S</a>',
  });
  assert.equal(page.ok, true);
});

test('public member links alone never prove an authenticated session', () => {
  const publicPage = auth.diagnoseAuthPage({
    statusCode: 200,
    body: '<a href="/member/Alice">post author</a>',
  });
  assert.equal(publicPage.ok, false);
  assert.equal(publicPage.code, 'auth_page_unrecognized');

  const balancePage = auth.diagnoseAuthPage({
    statusCode: 200,
    body: '<div class="balance_area bigger"></div><a href="/member/Alice">Alice</a>',
  });
  assert.equal(balancePage.ok, true);
  assert.equal(balancePage.identity, 'alice');
});

test('identity metadata stores no plaintext account name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-auth-test-'));
  try {
    const file = path.join(dir, 'identity.json');
    const record = auth.createIdentityRecord('SecretAccount');
    auth.writeIdentity(file, record);
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes('SecretAccount'), false);
    assert.equal(auth.identityMatches(auth.readIdentity(file), 'secretaccount'), true);
    assert.equal(auth.identityMatches(auth.readIdentity(file), 'another'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy Chromium state can only be removed inside the profile root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-auth-test-'));
  try {
    const chromeRoot = path.join(dir, 'chrome-profile');
    const target = path.join(chromeRoot, 'acc1');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'state'), 'legacy');
    auth.safeRemoveChromeProfile({ readerDataDir: dir, chromeProfileDir: target });
    assert.equal(fs.existsSync(target), false);
    assert.throws(
      () => auth.safeRemoveChromeProfile({ readerDataDir: dir, chromeProfileDir: chromeRoot }),
      /不安全/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
