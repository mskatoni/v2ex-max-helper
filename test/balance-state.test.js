'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const balanceHtml = '<div class="balance_area bigger">0 <img alt="G"> 2 <img alt="S"> 9 <img alt="B"></div>';
const coinHtml = (gold, silver, copper) =>
  `<div class="balance_area bigger">${gold} <img alt="G"> ${silver} <img alt="S"> ${copper} <img alt="B"></div>`;

function runBalanceScript(dataDir, body, extraEnv = {}) {
  return childProcess.spawnSync(process.execPath, ['-e', body], {
    cwd: repoRoot,
    env: {
      ...process.env,
      V2EX_DATA_DIR: dataDir,
      V2EX_PROFILE: 'default',
      V2EX_PROXY_ENABLE: '0',
      TG_TOKEN: '',
      TG_CHAT_ID: '',
      FEISHU_ENABLE: '0',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

test('balance parser requires a copper value and preserves zero-valued coins', () => {
  const script = `const b=require('./reader/balance'); console.log(JSON.stringify([b.parseBalance(${JSON.stringify(balanceHtml)}),b.parseBalance('<div class="balance_area bigger">none</div>')]));`;
  const result = runBalanceScript(os.tmpdir(), script);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), [{ gold: 0, silver: 2, copper: 9 }, null]);
});

test('corrupt balance history is rebuilt and repeated today updates retain seven days', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-balance-state-'));
  try {
    const logFile = path.join(dir, 'balance_log.json');
    fs.writeFileSync(logFile, '{broken');
    let result = runBalanceScript(dir, `require('./reader/balance').saveBalanceLog(${JSON.stringify(balanceHtml)})`);
    assert.equal(result.status, 0, result.stderr);
    let parsed = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    assert.equal(Object.keys(parsed).length, 1);

    const today = new Date();
    const pad = value => String(value).padStart(2, '0');
    const key = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    parsed = {};
    for (let offset = 6; offset >= 0; offset--) {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
      parsed[key(date)] = { copper: offset, last: offset, lastTime: date.toISOString() };
    }
    fs.writeFileSync(logFile, JSON.stringify(parsed));
    result = runBalanceScript(dir, `require('./reader/balance').saveBalanceLog(${JSON.stringify(balanceHtml)})`);
    assert.equal(result.status, 0, result.stderr);
    parsed = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    assert.equal(Object.keys(parsed).length, 7);
    assert.equal(parsed[key(today)].copper, 9);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('balance inspection tool never prints raw account HTML', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'reader', 'inspect_balance.js'), 'utf8');
  assert.doesNotMatch(source, /relevant\.slice|substring\(start|交易区域|相关行/);
  assert.match(source, /Raw HTML omitted/);
});

// 回归：issue #7「只比较铜币个位数/单值，完全忽略银币变动导致第二次活跃度奖励未被识别」
// 79 铜 → 13 铜 若同时伴随银币 +1，实际是奖励到账；旧实现只比铜币，会当成消费而不计数，
// 于是第二次活跃度奖励永远不会触发停止条件，reader 一直读到 14:00。
test('balance changes are detected across all three coin denominations', () => {
  const queue = [
    coinHtml(0, 2, 79), coinHtml(0, 3, 13),   // 银币 +1 / 铜币 -66（issue #7 场景）
    coinHtml(0, 2, 10), coinHtml(0, 2, 15),   // 纯铜币奖励
    coinHtml(0, 2, 79), coinHtml(0, 2, 13),   // 纯铜币支出，不应计数
    coinHtml(1, 2, 79), coinHtml(2, 2, 79),   // 金币奖励
  ];
  const script = `
const https = require('https');
const { EventEmitter } = require('events');
const queue = JSON.parse(process.env.BALANCE_RESPONSE_QUEUE);
let call = 0;
https.request = (options, callback) => {
  const req = new EventEmitter();
  req.write = () => {};
  req.destroy = () => {};
  req.setTimeout = () => {};
  req.end = () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    res.setEncoding = () => {};
    callback(res);
    const body = queue[call++] || '';
    setImmediate(() => { res.emit('data', body); res.emit('end'); });
  };
  return req;
};
const balance = require('./reader/balance');
(async () => {
  const out = {};
  await balance.init('A2=test');
  out.silverReward = await balance.check('A2=test');
  await balance.init('A2=test');
  out.copperReward = await balance.check('A2=test');
  await balance.init('A2=test');
  out.pureSpend = await balance.check('A2=test');
  await balance.init('A2=test');
  out.goldReward = await balance.check('A2=test');
  out.requests = call;
  out.verdicts = {
    silverUpCopperDown: balance.compareCoins({ gold: 0, silver: 2, copper: 79 }, { gold: 0, silver: 3, copper: 13 }),
    goldUp: balance.compareCoins({ gold: 0, silver: 2, copper: 79 }, { gold: 1, silver: 2, copper: 79 }),
    copperDownOnly: balance.compareCoins({ gold: 0, silver: 2, copper: 79 }, { gold: 0, silver: 2, copper: 13 }),
    identical: balance.compareCoins({ gold: 1, silver: 2, copper: 3 }, { gold: 1, silver: 2, copper: 3 }),
    missingFields: balance.compareCoins({ copper: 5 }, { silver: 1, copper: 5 }),
    noBaseline: balance.compareCoins(null, { copper: 5 }),
  };
  out.formatted = balance.formatCoins({ gold: 0, silver: 1, copper: 13 });
  console.log('OUT:' + JSON.stringify(out));
})().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2ex-balance-coins-'));
  try {
    const result = runBalanceScript(dir, script, {
      BALANCE_RESPONSE_QUEUE: JSON.stringify(queue),
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.slice(result.stdout.indexOf('OUT:') + 4).trim());

    // 奖励到账（无论以哪种面额发放）都必须被计为一次余额变化
    assert.equal(out.silverReward, 1, '银币发放的活跃度奖励未被识别');
    assert.equal(out.copperReward, 1, '铜币发放的活跃度奖励未被识别');
    assert.equal(out.goldReward, 1, '金币发放的活跃度奖励未被识别');
    // 纯支出仍不应计入活跃度变化
    assert.equal(out.pureSpend, 0, '纯消费被误计为活跃度变化');

    assert.deepEqual(out.verdicts, {
      silverUpCopperDown: 'increase',
      goldUp: 'increase',
      copperDownOnly: 'decrease',
      identical: 'same',
      missingFields: 'increase',
      noBaseline: 'unknown',
    });
    assert.equal(out.formatted, '1 银币 13 铜币');
    // 4 次 init + 4 次 check；未配置推送时不应产生额外请求
    assert.equal(out.requests, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
