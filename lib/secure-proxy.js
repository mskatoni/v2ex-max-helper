'use strict';

const https = require('https');
const net = require('net');
const tls = require('tls');
const { URL, urlToHttpOptions } = require('url');

let installed = false;
let cachedProxy = '';
let cachedAgent = null;
const DOCKER_HOST_ALIASES = new Set(['host.docker.internal', 'gateway.docker.internal']);
const PROXY_HANDSHAKE_TIMEOUT_MS = 20000;
const MAX_PROXY_HEADER_BYTES = 64 * 1024;

function normalizeHostname(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
}

function getTargetHostname(options = {}) {
  const explicit = options.hostname || options.servername;
  if (explicit) return normalizeHostname(explicit);
  const host = String(options.host || '');
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end > 0) return normalizeHostname(host.slice(0, end + 1));
  }
  if (net.isIP(host)) return normalizeHostname(host);
  return normalizeHostname(host.replace(/:\d+$/, ''));
}

function formatConnectAuthority(hostname, port) {
  const host = normalizeHostname(hostname);
  return `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

function ipv6ToBuffer(hostname) {
  let input = normalizeHostname(hostname);
  const zoneIndex = input.indexOf('%');
  if (zoneIndex >= 0) input = input.slice(0, zoneIndex);
  if (net.isIP(input) !== 6) throw new Error('SOCKS5 IPv6 target is invalid');

  const halves = input.split('::');
  if (halves.length > 2) throw new Error('SOCKS5 IPv6 target is invalid');
  const parseHalf = (half) => {
    if (!half) return [];
    return half.split(':').flatMap((part) => {
      if (part.includes('.')) {
        const octets = part.split('.').map(Number);
        if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
          throw new Error('SOCKS5 IPv6 target is invalid');
        }
        return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
      }
      if (!/^[0-9a-f]{1,4}$/i.test(part)) throw new Error('SOCKS5 IPv6 target is invalid');
      return [parseInt(part, 16)];
    });
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] || '');
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    throw new Error('SOCKS5 IPv6 target is invalid');
  }
  const words = halves.length === 2 ? [...left, ...Array(missing).fill(0), ...right] : left;
  const buffer = Buffer.alloc(16);
  words.forEach((word, index) => buffer.writeUInt16BE(word, index * 2));
  return buffer;
}

function buildSocksConnectRequest(hostname, targetPort) {
  const host = normalizeHostname(hostname);
  const portNumber = Number(targetPort);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new Error('SOCKS5 target port is invalid');
  }

  let atyp;
  let address;
  if (net.isIP(host) === 4) {
    atyp = 0x01;
    address = Buffer.from(host.split('.').map(Number));
  } else if (net.isIP(host) === 6) {
    atyp = 0x04;
    address = ipv6ToBuffer(host);
  } else {
    address = Buffer.from(host);
    if (!address.length || address.length > 255) throw new Error('SOCKS5 target host is too long');
    atyp = 0x03;
    address = Buffer.concat([Buffer.from([address.length]), address]);
  }
  const port = Buffer.alloc(2);
  port.writeUInt16BE(portNumber, 0);
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), address, port]);
}

function proxyEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.V2EX_PROXY_ENABLE || '').trim());
}

function lanProxyAllowed() {
  return /^(1|true|yes|on)$/i.test(String(process.env.V2EX_PROXY_ALLOW_LAN || '').trim());
}

function getProxyUrl() {
  if (!proxyEnabled()) return '';
  return process.env.V2EX_PROXY ||
         process.env.https_proxy ||
         process.env.HTTPS_PROXY ||
         process.env.http_proxy ||
         process.env.HTTP_PROXY ||
         process.env.all_proxy ||
         process.env.ALL_PROXY ||
         '';
}

function getNoProxy() {
  return process.env.no_proxy || process.env.NO_PROXY || '';
}

function redactProxyUrl(value) {
  if (!value) return '';
  try {
    const u = new URL(value);
    if (u.username) u.username = '***';
    if (u.password) u.password = '***';
    if (u.pathname && u.pathname !== '/') u.pathname = '/[redacted]';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch (_) {
    return '[invalid proxy url]';
  }
}

function parseProxyUrl() {
  const raw = getProxyUrl().trim();
  if (!proxyEnabled()) return null;
  if (!raw) {
    throw new Error('V2EX proxy is enabled but no proxy URL is configured');
  }

  let proxy;
  try {
    proxy = new URL(raw);
  } catch (_) {
    throw new Error(`HTTPS proxy URL invalid: ${redactProxyUrl(raw)}`);
  }

  if (!isAllowedProxyHost(proxy.hostname)) {
    throw new Error(`Only loopback and Docker host proxy URLs are allowed by default; set V2EX_PROXY_ALLOW_LAN=1 for RFC1918 LAN proxy IPs. Refusing proxy: ${redactProxyUrl(raw)}`);
  }

  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxy.protocol)) {
    throw new Error(`Unsupported local proxy protocol: ${redactProxyUrl(raw)}`);
  }

  if (proxy.port && (!/^\d+$/.test(proxy.port) || Number(proxy.port) < 1 || Number(proxy.port) > 65535)) {
    throw new Error(`Proxy port is invalid: ${redactProxyUrl(raw)}`);
  }

  if ((proxy.pathname && proxy.pathname !== '/') || proxy.search || proxy.hash) {
    throw new Error(`Proxy URL must not contain a path, query, or fragment: ${redactProxyUrl(raw)}`);
  }

  try {
    decodeURIComponent(proxy.username || '');
    decodeURIComponent(proxy.password || '');
  } catch (_) {
    throw new Error(`Proxy credentials contain invalid percent encoding: ${redactProxyUrl(raw)}`);
  }

  const hasAuth = Boolean(proxy.username || proxy.password);
  if (hasAuth && !isLoopbackHost(proxy.hostname) && proxy.protocol !== 'https:') {
    throw new Error('Authenticated LAN or Docker-host proxies must use HTTPS; plaintext proxy credentials are only allowed on loopback');
  }

  return proxy;
}

function isLoopbackHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === 'localhost') return true;
  if (host === '::1') return true;
  const ip = net.isIP(host);
  if (ip === 4) return host.startsWith('127.');
  return false;
}

function isDockerHostAlias(hostname) {
  return DOCKER_HOST_ALIASES.has(normalizeHostname(hostname));
}

function isPrivateLanHost(hostname) {
  const host = normalizeHostname(hostname);
  if (net.isIP(host) !== 4) return false;
  const parts = host.split('.').map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return parts[0] === 192 && parts[1] === 168;
}

function isAllowedProxyHost(hostname) {
  if (isLoopbackHost(hostname)) return true;
  if (isDockerHostAlias(hostname)) return true;
  return lanProxyAllowed() && isPrivateLanHost(hostname);
}

function isSafeDirectHost(hostname) {
  return isLoopbackHost(hostname) || isDockerHostAlias(hostname) || isPrivateLanHost(hostname);
}

function splitNoProxyEntry(value) {
  let entry = String(value || '').trim().toLowerCase();
  if (!entry) return null;
  if (entry === '*') return { host: '*', port: '' };

  let port = '';
  if (entry.startsWith('[')) {
    const end = entry.indexOf(']');
    if (end >= 0) {
      const suffix = entry.slice(end + 1);
      if (/^:\d+$/.test(suffix)) port = suffix.slice(1);
      entry = entry.slice(1, end);
    }
  } else {
    const colon = entry.lastIndexOf(':');
    if (colon > -1 && entry.indexOf(':') === colon && /^\d+$/.test(entry.slice(colon + 1))) {
      port = entry.slice(colon + 1);
      entry = entry.slice(0, colon);
    }
  }

  return { host: entry.replace(/\.$/, ''), port };
}

function shouldBypassProxy(hostname, port) {
  const targetHost = normalizeHostname(hostname).replace(/\.$/, '');
  const targetPort = String(port || '');
  if (!targetHost || !isSafeDirectHost(targetHost)) return false;

  return getNoProxy().split(',').some((rawEntry) => {
    const entry = splitNoProxyEntry(rawEntry);
    if (!entry) return false;
    if (entry.port && entry.port !== targetPort) return false;
    if (entry.host === '*') return true;
    if (entry.host.startsWith('*.')) {
      return targetHost.endsWith(entry.host.slice(1)) && targetHost !== entry.host.slice(2);
    }
    if (entry.host.startsWith('.')) {
      return targetHost === entry.host.slice(1) || targetHost.endsWith(entry.host);
    }
    return targetHost === entry.host;
  });
}

function getSafeNoProxy() {
  return getNoProxy().split(',').map(value => value.trim()).filter((value) => {
    const entry = splitNoProxyEntry(value);
    if (!entry || entry.host === '*' || entry.host.startsWith('.') || entry.host.startsWith('*.')) return false;
    return isSafeDirectHost(entry.host);
  }).join(',');
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
  const targetHost = getTargetHostname(options);
  const targetPort = Number(options.port || 443);
  if (!targetHost) {
    callback(new Error('HTTPS proxy target host missing'));
    return;
  }

  let settled = false;
  let handshakeTimer = null;
  function finish(err, socket) {
    if (settled) return;
    settled = true;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    callback(err, socket);
  }

  const proxyHost = normalizeHostname(proxy.hostname);
  const connectOptions = {
    host: proxyHost,
    port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)),
  };
  const proxySocket = proxy.protocol === 'https:'
    ? tls.connect({ ...connectOptions, servername: net.isIP(proxyHost) ? undefined : proxyHost })
    : net.connect(connectOptions);
  handshakeTimer = setTimeout(() => {
    finish(new Error('HTTPS proxy handshake timed out'));
    proxySocket.destroy();
  }, PROXY_HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref();

  function sendConnect() {
    const authority = formatConnectAuthority(targetHost, targetPort);
    const headers = [
      `CONNECT ${authority} HTTP/1.1`,
      `Host: ${authority}`,
      'Connection: keep-alive',
      'Proxy-Connection: Keep-Alive',
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
    if (buffer.length > MAX_PROXY_HEADER_BYTES) {
      proxySocket.destroy();
      finish(new Error('HTTPS proxy CONNECT response headers are too large'));
      return;
    }
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;

    proxySocket.off('data', onProxyData);
    const header = buffer.slice(0, headerEnd).toString('latin1');
    const statusLine = header.split('\r\n')[0] || '';
    const status = Number((statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i) || [])[1]);
    if (status !== 200) {
      proxySocket.destroy();
      finish(new Error(`HTTPS proxy CONNECT failed: HTTP ${status || 'unknown'}`));
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
  const targetHost = getTargetHostname(options);
  const targetPort = Number(options.port || 443);
  if (!targetHost) {
    callback(new Error('SOCKS5 proxy target host missing'));
    return;
  }

  let settled = false;
  let handshakeTimer = null;
  function finish(err, socket) {
    if (settled) return;
    settled = true;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    callback(err, socket);
  }

  const proxySocket = net.connect({
    host: normalizeHostname(proxy.hostname),
    port: Number(proxy.port || 1080),
  });
  handshakeTimer = setTimeout(() => {
    finish(new Error('SOCKS5 proxy handshake timed out'));
    proxySocket.destroy();
  }, PROXY_HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref();

  let stage = 'greeting';
  let buffer = Buffer.alloc(0);
  const hasAuth = Boolean(proxy.username || proxy.password);

  proxySocket.once('connect', () => {
    proxySocket.write(hasAuth
      ? Buffer.from([0x05, 0x01, 0x02])
      : Buffer.from([0x05, 0x01, 0x00]));
  });

  proxySocket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_PROXY_HEADER_BYTES) {
      proxySocket.destroy();
      finish(new Error('SOCKS5 proxy response is too large'));
      return;
    }

    if (stage === 'greeting') {
      if (buffer.length < 2) return;
      if (buffer[0] !== 0x05) {
        proxySocket.destroy();
        finish(new Error('SOCKS5 proxy returned an invalid greeting version'));
        return;
      }
      const method = buffer[1];
      buffer = buffer.slice(2);
      if (method === 0xff) {
        proxySocket.destroy();
        finish(new Error('SOCKS5 proxy rejected authentication methods'));
        return;
      }
      if (method === 0x02) {
        if (!hasAuth) {
          proxySocket.destroy();
          finish(new Error('SOCKS5 proxy selected an authentication method that was not configured'));
          return;
        }
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
      if (method !== 0x00 || hasAuth) {
        proxySocket.destroy();
        finish(new Error(hasAuth
          ? 'SOCKS5 proxy refused the configured authentication method'
          : `SOCKS5 proxy selected unsupported auth method: ${method}`));
        return;
      }
      stage = 'connect';
      sendSocksConnect(proxySocket, targetHost, targetPort);
    }

    if (stage === 'auth') {
      if (buffer.length < 2) return;
      const ok = buffer[0] === 0x01 && buffer[1] === 0x00;
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
      if (buffer[0] !== 0x05 || buffer[2] !== 0x00) {
        proxySocket.destroy();
        finish(new Error('SOCKS5 proxy returned an invalid CONNECT response'));
        return;
      }
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
  try {
    socket.write(buildSocksConnectRequest(targetHost, targetPort));
  } catch (error) {
    socket.destroy(error);
  }
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
    const targetHost = merged.hostname || merged.host || merged.servername;
    const targetPort = merged.port || 443;
    if (!shouldBypassProxy(targetHost, targetPort)) merged.agent = agent;
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

  const hasAuth = Boolean(proxy.username || proxy.password);
  if (hasAuth && (proxy.protocol === 'socks5:' || proxy.protocol === 'socks5h:')) {
    throw new Error('Playwright does not support SOCKS5 proxy authentication; use an unauthenticated local/LAN SOCKS5 endpoint or an authenticated HTTP(S) proxy');
  }

  // Playwright requires HTTP(S) credentials outside server and only accepts socks5://.
  const protocol = proxy.protocol === 'socks5h:' ? 'socks5:' : proxy.protocol;
  const result = { server: `${protocol}//${proxy.host}` };
  if (hasAuth) {
    result.username = decodeURIComponent(proxy.username || '');
    result.password = decodeURIComponent(proxy.password || '');
  }
  const bypass = getSafeNoProxy();
  if (bypass) result.bypass = bypass;
  return result;
}

module.exports = {
  getProxyUrl,
  getNoProxy,
  getSafeNoProxy,
  proxyEnabled,
  lanProxyAllowed,
  redactProxyUrl,
  shouldBypassProxy,
  getTargetHostname,
  formatConnectAuthority,
  buildSocksConnectRequest,
  installGlobalHttpsProxy,
  getPlaywrightProxy,
};
