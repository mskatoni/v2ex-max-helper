'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const test = require('node:test');

const originalRequest = https.request;

function mockRequest(statusCode, headers = {}, chunks = ['body'], terminalEvent = 'end') {
  https.request = (_options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.headers = headers;
      callback(res);
      setImmediate(() => {
        for (const chunk of chunks) res.emit('data', chunk);
        res.emit(terminalEvent);
      });
    };
    req.destroy = error => setImmediate(() => req.emit('error', error || new Error('destroyed')));
    return req;
  };
}

test.afterEach(() => {
  https.request = originalRequest;
});

test('fetcher rejects non-2xx and aborted responses', async () => {
  const fetcher = require('../reader/fetcher');
  mockRequest(500);
  await assert.rejects(fetcher.fetchPage('/recent', 'A2=fake'), /HTTP 500/);
  mockRequest(200, {}, [], 'aborted');
  await assert.rejects(fetcher.fetchPage('/recent', 'A2=fake'), /aborted/);
});

test('fetcher rejects an explicit login page instead of entering an empty-queue loop', async () => {
  const fetcher = require('../reader/fetcher');
  mockRequest(200, {}, ['<a href="/signin">Sign in</a>']);
  await assert.rejects(fetcher.fetchPage('/recent', 'A2=fake'), error => error.code === 'SESSION_EXPIRED');
});

test('fetcher does not request the recent first page twice', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'reader', 'fetcher.js'), 'utf8');
  assert.doesNotMatch(source, /\{ path: '\/recent',\s+name: '最新' \}/);
  assert.match(source, /'\/recent\?p=1'/);
});

test('balance redirects remain on the exact V2EX HTTPS origin', async () => {
  const balance = require('../reader/balance');
  mockRequest(302, { location: 'https://example.test/steal' }, []);
  await assert.rejects(balance.fetchBalance('A2=fake'), /outside V2EX/);

  mockRequest(302, { location: 'https://[broken' }, []);
  await assert.rejects(balance.fetchBalance('A2=fake'), /redirect URL is invalid/);
});
