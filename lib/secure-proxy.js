'use strict';

const https = require('https');
const tls = require('tls');
const { URL, urlToHttpOptions } = require('url');

let installed = false;
let cachedProxy = '';
let cachedAgent = null;

function getProxyUrl() {
  return process.env.V2EX_HTTPS_PROXY ||
         process.env.HTTPS_PROXY ||
         process.env.https_proxy ||
         process.env.HTTP_PROXY ||
         process.env.http_proxy ||
         process.env.ALL_PROXY ||
         process.env.all_proxy ||
         '';
}

function redactProxyUrl(value) {
  if (!value) return '';
  try {
    const u = new URL(value);
    if (u.username) u.username = '***';
    if (u.password) u.password = '***';
    return u.toString();
  } catch (_) {
    return '[invalid proxy url]';
  }
}

function parseProxyUrl() {
  const raw = getProxyUrl().trim();
  if (!raw) return null;

  let proxy;
  try {
    proxy = new URL(raw);
  } catch (_) {
    throw new Error(`HTTPS proxy URL invalid: ${redactProxyUrl(raw)}`);
  }

  if (proxy.protocol !== 'https:') {
    throw new Error(`Only HTTPS proxy URLs are allowed; refusing plaintext proxy: ${redactProxyUrl(raw)}`);
  }

  return proxy;
}

function connectViaProxy(options, proxy, callback) {
  const targetHost = String(options.hostname || options.host || options.servername || '').replace(/:\d+$/, '');
  const targetPort = Number(options.port || 443);
  if (!targetHost) {
    callback(new Error('HTTPS proxy target host missing'));
    return;
  }

  let settled = false;
  function finish(err, socket) {
    if (settled) return;
    settled = true;
    callback(err, socket);
  }

  const proxySocket = tls.connect({
    host: proxy.hostname,
    port: Number(proxy.port || 443),
    servername: proxy.hostname,
  });

  proxySocket.once('secureConnect', () => {
    const headers = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`,
      'Connection: close',
    ];

    if (proxy.username || proxy.password) {
      const auth = Buffer
        .from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`)
        .toString('base64');
      headers.push(`Proxy-Authorization: Basic ${auth}`);
    }

    proxySocket.write(`${headers.join('\r\n')}\r\n\r\n`);
  });

  let buffer = Buffer.alloc(0);
  function onProxyData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;

    proxySocket.off('data', onProxyData);
    const header = buffer.slice(0, headerEnd).toString('latin1');
    const statusLine = header.split('\r\n')[0] || '';
    const status = Number((statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i) || [])[1]);
    if (status !== 200) {
      proxySocket.destroy();
      finish(new Error(`HTTPS proxy CONNECT failed: ${statusLine || 'no status line'}`));
      return;
    }

    const rest = buffer.slice(headerEnd + 4);
    if (rest.length > 0) proxySocket.unshift(rest);

    const targetSocket = tls.connect({
      ...options,
      socket: proxySocket,
      servername: options.servername || targetHost,
    });
    targetSocket.once('secureConnect', () => finish(null, targetSocket));
    targetSocket.once('error', finish);
  }

  proxySocket.on('data', onProxyData);
  proxySocket.once('error', finish);
}

function getHttpsAgent() {
  const proxy = parseProxyUrl();
  if (!proxy) return null;

  const key = proxy.toString();
  if (cachedAgent && cachedProxy === key) return cachedAgent;

  const agent = new https.Agent();
  agent.createConnection = (options, callback) => {
    connectViaProxy(options, proxy, callback);
  };

  cachedProxy = key;
  cachedAgent = agent;
  return agent;
}

function normalizeRequestOptions(input, options) {
  let base;
  if (typeof input === 'string' || input instanceof URL) {
    base = urlToHttpOptions(new URL(input));
  } else {
    base = { ...(input || {}) };
  }
  return { ...base, ...(options || {}) };
}

function installGlobalHttpsProxy() {
  const agent = getHttpsAgent();
  if (!agent || installed) return agent;

  const originalRequest = https.request;
  https.request = function patchedRequest(input, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof options === 'function') {
      cb = options;
      opts = undefined;
    }
    const merged = normalizeRequestOptions(input, opts);
    if (!merged.agent) merged.agent = agent;
    return originalRequest.call(https, merged, cb);
  };

  https.get = function patchedGet(input, options, callback) {
    const req = https.request(input, options, callback);
    req.end();
    return req;
  };

  installed = true;
  return agent;
}

function getPlaywrightProxy() {
  const proxy = parseProxyUrl();
  if (!proxy) return null;
  return { server: proxy.toString() };
}

module.exports = {
  getProxyUrl,
  redactProxyUrl,
  installGlobalHttpsProxy,
  getPlaywrightProxy,
};
