FROM node:18-slim

WORKDIR /app

# 安装 Playwright 所需的系统依赖（不装系统 chromium，用 Playwright 自带版本）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    libxss1 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxi6 \
    libxtst6 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    fonts-noto-cjk \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Playwright 自带 Chromium，安装到项目内（容器持久路径）
ENV PLAYWRIGHT_BROWSERS_PATH=/app/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0

# 复制依赖定义并安装
COPY checkin/package*.json ./checkin/
COPY reader/package*.json ./reader/

RUN cd checkin && npm ci --omit=dev \
 && cd ../reader && npm ci --omit=dev \
 && npx --prefix reader playwright install chromium \
 && rm -rf /tmp/* ~/.npm

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

USER v2ex

EXPOSE 8080

ENV NODE_ENV=production
ENV V2EX_DATA_DIR=/app/data
ENV PLAYWRIGHT_BROWSERS_PATH=/app/ms-playwright

CMD ["./entrypoint.sh"]
