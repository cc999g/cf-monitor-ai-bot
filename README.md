<div align="center">

**🌐 语言 / Language**

[🇨🇳 中文](README.md) · [🇺🇸 English](README.en.md) · [🇯🇵 日本語](README.ja.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇩🇪 Deutsch](README.de.md) · [🇪🇸 Español](README.es.md) · [🇷🇺 Русский](README.ru.md)

</div>

# CF Monitor AI Bot

一个运行在 **Cloudflare Workers** 上的 Telegram 机器人：**Cloudflare 账户用量监控 + 多模型 AI 对话**。

> 本项目为**原创项目**（非开源项目修改而来）。功能演进、代码实现均从零编写。

---

## ✨ 功能

### 🧠 AI 对话
- **默认对话模式**：直接输入文字即对话，`/` 开头才是命令
- **三级模型体系**：
  - ☁️ **Cloudflare 免费模型**（永久内置 5 个：通义 Qwen3-30B / GPT-OSS-120B / Llama 3.3 70B / Mistral Small 24B / Llama 3.1 8B）
  - 🔑 **内置 API**（永久保留，不可删除，如自建中转）
  - 📦 **临时 API**（`/setapi` 任意添加，`/delapi` 删除，不影响前两类）
- **模型自由选择**：面板带优缺点 + 来源标记（☁️/🔑/📦），每人独立偏好
- **多轮记忆**：五档深度（浅 1 轮 → 极深 40 轮）+ 自定义（`/mem 轮数 每条字数`，上限 100 轮）
- **开新会话**：一键清空记忆
- **智能回退**：选中模型失败自动换备用；临时 API 全挂自动回退 CF 并提示

### 📊 用量监控（CF 官方口径）
- Workers 请求：今日已用 / 剩余（100,000/日，**00:00 UTC 重置**）
- AI 用量：Neurons 已用 / 剩余（10,000/日，按次累计到 KV）

### 🔐 多人权限
- **两级邀请码**：管理员码 / 成员码（bot 内 `/setcode` 随时修改）
- 超级管理员（`TG_CHAT_ID`）免验证，永远最高权限
- 管理操作（增删 API、改 Key、改码）仅管理员可执行
- 成员偏好 / 记忆 / 模型选择 **每人独立，互不干扰**

### ⚙️ 自定义 API 管理
- `/setapi 地址|密钥|模型1,模型2|名称` 添加（不覆盖已有，自动设为主模型）
- `/setkey 名称 新密钥` 修改 Key（KV 唯一权威，立即生效）
- 地址格式校验（必须 http/https）

### 🎛️ 交互体验
- 常驻快捷键盘，不用翻命令
- 面板式操作：模型切换直接刷新面板 + toast 确认
- Webhook 签名校验（`secret_token`），防伪造请求

---

## 🏗️ 技术架构

```
Telegram 用户 → Webhook(签名校验) → Cloudflare Worker
                      ├─ Workers AI（免费模型）
                      ├─ 自定义 API（OpenAI 兼容）
                      ├─ CF GraphQL（用量查询）
                      └─ KV（配置/记忆/用量/权限 持久化）
```

---

## 🚀 部署步骤

### ⚡ 方式一：一键部署（推荐）

只需要填 4 个必填项，其余自动生成：

**1. 准备**
- 一个 Cloudflare 账户
- 一个 Telegram Bot Token（找 @BotFather 创建）
- Node.js 18+（部署机器需要）

**2. 填写配置**

```bash
# 复制模板
cp .env.example .env
```

编辑 `.env`，必填 4 项：

```ini
CF_API_TOKEN=你的Cloudflare API Token
CF_ACCOUNT_ID=你的Cloudflare账户ID
TG_BOT_TOKEN=你的Telegram Bot Token
TG_CHAT_ID=你的Telegram Chat ID
```

> 其余项（邀请码、SETUP_KEY、Webhook 密钥）留空即可，脚本自动生成并打印。

**3. 运行部署脚本**

Windows（PowerShell）：
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

Linux / macOS：
```bash
chmod +x deploy.sh && ./deploy.sh
```

脚本会自动完成：创建/复用 KV 命名空间 → 生成缺失密钥 → 配置 wrangler → 设置全部 Secrets → 部署 Worker。

**4. 注册 Webhook**

部署完成后脚本会打印一条 curl 命令（已带生成的 SETUP_KEY），复制到终端运行即可：

```bash
curl "https://cf-monitor-ai-bot.<你的子域名>.workers.dev/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

**5. 开始使用**
在 Telegram 里给 bot 发管理员码（或成员码）激活即可。

---

### 🔧 方式二：手动部署

### 1. 准备
- 一个 Cloudflare 账户
- 一个 Telegram Bot Token（找 @BotFather 创建）
- Node.js 18+ 环境

### 2. 创建 KV 命名空间
Cloudflare Dashboard → Workers & Pages → KV → 创建命名空间，把 ID 填入 `wrangler.toml`。

### 3. 配置 `wrangler.toml`
把 `<占位符>` 替换为你的值：KV 命名空间 ID、CF 账户 ID、TG Chat ID。
### 4. 配置 Secrets

```bash
cd cf-bot-public
npx wrangler@4 secret put TG_BOT_TOKEN        # Telegram Bot Token
npx wrangler@4 secret put CF_API_TOKEN        # Cloudflare API Token（需 GraphQL 用量查询权限，建议 Edit All Resources）
npx wrangler@4 secret put SETUP_KEY           # /setup 管理入口的访问密钥（自己定一个长随机串）
npx wrangler@4 secret put TG_ACCESS_CODE      # 管理员邀请码
npx wrangler@4 secret put TG_MEMBER_CODE      # 普通成员邀请码
npx wrangler@4 secret put TG_WEBHOOK_SECRET   # Webhook 签名密钥（随机生成）
```

### 5. 部署

```bash
CLOUDFLARE_API_TOKEN=<你的CF_API_TOKEN> \
CLOUDFLARE_ACCOUNT_ID=<你的账户ID> \
npx wrangler@4 deploy
```

### 6. 注册 Webhook

```bash
curl "https://<你的worker域名>/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

> 管理入口 `/setup`、`/debug` 采用**请求头校验**（`X-Setup-Key`），密钥不暴露在 URL。

### 7. 使用
- 超级管理员直接可用（`TG_CHAT_ID`）
- 其他人需输入管理员码或成员码激活

---

## 📜 命令一览

| 命令 | 说明 | 权限 |
|---|---|---|
| `/status` | 查询用量 | 全员 |
| `/ai 问题` | AI 对话（也可直接输入文字） | 全员 |
| `/mem 轮数 字数` | 设置记忆深度 | 全员 |
| `/new` | 清空记忆开新会话 | 全员 |
| `/setapi` | 添加自定义 API | 管理员 |
| `/delapi` | 删除临时 API | 管理员 |
| `/setkey` | 修改 API Key | 管理员 |
| `/setcode` | 设置两级邀请码 | 管理员 |

---

## 🔜 规划中 / 未实现功能

- **多会话（可切换）**：像 ChatGPT 一样建立多个会话、互相切换，每个会话独立记忆。设计已完成，因暂缓未实现；如后续需要可继续开发。
- **`/kick` 移除成员**：管理员一键将已激活用户移出（撤销激活），防止滥用。尚未实现。
- **邀请码明文**：新成员输入邀请码的消息会留在 Telegram 聊天记录中，属设计取舍；介意请定期用 `/setcode` 更换。

## ⚠️ 注意事项

1. **邀请码明文**：输入邀请码的消息会留在 Telegram 聊天记录，建议定期更换。
2. **额度口径**：Workers 10 万请求/日、Workers AI 1 万 Neurons/日，00:00 UTC 重置；「极深」记忆（40 轮×3000 字）每次调用消耗 Neurons 显著增加，高频使用请注意剩余额度（`/status` 可查）。
3. **中转 API 模型名可能名不副实**：第三方代理的模型名不一定路由到对应模型，添加后请实测；本项目内置模型均已实测。
4. **API Token 权限**：`/status` 用量查询需要 GraphQL 权限，建议使用 Edit All Resources 级别 Token，否则报 Authentication error。
5. **管理入口为请求头校验**：`/setup`、`/debug` 需带 `X-Setup-Key` 请求头，浏览器直接打开会 403（用 curl 命令访问）。
6. **KV 是唯一权威**：配置以 KV 为准，`/setapi` `/setkey` `/setcode` 修改立即生效，无需重新部署。
7. **临时 API 被删自动自愈**：正在使用被删除 API 的用户会自动切回 Cloudflare 免费模型。

## 🐛 部署常见踩坑

1. **忘记注册 Webhook**：部署后必须执行 `/setup` 注册（带 `X-Setup-Key`），否则 bot 收不到任何消息。
2. **改了 `TG_WEBHOOK_SECRET` 没重新注册**：会返回 403，重新执行 `/setup` 即可。
3. **API Token 权限不足**：`/status` 报 `[{"code":10000,"message":"Authentication error"}]` → 去 Dashboard 换 Edit All Resources 的 Token。
4. **wrangler 操作 KV 不带 `--remote`**：`wrangler kv key get/put` 默认操作本地模拟，查不到云端数据；调试时加 `--remote`。
5. **自定义 API 地址没写协议头**：必须 `http://` 或 `https://` 开头，否则被拦截。
6. **PowerShell 执行策略**：直接运行 deploy.ps1 可能被拦截，用 `powershell -ExecutionPolicy Bypass -File .\deploy.ps1`。
7. **记忆设置超出上限**：`/mem 轮数 字数` 总字符超过 12 万会被拒绝，适当减少轮数或字数。
8. **长回复被截断**：CF 模型 max_tokens 4096、自定义 API 2000，超长回答被截断属正常现象。

---

## 🔒 安全说明
- 所有密钥存 Cloudflare Secrets，不入代码
- KV 是配置唯一权威（`cfg:apis`），修改立即生效
- Webhook 校验 `secret_token`；管理入口校验请求头

## 📄 License
MIT

---

*本项目由 AI 辅助生成。*
