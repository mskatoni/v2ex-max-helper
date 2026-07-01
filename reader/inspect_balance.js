'use strict';
// 调试工具：抓取 /balance 页面，打印活跃度/奖励相关的 HTML 片段
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

  // 找交易记录相关行
  const lines = resp.body.split('\n');
  const relevant = lines.filter(l =>
    l.includes('活') || l.includes('奖') || l.includes('签到') ||
    l.includes('award') || l.includes('tr') || l.includes('copper')
  );
  console.log('\n=== 相关行 ===');
  console.log(relevant.slice(0, 40).join('\n'));
  console.log('\n=== 交易区域 ===');
  const start = resp.body.indexOf('balance_area');
  console.log(start >= 0 ? resp.body.substring(start, start + 3000) : '(未找到 balance_area)');
}).catch(e => {
  console.error(`inspect_balance failed: ${e.message}`);
  process.exit(1);
});
