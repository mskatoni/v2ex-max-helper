FROM node:24-bookworm-slim

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
    tini \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Playwright 自带 Chromium，安装到项目内（容器持久路径）
ENV PLAYWRIGHT_BROWSERS_PATH=/app/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0

# 复制依赖定义并按 lockfile 安装，避免每次构建漂移到不同版本。
COPY checkin/package*.json ./checkin/
COPY reader/package*.json ./reader/

RUN cd checkin && npm ci --omit=dev --no-audit --no-fund \
 && cd ../reader && npm ci --omit=dev --no-audit --no-fund \
 && ./node_modules/.bin/playwright install chromium \
 && npm cache clean --force \
 && rm -rf /tmp/* ~/.npm

# 复制业务代码
COPY checkin/ ./checkin/
COPY reader/ ./reader/
COPY lib/ ./lib/
COPY scripts/entrypoint.sh ./entrypoint.sh

# 赋予入口脚本执行权限
RUN chmod +x ./entrypoint.sh

# 创建非 root 用户（安全）
RUN groupadd -r v2ex && useradd -r -g v2ex -d /app/data v2ex \
    && mkdir -p /app/data \
    && chown v2ex:v2ex /app/data

USER v2ex

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD-SHELL wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/health" || exit 1

ENV NODE_ENV=production
ENV HOME=/app/data
ENV V2EX_DATA_DIR=/app/data
ENV PLAYWRIGHT_BROWSERS_PATH=/app/ms-playwright

STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./entrypoint.sh"]
