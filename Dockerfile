FROM node:18-slim

WORKDIR /app

# 安装 Chromium 和 Playwright 所需的系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    libxss1 \
    libgtk-3-0 \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# 告诉 Playwright 使用系统 Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROME_BIN=/usr/bin/chromium

# 复制依赖定义并安装
COPY checkin/package*.json ./checkin/
COPY reader/package*.json ./reader/

RUN cd checkin && npm ci --omit=dev \
 && cd ../reader && npm ci --omit=dev

# 复制业务代码
COPY checkin/ ./checkin/
COPY reader/ ./reader/
COPY scripts/entrypoint.sh ./entrypoint.sh
COPY server.js ./server.js

# 赋予入口脚本执行权限
RUN chmod +x ./entrypoint.sh

# 创建非 root 用户（安全）
RUN groupadd -r v2ex && useradd -r -g v2ex -d /app v2ex \
    && chown -R v2ex:v2ex /app

# 运行时数据目录（临时，重启清空）
RUN mkdir -p /tmp/v2ex-data && chown v2ex:v2ex /tmp/v2ex-data

USER v2ex

# Render 会自动设置 PORT 环境变量
EXPOSE 8080

ENV NODE_ENV=production
ENV V2EX_DATA_DIR=/tmp/v2ex-data
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

CMD ["./entrypoint.sh"]
