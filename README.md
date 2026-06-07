# V2EX Max Helper

> V2EX 一站式自动助手：**每日签到** + **自动阅读刷活跃度** + **Telegram Bot 上报/远程控制**。

纯 Node.js 实现，可部署在任意 VPS 上挂机运行。包含两个相互独立、可单独使用的模块：

| 模块 | 目录 | 作用 |
|------|------|------|
| 签到 | [`checkin/`](checkin/) | 每日自动签到、保活心跳防 Session 过期、Cookie 失效推送告警 |
| 阅读 + Bot | [`reader/`](reader/) | Playwright 自动阅读帖子刷活跃度铜币、SQLite 去重队列、Telegram Bot 命令上报 |

---

## ✨ 功能特性

- ✅ **每日签到**：自动领取每日登录奖励，记录连续签到天数，支持失败重试。
- 🔄 **登录态自动续期**：捕获服务端响应的 `Set-Cookie` 并写回本地，利用 V2EX 的滑动续期机制持续延长 `A2` 登录有效期，**正常情况无需反复重新登录**（签到 / 保活 / 阅读三条链路均自动续期）。
- 🔁 **保活心跳**：每 6 小时访问首页触发登录态续期，避免 Cookie 自然过期。
- 📖 **自动阅读**：真实浏览器（Playwright）阅读帖子刷活跃度铜币，**拟人随机化**——停留时长偏态分布（多数偏短、偶尔长读）、帖子间随机间隔、阅读时随机滚动页面，参数可调。
- 🗃️ **智能队列**：SQLite（sql.js 纯 JS 版）多源抓取 + 去重，每帖最多读 3 次，自动清理旧记录。
- 🛑 **多重停止条件**：余额变化达标 / 阅读量上限 / 超时窗口，任一触发即安全退出。
- 🤖 **Telegram Bot**：`/sou` 查余额、`/debug` 看报错、`/stop` 远程停止，**硬锁授权 Chat ID**。
- 📢 **推送告警**：Cookie 失效、活跃度奖励、阅读完成均可推送至 Telegram / Bark。
- 👥 **多账号 + 指纹隔离**：通过 `V2EX_PROFILE` 隔离多账号的 Cookie、浏览器数据与**确定性指纹**（UA/视口/时区/语言/硬件/WebGL），降低账号关联风险。详见 [`docs/多账号与指纹隔离.md`](docs/多账号与指纹隔离.md)。
- 🔒 **隐私优先**：所有 Token、Chat ID、Cookie 均从环境变量或本地文件读取，**不写入代码**。

---

## 🚀 快速开始

### 1. 环境要求

- Node.js 18+
- 阅读模块需要 Chromium（`reader/` 安装 `playwright` 时会自带，或运行 `npx playwright install chromium`）

#### VPS 配置建议

阅读模块会启动真实 Chromium 浏览器（有头模式以降低风控），内存是主要瓶颈。

| 使用场景 | CPU | 内存 | Swap | 说明 |
|----------|-----|------|------|------|
| **仅签到 + 保活** | 1 vCPU | 512 MB | 可选 | 纯 HTTP 请求，几乎不吃资源 |
| **签到 + 自动阅读（最低）** | 1 vCPU | **1 GB** | **建议开 1 GB** | Chromium 峰值约 400~700 MB，1 GB 物理内存易在 Cloudflare 挑战时 OOM，**务必配 1 GB Swap 兜底** |
| **签到 + 自动阅读（推荐）** | 1 vCPU | **2 GB** | 可不开 | 运行稳定，无需 Swap |

> 1 GB 内存的小鸡跑阅读模块，**强烈建议开启 1 GB Swap**，否则浏览器渲染高峰可能被系统 OOM Killer 杀掉。
> 创建 1 GB Swap：
> ```bash
> sudo fallocate -l 1G /swapfile
> sudo chmod 600 /swapfile
> sudo mkswap /swapfile
> sudo swapon /swapfile
> echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # 开机自动挂载
> free -h   # 确认 Swap 已生效
> ```

### 2. 下载并解压

从 [Releases](https://github.com/mskatoni/v2ex-max-helper/releases) 或仓库主页下载 `main.zip` 并解压。

### 3. 配置敏感信息

```bash
cp .v2ex_env.example ~/.v2ex_env
# 编辑 ~/.v2ex_env，填入你的 TG_TOKEN、TG_CHAT_ID 等
chmod 600 ~/.v2ex_env
```

### 4. 保存你的 V2EX Cookie

登录 V2EX 后，从浏览器开发者工具复制完整 Cookie 字符串，然后：

```bash
cd checkin
V2EX_COOKIE="你的cookie字符串" node v2ex-checkin.js --save-cookie
# Cookie 会被保存到 ~/.v2ex_cookie（权限 600）
```

> 签到与阅读两个模块**共用** `~/.v2ex_cookie`。

### 5. 运行

```bash
# 每日签到
cd checkin && node v2ex-checkin.js

# 自动阅读（建议先干跑测试）
cd reader && npm install
node main.js --dry-run   # 干跑，只演练不真实阅读
node main.js             # 正式运行

# 启动 Telegram Bot（常驻进程）
node bot.js
```

---

## 🤖 Telegram Bot 命令

| 命令 | 说明 |
|------|------|
| `/sou` | 查询今日 / 昨日余额（铜币）记录 |
| `/debug` | 查看阅读脚本最近的报错日志 |
| `/stop` | 远程停止正在运行的阅读脚本 |

Bot 通过 `TG_CHAT_ID` **硬锁授权**，只响应你本人的消息，其他人无法控制。

---

## ⏰ 定时任务（推荐 systemd timer）

**推荐用 systemd timer**：支持开机自动补跑漏掉的任务（`Persistent`）、内置随机延迟错峰（`RandomizedDelaySec`）、日志统一进 journald。仓库提供一键安装脚本：

```bash
cd v2ex-max-helper
sudo bash scripts/install-systemd.sh            # 交互式安装签到/保活/阅读 timer
sudo bash scripts/install-systemd.sh --profile acc2   # 多账号
sudo bash scripts/install-systemd.sh --bot      # 同时安装 Bot 常驻 service

systemctl list-timers 'v2ex-*'                  # 查看定时器
journalctl -u v2ex-checkin -n 50                # 查看签到日志
```

无 systemd 的老系统可回退 crontab。手动配置 timer / crontab 的完整示例见 [`docs/部署指南.md`](docs/部署指南.md)。

> 🤖 想让 AI 助手代为部署？见 [`docs/Agent辅助部署.md`](docs/Agent辅助部署.md)。
> **门槛极低：只需有效 Cookie + 约 5 Mbps 网络即可部署。**
> ✅ **推荐工具**：付费首选 **Claude Pro**；想免费则用 **Antigravity（Google Antigravity，<https://antigravity.google>）**，
> 仅需 Google 账号在 Free 计划下即可调用 Claude Opus 4.6 等模型完成部署。
> ⚠️ **安全提醒：请勿使用任何第三方「中转站 API」驱动部署 Agent**，
> 中转站会让你的 Cookie、Token 等敏感数据明文流经其服务器，导致被第四方泄露。
> 请使用上述官方直连方案，并将 Cookie 等敏感值手动留在自己的服务器上。

---

## 📁 目录结构

```
v2ex-max-helper/
├── checkin/                 # 签到模块
│   ├── v2ex-checkin.js      # 签到 + 保活主程序
│   └── package.json
├── reader/                  # 自动阅读 + Bot 模块
│   ├── main.js              # 阅读主调度器
│   ├── bot.js               # Telegram Bot 命令处理器
│   ├── notify.js            # 推送通知
│   ├── browser.js           # Playwright 浏览器控制
│   ├── fetcher.js           # 帖子 URL 多源抓取
│   ├── balance.js           # 余额监控
│   ├── queue.js             # SQLite 去重队列
│   ├── fingerprint.js       # 浏览器指纹隔离（多账号）
│   ├── logger.js            # 日志
│   ├── inspect_balance.js   # 余额调试工具
│   ├── data/                # 运行时数据（已被 gitignore）
│   └── package.json
├── scripts/                 # 运维脚本
│   └── install-systemd.sh   # systemd timer 一键安装
├── docs/                    # 中文文档
│   ├── 部署指南.md
│   ├── Agent辅助部署.md     # AI 助手部署 + 安全须知
│   ├── 多账号与指纹隔离.md  # 多账号管理 + 指纹隔离
│   ├── 配置说明.md
│   └── 常见问题.md
├── .v2ex_env.example        # 配置示例
├── .gitignore
├── LICENSE
└── README.md
```

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
