#!/bin/sh
set -e

echo "[entrypoint] Starting v2ex-max-helper..."

# 确保数据目录存在
if [ -n "$V2EX_DATA_DIR" ]; then
  mkdir -p "$V2EX_DATA_DIR"
fi

# 将 V2EX_COOKIE 环境变量写入文件（供模块读取）
if [ -n "$V2EX_COOKIE" ]; then
  COOKIE_TARGET="${V2EX_DATA_DIR}/.v2ex_cookie"
  echo "[entrypoint] Writing cookie from env to ${COOKIE_TARGET}"
  printf '%s' "$V2EX_COOKIE" > "$COOKIE_TARGET"
  chmod 600 "$COOKIE_TARGET"
fi

# Docker 下禁用 bot.js 内置的 HTTP 铁墙（由 server.js 统一提供）
export DISABLE_HTTP_WALL=1

# 后台启动：Telegram Bot（常驻，内置每日定时签到/阅读调度器）
node reader/bot.js &
BOT_PID=$!
echo "[entrypoint] bot started (PID: $BOT_PID)"

# 前台启动：HTTP 健康检查服务（阻塞进程，防止容器退出）
exec node server.js
