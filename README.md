# V2EX Max Helper

> V2EX 一站式自动助手：**每日签到** + **自动阅读刷活跃度** + **Telegram Bot 上报/远程控制**。

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Version](https://img.shields.io/badge/version-v1.3.2-blue)

纯 Node.js 实现，可部署在任意 VPS、Docker 或 Render 上挂机运行。包含两个相互独立、可单独使用的模块：

| 模块 | 目录 | 作用 |
|------|------|------|
| 签到 | [`checkin/`](checkin/) | 每日自动签到、保活心跳防 Session 过期、Cookie 失效推送告警 |
| 阅读 + Bot | [`reader/`](reader/) | Playwright 自动阅读帖子刷活跃度铜币、SQLite 去重队列、Telegram Bot 命令上报 |

---

## 📖 V2EX 活跃度奖励机制

> 如果你已熟悉 V2EX 的铜币系统，可跳过本节。

V2EX 每天会根据用户的**浏览行为**自动发放铜币奖励（通常两轮、每轮数枚），不需要手动领取。
只要在当天使用**已登录的浏览器**访问一定数量的帖子，系统就会把铜币直接加到余额里——
这就是本项目「自动阅读」模块所做的事：**用真实浏览器读帖子，触发活跃度奖励**。

签到奖励则是另一个独立的每日任务（`/mission/daily`），需要主动领取。

---

## ✨ 功能特性

- ✅ **每日签到**：自动领取每日登录奖励，记录连续签到天数，支持失败重试。
- 🔄 **登录态自动续期**：捕获服务端响应的 `Set-Cookie` 并写回本地，利用 V2EX 的滑动续期机制持续延长 `A2` 登录有效期，**正常情况无需反复重新登录**（签到 / 保活 / 阅读三条链路均自动续期）。
- 🔁 **保活心跳**：每 6 小时访问首页，定期触发上述登录态续期，避免长期闲置导致 Cookie 自然过期。
- 📖 **自动阅读**：真实浏览器（Playwright）阅读帖子刷活跃度铜币，**拟人随机化**——停留时长偏态分布（多数偏短、偶尔长读）、帖子间随机间隔、阅读时随机滚动页面，参数可调。
- 🗃️ **智能队列**：SQLite（sql.js 纯 JS 版）多源抓取 + 去重，每帖最多读 3 次，自动清理旧记录。
- 🛑 **多重停止条件**：余额变化达标且满足最低阅读量 / 阅读量上限 / 超时窗口 / 登录确认失效，任一触发即安全退出。
- 🤖 **Telegram Bot**：`/start` 控制面板、`/sou` 查余额、`/checkin`/`/read` 手动任务、`/cookie` 导入登录态、`/debug` 管日志、`/stop` 远程停止。
- 📢 **推送告警**：Cookie 失效、活跃度奖励、阅读完成均可推送至 Telegram / Bark。
- 👥 **多账号 + 指纹隔离**：通过 `V2EX_PROFILE` 隔离多账号的 Cookie、浏览器数据与**确定性指纹**（UA/视口/时区/语言/硬件/WebGL），降低账号关联风险。详见 [`docs/多账号与指纹隔离.md`](docs/多账号与指纹隔离.md)。
- 🔒 **隐私优先**：所有 Token、Chat ID、Cookie 均从环境变量或运行时文件读取，**不写入代码**；未配置 `TG_CHAT_ID` 时必须设置 `TG_SETUP_CODE` 后才能首次绑定。

---

## 🔄 工作流程

项目由四条链路组成，互不强依赖。签到、保活、阅读都会在请求后捕获服务端返回的新 Cookie 并写回本地，尽量延长登录态。

**签到链路**

默认每日 `01:10 UTC` 触发，约北京时间 `09:10`。

1. 读取本地 Cookie。
2. 访问每日任务页，判断今天是否已经签到。
3. 未签到时领取奖励，并查询当前余额。
4. 写回续期后的 Cookie。
5. 失败时通过 Telegram / Bark 推送告警。

**保活链路**

默认每 6 小时触发一次。

1. 带 Cookie 访问 V2EX 首页。
2. 捕获响应里的续期 Cookie。
3. 写回本地 Cookie 文件，降低长期闲置后失效的概率。

**自动阅读链路**

默认每日 `01:15 UTC` 触发，约北京时间 `09:15`。

1. 启动 Playwright，并注入当前 profile 的指纹和 Cookie。
2. 从 SQLite 队列取帖子，队列来源包括 `/recent`、热门、全部、技术分区等页面。
3. 打开帖子后随机停留、随机滚动，模拟真实阅读节奏。
4. 每读一批帖子检查一次余额变化。
5. 达到停止条件后关闭浏览器并输出统计。

阅读任务会在以下任一条件满足时安全退出：

- 余额变化达到目标，且已读数量达到最低要求。
- 阅读篇数达到上限。
- 到达截止时间。
- 确认登录态失效。

**Telegram Bot 链路**

Bot 作为常驻进程运行，负责远程控制和状态查询。

1. 启动后读取 `TG_TOKEN`。
2. 如果没有配置 `TG_CHAT_ID`，必须先配置 `TG_SETUP_CODE`，再私聊发送 `/bind <口令>` 完成绑定。
3. 只响应已绑定用户的命令。
4. 支持余额查询、Cookie 导入、手动签到、手动阅读、日志级别调整和停止任务。

---

## 🚀 部署

提供 Docker / Render / VPS 脚本等部署方式，任选其一。

**前置**：运行环境需要能访问 `www.v2ex.com`。VPS 脚本部署需要 Linux（Debian/Ubuntu 最省心）+ Node.js 18+；Docker / Render 会在镜像内安装依赖。

| 使用场景 | 内存 | Swap | 说明 |
|----------|------|------|------|
| **仅签到 + 保活** | 小于 200 MB | 可选 | 纯 HTTP 请求，几乎不吃资源 |
| **签到 + 自动阅读** | **512 MB** | **建议 1 GB** | Chromium 峰值约 400~700 MB，**务必配 Swap** |
| **签到 + 自动阅读（推荐）** | **2 GB** | 可不开 | 运行稳定 |

代理默认关闭。确实需要时设置 `V2EX_PROXY_ENABLE=1`，并指定本机代理，例如 `V2EX_PROXY=http://127.0.0.1:7890` 或 `V2EX_PROXY=socks5://127.0.0.1:7890`；项目拒绝远端代理。

---

### 方式一：Docker Compose（推荐）

本地或 VPS 已安装 Docker 后，可以直接使用仓库内的 `docker-compose.yml`：

```bash
cp .env.render.example .env
# 编辑 .env，至少填入 TG_TOKEN；TG_CHAT_ID 和 TG_SETUP_CODE 二选一
docker compose up -d --build
docker compose logs -f v2ex-bot
```

如果没有在 `.env` 里填写 `TG_CHAT_ID`，必须设置 `TG_SETUP_CODE`，容器启动后私聊 Bot 发送 `/bind <口令>` 完成绑定；无口令首次自动绑定已关闭，避免被陌生人抢先绑定。随后直接粘贴完整 V2EX Cookie，Bot 会自动识别、验证并写入持久化数据卷。

运行数据保存在 `v2ex-data` volume 中；脚本刷新后的 Cookie 会优先沿用 volume 里的版本，避免容器重启时被旧环境变量覆盖。

仓库还包含 GitHub Actions 镜像发布流程：推送到 `mskatoni-patch-beta`、`main` 或 `master` 时会构建并发布到 GHCR。

---

### 方式二：Render（Docker Runtime）

仓库已包含 `render.yaml`，可在 Render Dashboard 通过 Blueprint 部署，也可创建现有 Web Service 后切到 Docker runtime。

部署时在 Environment 中手动填入：

```text
V2EX_COOKIE=完整 V2EX Cookie
TG_TOKEN=BotFather 申请的 Bot Token
TG_CHAT_ID=你的 Telegram 数字 Chat ID（与 TG_SETUP_CODE 二选一）
TG_SETUP_CODE=首次私聊绑定口令（未填 TG_CHAT_ID 时必填）
```

健康检查路径为 `/health`。如果只想运行签到和 Bot，不跑自动阅读，可额外设置：

```text
SKIP_READER=1
```

Render 免费实例可能休眠，Bot 内置自保活逻辑会在配置 `RENDER_EXTERNAL_URL` 时定期访问自身；稳定性要求更高时建议使用付费实例或外部 pinger。

Render Blueprint 默认把运行时数据写到 `/app/data`。免费实例文件系统不保证长期持久，重建后建议重新私聊绑定 Bot 或重新粘贴 Cookie；需要强持久化时可改用 Docker/VPS，或在付费实例上挂载 Render Disk。

---

### 方式三：AI Agent 辅助部署

让 AI 编程助手代你完成部署：**Agent 负责装环境 / 依赖 / 配置，你只在最后手动填 Token、存 Cookie**。

- 门槛极低：一台能访问 V2EX 的普通小鸡 + 约 5 Mbps 网络即可，直接把 GitHub 项目链接 https://github.com/mskatoni/v2ex-max-helper 丢给 agent 并命令其开始部署即可。
- ✅ **推荐工具**：付费首选 **Claude Pro**；想免费用 **Antigravity（Google Antigravity，<https://antigravity.google>）**，Google 账号 Free 计划即可调用 Claude Opus 4.6 等模型。
- ⚠️ **安全**：启动 Agent 时用官方直连 API，不要经过第三方「中转站」；Cookie、Token 留到最后由你本人手动写入。

模板见 [`docs/Agent辅助部署.md`](docs/Agent辅助部署.md)。

---

### 方式四：一键部署脚本

在 Linux VPS 上以 **root** 执行，自动完成 8 个步骤：装 Node.js → 拉取项目 → 装依赖（含 Chromium/xvfb）→ 引导粘贴 Cookie → 配好 systemd 定时任务 → 可选安装 Bot → 输出组件状态摘要。

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/mskatoni/v2ex-max-helper/mskatoni-patch-beta/scripts/install.sh)
```

> 用 `bash <(curl ...)` 而非 `curl | bash`，这样脚本才能正常接收你的**交互输入**（粘贴 Cookie、选择是否装阅读模块和 Bot）。

可选环境变量（写在命令前面即可）：

```bash
# 多账号：为指定 profile 部署
V2EX_PROFILE=acc2 bash <(curl -fsSL https://raw.githubusercontent.com/mskatoni/v2ex-max-helper/mskatoni-patch-beta/scripts/install.sh)

# 只装签到+保活，不装自动阅读（省内存）
SKIP_READER=1 bash <(curl -fsSL https://raw.githubusercontent.com/mskatoni/v2ex-max-helper/mskatoni-patch-beta/scripts/install.sh)
```

脚本跑完后：

```bash
systemctl list-timers 'v2ex-*'        # 查看定时器
journalctl -u v2ex-checkin -n 50      # 查看签到日志
```

> [!NOTE]
> `checkin/` 和 `reader/` 现在都通过 `lib/config.js` 读取环境变量与 `~/.v2ex_env`，且环境变量优先。
> `TG_BOT_TOKEN` 仍作为签到推送的旧变量名兼容，设置后优先于 `TG_TOKEN`。
> 详见 [`docs/配置说明.md`](docs/配置说明.md)。

---

## 🧪 测试与调试

部署后建议先用以下方式验证，确认无误再挂机：

```bash
# 签到：立即签到测试
cd ~/v2ex-max-helper/checkin
node v2ex-checkin.js

# 保活：测试心跳
node v2ex-checkin.js --ping

# 阅读：干跑模式（不启动浏览器，只验证流程）
cd ~/v2ex-max-helper/reader
node main.js --dry-run

# 阅读：限制只读 5 篇（真实浏览器，快速验证）
node main.js --limit 5

# 余额调试：打印 /balance 请求状态、诊断结果与解析片段
node inspect_balance.js
```

| 参数 | 说明 |
|------|------|
| `--dry-run` | 跳过浏览器启动和真实请求，只跑调度逻辑验证流程 |
| `--limit N` | 最多读 N 篇后停止（覆盖默认的 1000 篇上限），同时禁用截止时间检查 |
| `--ping` | 签到脚本的保活模式，只访问首页刷新登录态 |
| `--save-cookie` | 将 `V2EX_COOKIE` 环境变量的值保存到本地 Cookie 文件 |

---

## 🤖 Telegram Bot 命令

| 命令 | 说明 |
|------|------|
| `/start` | 打开交互遥控中心（含内联按钮） |
| `/help` | 查看命令帮助 |
| `/sou` | 查询今日 / 昨日余额（铜币）记录 |
| `/tasks` | 查看当前后台任务状态 |
| `/checkin` | 立即运行一次签到 |
| `/read [数量]` | 手动触发阅读，默认 5 篇 |
| `/cookie [内容]` | 导入并合并 V2EX Cookie；也可以直接粘贴 Cookie 文本 |
| `/debug [OFF\|ERROR\|WARN\|INFO]` | 查看或修改日志级别，默认 `OFF` |
| `/stop` | 远程停止正在运行的阅读脚本 |

Bot 通过 `TG_CHAT_ID` 或首次私聊绑定文件 **硬锁授权**，只响应你本人的消息，其他人无法控制。为减少隐私暴露，`TG_CHAT_ID` 可以不填，但此时必须设置 `TG_SETUP_CODE`；首次绑定时发送 `/bind <口令>`，Bot 才会把 Chat ID 写入运行时数据目录。无口令首次自动绑定已关闭。

### 安装 Bot

Bot 是常驻进程。**一键部署脚本**在 Step 7/8 会交互式询问是否安装；也可事后手动安装：

```bash
sudo bash scripts/install-systemd.sh --bot   # 安装 Bot 常驻 service
systemctl status v2ex-bot                     # 查看状态
```

> 前提：确保 `~/.v2ex_env` 中已填入 `TG_TOKEN`，并配置 `TG_CHAT_ID` 或 `TG_SETUP_CODE`。

---

## 📁 目录结构

```
v2ex-max-helper/
├── checkin/                 # 签到模块
│   ├── v2ex-checkin.js      # 签到 + 保活主程序（v1.3.2）
│   └── package.json
├── reader/                  # 自动阅读 + Bot 模块
│   ├── main.js              # 阅读主调度器（支持 --dry-run / --limit）
│   ├── bot.js               # Telegram Bot 命令处理器（常驻进程）
│   ├── notify.js            # 推送通知（Telegram / Bark）
│   ├── browser.js           # Playwright 浏览器控制 + 拟人随机化
│   ├── fetcher.js           # 帖子 URL 多源抓取（/recent 多页 + 分区）
│   ├── balance.js           # 余额监控 + 变化检测 + 失败诊断
│   ├── queue.js             # SQLite 去重队列（每帖最多读 3 次）
│   ├── fingerprint.js       # 浏览器指纹隔离（多账号确定性指纹）
│   ├── logger.js            # 日志
│   ├── inspect_balance.js   # 余额调试工具（手动排查用）
│   ├── data/                # 运行时数据（已被 gitignore）
│   └── package.json
├── scripts/                 # 运维脚本
│   ├── install.sh           # 一键部署 / 更新（支持 --update 模式）
│   ├── install-systemd.sh   # systemd timer + Bot + logrotate 安装
│   ├── entrypoint.sh        # Docker / Render 容器入口
│   └── keepalive-setup.md   # Render / 外部保活说明
├── docker/                  # 旧版 cron 容器部署参考
├── lib/                     # checkin / reader 共用配置模块
├── .github/workflows/       # GHCR 镜像构建发布
├── docs/                    # 中文文档
│   ├── 部署指南.md          # 手动部署完整流程
│   ├── Agent辅助部署.md     # AI 助手部署 + 安全须知
│   ├── 多账号与指纹隔离.md  # 多账号管理 + 指纹隔离
│   ├── 配置说明.md          # 环境变量 / 参数一览
│   └── 常见问题.md          # FAQ
├── .v2ex_env.example        # 配置示例
├── .env.render.example      # Docker / Render 环境变量示例
├── Dockerfile               # Docker / Render 镜像构建
├── docker-compose.yml       # Docker Compose 部署
├── render.yaml              # Render Blueprint
├── server.js                # 健康检查 HTTP 服务
├── .gitignore
├── LICENSE
└── README.md
```

---

## 🔧 更新与卸载

### 更新到最新版

**推荐：一键更新**（自动拉取代码 + 重装依赖，保留 Cookie 和定时任务）：

```bash
bash ~/v2ex-max-helper/scripts/install.sh --update
```

> 脚本会自动检测 `.git` 目录：有则 `git pull`，无则重新下载 zip 并用 `rsync` 覆盖（仅代码文件，不影响 `node_modules`、`data/` 等）。

也可手动更新：

```bash
cd ~/v2ex-max-helper
git pull origin mskatoni-patch-beta           # git clone 安装 beta 分支的
cd reader && npm install                      # 更新依赖
```

> 更新不会影响你的 `~/.v2ex_cookie`、`~/.v2ex_env`、`reader/data/` 等运行时数据。

### 卸载

```bash
# 卸载 systemd 定时任务
sudo bash ~/v2ex-max-helper/scripts/install-systemd.sh --uninstall

# 多账号需分别卸载
sudo bash ~/v2ex-max-helper/scripts/install-systemd.sh --uninstall --profile acc2

# 删除项目（可选）
rm -rf ~/v2ex-max-helper

# 删除配置/数据（可选）
rm -f ~/.v2ex_cookie ~/.v2ex_env
```

---

## 📋 日志管理

长期运行建议配置日志轮转，避免日志文件无限增长。创建 `/etc/logrotate.d/v2ex`：

```
/var/log/v2ex.log /var/log/v2ex-reader.log /var/log/v2ex-bot.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

> 如果使用一键脚本 + systemd timer 部署，日志默认走 journald（`journalctl -u v2ex-*`），
> journald 自带轮转机制，无需额外配置 logrotate。只有使用 crontab + 文件重定向时才需要上述配置。

---

## ⚠️ 免责声明

本项目仅供学习与个人自动化使用。请遵守 [V2EX 用户协议](https://www.v2ex.com/about)，合理设置频率，自行承担使用风险。

## 📄 许可证

[CC BY-NC-SA 4.0](LICENSE)（知识共享 署名-非商业性使用-相同方式共享）

- ✅ 可自由使用、修改、分发；
- ⛔ **禁止任何商业用途**；
- 🔁 二次开发 / 衍生作品**必须以相同的 CC BY-NC-SA 4.0 协议开源**；
- ©️ 须保留原作者署名并标明改动。

> 注：因含「禁止商用」条款，本许可证非 OSI 认证的开源许可证，仅限个人、学习与非商业自动化使用。
