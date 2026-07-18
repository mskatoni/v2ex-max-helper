'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const browser = require('../reader/browser');
const fingerprint = require('../reader/fingerprint');

test('fingerprint user agent follows the bundled Playwright Chromium version', () => {
  const fp = fingerprint.generate('test-profile');
  assert.match(fp.chromeVersion, /^\d+\.0\.0\.0$/);
  assert.match(fp.userAgent, new RegExp(`Chrome/${fp.majorVersion}\\.`));
  assert.equal(fp.chromeVersion, fingerprint.bundledChromiumVersion());
});

test('Docker keeps only runtime data writable without copying the full app layer', () => {
  const dockerfile = fs.readFileSync(path.resolve(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /chown\s+-R\s+v2ex:v2ex\s+\/app(?:\s|$)/);
  assert.match(dockerfile, /chown\s+v2ex:v2ex\s+\/app\/data/);
  assert.match(dockerfile, /^USER\s+v2ex\s*$/m);
});

test('Chromium launch args bound disk caches and keep memory pressure enabled', () => {
  const args = browser.buildLaunchArgs();
  assert.ok(args.includes('--disk-cache-size=67108864'));
  assert.ok(args.includes('--media-cache-size=16777216'));
  assert.equal(args.includes('--memory-pressure-off'), false);
  assert.equal(args.includes('--single-process'), false);
});

test('Chromium disables QUIC only when the explicit proxy gate is enabled', () => {
  const previous = process.env.V2EX_PROXY_ENABLE;
  try {
    process.env.V2EX_PROXY_ENABLE = '';
    assert.equal(browser.buildLaunchArgs().includes('--disable-quic'), false);
    process.env.V2EX_PROXY_ENABLE = '1';
    assert.equal(browser.buildLaunchArgs().includes('--disable-quic'), true);
  } finally {
    if (previous === undefined) delete process.env.V2EX_PROXY_ENABLE;
    else process.env.V2EX_PROXY_ENABLE = previous;
  }
});

test('navigation timeouts rebuild the page before the next post', () => {
  assert.equal(browser.shouldResetPage(new Error('page.goto: Timeout 30000ms exceeded.')), true);
  assert.equal(browser.shouldResetPage(new Error('ordinary content error')), false);
});

test('post navigation accepts only credential-free V2EX topic URLs', () => {
  const normalized = browser.normalizePostUrl('https://www.v2ex.com/t/123?from=home#reply1');
  assert.equal(normalized.toString(), 'https://www.v2ex.com/t/123');
  assert.throws(() => browser.normalizePostUrl('https://user:pass@www.v2ex.com/t/123'), /拒绝/);
  assert.throws(() => browser.normalizePostUrl('https://www.v2ex.com.evil.test/t/123'), /拒绝/);
  assert.throws(() => browser.normalizePostUrl('https://www.v2ex.com/go/linux'), /拒绝/);
});

test('cookie writeback includes only exact V2EX domains', () => {
  const value = browser.serializeCookies([
    { name: 'A2', value: 'good', domain: '.v2ex.com' },
    { name: 'PB3_SESSION', value: 'good2', domain: 'www.v2ex.com' },
    { name: 'A2', value: 'evil', domain: 'evilv2ex.com' },
    { name: 'A2', value: 'evil2', domain: 'www.v2ex.com.evil.test' },
  ]);
  assert.equal(value, 'A2=good; PB3_SESSION=good2');
});

test('all authentication cookies are injected as HttpOnly', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'reader', 'browser.js'), 'utf8');
  assert.match(source, /HTTP_ONLY_COOKIES = new Set\(\['A2', 'A2O', 'PB3_SESSION', 'cf_clearance'\]\)/);
});

test('unverified account pages fail and final cookie persistence is strict', () => {
  const browserSource = fs.readFileSync(path.resolve(__dirname, '..', 'reader', 'browser.js'), 'utf8');
  const mainSource = fs.readFileSync(path.resolve(__dirname, '..', 'reader', 'main.js'), 'utf8');
  assert.match(browserSource, /if \(!authState\.ok\) \{/);
  assert.match(browserSource, /syncCookies\(\{ throwOnError: true \}\)/);
  assert.match(mainSource, /browser\.close\(\{ throwOnError: true \}\)/);
  assert.match(mainSource, /浏览器状态保存失败/);
});

test('three-read failure probes cannot fall back to a stale disk cookie', () => {
  const browserSource = fs.readFileSync(path.resolve(__dirname, '..', 'reader', 'browser.js'), 'utf8');
  const mainSource = fs.readFileSync(path.resolve(__dirname, '..', 'reader', 'main.js'), 'utf8');
  assert.match(browserSource, /options\.requireContextAuth[\s\S]{0,180}return ''/);
  assert.match(mainSource, /getCurrentCookie\(\{ requireContextAuth: true \}\)/);
});

test('reader runtime never falls back to disk after Chromium starts', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'reader', 'main.js'), 'utf8');
  const calls = [...main.matchAll(/browser\.getCurrentCookie\(([^)]*)\)/g)];
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /requireContextAuth:\s*true/);
  assert.match(main, /async function requireBrowserCookie\(\)/);
  assert.match(main, /error\.code = 'SESSION_EXPIRED'/);
  assert.match(main, /await notify\.notifyReaderError\(stats\)/);
});

test('cookie writeback de-duplicates names and prefers the exact host', () => {
  const serialized = browser.serializeCookies([
    { name: 'A2', value: 'parent', domain: '.v2ex.com', path: '/' },
    { name: 'A2', value: 'exact', domain: 'www.v2ex.com', path: '/' },
    { name: 'scoped', value: 'drop', domain: 'www.v2ex.com', path: '/mission' },
  ]);
  assert.equal(serialized, 'A2=exact');
});

test('cache pruning removes only known cache directories above the threshold', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-browser-cache-'));
  try {
    const cache = path.join(profile, 'Default', 'Cache');
    const codeCache = path.join(profile, 'Default', 'Code Cache');
    const localStorage = path.join(profile, 'Default', 'Local Storage');
    fs.mkdirSync(cache, { recursive: true });
    fs.mkdirSync(codeCache, { recursive: true });
    fs.mkdirSync(localStorage, { recursive: true });
    fs.writeFileSync(path.join(cache, 'cache.data'), Buffer.alloc(800));
    fs.writeFileSync(path.join(codeCache, 'code.data'), Buffer.alloc(800));
    fs.writeFileSync(path.join(localStorage, 'login-state'), 'preserve');
    fs.writeFileSync(path.join(profile, 'identity-state'), 'preserve');

    const result = browser.pruneBrowserCache(profile, 1024);
    assert.equal(result.pruned, true);
    assert.ok(result.sizeBefore > 1024);
    assert.equal(result.sizeAfter, 0);
    assert.equal(fs.existsSync(cache), false);
    assert.equal(fs.existsSync(codeCache), false);
    assert.equal(fs.readFileSync(path.join(localStorage, 'login-state'), 'utf8'), 'preserve');
    assert.equal(fs.readFileSync(path.join(profile, 'identity-state'), 'utf8'), 'preserve');
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('cache pruning leaves a cache below the threshold intact', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-browser-cache-'));
  try {
    const cacheFile = path.join(profile, 'Default', 'Cache', 'cache.data');
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, Buffer.alloc(128));

    const result = browser.pruneBrowserCache(profile, 1024);
    assert.equal(result.pruned, false);
    assert.equal(fs.existsSync(cacheFile), true);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
