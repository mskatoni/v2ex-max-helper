'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.FEISHU_VERIFICATION_TOKEN = 'local-test-token';
process.env.FEISHU_CHAT_ID = 'local-private-chat';
delete process.env.V2EX_PROXY_ENABLE;

const { createServer, parseMessage, isAuthorizedChat } = require('../reader/feishu-bot');

function request(port, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/feishu/callback',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function withServer(run) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await run(server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('Feishu callback validates token and returns challenge with safe headers', async () => {
  await withServer(async (port) => {
    const denied = await request(port, { type: 'url_verification', token: 'wrong', challenge: 'x' });
    assert.equal(denied.statusCode, 401);

    const accepted = await request(port, {
      type: 'url_verification',
      token: 'local-test-token',
      challenge: 'challenge-value',
    });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(JSON.parse(accepted.body), { challenge: 'challenge-value' });
    assert.equal(accepted.headers['cache-control'], 'no-store');
    assert.equal(accepted.headers.connection, 'close');
    assert.equal(accepted.headers['x-content-type-options'], 'nosniff');
  });
});

test('Feishu callback rejects malformed and oversized bodies', async () => {
  await withServer(async (port) => {
    assert.equal((await request(port, '{')).statusCode, 400);
    const oversized = await request(port, '', { 'Content-Length': String(1024 * 1024 + 1) });
    assert.equal(oversized.statusCode, 413);
  });
});

test('Feishu commands accept only the configured private chat', () => {
  const parsed = parseMessage({
    event: {
      message: {
        chat_id: 'local-private-chat',
        chat_type: 'p2p',
        content: JSON.stringify({ text: '/status' }),
      },
      sender: { sender_id: { open_id: 'sender' } },
    },
  });
  assert.equal(parsed.chatType, 'p2p');
  assert.equal(isAuthorizedChat(parsed.chatId, parsed.chatType), true);
  assert.equal(isAuthorizedChat(parsed.chatId, 'group'), false);
  assert.equal(isAuthorizedChat('different-chat', 'p2p'), false);
});

test('Feishu callback listener is loopback-only and debug reads are bounded', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'reader', 'feishu-bot.js'), 'utf8');
  assert.match(source, /server\.listen\(port, '127\.0\.0\.1'/);
  assert.match(source, /MAX_DEBUG_READ_BYTES = 64 \* 1024/);
  assert.match(source, /server\.maxConnections = 64/);
  assert.match(source, /req\.on\('aborted'/);
  assert.doesNotMatch(source, /readFileSync\(cfg\.readerLog/);
});

test('Feishu status command accepts Telegram-compatible aliases', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'reader', 'feishu-bot.js'), 'utf8');
  assert.match(source, /case '\/status':[\s\S]{0,80}case '\/tasks':[\s\S]{0,80}case '\/stats':/);
  assert.match(source, /case '\/start':[\s\S]{0,40}case '\/help':/);
});
