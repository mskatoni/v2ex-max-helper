#!/usr/bin/env bash
# =============================================================================
# V2EX Max Helper — systemd timer 一键安装脚本
#
# 为「每日签到 / 保活心跳 / 自动阅读」生成 systemd service + timer 单元，
# 并可选安装 Telegram Bot 常驻 service。
#
# 用法：
#   sudo bash scripts/install-systemd.sh                 # 安装默认账号
#   sudo bash scripts/install-systemd.sh --profile acc2  # 为多账号 profile 安装
#   sudo bash scripts/install-systemd.sh --uninstall     # 卸载默认账号
#   sudo bash scripts/install-systemd.sh --uninstall --profile acc2
#   sudo bash scripts/install-systemd.sh --no-reader     # 不安装阅读 timer
#   sudo bash scripts/install-systemd.sh --bot           # 同时安装 Bot service
#   sudo bash scripts/install-systemd.sh --bot-only      # 只补装 Bot，不重写 timer
#
# 签到、保活和阅读时间均按服务器本地时区解析。
# =============================================================================
set -euo pipefail

# ---------- 颜色 ----------
if [[ -t 1 ]]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[36m'; N=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; N=''
fi
info()  { echo "${B}[*]${N} $*"; }
ok()    { echo "${G}[✓]${N} $*"; }
warn()  { echo "${Y}[!]${N} $*"; }
die()   { echo "${R}[x]${N} $*" >&2; exit 1; }

# ---------- 参数解析 ----------
PROFILE="default"
DO_UNINSTALL=0
INSTALL_READER=1
INSTALL_BOT=0
BOT_ONLY=0
ASSUME_YES=0
RUN_USER_ARG=""
PROJ_ROOT_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)    PROFILE="${2:?--profile 需要一个名称}"; shift 2 ;;
    --profile=*)  PROFILE="${1#*=}"; shift ;;
    --uninstall)  DO_UNINSTALL=1; shift ;;
    --no-reader)  INSTALL_READER=0; shift ;;
    --bot)        INSTALL_BOT=1; shift ;;
    --bot-only)   INSTALL_BOT=1; BOT_ONLY=1; INSTALL_READER=0; shift ;;
    --yes)        ASSUME_YES=1; shift ;;
    --user)       RUN_USER_ARG="${2:?--user 需要用户名}"; shift 2 ;;
    --user=*)     RUN_USER_ARG="${1#*=}"; shift ;;
    --project-root) PROJ_ROOT_ARG="${2:?--project-root 需要路径}"; shift 2 ;;
    --project-root=*) PROJ_ROOT_ARG="${1#*=}"; shift ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo bash $0 ...）"
command -v systemctl >/dev/null 2>&1 || die "未检测到 systemd，请改用 crontab 方案（见 部署指南.md）"

# profile 名安全校验（只允许字母数字、下划线、连字符）
[[ "$PROFILE" =~ ^[A-Za-z0-9_-]+$ ]] || die "profile 名非法：$PROFILE"
PROFILE_LOWER="${PROFILE,,}"
if [[ "$PROFILE" != "default" && "$PROFILE_LOWER" == "default" ]] ||
   [[ "$PROFILE_LOWER" =~ ^(con|prn|aux|nul|com[1-9]|lpt[1-9])$ ]]; then
  die "profile 不能使用跨平台保留名称：$PROFILE"
fi
if [[ $INSTALL_BOT -eq 1 && "$PROFILE" != "default" ]]; then
  die "Telegram 长轮询 Bot 只能安装一个；请仅用默认 profile 执行 --bot，多账号由 V2EX_PROFILE_LIST 管理"
fi

# 单元名后缀：default 不加后缀，其他用 -<profile>
if [[ "$PROFILE" == "default" ]]; then SUF=""; else SUF="-$PROFILE"; fi
UNIT_CHECKIN="v2ex-checkin${SUF}"
UNIT_PING="v2ex-ping${SUF}"
UNIT_READER="v2ex-reader${SUF}"
UNIT_BOT="v2ex-bot${SUF}"
SYSD="/etc/systemd/system"

# =============================================================================
# 卸载
# =============================================================================
if [[ $DO_UNINSTALL -eq 1 ]]; then
  info "卸载 profile=${PROFILE} 的 systemd 单元..."
  for u in "${UNIT_CHECKIN}.timer" "${UNIT_PING}.timer" "${UNIT_READER}.timer" \
           "${UNIT_CHECKIN}.service" "${UNIT_PING}.service" "${UNIT_READER}.service" \
           "${UNIT_BOT}.service"; do
    if systemctl cat "$u" >/dev/null 2>&1; then
      systemctl disable --now "$u" >/dev/null 2>&1 || true
    fi
    rm -f "${SYSD}/${u}"
  done
  systemctl daemon-reload
  ok "已卸载 profile=${PROFILE} 的全部单元。"
  exit 0
fi

# =============================================================================
# 交互收集配置
# =============================================================================
DEF_USER="${SUDO_USER:-root}"
if [[ -n "$RUN_USER_ARG" ]]; then
  RUN_USER="$RUN_USER_ARG"
elif [[ $ASSUME_YES -eq 1 ]]; then
  RUN_USER="$DEF_USER"
else
  read -rp "运行用户 [${DEF_USER}]: " RUN_USER; RUN_USER="${RUN_USER:-$DEF_USER}"
fi
id "$RUN_USER" >/dev/null 2>&1 || die "用户不存在：$RUN_USER"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[[ -n "$RUN_HOME" ]] || die "无法确定 $RUN_USER 的家目录"

# 项目根目录：默认取脚本所在仓库的上级
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEF_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
if [[ -n "$PROJ_ROOT_ARG" ]]; then
  PROJ_ROOT="$PROJ_ROOT_ARG"
elif [[ $ASSUME_YES -eq 1 ]]; then
  PROJ_ROOT="$DEF_ROOT"
else
  read -rp "项目根目录 [${DEF_ROOT}]: " PROJ_ROOT; PROJ_ROOT="${PROJ_ROOT:-$DEF_ROOT}"
fi
if [[ "$PROJ_ROOT" == *$'\n'* || "$PROJ_ROOT" == *$'\r'* || "$RUN_HOME" == *$'\n'* || "$RUN_HOME" == *$'\r'* ]]; then
  die "项目路径或用户家目录包含不支持的控制字符"
fi
PROJ_ROOT="$(realpath -e -- "$PROJ_ROOT")" || die "无法解析项目根目录：$PROJ_ROOT"
[[ -f "${PROJ_ROOT}/checkin/v2ex-checkin.js" ]] || die "在 ${PROJ_ROOT} 下找不到 checkin/v2ex-checkin.js，请确认路径"

# node 路径
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || die "未找到 node，请先安装 Node.js 24+"
NODE_MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" -ge 24 ]] || die "Node.js 版本过低（$($NODE_BIN -v)），请升级到 24+"
ok "node: ${NODE_BIN}"

# 浏览器默认 headless；仅显式使用 HEADLESS=false 时才需要 xvfb-run。
XVFB_PREFIX=""
if [[ $INSTALL_READER -eq 1 && $ASSUME_YES -eq 0 ]]; then
  if command -v xvfb-run >/dev/null 2>&1; then
    XVFB_BIN="$(command -v xvfb-run)"
    read -rp "是否为显式 HEADLESS=false 的阅读任务启用 xvfb-run？[y/N]: " yn
    [[ "${yn,,}" == "y" ]] && XVFB_PREFIX="${XVFB_BIN} -a "
  fi
fi

# 时间配置
T_CHECKIN="*-*-* 09:10:00"
T_PING="*-*-* 00/6:00:00"
T_READER="*-*-* 09:15:00"
if [[ $BOT_ONLY -eq 0 && $ASSUME_YES -eq 0 ]]; then
  read -rp "签到时间 OnCalendar [${T_CHECKIN}]: " value; T_CHECKIN="${value:-$T_CHECKIN}"
  read -rp "保活时间 OnCalendar [${T_PING}]: " value; T_PING="${value:-$T_PING}"
  read -rp "阅读时间 OnCalendar [${T_READER}]: " value; T_READER="${value:-$T_READER}"
fi
if [[ $BOT_ONLY -eq 0 ]]; then
  command -v systemd-analyze >/dev/null 2>&1 || die "缺少 systemd-analyze，无法安全校验 timer 时间"
  systemd-analyze calendar "$T_CHECKIN" >/dev/null 2>&1 || die "签到 OnCalendar 无效：$T_CHECKIN"
  systemd-analyze calendar "$T_PING" >/dev/null 2>&1 || die "保活 OnCalendar 无效：$T_PING"
  systemd-analyze calendar "$T_READER" >/dev/null 2>&1 || die "阅读 OnCalendar 无效：$T_READER"
fi

# 所有单元都显式指定 profile；非 default 单元屏蔽共享路径和启动 Cookie 覆盖值。
PROFILE_ENV="Environment=V2EX_PROFILE=${PROFILE}"
PROFILE_ISOLATION_ENV=""
if [[ "$PROFILE" != "default" ]]; then
  PROFILE_ISOLATION_ENV=$'Environment=COOKIE_FILE=\nEnvironment=DB_PATH=\nEnvironment=V2EX_COOKIE='
fi

echo
info "即将安装（profile=${PROFILE}）："
echo "  用户       : ${RUN_USER} (HOME=${RUN_HOME})"
echo "  项目根目录 : ${PROJ_ROOT}"
if [[ $BOT_ONLY -eq 0 ]]; then
  echo "  签到       : ${T_CHECKIN}"
  echo "  保活       : ${T_PING}"
  [[ $INSTALL_READER -eq 1 ]] && echo "  阅读       : ${T_READER}  ${XVFB_PREFIX:+(xvfb-run)}"
fi
[[ $INSTALL_BOT -eq 1 ]] && echo "  Bot        : 常驻 service（定时任务由 systemd timer 负责）"
if [[ $ASSUME_YES -eq 0 ]]; then
  read -rp "确认安装？[Y/n]: " go; [[ "${go,,}" == "n" ]] && { warn "已取消"; exit 0; }
fi

# =============================================================================
# 生成单元文件
# =============================================================================
write_oneshot_service() {
  local name="$1" desc="$2" workdir="$3" execstart="$4" extra="${5:-}" unit_extra="${6:-}"
  cat > "${SYSD}/${name}.service" <<EOF
[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target
${unit_extra}

[Service]
Type=oneshot
User=${RUN_USER}
UMask=0077
Environment=HOME=${RUN_HOME}
${PROFILE_ENV}
${PROFILE_ISOLATION_ENV}
WorkingDirectory=${workdir}
ExecStart=${execstart}
${extra}
EOF
}

write_timer() {
  local name="$1" desc="$2" oncal="$3" rand="$4"
  cat > "${SYSD}/${name}.timer" <<EOF
[Unit]
Description=${desc}

[Timer]
OnCalendar=${oncal}
RandomizedDelaySec=${rand}
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

CHK_DIR="${PROJ_ROOT}/checkin"
RDR_DIR="${PROJ_ROOT}/reader"

if [[ $BOT_ONLY -eq 0 ]]; then
  # 签到
  write_oneshot_service "$UNIT_CHECKIN" "V2EX 每日签到 (${PROFILE})" \
    "$CHK_DIR" "${NODE_BIN} v2ex-checkin.js"
  write_timer "$UNIT_CHECKIN" "V2EX 每日签到定时器 (${PROFILE})" "$T_CHECKIN" 600

  # 保活
  write_oneshot_service "$UNIT_PING" "V2EX 保活心跳 (${PROFILE})" \
    "$CHK_DIR" "${NODE_BIN} v2ex-checkin.js --ping"
  write_timer "$UNIT_PING" "V2EX 保活定时器 (${PROFILE})" "$T_PING" 300

  # 阅读
  if [[ $INSTALL_READER -eq 1 ]]; then
    READER_UNIT_DEPS="$(printf 'Requires=%s.service\nAfter=%s.service' "$UNIT_CHECKIN" "$UNIT_CHECKIN")"
    write_oneshot_service "$UNIT_READER" "V2EX 自动阅读 (${PROFILE})" \
      "$RDR_DIR" "${XVFB_PREFIX}${NODE_BIN} main.js" "TimeoutStartSec=6h" "$READER_UNIT_DEPS"
    write_timer "$UNIT_READER" "V2EX 自动阅读定时器 (${PROFILE})" "$T_READER" 900
  fi
fi

# Bot（常驻）
if [[ $INSTALL_BOT -eq 1 ]]; then
  cat > "${SYSD}/${UNIT_BOT}.service" <<EOF
[Unit]
Description=V2EX Telegram Bot (${PROFILE})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
UMask=0077
Environment=HOME=${RUN_HOME}
${PROFILE_ENV}
Environment=V2EX_DISABLE_INTERNAL_SCHEDULER=1
Environment=DISABLE_HTTP_WALL=1
WorkingDirectory=${RDR_DIR}
ExecStart=${NODE_BIN} bot.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
fi

# =============================================================================
# 启用
# =============================================================================
systemctl daemon-reload

if [[ $BOT_ONLY -eq 0 ]]; then
  ENABLE_TIMERS=("${UNIT_CHECKIN}.timer" "${UNIT_PING}.timer")
  [[ $INSTALL_READER -eq 1 ]] && ENABLE_TIMERS+=("${UNIT_READER}.timer")
  systemctl enable --now "${ENABLE_TIMERS[@]}"
fi

if [[ $INSTALL_BOT -eq 1 ]]; then
  systemctl enable "${UNIT_BOT}.service"
  systemctl restart "${UNIT_BOT}.service"
  systemctl is-active --quiet "${UNIT_BOT}.service" || die "Bot 服务启动失败：${UNIT_BOT}.service"
fi

# =============================================================================
# 配置 logrotate（防止日志无限增长）
# =============================================================================
LOGROTATE_CONF="/etc/logrotate.d/v2ex"
if [[ ! -f "$LOGROTATE_CONF" ]] && command -v logrotate >/dev/null 2>&1; then
  cat > "$LOGROTATE_CONF" <<'LOGEOF'
/var/log/v2ex.log /var/log/v2ex-reader.log /var/log/v2ex-bot.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
LOGEOF
  info "已创建日志轮转配置 ${LOGROTATE_CONF}"
fi

echo
ok "安装完成（profile=${PROFILE}）"
echo
info "常用命令："
echo "  systemctl list-timers 'v2ex-*'              # 查看定时器与下次触发"
echo "  journalctl -u ${UNIT_CHECKIN} -n 50         # 签到日志"
echo "  journalctl -u ${UNIT_PING} -f               # 实时保活日志"
[[ $INSTALL_READER -eq 1 ]] && echo "  systemctl start ${UNIT_READER}.service       # 手动触发一次阅读"
[[ $INSTALL_BOT -eq 1 ]]    && echo "  systemctl status ${UNIT_BOT}                 # Bot 状态"
echo "  sudo bash $0 --uninstall ${PROFILE:+--profile $PROFILE}   # 卸载"
echo
warn "提示：请确认运行用户 ${RUN_USER} 的家目录下已保存 Cookie（~/.v2ex_cookie 或 .<profile>）。"
warn "      签到、阅读和 Bot 都会读取运行用户家目录下的 ~/.v2ex_env，且 Environment= 优先。"
warn "      Telegram Bot 需要配置 TG_CHAT_ID，或配置 TG_SETUP_CODE 后用 /bind 绑定。"
info "日志：systemd timer 任务默认输出到 journald（自带轮转）。"
info "      若改用 crontab + 文件重定向，logrotate 配置已就绪（${LOGROTATE_CONF:-/etc/logrotate.d/v2ex}）。"
