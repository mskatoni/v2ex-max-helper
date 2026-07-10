'use strict';
// ========== 统一日志 ==========
function pad(n) { return String(n).padStart(2, '0'); }
function utcOffset(d) {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
function ts() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${utcOffset(d)}`;
}
const logger = {
  info:  (m) => console.log(`[${ts()}] [INFO ] ${m}`),
  ok:    (m) => console.log(`[${ts()}] [OK   ] ${m}`),
  warn:  (m) => console.warn(`[${ts()}] [WARN ] ${m}`),
  error: (m) => console.error(`[${ts()}] [ERROR] ${m}`),
  sep:   ()  => console.log('─'.repeat(60)),
};
module.exports = logger;
