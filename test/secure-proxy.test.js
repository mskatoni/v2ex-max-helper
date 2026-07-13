'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const script = "const value=require('./lib/secure-proxy').getPlaywrightProxy();console.log(JSON.stringify(value))";

function proxyEnv(extra = {}) {
  return {
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
    ...extra,
  };
}

function run(extra = {}) {
  return childProcess.spawnSync(process.execPath, ['-e', script], {
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
