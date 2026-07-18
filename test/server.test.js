'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, method, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: requestPath }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

async function waitForHealth(port, child) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`health server exited with code ${child.exitCode}`);
    try {
      return await request(port, 'GET', '/health');
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw lastError || new Error('health server did not start');
}

test('health server exposes only bounded GET and HEAD endpoints', async (t) => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH || '',
      SystemRoot: process.env.SystemRoot || '',
      ComSpec: process.env.ComSpec || '',
      TEMP: process.env.TEMP || '',
      TMP: process.env.TMP || '',
      HOME: process.env.HOME || '',
      USERPROFILE: process.env.USERPROFILE || '',
      PORT: String(port),
    },
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) {
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }
  });

  const health = await waitForHealth(port, child);
  assert.equal(health.statusCode, 200, stderr);
  assert.equal(JSON.parse(health.body).status, 'ok');
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(health.headers.connection, 'close');
  assert.equal(health.headers['x-content-type-options'], 'nosniff');

  const head = await request(port, 'HEAD', '/');
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.ok(Number(head.headers['content-length']) > 0);

  assert.equal((await request(port, 'POST', '/')).statusCode, 405);
  assert.equal((await request(port, 'GET', '/private')).statusCode, 404);
});
