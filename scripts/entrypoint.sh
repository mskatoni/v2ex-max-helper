#!/bin/sh
set -e

echo "[entrypoint] Starting v2ex-max-helper on Render..."

# 确保数据目录存在
if [ -n "$V2EX_DATA_DIR" ]; then
  mkdir -p "$V2EX_DATA_DIR"
fi

# 将 V2EX_COOKIE 环境变量写入临时文件（供模块读取）
if [ -n "$V2EX_COOKIE" ]; then
  echo "[entrypoint] Writing cookie from env to ${V2EX_DATA_DIR}/.v2ex_cookie"
  echo "$V2EX_COOKIE" > "${V2EX_DATA_DIR}/.v2ex_cookie"
fi

# 后台启动：签到模块（一键签到一次）
node checkin/v2ex-checkin.js &
CHECKIN_PID=$!
echo "[entrypoint] checkin started (PID: $CHECKIN_PID)"

# 禁用 bot.js 内置的 HTTP 端口监听，防止与 server.js 冲突
export DISABLE_HTTP_WALL=1

# 后台启动：Telegram Bot（常驻，内置每日 01:10 签到 / 01:15 阅读调度器）
node reader/bot.js &
BOT_PID=$!
echo "[entrypoint] bot started (PID: $BOT_PID)"

# 后台启动：阅读模块（一键阅读一次）
node reader/main.js &
READER_PID=$!
echo "[entrypoint] reader scheduler started (PID: $READER_PID)"

# 前台启动：HTTP 健康检查服务（阻塞进程，防止容器退出）
node server.js
