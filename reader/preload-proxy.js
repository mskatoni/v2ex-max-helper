const HttpsProxyAgent = require('https-proxy-agent');
const https = require('https');
const url = require('url');

const proxyUrl = 'http://127.0.0.1:7890';
const agent = new HttpsProxyAgent.HttpsProxyAgent(proxyUrl);

// Patch https.request
const origRequest = https.request;
https.request = function(opts, cb) {
    if (typeof opts === 'string') opts = url.parse(opts);
    const merged = Object.assign({}, opts, { agent, rejectUnauthorized: false });
    if (typeof cb === 'function') return origRequest.call(https, merged, cb);
    return origRequest.call(https, merged);
};

// Patch https.get (Node.js get(url, options, callback) signature)
const origGet = https.get;
https.get = function(input, options, cb) {
    let opts, callback;
    if (typeof options === 'function') { callback = options; opts = {}; }
    else { callback = cb; opts = options || {}; }
    if (typeof input === 'string') input = url.parse(input);
    const merged = Object.assign({}, input, opts, { agent, method: 'GET', rejectUnauthorized: false });
    if (typeof callback === 'function') return origGet.call(https, merged, callback);
    return origGet.call(https, merged);
};
