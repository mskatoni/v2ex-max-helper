# Agent 辅助部署方案

本项目结构清晰、依赖极少，非常适合交给 **AI 编程助手（Agent）** 部署：
**Agent 负责所有不涉及敏感信息的环节**（装环境、装依赖、干跑验证、配置定时任务），
**你本人只在最后手动完成两个敏感步骤**（填入 Telegram Token、保存 V2EX Cookie）。

你需要准备：

- 一台能访问 `www.v2ex.com` 的 VPS；
- 一个已登录 V2EX 的 Cookie 字符串（仅最后一步用到，不交给 Agent）。

---

## ⚠️ 安全红线：请勿使用「中转站 API」部署

> **务必使用 AI 服务商官方直连 API（OpenAI / Anthropic / Google 等官方端点），
> 切勿使用任何第三方「中转站 / API 代理 / 镜像聚合」来驱动部署 Agent。**

原因：

- **中转站会截留你的数据**：中转站位于你和官方 API 之间，你发给 Agent 的所有内容
  （包括 **服务器 IP、SSH 信息**等）都会明文流经它的服务器。中转站随时可能记录这些内容，
  再转售或泄露给未知的第四方。
- **敏感凭证一旦泄露后果严重**：V2EX Cookie 等同账号控制权，Telegram Token 等同 Bot 控制权。
  正因如此，本项目把 Cookie 存在你自己的服务器（`~/.v2ex_cookie`，权限 600），
  并要求这些凭证**全程不经过 Agent**，自然也就不会经过中转站。
- **无法审计、无可追责**：中转站普遍不公开日志策略，出事无从追查。

✅ **正确做法**：
- 用 AI 服务商的官方 API 直连（见下方推荐工具）；
- 把 Cookie、Token 这类敏感值**手动**粘进服务器，而不是发给联网的 Agent；
- 让 Agent 看到的配置文件只含占位符，真实值在最后一步由你本人替换。

### 推荐的官方 Agent 工具

| 方案 | 费用 | 说明 |
|------|------|------|
| **Claude Pro**（推荐） | 付费订阅 | Anthropic 官方，Claude Code / 网页端直连官方 API，稳定可靠，适合长期使用 |
| **Antigravity（Google Antigravity）** | **免费** | Google 官方 Agentic 编程工具，**用 Google 账号在 Free 计划下即可使用 Claude Opus 4.6 等模型**，零成本起步 |

两者都是**官方直连、不经中转站**，区别只在费用：

- **预算充足 → Claude Pro**：付费订阅，长期使用稳定省心。
- **想零成本 → Antigravity（Google Antigravity）**：官网 <https://antigravity.google> ，
  仅需 Google 账号登录，Free 计划即可调用 Claude Opus 4.6 等顶级模型完成本项目部署。

> 关键不在于选哪个，而在于**走官方直连**。两者都满足这一点，按预算选即可。

---

## 部署门槛极低

本项目对资源和网络要求都很轻：

| 项目 | 最低要求 |
|------|----------|
| **网络带宽** | **5 Mbps 即可**（签到是纯文本 HTTP；阅读也只是加载网页文本，无大流量） |
| **内存（仅签到）** | 512 MB |
| **内存（含自动阅读）** | 1 GB + 1 GB Swap（阅读需启动 Chromium，详见 README） |
| **公网连通性** | 能访问 `www.v2ex.com`；用 Telegram 推送时还需能访问 `api.telegram.org` |

不需要高带宽、不需要大流量、不需要昂贵机器——一台普通低配小鸡即可长期挂机。

---

## 推荐的 Agent 部署流程

把下面的「任务说明」连同本仓库一起交给 Agent，让它按步骤执行（敏感值留到最后由你手动填）：

1. **检查环境**：确认 VPS 已装 Node.js 18+，未装则安装。
2. **放置代码**：下载 / 解压本项目到 `~/v2ex-max-helper`。
3. **生成配置**：`cp .v2ex_env.example ~/.v2ex_env`，但**保留占位符不填真实值**。
4. **安装依赖**：在 `reader/` 执行 `npm install` 与 `npx playwright install chromium`。
5. **干跑验证**：`cd reader && node main.js --dry-run`，确认离线调度流程无报错；该模式不需要 Cookie，也不会访问 V2EX 或写入阅读队列。
6. **配置定时任务**：运行 `sudo bash scripts/install-systemd.sh` 安装 systemd timer（推荐；无 systemd 时回退 crontab，见 `部署指南.md`）。
7. **交还给你手动完成**（敏感步骤，Agent 不接触）：
   - 你本人把真实 `TG_TOKEN` 填入 `~/.v2ex_env`；配置 `TG_CHAT_ID`，或配置 `TG_SETUP_CODE` 后使用 `/bind <口令>` 首次绑定；
   - 你本人执行 `V2EX_COOKIE="..." node checkin/v2ex-checkin.js --save-cookie` 保存 Cookie。

### 可直接复制给 Agent 的提示词模板

```
请帮我在这台 Linux VPS 上部署 v2ex-max-helper 项目（代码已在 ~/v2ex-max-helper）。
要求：
1. 不要向你/任何外部服务发送我的真实 Cookie、Telegram Token 或服务器密钥。
2. 完成以下环节：环境检查（Node.js 18+）、安装依赖、playwright chromium 安装、
   dry-run 验证、用 scripts/install-systemd.sh 配置定时任务。
3. 涉及真实 Cookie 和 Token 的步骤，只生成命令模板并停下，由我本人手动执行。
参考文档：docs/部署指南.md、docs/配置说明.md。
```

> 注意：模板里没有「禁用中转站」这一条，因为 Agent 自己无法知道、也无法控制它背后接的是不是
> 中转站——这是**你启动 Agent 时选择 API 的责任**，而非能下达给 Agent 的指令。请在自己这端确保用官方直连。

---

## 小结

- 🚫 启动 Agent 时务必用官方直连 API，不要经过第三方中转站；
- ✅ 官方直连工具任选：**Claude Pro**（付费）或 **Antigravity**（免费，Google 账号 Free 计划即可用 Claude Opus 4.6）；
- 🔑 Cookie、Token 全程不交给 Agent，由你本人在最后手动写入服务器；
- 🪶 一台普通低配小鸡 + 约 5 Mbps 网络即可长期挂机，门槛极低。
