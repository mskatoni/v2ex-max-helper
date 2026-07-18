'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const balanceHtml = '<div class="balance_area bigger">0 <img alt="G"> 2 <img alt="S"> 9 <img alt="B"></div>';

function runBalanceScript(dataDir, body) {
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
