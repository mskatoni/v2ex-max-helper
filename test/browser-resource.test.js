'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const browser = require('../reader/browser');

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
