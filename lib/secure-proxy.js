'use strict';

const https = require('https');
const net = require('net');
const tls = require('tls');
const { URL, urlToHttpOptions } = require('url');

let installed = false;
let cachedProxy = '';
let cachedAgent = null;

function getProxyUrl() {
  return process.env.V2EX_PROXY ||
         process.env.V2EX_HTTPS_PROXY ||
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

  if (!isLoopbackHost(proxy.hostname)) {
    throw new Error(`Only loopback proxy URLs are allowed; refusing remote proxy: ${redactProxyUrl(raw)}`);
  }

  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxy.protocol)) {
    throw new Error(`Unsupported local proxy protocol: ${redactProxyUrl(raw)}`);
  }

  return proxy;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost') return true;
  if (host === '::1') return true;
  const ip = net.isIP(host);
  if (ip === 4) return host.startsWith('127.');
  return false;
}

function connectToTarget(options, socket, targetHost, callback) {
  const targetSocket = tls.connect({
    ...options,
    socket,
    servername: options.servername || targetHost,
  });
  targetSocket.once('secureConnect', () => callback(null, targetSocket));
  targetSocket.once('error', callback);
}

function connectViaHttpProxy(options, proxy, callback) {
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

  const connectOptions = {
    host: proxy.hostname,
    port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)),
  };
  const proxySocket = proxy.protocol === 'https:'
    ? tls.connect({ ...connectOptions, servername: proxy.hostname })
    : net.connect(connectOptions);

  function sendConnect() {
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
  }

  if (proxy.protocol === 'https:') {
    proxySocket.once('secureConnect', sendConnect);
  } else {
    proxySocket.once('connect', sendConnect);
  }

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

    connectToTarget(options, proxySocket, targetHost, finish);
  }

  proxySocket.on('data', onProxyData);
  proxySocket.once('error', finish);
}

function connectViaSocks5Proxy(options, proxy, callback) {
  const targetHost = String(options.hostname || options.host || options.servername || '').replace(/:\d+$/, '');
  const targetPort = Number(options.port || 443);
  if (!targetHost) {
    callback(new Error('SOCKS5 proxy target host missing'));
    return;
  }

  let settled = false;
  function finish(err, socket) {
    if (settled) return;
    settled = true;
    callback(err, socket);
  }

  const proxySocket = net.connect({
    host: proxy.hostname,
    port: Number(proxy.port || 1080),
  });

  let stage = 'greeting';
  let buffer = Buffer.alloc(0);
  const hasAuth = Boolean(proxy.username || proxy.password);

  proxySocket.once('connect', () => {
    proxySocket.write(hasAuth
      ? Buffer.from([0x05, 0x02, 0x00, 0x02])
      : Buffer.from([0x05, 0x01, 0x00]));
  });

  proxySocket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    if (stage === 'greeting') {
      if (buffer.length < 2) return;
      const method = buffer[1];
      buffer = buffer.slice(2);
      if (method === 0xff) {
        proxySocket.destroy();
        finish(new Error('SOCKS5 proxy rejected authentication methods'));
        return;
      }
      if (method === 0x02) {
        const user = Buffer.from(decodeURIComponent(proxy.username || ''));
        const pass = Buffer.from(decodeURIComponent(proxy.password || ''));
        if (user.length > 255 || pass.length > 255) {
          proxySocket.destroy();
          finish(new Error('SOCKS5 proxy credentials are too long'));
          return;
        }
        stage = 'auth';
        proxySocket.write(Buffer.concat([
          Buffer.from([0x01, user.length]),
          user,
          Buffer.from([pass.length]),
          pass,
        ]));
        return;
      }
      if (method !== 0x00) {
        proxySocket.destroy();
        finish(new Error(`SOCKS5 proxy selected unsupported auth method: ${method}`));
        return;
      }
      stage = 'connect';
      sendSocksConnect(proxySocket, targetHost, targetPort);
    }

    if (stage === 'auth') {
      if (buffer.length < 2) return;
      const ok = buffer[1] === 0x00;
      buffer = buffer.slice(2);
      if (!ok) {
        proxySocket.destroy();
        finish(new Error('SOCKS5 proxy authentication failed'));
        return;
      }
      stage = 'connect';
      sendSocksConnect(proxySocket, targetHost, targetPort);
    }

    if (stage === 'connect') {
      if (buffer.length < 5) return;
      const status = buffer[1];
      const atyp = buffer[3];
      let replyLen = 0;
      if (atyp === 0x01) replyLen = 10;
      else if (atyp === 0x04) replyLen = 22;
      else if (atyp === 0x03) {
        if (buffer.length < 5) return;
        replyLen = 5 + buffer[4] + 2;
      } else {
        proxySocket.destroy();
        finish(new Error('SOCKS5 proxy returned invalid address type'));
        return;
      }
      if (buffer.length < replyLen) return;
      if (status !== 0x00) {
        proxySocket.destroy();
        finish(new Error(`SOCKS5 proxy CONNECT failed: ${status}`));
        return;
      }
      const rest = buffer.slice(replyLen);
      buffer = Buffer.alloc(0);
      proxySocket.removeAllListeners('data');
      if (rest.length > 0) proxySocket.unshift(rest);
      connectToTarget(options, proxySocket, targetHost, finish);
    }
  });

  proxySocket.once('error', finish);
}

function sendSocksConnect(socket, targetHost, targetPort) {
  const host = Buffer.from(targetHost);
  if (host.length > 255) {
    socket.destroy(new Error('SOCKS5 target host is too long'));
    return;
  }
  const port = Buffer.alloc(2);
  port.writeUInt16BE(targetPort, 0);
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    port,
  ]));
}

function getHttpsAgent() {
  const proxy = parseProxyUrl();
  if (!proxy) return null;

  const key = proxy.toString();
  if (cachedAgent && cachedProxy === key) return cachedAgent;

  const agent = new https.Agent();
  agent.createConnection = (options, callback) => {
    if (proxy.protocol === 'socks5:' || proxy.protocol === 'socks5h:') {
      connectViaSocks5Proxy(options, proxy, callback);
    } else {
      connectViaHttpProxy(options, proxy, callback);
    }
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
