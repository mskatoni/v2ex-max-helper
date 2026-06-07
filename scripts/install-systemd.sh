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
#
# 时间默认按服务器本地时区解析（OnCalendar）。
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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)    PROFILE="${2:?--profile 需要一个名称}"; shift 2 ;;
    --profile=*)  PROFILE="${1#*=}"; shift ;;
    --uninstall)  DO_UNINSTALL=1; shift ;;
    --no-reader)  INSTALL_READER=0; shift ;;
    --bot)        INSTALL_BOT=1; shift ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo bash $0 ...）"
command -v systemctl >/dev/null 2>&1 || die "未检测到 systemd，请改用 crontab 方案（见 部署指南.md）"

# profile 名安全校验（只允许字母数字、下划线、连字符）
[[ "$PROFILE" =~ ^[A-Za-z0-9_-]+$ ]] || die "profile 名非法：$PROFILE"

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
    if systemctl list-unit-files | grep -q "^${u}"; then
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
read -rp "运行用户 [${DEF_USER}]: " RUN_USER; RUN_USER="${RUN_USER:-$DEF_USER}"
id "$RUN_USER" >/dev/null 2>&1 || die "用户不存在：$RUN_USER"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[[ -n "$RUN_HOME" ]] || die "无法确定 $RUN_USER 的家目录"

# 项目根目录：默认取脚本所在仓库的上级
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEF_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
read -rp "项目根目录 [${DEF_ROOT}]: " PROJ_ROOT; PROJ_ROOT="${PROJ_ROOT:-$DEF_ROOT}"
[[ -f "${PROJ_ROOT}/checkin/v2ex-checkin.js" ]] || die "在 ${PROJ_ROOT} 下找不到 checkin/v2ex-checkin.js，请确认路径"

# node 路径
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || die "未找到 node，请先安装 Node.js 18+"
ok "node: ${NODE_BIN}"

# 阅读模块需要 xvfb-run（无头机器）
XVFB_PREFIX=""
if [[ $INSTALL_READER -eq 1 ]]; then
  if command -v xvfb-run >/dev/null 2>&1; then
    XVFB_BIN="$(command -v xvfb-run)"
    read -rp "阅读模块用 xvfb-run 包装（无头服务器选 Y）？[Y/n]: " yn
    [[ "${yn,,}" == "n" ]] || XVFB_PREFIX="${XVFB_BIN} -a "
  else
    warn "未检测到 xvfb-run。有头机器可忽略；无头服务器请先 apt-get install -y xvfb"
  fi
fi

# 时间配置
read -rp "签到时间 OnCalendar [*-*-* 09:10:00]: " T_CHECKIN; T_CHECKIN="${T_CHECKIN:-*-*-* 09:10:00}"
read -rp "保活时间 OnCalendar [*-*-* 00/6:00:00]: " T_PING;   T_PING="${T_PING:-*-*-* 00/6:00:00}"
read -rp "阅读时间 OnCalendar [*-*-* 09:15:00]: " T_READER; T_READER="${T_READER:-*-*-* 09:15:00}"

# 环境变量：V2EX_PROFILE（非 default 才注入）
PROFILE_ENV=""
[[ "$PROFILE" != "default" ]] && PROFILE_ENV="Environment=V2EX_PROFILE=${PROFILE}"

echo
info "即将安装（profile=${PROFILE}）："
echo "  用户       : ${RUN_USER} (HOME=${RUN_HOME})"
echo "  项目根目录 : ${PROJ_ROOT}"
echo "  签到       : ${T_CHECKIN}"
echo "  保活       : ${T_PING}"
[[ $INSTALL_READER -eq 1 ]] && echo "  阅读       : ${T_READER}  ${XVFB_PREFIX:+(xvfb-run)}"
[[ $INSTALL_BOT -eq 1 ]]    && echo "  Bot        : 常驻 service"
read -rp "确认安装？[Y/n]: " go; [[ "${go,,}" == "n" ]] && { warn "已取消"; exit 0; }

# =============================================================================
# 生成单元文件
# =============================================================================
write_oneshot_service() {
  local name="$1" desc="$2" workdir="$3" execstart="$4" extra="${5:-}"
  cat > "${SYSD}/${name}.service" <<EOF
[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${RUN_USER}
Environment=HOME=${RUN_HOME}
${PROFILE_ENV}
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
  write_oneshot_service "$UNIT_READER" "V2EX 自动阅读 (${PROFILE})" \
    "$RDR_DIR" "${XVFB_PREFIX}${NODE_BIN} main.js" "TimeoutStartSec=6h"
  write_timer "$UNIT_READER" "V2EX 自动阅读定时器 (${PROFILE})" "$T_READER" 900
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
Environment=HOME=${RUN_HOME}
${PROFILE_ENV}
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

ENABLE_TIMERS=("${UNIT_CHECKIN}.timer" "${UNIT_PING}.timer")
[[ $INSTALL_READER -eq 1 ]] && ENABLE_TIMERS+=("${UNIT_READER}.timer")
systemctl enable --now "${ENABLE_TIMERS[@]}"

if [[ $INSTALL_BOT -eq 1 ]]; then
  systemctl enable --now "${UNIT_BOT}.service"
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
warn "提示：请确认已配置 ~/.v2ex_env 与 ~/.v2ex_cookie（对应运行用户 ${RUN_USER} 的家目录）。"
