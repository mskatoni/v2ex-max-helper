'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const script = "const value=require('./lib/secure-proxy').getPlaywrightProxy();console.log(JSON.stringify(value))";

function proxyEnv(extra = {}) {
  const env = {
    ...process.env,
    V2EX_PROXY_ENABLE: '',
    V2EX_PROXY_ALLOW_LAN: '',
    V2EX_PROXY: '',
    HTTPS_PROXY: '',
    https_proxy: '',
    HTTP_PROXY: '',
    http_proxy: '',
    ALL_PROXY: '',
    all_proxy: '',
    NO_PROXY: '',
    no_proxy: '',
    ...extra,
  };
  if (process.platform === 'win32') {
    for (const [lower, upper] of [
      ['https_proxy', 'HTTPS_PROXY'],
      ['http_proxy', 'HTTP_PROXY'],
      ['all_proxy', 'ALL_PROXY'],
      ['no_proxy', 'NO_PROXY'],
    ]) {
      const value = Object.prototype.hasOwnProperty.call(extra, lower)
        ? extra[lower]
        : Object.prototype.hasOwnProperty.call(extra, upper)
          ? extra[upper]
          : '';
      delete env[lower];
      delete env[upper];
      env[upper] = value;
    }
  }
  return env;
}

function run(extra = {}, code = script) {
  return childProcess.spawnSync(process.execPath, ['-e', code], {
    cwd: repoRoot,
    env: proxyEnv(extra),
    encoding: 'utf8',
  });
}

test('proxy code stays disabled unless explicitly enabled', () => {
  const result = run({ V2EX_PROXY: 'not a URL' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'null');
});

test('enabled proxy without a URL fails closed', () => {
  const result = run({ V2EX_PROXY_ENABLE: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /enabled but no proxy URL/i);
});

test('loopback HTTP and SOCKS5 proxies are accepted', () => {
  const http = run({ V2EX_PROXY_ENABLE: '1', V2EX_PROXY: 'http://127.0.0.1:7890' });
  const socks = run({ V2EX_PROXY_ENABLE: '1', V2EX_PROXY: 'socks5://localhost:1080' });
  assert.equal(http.status, 0);
  assert.deepEqual(JSON.parse(http.stdout), { server: 'http://127.0.0.1:7890' });
  assert.equal(socks.status, 0);
  assert.deepEqual(JSON.parse(socks.stdout), { server: 'socks5://localhost:1080' });
});

test('Docker host aliases are accepted without opening ordinary domains', () => {
  for (const host of ['host.docker.internal', 'gateway.docker.internal']) {
    const result = run({ V2EX_PROXY_ENABLE: '1', V2EX_PROXY: `http://${host}:7890` });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { server: `http://${host}:7890` });
  }
});

test('explicit proxy wins and lowercase system variables follow standard precedence', () => {
  const explicit = run({
    V2EX_PROXY_ENABLE: '1',
    V2EX_PROXY: 'http://127.0.0.1:7000',
    https_proxy: 'http://127.0.0.1:7001',
  });
  const system = run({
    V2EX_PROXY_ENABLE: '1',
    HTTPS_PROXY: 'http://127.0.0.1:7002',
    https_proxy: 'http://127.0.0.1:7003',
  });
  const fallback = run({
    V2EX_PROXY_ENABLE: '1',
    all_proxy: 'socks5://127.0.0.1:7004',
  });
  assert.deepEqual(JSON.parse(explicit.stdout), { server: 'http://127.0.0.1:7000' });
  assert.deepEqual(JSON.parse(system.stdout), { server: 'http://127.0.0.1:7003' });
  assert.deepEqual(JSON.parse(fallback.stdout), { server: 'socks5://127.0.0.1:7004' });
});

test('NO_PROXY is passed to Playwright and matches exact, suffix, wildcard and port rules', () => {
  const result = run({
    V2EX_PROXY_ENABLE: '1',
    V2EX_PROXY: 'http://127.0.0.1:7890',
    no_proxy: 'localhost,.example.com,*.internal.test,api.local:8443',
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    server: 'http://127.0.0.1:7890',
    bypass: 'localhost,.example.com,*.internal.test,api.local:8443',
  });

  const bypassScript = "const p=require('./lib/secure-proxy');console.log(JSON.stringify([p.shouldBypassProxy('localhost',443),p.shouldBypassProxy('www.example.com',443),p.shouldBypassProxy('node.internal.test',443),p.shouldBypassProxy('api.local',443),p.shouldBypassProxy('api.local',8443),p.shouldBypassProxy('www.v2ex.com',443)]))";
  const bypass = run({ no_proxy: 'localhost,.example.com,*.internal.test,api.local:8443' }, bypassScript);
  assert.deepEqual(JSON.parse(bypass.stdout), [true, true, true, false, true, false]);
});

test('LAN proxy requires the explicit private-network allow switch', () => {
  const blocked = run({ V2EX_PROXY_ENABLE: '1', V2EX_PROXY: 'http://192.168.1.9:7890' });
  const allowed = run({
    V2EX_PROXY_ENABLE: '1',
    V2EX_PROXY_ALLOW_LAN: '1',
    V2EX_PROXY: 'http://192.168.1.9:7890',
  });
  assert.notEqual(blocked.status, 0);
  assert.equal(allowed.status, 0);
  assert.deepEqual(JSON.parse(allowed.stdout), { server: 'http://192.168.1.9:7890' });
});

test('public IPs, ordinary domains, and unsupported protocols stay rejected', () => {
  for (const proxy of ['http://8.8.8.8:7890', 'http://proxy.example:7890', 'ftp://127.0.0.1:21']) {
    const result = run({
      V2EX_PROXY_ENABLE: '1',
      V2EX_PROXY_ALLOW_LAN: '1',
      V2EX_PROXY: proxy,
    });
    assert.notEqual(result.status, 0, proxy);
  }
});

test('all first-party HTTPS and Chromium paths load the shared proxy policy', () => {
  const roots = ['reader', 'checkin', 'lib'];
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(file);
    }
  }
  for (const root of roots) visit(path.join(repoRoot, root));

  for (const file of files) {
    if (file.endsWith(path.join('lib', 'secure-proxy.js'))) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (/\bhttps\.(?:request|get)\s*\(/.test(source)) {
      assert.match(source, /require\(['"][^'"]*config['"]\)/, file);
    }
    assert.doesNotMatch(source, /\b(?:net|tls)\.connect\s*\(/, file);
    assert.doesNotMatch(source, /\bfetch\s*\(/, file);
  }

  const browserSource = fs.readFileSync(path.join(repoRoot, 'reader', 'browser.js'), 'utf8');
  assert.match(browserSource, /getPlaywrightProxy\s*\(/);
  assert.match(browserSource, /--disable-quic/);
});
