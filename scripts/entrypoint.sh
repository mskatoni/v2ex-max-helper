#!/bin/sh
set -eu

echo "[entrypoint] Starting v2ex-max-helper..."

# 确保数据目录存在
DATA_DIR="${V2EX_DATA_DIR:-/app/data}"
export V2EX_DATA_DIR="$DATA_DIR"
mkdir -p "$V2EX_DATA_DIR"

# V2EX_COOKIE 由 Node.js 在确认 profile 并验证账号身份后原子写入。
# 入口脚本不直接触碰登录凭证，避免多账号模式下写入错误槽位。

# Bot 自带受限的 /health 服务。直接 exec 可少驻留一个 Node/V8 进程，
# 并让 tini 把退出信号直接交给 Bot 的优雅关闭处理器。
exec node reader/bot.js
