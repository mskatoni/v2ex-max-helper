#!/usr/bin/env bash
# =============================================================================
# V2EX Max Helper — 一键部署脚本（给 mjj 用）
#
# 一条命令在全新 Linux VPS 上完成：
#   装 Node.js → 拉取项目 → 装依赖 → （可选）装 xvfb/Chromium → 引导存 Cookie
#   → 用 systemd timer 配好签到/保活/（可选）阅读定时任务
#   → （可选）安装 Telegram Bot 常驻服务
#
# 用法（在 VPS 上以 root 执行）：
#   bash <(curl -fsSL https://raw.githubusercontent.com/mskatoni/v2ex-max-helper/mskatoni-patch-beta/scripts/install.sh)
# 或先下载再运行：
#   bash scripts/install.sh
# 更新已有安装：
#   bash scripts/install.sh --update
#
# 参数：
#   --update              更新模式：拉取最新代码 + 重装依赖，保留 Cookie 和定时器
#
# 环境变量（可选，跳过对应交互）：
#   V2EX_PROFILE=acc2     为指定多账号 profile 部署
#   INSTALL_DIR=/opt/v2ex 自定义安装目录（默认 ~/v2ex-max-helper）
#   SKIP_READER=1         只装签到+保活，不装自动阅读
#   BRANCH=main           指定下载分支（默认 mskatoni-patch-beta）
# =============================================================================
set -euo pipefail

REPO_NAME="v2ex-max-helper"
REPO_RAW="https://github.com/mskatoni/${REPO_NAME}"
BRANCH="${BRANCH:-mskatoni-patch-beta}"
ZIP_URL="${REPO_RAW}/archive/refs/heads/${BRANCH}.zip"
PROFILE="${V2EX_PROFILE:-default}"

# ---------- 参数解析 ----------
UPDATE_MODE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --update)  UPDATE_MODE=1; shift ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（用 --help 查看用法）" >&2; exit 1 ;;
  esac
done

# ---------- 颜色 ----------
if [[ -t 1 ]]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[36m'; N=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; N=''
fi
info() { echo "${B}[*]${N} $*"; }
ok()   { echo "${G}[✓]${N} $*"; }
warn() { echo "${Y}[!]${N} $*"; }
die()  { echo "${R}[x]${N} $*" >&2; exit 1; }
step() { echo; echo "${B}==== $* ====${N}"; }

[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo bash 或切到 root）"

# ---------- 自动检测更新模式 ----------
DEFAULT_DIR="${INSTALL_DIR:-$HOME/v2ex-max-helper}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo '')"

# 如果项目目录已存在，自动进入更新模式
if [[ $UPDATE_MODE -eq 0 ]]; then
  if [[ -n "$SCRIPT_DIR" && -f "${SCRIPT_DIR}/../checkin/v2ex-checkin.js" ]]; then
    UPDATE_MODE=1
  elif [[ -f "${DEFAULT_DIR}/checkin/v2ex-checkin.js" ]]; then
    UPDATE_MODE=1
  fi
fi

if [[ $UPDATE_MODE -eq 1 ]]; then
  info "进入${Y}更新模式${N}（保留 Cookie 和定时任务配置）"
fi

# ---------- 跟踪安装组件（用于最终摘要） ----------
SUMMARY_COMPONENTS=()   # 已安装/更新的组件列表
SUMMARY_SKIPPED=()      # 跳过的组件列表
HAS_SYSTEMD=0           # 是否安装了 systemd timer
INSTALLED_BOT=0         # 是否安装了 Bot

# ---------- 检测包管理器 ----------
if   command -v apt-get >/dev/null 2>&1; then PM="apt";    INSTALL="apt-get install -y";    UPDATE="apt-get update -y"
elif command -v dnf     >/dev/null 2>&1; then PM="dnf";    INSTALL="dnf install -y";        UPDATE="true"
elif command -v yum     >/dev/null 2>&1; then PM="yum";    INSTALL="yum install -y";        UPDATE="true"
elif command -v apk     >/dev/null 2>&1; then PM="apk";    INSTALL="apk add";               UPDATE="apk update"
else die "未识别的包管理器（支持 apt/dnf/yum/apk）"; fi
info "包管理器：${PM}"

# =============================================================================
# Step 1/8 — 基础工具
# =============================================================================
step "1/8 基础工具"
$UPDATE >/dev/null 2>&1 || true
for pkg in curl unzip git; do
  command -v "$pkg" >/dev/null 2>&1 || { info "安装 $pkg"; $INSTALL "$pkg" >/dev/null 2>&1 || true; }
done
ok "基础工具就绪"

# =============================================================================
# Step 2/8 — Node.js 18+
# =============================================================================
step "2/8 Node.js"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
  if [[ "$major" -ge 18 ]]; then need_node=0; ok "已安装 Node $(node -v)"; else warn "Node 版本过低（$(node -v)），将升级"; fi
fi
if [[ $need_node -eq 1 ]]; then
  case "$PM" in
    apt)        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1; $INSTALL nodejs >/dev/null 2>&1 ;;
    dnf|yum)    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null 2>&1; $INSTALL nodejs >/dev/null 2>&1 ;;
    apk)        $INSTALL nodejs npm >/dev/null 2>&1 ;;
  esac
  command -v node >/dev/null 2>&1 || die "Node.js 安装失败，请手动安装后重试"
  ok "Node $(node -v) 安装完成"
fi

# =============================================================================
# Step 3/8 — 获取 / 更新项目代码
# =============================================================================
step "3/8 获取项目代码"

if [[ -n "$SCRIPT_DIR" && -f "${SCRIPT_DIR}/../checkin/v2ex-checkin.js" ]]; then
  # 已在项目内运行（如 git clone 后执行）
  PROJ_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
  if [[ $UPDATE_MODE -eq 1 && -d "${PROJ_DIR}/.git" ]]; then
    info "从 git 拉取最新代码..."
    ( cd "$PROJ_DIR" && git pull --ff-only ) || warn "git pull 失败，继续使用当前版本"
    SUMMARY_COMPONENTS+=("项目代码（git pull 更新）")
  else
    ok "检测到本地项目：${PROJ_DIR}"
    [[ $UPDATE_MODE -eq 1 ]] && SUMMARY_COMPONENTS+=("项目代码（本地，无 .git）") || SUMMARY_COMPONENTS+=("项目代码")
  fi
else
  PROJ_DIR="$DEFAULT_DIR"
  if [[ -f "${PROJ_DIR}/checkin/v2ex-checkin.js" ]]; then
    if [[ $UPDATE_MODE -eq 1 ]]; then
      if [[ -d "${PROJ_DIR}/.git" ]]; then
        info "从 git 拉取最新代码..."
        ( cd "$PROJ_DIR" && git pull --ff-only ) || warn "git pull 失败，继续使用当前版本"
        SUMMARY_COMPONENTS+=("项目代码（git pull 更新）")
      else
        info "重新下载最新代码（分支：${BRANCH}）..."
        tmp="$(mktemp -d)"
        curl -fsSL "$ZIP_URL" -o "${tmp}/source.zip" || { warn "下载失败，继续使用当前版本"; rm -rf "$tmp"; }
        if [[ -f "${tmp}/source.zip" ]]; then
          unzip -q "${tmp}/source.zip" -d "$tmp"
          src_dir="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
          [[ -n "$src_dir" ]] || { warn "解压后未找到项目目录，继续使用当前版本"; rm -rf "$tmp"; }
          # 保留用户数据目录，只更新代码文件
          if [[ -n "${src_dir:-}" ]]; then
            rsync -a --exclude='node_modules' --exclude='.git' \
              "${src_dir}/" "$PROJ_DIR/" 2>/dev/null \
              || cp -a "${src_dir}/." "$PROJ_DIR/" 2>/dev/null || true
          fi
          rm -rf "$tmp"
          SUMMARY_COMPONENTS+=("项目代码（zip 重新下载）")
        fi
        ok "代码已更新：${PROJ_DIR}"
      fi
    else
      ok "已存在：${PROJ_DIR}"
      SUMMARY_COMPONENTS+=("项目代码")
    fi
  else
    info "下载分支 ${BRANCH} 到 ${PROJ_DIR}"
    tmp="$(mktemp -d)"
    curl -fsSL "$ZIP_URL" -o "${tmp}/source.zip" || die "下载失败，请检查网络或手动 git clone"
    unzip -q "${tmp}/source.zip" -d "$tmp"
    src_dir="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    [[ -n "$src_dir" ]] || die "解压后未找到项目目录"
    mkdir -p "$(dirname "$PROJ_DIR")"
    rm -rf "$PROJ_DIR"
    mv "$src_dir" "$PROJ_DIR"
    rm -rf "$tmp"
    ok "项目就绪：${PROJ_DIR}"
    SUMMARY_COMPONENTS+=("项目代码（全新安装）")
  fi
fi

# ---------- 选择是否安装阅读模块 ----------
INSTALL_READER=1
[[ "${SKIP_READER:-0}" == "1" ]] && INSTALL_READER=0
if [[ $INSTALL_READER -eq 1 && -t 0 && $UPDATE_MODE -eq 0 ]]; then
  read -rp "是否安装『自动阅读』模块（需 Chromium，吃内存；只签到选 n）？[Y/n]: " yn
  [[ "${yn,,}" == "n" ]] && INSTALL_READER=0
fi

# =============================================================================
# Step 4/8 — 安装依赖
# =============================================================================
step "4/8 安装依赖"
if [[ $INSTALL_READER -eq 1 ]]; then
  # 无头机器需要 xvfb
  if ! command -v xvfb-run >/dev/null 2>&1; then
    info "安装 xvfb（无头服务器跑有头浏览器用）"
    case "$PM" in
      apt)     $INSTALL xvfb >/dev/null 2>&1 || warn "xvfb 安装失败，可后续手动装" ;;
      dnf|yum) $INSTALL xorg-x11-server-Xvfb >/dev/null 2>&1 || warn "xvfb 安装失败" ;;
      apk)     $INSTALL xvfb >/dev/null 2>&1 || warn "xvfb 安装失败" ;;
    esac
  fi
  info "安装 reader 依赖（playwright + sql.js），可能较慢..."
  ( cd "${PROJ_DIR}/reader" && npm install --no-audit --no-fund >/dev/null 2>&1 ) || die "npm install 失败"
  info "安装 Chromium 内核..."
  ( cd "${PROJ_DIR}/reader" && npx playwright install chromium >/dev/null 2>&1 ) || warn "Chromium 安装失败，可手动 npx playwright install chromium"
  ok "阅读模块依赖就绪"
  SUMMARY_COMPONENTS+=("阅读模块依赖")
else
  ok "仅签到模块，无需额外依赖"
  SUMMARY_SKIPPED+=("阅读模块")
fi

# =============================================================================
# Step 5/8 — 保存 V2EX Cookie
# =============================================================================
step "5/8 保存 V2EX Cookie"
CK_FILE="$HOME/.v2ex_cookie"
[[ "$PROFILE" != "default" ]] && CK_FILE="$HOME/.v2ex_cookie.${PROFILE}"

if [[ $UPDATE_MODE -eq 1 ]]; then
  # 更新模式：保留现有 Cookie
  if [[ -s "$CK_FILE" ]]; then
    ok "保留现有 Cookie：${CK_FILE}"
    SUMMARY_SKIPPED+=("Cookie 设置（保留现有）")
  else
    warn "未找到 Cookie 文件 ${CK_FILE}，请手动执行："
    echo "  V2EX_COOKIE=\"你的cookie\" node ${PROJ_DIR}/checkin/v2ex-checkin.js --save-cookie"
  fi
elif [[ -s "$CK_FILE" ]]; then
  ok "已存在 Cookie：${CK_FILE}（如需更新可重跑 --save-cookie）"
  SUMMARY_COMPONENTS+=("Cookie")
elif [[ -t 0 ]]; then
  echo "请粘贴登录后的 V2EX Cookie 字符串（浏览器 F12 → Network → 任意请求 → Request Headers 的 Cookie）："
  read -rp "Cookie: " ck
  if [[ -n "$ck" ]]; then
    V2EX_PROFILE="$PROFILE" V2EX_COOKIE="$ck" node "${PROJ_DIR}/checkin/v2ex-checkin.js" --save-cookie \
      && { ok "Cookie 已保存到 ${CK_FILE}"; SUMMARY_COMPONENTS+=("Cookie"); } \
      || warn "保存失败，稍后手动执行 --save-cookie"
  else
    warn "未输入 Cookie，稍后请手动执行："
    echo "  V2EX_COOKIE=\"你的cookie\" node ${PROJ_DIR}/checkin/v2ex-checkin.js --save-cookie"
  fi
else
  warn "非交互环境，跳过 Cookie 录入。请稍后手动执行："
  echo "  V2EX_COOKIE=\"你的cookie\" node ${PROJ_DIR}/checkin/v2ex-checkin.js --save-cookie"
fi

# =============================================================================
# Step 6/8 — 配置定时任务（systemd timer）
# =============================================================================
step "6/8 配置定时任务（systemd timer）"
if [[ $UPDATE_MODE -eq 1 ]]; then
  ok "更新模式：保留现有定时任务配置"
  SUMMARY_SKIPPED+=("定时任务（保留现有）")
  # 检测 systemd 以便后续步骤判断
  command -v systemctl >/dev/null 2>&1 && HAS_SYSTEMD=1
elif command -v systemctl >/dev/null 2>&1; then
  HAS_SYSTEMD=1
  SYSD_ARGS=()
  [[ "$PROFILE" != "default" ]] && SYSD_ARGS+=(--profile "$PROFILE")
  [[ $INSTALL_READER -eq 0 ]]   && SYSD_ARGS+=(--no-reader)
  info "调用 install-systemd.sh ${SYSD_ARGS[*]:-}"
  bash "${PROJ_DIR}/scripts/install-systemd.sh" "${SYSD_ARGS[@]}" \
    && SUMMARY_COMPONENTS+=("systemd 定时任务") \
    || warn "systemd 安装未完成，可稍后手动运行 scripts/install-systemd.sh"
else
  warn "无 systemd，跳过。请参考 docs/部署指南.md 的 crontab 回退方案。"
fi

# =============================================================================
# Step 6.5 — 配置 logrotate（仅 crontab 回退方案需要）
# =============================================================================
# 当使用 systemd timer 时，journald 自行管理日志轮转，无需 logrotate。
# 仅在无 systemd（使用 crontab + 文件重定向）时配置 logrotate。
if [[ $HAS_SYSTEMD -eq 0 ]]; then
  if command -v logrotate >/dev/null 2>&1; then
    info "无 systemd 环境，配置 logrotate 管理日志文件..."
    LOGROTATE_CONF="/etc/logrotate.d/v2ex"
    cat > "$LOGROTATE_CONF" <<'LOGROTATE_EOF'
/var/log/v2ex-*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
}
LOGROTATE_EOF
    ok "logrotate 已配置：${LOGROTATE_CONF}"
    SUMMARY_COMPONENTS+=("logrotate 日志轮转")
  else
    warn "未找到 logrotate，日志文件需手动清理。可安装：$INSTALL logrotate"
  fi
fi

# =============================================================================
# Step 7/8 — Telegram Bot 常驻服务（可选）
# =============================================================================
step "7/8 Telegram Bot 常驻服务（可选）"
if [[ $UPDATE_MODE -eq 1 ]]; then
  # 更新模式下，若 Bot 已安装则跳过
  if [[ $HAS_SYSTEMD -eq 1 ]] && systemctl list-unit-files 2>/dev/null | grep -q 'v2ex-bot.*\.service'; then
    ok "Bot 服务已安装，保留现有配置"
    SUMMARY_SKIPPED+=("Telegram Bot（保留现有）")
  else
    ok "更新模式：跳过 Bot 安装"
    SUMMARY_SKIPPED+=("Telegram Bot")
  fi
elif [[ $HAS_SYSTEMD -eq 1 && -t 0 ]]; then
  read -rp "是否安装 Telegram Bot 常驻服务？需先配好 ~/.v2ex_env [y/N]: " yn_bot
  if [[ "${yn_bot,,}" == "y" ]]; then
    BOT_ARGS=(--bot)
    [[ "$PROFILE" != "default" ]] && BOT_ARGS+=(--profile "$PROFILE")
    [[ $INSTALL_READER -eq 0 ]]   && BOT_ARGS+=(--no-reader)
    info "调用 install-systemd.sh ${BOT_ARGS[*]}"
    bash "${PROJ_DIR}/scripts/install-systemd.sh" "${BOT_ARGS[@]}" \
      && { ok "Bot 服务安装完成"; INSTALLED_BOT=1; SUMMARY_COMPONENTS+=("Telegram Bot 常驻服务"); } \
      || warn "Bot 安装失败，可稍后手动运行：bash ${PROJ_DIR}/scripts/install-systemd.sh --bot"
  else
    ok "跳过 Bot 安装（后续可运行：bash ${PROJ_DIR}/scripts/install-systemd.sh --bot）"
    SUMMARY_SKIPPED+=("Telegram Bot")
  fi
elif [[ $HAS_SYSTEMD -eq 0 ]]; then
  warn "无 systemd，无法安装 Bot 常驻服务。"
  SUMMARY_SKIPPED+=("Telegram Bot（无 systemd）")
else
  ok "非交互环境，跳过 Bot 安装。后续可运行：bash ${PROJ_DIR}/scripts/install-systemd.sh --bot"
  SUMMARY_SKIPPED+=("Telegram Bot")
fi

# =============================================================================
# Step 8/8 — 部署摘要
# =============================================================================
step "8/8 部署摘要"

if [[ $UPDATE_MODE -eq 1 ]]; then
  ok "${G}更新完成！${N}项目目录：${PROJ_DIR}"
else
  ok "${G}部署完成！${N}项目目录：${PROJ_DIR}"
fi

echo
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │             📋 安装组件状态                      │"
echo "  ├─────────────────────────────────────────────────┤"
if [[ ${#SUMMARY_COMPONENTS[@]} -gt 0 ]]; then
  for c in "${SUMMARY_COMPONENTS[@]}"; do
    printf "  │  ${G}✓${N} %-43s │\n" "$c"
  done
fi
if [[ ${#SUMMARY_SKIPPED[@]} -gt 0 ]]; then
  for s in "${SUMMARY_SKIPPED[@]}"; do
    printf "  │  ${Y}—${N} %-43s │\n" "$s"
  done
fi
echo "  └─────────────────────────────────────────────────┘"

echo
info "下一步："
echo "  • 用 Telegram Bot：把 TG_TOKEN 写入 ~/.v2ex_env；并配置 TG_CHAT_ID，或设置 TG_SETUP_CODE 后用 /bind 绑定"
if [[ $HAS_SYSTEMD -eq 1 ]]; then
  echo "  • 查看定时器：systemctl list-timers 'v2ex-*'"
  echo "  • 查看签到日志：journalctl -u v2ex-checkin -n 50"
fi
echo "  • 文档：${PROJ_DIR}/docs/"
echo "  • 更新到最新版本：bash ${PROJ_DIR}/scripts/install.sh --update"
if [[ $INSTALLED_BOT -eq 1 ]]; then
  echo "  • 查看 Bot 状态：systemctl status v2ex-bot"
fi
echo
