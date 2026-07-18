'use strict';
// 调试工具：抓取 /balance 页面，只打印不含页面正文的结构摘要。
// 用于排查铜币解析正则是否匹配，正常运行不需要它。
const fs    = require('fs');
const balance = require('./balance');
const config = require('../lib/config');

const cfg = config.getConfig();
const cookie = fs.readFileSync(cfg.cookieFile, 'utf8').trim();

balance.fetchBalance(cookie).then(resp => {
  const issue = balance.diagnoseResponse(resp);
  const parsed = balance.parseBalance(resp.body);

  console.log('=== 请求状态 ===');
  console.log(`HTTP: ${resp.statusCode}`);
  console.log(`Final URL: ${resp.finalUrl}`);
  console.log(`Redirected: ${resp.redirected ? 'yes' : 'no'}`);
  console.log(`Diagnosis: ${issue ? `${issue.code} - ${issue.message}` : 'ok'}`);
  console.log(`Parsed: ${parsed ? JSON.stringify(parsed) : 'null'}`);
  console.log(`Body bytes: ${Buffer.byteLength(resp.body || '')}`);
  console.log(`Has balance area: ${/balance_area\s+bigger/i.test(resp.body) ? 'yes' : 'no'}`);
  console.log(`Coin image markers: ${(resp.body.match(/<img[^>]+alt=["'][GSB]["']/gi) || []).length}`);
  console.log('Raw HTML omitted to protect account and transaction privacy.');
}).catch(e => {
  console.error(`inspect_balance failed: ${e.message}`);
  process.exit(1);
});
