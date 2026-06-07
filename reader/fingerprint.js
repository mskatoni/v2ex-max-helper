'use strict';
// ========== 浏览器指纹隔离 ==========
// 为多账号场景提供「每个账号一套确定性指纹」：
//   - 以 profile 名作为种子，保证同一账号每次启动指纹完全一致；
//   - 不同账号之间指纹相互隔离，避免被关联（UA/视口/时区/语言/硬件参数等）。
//
// 设计原则：只在「合理且常见」的取值范围内选择，避免生成罕见组合反而更显眼。

const crypto = require('crypto');

// 基于种子字符串生成一个确定性 PRNG（mulberry32）
function makeRng(seedStr) {
  // 用 sha256 把任意字符串折叠成 32-bit 种子
  const hash = crypto.createHash('sha256').update(String(seedStr)).digest();
  let a = hash.readUInt32LE(0);
  return function rng() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 从数组里按 rng 确定性取一个
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// ===== 候选池（均为常见、低风险的真实组合）=====

// 近期主流稳定版 Chrome 大版本
const CHROME_VERSIONS = ['122.0.0.0', '123.0.0.0', '124.0.0.0', '125.0.0.0', '126.0.0.0'];

// 平台维度：UA 片段 + navigator.platform + UA-CH platform
const PLATFORMS = [
  {
    name: 'Windows',
    uaOS: 'Windows NT 10.0; Win64; x64',
    navPlatform: 'Win32',
    chPlatform: 'Windows',
    chPlatformVersion: '15.0.0',
  },
  {
    name: 'macOS',
    uaOS: 'Macintosh; Intel Mac OS X 10_15_7',
    navPlatform: 'MacIntel',
    chPlatform: 'macOS',
    chPlatformVersion: '14.5.0',
  },
];

// 常见桌面分辨率对应的视口（已扣除浏览器边框，取常见可视区）
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

// 语言（V2EX 受众，以中文为主，少量英文优先）
const LANGUAGES = [
  { locale: 'zh-CN', accept: 'zh-CN,zh;q=0.9,en;q=0.8', langs: ['zh-CN', 'zh', 'en'] },
  { locale: 'zh-CN', accept: 'zh-CN,zh;q=0.9', langs: ['zh-CN', 'zh'] },
  { locale: 'en-US', accept: 'en-US,en;q=0.9,zh-CN;q=0.8', langs: ['en-US', 'en', 'zh-CN'] },
];

// 时区（与中文受众匹配，覆盖常见地区）
const TIMEZONES = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Singapore'];

// 硬件并发数（CPU 逻辑核心，常见值）
const HW_CONCURRENCY = [4, 8, 12, 16];

// 设备内存（GB，navigator.deviceMemory 只会暴露 0.25/0.5/1/2/4/8）
const DEVICE_MEMORY = [4, 8];

// WebGL vendor/renderer 组合（常见显卡）
const WEBGL = [
  { vendor: 'Google Inc. (Intel)',  renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)',  renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)',    renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Apple Inc.',           renderer: 'Apple GPU' },
];

/**
 * 根据 profile 名生成一套确定性指纹。
 * @param {string} profileName 账号 profile 名（如 'default'、'acc1'）
 * @returns {object} fingerprint
 */
function generate(profileName) {
  const rng = makeRng(`v2ex-fp::${profileName}`);

  const chromeVer = pick(rng, CHROME_VERSIONS);
  const platform  = pick(rng, PLATFORMS);
  const viewport  = pick(rng, VIEWPORTS);
  const lang      = pick(rng, LANGUAGES);
  const webgl     = pick(rng, WEBGL);

  // macOS 上不会出现 NVIDIA/AMD D3D11，统一用 Apple GPU；非 mac 上避免误用 Apple GPU
  let gl = webgl;
  if (platform.name === 'macOS') {
    gl = { vendor: 'Apple Inc.', renderer: 'Apple GPU' };
  } else if (webgl.renderer === 'Apple GPU') {
    gl = WEBGL[0]; // 回退到 Intel
  }

  const userAgent =
    `Mozilla/5.0 (${platform.uaOS}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${chromeVer} Safari/537.36`;

  const majorVersion = chromeVer.split('.')[0];

  return {
    profileName,
    chromeVersion: chromeVer,
    majorVersion,
    userAgent,
    platform: platform.name,
    navPlatform: platform.navPlatform,
    chPlatform: platform.chPlatform,
    chPlatformVersion: platform.chPlatformVersion,
    viewport,
    locale: lang.locale,
    acceptLanguage: lang.accept,
    languages: lang.langs,
    timezoneId: pick(rng, TIMEZONES),
    hardwareConcurrency: pick(rng, HW_CONCURRENCY),
    deviceMemory: pick(rng, DEVICE_MEMORY),
    webglVendor: gl.vendor,
    webglRenderer: gl.renderer,
  };
}

/**
 * 生成在浏览器上下文中执行的指纹注入脚本（覆盖各 navigator / WebGL 属性）。
 * @param {object} fp generate() 的返回值
 * @returns {Function} 供 addInitScript 使用的函数
 */
function buildInitScript(fp) {
  return (cfg) => {
    // 隐藏自动化标志
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };

    const define = (obj, prop, value) => {
      try { Object.defineProperty(obj, prop, { get: () => value }); } catch (_) {}
    };

    define(navigator, 'platform', cfg.navPlatform);
    define(navigator, 'hardwareConcurrency', cfg.hardwareConcurrency);
    define(navigator, 'deviceMemory', cfg.deviceMemory);
    define(navigator, 'language', cfg.languages[0]);
    define(navigator, 'languages', Object.freeze(cfg.languages.slice()));

    // WebGL vendor / renderer 伪装
    const patchGL = (proto) => {
      if (!proto || !proto.getParameter) return;
      const orig = proto.getParameter;
      proto.getParameter = function (param) {
        // UNMASKED_VENDOR_WEBGL = 37445, UNMASKED_RENDERER_WEBGL = 37446
        if (param === 37445) return cfg.webglVendor;
        if (param === 37446) return cfg.webglRenderer;
        return orig.call(this, param);
      };
    };
    if (typeof WebGLRenderingContext !== 'undefined') patchGL(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patchGL(WebGL2RenderingContext.prototype);
  };
}

module.exports = { generate, buildInitScript };
