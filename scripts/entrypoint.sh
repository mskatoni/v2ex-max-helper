#!/bin/sh
set -eu

echo "[entrypoint] Starting v2ex-max-helper..."

# 确保数据目录存在
DATA_DIR="${V2EX_DATA_DIR:-/app/data}"
export V2EX_DATA_DIR="$DATA_DIR"
mkdir -p "$V2EX_DATA_DIR"

# V2EX_COOKIE 由 Node.js 在确认 profile 并验证账号身份后原子写入。
# 入口脚本不直接触碰登录凭证，避免多账号模式下写入错误槽位。

# Docker 下禁用 bot.js 内置的 HTTP 铁墙（由 server.js 统一提供）
export DISABLE_HTTP_WALL=1

# 后台启动 HTTP 健康检查服务
node server.js &
SERVER_PID=$!
echo "[entrypoint] health server started (PID: $SERVER_PID)"

# 后台启动 Telegram Bot（常驻，内置每日定时签到/阅读调度器）
node reader/bot.js &
BOT_PID=$!
echo "[entrypoint] bot started (PID: $BOT_PID)"

cleanup() {
  echo "[entrypoint] shutting down..."
  kill "$BOT_PID" "$SERVER_PID" 2>/dev/null || true
  wait "$BOT_PID" "$SERVER_PID" 2>/dev/null || true
}

trap 'cleanup; exit 143' INT TERM

set +e
wait "$BOT_PID"
BOT_STATUS=$?
set -e

echo "[entrypoint] bot exited with status ${BOT_STATUS}; stopping health server"
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
exit "$BOT_STATUS"
