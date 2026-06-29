#!/bin/bash
set -e

echo "================================================="
echo " V2EX Bot Docker Initialization"
echo "================================================="

# 确保数据目录存在
mkdir -p /data

# 导出环境变量供 cron 使用 (过滤掉不合适的变量)
env | grep -v 'no_proxy' | grep -v 'HOSTNAME' >> /etc/environment

# 启动 cron 守护进程
echo "Starting cron daemon..."
service cron start

# 检查 Bot Token。TG_CHAT_ID 可留空，Bot 首次私聊后自动绑定。
if [ -z "$TG_TOKEN" ]; then
    echo "[WARNING] TG_TOKEN is not set."
    echo "[WARNING] Telegram Bot will not be able to start correctly."
else
    echo "Telegram Bot token configured. TG_CHAT_ID is optional."
fi

echo "================================================="
echo " Bot is now running and polling Telegram."
echo " Cron tasks are scheduled in the background."
echo "================================================="

# 前台运行 bot，维持容器不退出
cd /app/reader
exec /usr/bin/node bot.js
