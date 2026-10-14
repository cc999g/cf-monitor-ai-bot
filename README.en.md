<div align="center">

**🌐 Language / 语言**

[🇨🇳 中文](README.md) · [🇺🇸 English](README.en.md) · [🇯🇵 日本語](README.ja.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇩🇪 Deutsch](README.de.md) · [🇪🇸 Español](README.es.md) · [🇷🇺 Русский](README.ru.md)

</div>

# CF Monitor AI Bot

A Telegram bot running on **Cloudflare Workers**: **Cloudflare account usage monitoring + multi-model AI chat**.

> This is an **original project** (not derived from an open-source project). All features and code were written from scratch.

---

## ✨ Features

### 🧠 AI Chat
- **Default chat mode**: just type text to chat; commands start with `/`
- **Three-tier model system**:
  - ☁️ **Cloudflare free models** (5 built-in permanently: Qwen3-30B / GPT-OSS-120B / Llama 3.3 70B / Mistral Small 24B / Llama 3.1 8B)
  - 🔑 **Built-in API** (permanent, undeletable, e.g. self-hosted relay)
  - 📦 **Temporary APIs** (add any via `/setapi`, delete via `/delapi`, never affects the first two)
- **Free model choice**: panel shows pros/cons + source tags (☁️/🔑/📦), per-user preference
- **Multi-turn memory**: 5 depth presets (Light 1 round → Max 40 rounds) + custom (`/mem rounds chars-per-message`, up to 100 rounds)
- **New session**: clear memory with one tap
- **Smart fallback**: auto-switch to backup models on failure; falls back to CF with a notice if all temporary APIs fail

### 📊 Usage Monitoring (official CF metrics)
- Workers requests: used / remaining today (100,000/day, **resets 00:00 UTC**)
- AI usage: Neurons used / remaining (10,000/day, accumulated to KV per call)

### 🔐 Multi-user Access
- **Two-tier invite codes**: admin code / member code (change anytime in-bot via `/setcode`)
- Super admin (`TG_CHAT_ID`) skips verification, always highest privilege
- Admin-only operations: add/delete APIs, change keys, change codes
- Member preferences / memory / model choice are **isolated per user**

### ⚙️ Custom API Management
- `/setapi url|key|model1,model2|name` to add (never overwrites existing, auto-sets as main model)
- `/setkey name new-key` to change a key (KV is the single source of truth, takes effect instantly)
- URL format validation (must be http/https)

### 🎛️ UX
- Persistent quick keyboard, no scrolling for commands
- Panel-style operations: model switching refreshes the panel in place + toast confirmation
- Webhook signature verification (`secret_token`), blocks forged requests

---

## 🏗️ Architecture

```
Telegram user → Webhook (signature check) → Cloudflare Worker
                      ├─ Workers AI (free models)
                      ├─ Custom API (OpenAI-compatible)
                      ├─ CF GraphQL (usage query)
                      └─ KV (config / memory / usage / access, persisted)
```

---

## 🚀 Deployment

### ⚡ Option 1: One-click deploy (recommended)

Only 4 required fields, everything else is auto-generated:

**1. Prepare**
- A Cloudflare account
- A Telegram Bot Token (create via @BotFather)
- Node.js 18+ on the deploy machine

**2. Fill in the config**

```bash
cp .env.example .env
```

Edit `.env` — 4 required fields:

```ini
CF_API_TOKEN=your Cloudflare API Token
CF_ACCOUNT_ID=your Cloudflare Account ID
TG_BOT_TOKEN=your Telegram Bot Token
TG_CHAT_ID=your Telegram Chat ID
```

> Other fields (invite codes, SETUP_KEY, webhook secret) can be left empty — the script generates random values and prints them.

**3. Run the deploy script**

Windows (PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

Linux / macOS:
```bash
chmod +x deploy.sh && ./deploy.sh
```

The script automatically: creates/reuses the KV namespace → generates missing secrets → configures wrangler → sets all Secrets → deploys the Worker.

**4. Register the webhook**

After deployment the script prints a curl command (with the generated SETUP_KEY). Copy and run it:

```bash
curl "https://cf-monitor-ai-bot.<your-subdomain>.workers.dev/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

**5. Start using**
Send the admin code (or member code) to the bot in Telegram to activate.

---

### 🔧 Option 2: Manual deploy

### 1. Prepare
- A Cloudflare account
- A Telegram Bot Token (create via @BotFather)
- Node.js 18+ environment

### 2. Create a KV namespace
Cloudflare Dashboard → Workers & Pages → KV → create a namespace, fill its ID into `wrangler.toml`.

### 3. Configure `wrangler.toml`
Replace the `<placeholders>` with your values: KV namespace ID, CF account ID, TG Chat ID.

### 4. Configure Secrets

```bash
cd cf-bot-public
npx wrangler@4 secret put TG_BOT_TOKEN        # Telegram Bot Token
npx wrangler@4 secret put CF_API_TOKEN        # Cloudflare API Token (needs GraphQL usage permission; use Edit All Resources)
npx wrangler@4 secret put SETUP_KEY           # Key for the /setup admin route (pick a long random string)
npx wrangler@4 secret put TG_ACCESS_CODE      # Admin invite code
npx wrangler@4 secret put TG_MEMBER_CODE      # Member invite code
npx wrangler@4 secret put TG_WEBHOOK_SECRET   # Webhook signature secret (random)
```

### 5. Deploy

```bash
CLOUDFLARE_API_TOKEN=<your-CF-API-token> \
CLOUDFLARE_ACCOUNT_ID=<your-account-id> \
npx wrangler@4 deploy
```

### 6. Register the webhook

```bash
curl "https://<your-worker-domain>/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

> Admin routes `/setup` and `/debug` use **header-based auth** (`X-Setup-Key`), so the key never appears in the URL.

### 7. Use
- The super admin works immediately (`TG_CHAT_ID`)
- Everyone else must activate with the admin or member code

---

## 📜 Commands

| Command | Description | Access |
|---|---|---|
| `/status` | Check usage | All |
| `/ai question` | AI chat (or just type text) | All |
| `/mem rounds chars` | Set memory depth | All |
| `/new` | Clear memory, start a new session | All |
| `/setapi` | Add a custom API | Admin |
| `/delapi` | Delete a temporary API | Admin |
| `/setkey` | Change an API key | Admin |
| `/setcode` | Set the two-tier invite codes | Admin |

---

## 🔒 Security Notes
- All secrets live in Cloudflare Secrets, never in code
- KV is the single source of truth for config (`cfg:apis`), changes take effect instantly
- Webhook verifies `secret_token`; admin routes verify request headers

## 📄 License
MIT
