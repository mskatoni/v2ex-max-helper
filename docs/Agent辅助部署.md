# Agent 辅助部署方案

本项目结构清晰、依赖极少，非常适合交给 **AI 编程助手（Agent）** 半自动部署。
你只需准备两样东西：**V2EX Cookie** + **一台能联网的 VPS**，剩下的命令可让 Agent 代为执行。

---

## ⚠️ 安全红线：请勿使用「中转站 API」部署

> **务必使用 AI 服务商官方直连 API（OpenAI / Anthropic / Google 等官方端点），
> 切勿使用任何第三方「中转站 / API 代理 / 镜像聚合」来驱动部署 Agent。**

原因：

- **数据会被第四方截留**：中转站位于你和官方 API 之间，你发给 Agent 的所有内容
  （包括 **V2EX Cookie、Telegram Token、服务器 IP、SSH 信息**）都会明文流经中转站服务器，
  随时可能被记录、转售或泄露给未知的第四方。
- **Cookie 等同账号控制权**：V2EX Cookie 一旦泄露，他人可直接登录你的账号。
  本项目把 Cookie 存在你自己的服务器（`~/.v2ex_cookie`，权限 600），
  绝不要让它经过任何不可信的中转环节。
- **无法审计、无可追责**：中转站普遍不公开日志策略，出事无从追查。

✅ **正确做法**：
- 用官方 API Key 直连，或在本地运行可信的开源模型；
- 把 Cookie 这类敏感值**手动**粘进服务器，而不是发给联网的 Agent；
- 如必须让 Agent 看到敏感值，先用占位符代替，部署到最后一步再由你本人替换。

### 推荐的官方 Agent 工具

| 方案 | 费用 | 说明 |
|------|------|------|
| **Claude Pro**（推荐） | 付费订阅 | Anthropic 官方，Claude Code / 网页端直连官方 API，稳定可靠，适合长期使用 |
| **Antigravity（Google Antigravity）** | **免费** | Google 官方 Agentic 编程工具，**用 Google 账号在 Free 计划下即可使用 Claude Opus 4.6 等模型**，零成本起步 |

- **付费首选 Claude Pro**：官方直连，无中转风险。
- **想免费部署**：用 **Antigravity（Google Antigravity）**，官网 <https://antigravity.google> ，
  仅需 Google 账号登录，Free 计划即可调用 Claude Opus 4.6 等顶级模型完成本项目部署，
  全程走 Google / Anthropic 官方链路，**不经过任何第三方中转站**。

> 无论选哪个，关键都是：**走官方直连、不用中转站**。Antigravity 让「免费 + 安全」同时成立，
> 是预算有限又想避免中转站泄露风险时的最佳选择。

---

## 部署门槛极低

本项目对资源和网络要求都很轻：

| 需要的东西 | 最低要求 |
|------------|----------|
| **V2EX Cookie** | 一段登录后的 Cookie 字符串（必备，账号凭证） |
| **网络带宽** | **5 Mbps 即可**（签到是纯文本 HTTP；阅读也只是加载网页文本，无大流量） |
| **VPS 配置** | 签到 512 MB 内存；阅读 1 GB 内存 + 1 GB Swap（详见 README） |
| **公网要求** | 能正常访问 `www.v2ex.com` 和 `api.telegram.org` 即可 |

> 换句话说：**只要 Cookie 有效 + 网络能连上 V2EX（5Mbps 足矣），就能跑起来。**
> 不需要高带宽、不需要大流量、不需要昂贵机器。

---

## 推荐的 Agent 部署流程

把下面的「任务说明」连同本仓库一起交给 Agent，让它按步骤执行（敏感值留到最后由你手动填）：

1. **检查环境**：确认 VPS 已装 Node.js 18+，未装则安装。
2. **放置代码**：下载 / 解压本项目到 `~/v2ex-max-helper`。
3. **生成配置**：`cp .v2ex_env.example ~/.v2ex_env`，但**保留占位符不填真实值**。
4. **安装依赖**：在 `reader/` 执行 `npm install` 与 `npx playwright install chromium`。
5. **干跑验证**：`cd reader && node main.js --dry-run`，确认流程无报错。
6. **配置定时任务**：运行 `sudo bash scripts/install-systemd.sh` 安装 systemd timer（推荐；无 systemd 时回退 crontab，见 `部署指南.md`）。
7. **交还给你手动完成**（敏感步骤，Agent 不接触）：
   - 你本人把真实 `TG_TOKEN` / `TG_CHAT_ID` 填入 `~/.v2ex_env`；
   - 你本人执行 `V2EX_COOKIE="..." node checkin/v2ex-checkin.js --save-cookie` 保存 Cookie。

### 可直接复制给 Agent 的提示词模板

```
请帮我在这台 Linux VPS 上部署 v2ex-max-helper 项目（代码已在 ~/v2ex-max-helper）。
要求：
1. 只用官方直连 API，禁止经过任何第三方中转站。
2. 不要向你/任何外部服务发送我的真实 Cookie、Telegram Token 或服务器密钥。
3. 完成环境检查、依赖安装、playwright chromium 安装、dry-run 验证、crontab 配置。
4. 涉及真实 Cookie 和 Token 的步骤，请生成命令模板并停下，由我本人手动执行。
参考文档：docs/部署指南.md、docs/配置说明.md。
```

---

## 小结

- 🚫 不要用中转站 API 跑部署 Agent，避免 Cookie 等数据被第四方泄露；
- ✅ 推荐 **Claude Pro**（付费）或 **Antigravity / Google Antigravity**（免费，Google 账号 Free 计划即可用 Claude Opus 4.6）官方直连；
- 🔑 Cookie 始终留在你自己的服务器上，敏感步骤由你本人手动完成；
- 🪶 只需 Cookie + 5 Mbps 网络即可部署，门槛极低。
