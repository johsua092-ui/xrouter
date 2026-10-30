<p align="center">
  <img src="./public/banner.png" alt="X Router Banner" width="100%" />
</p>

<p align="center">
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-26-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <a href="https://nextjs.org"><img src="https://img.shields.io/badge/Next.js-14.2-000000?style=for-the-badge&logo=next.js&logoColor=white" alt="Next.js" /></a>
  <a href="https://sqlite.org"><img src="https://img.shields.io/badge/SQLite-WAL%20Zero--CGO-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite" /></a>
  <a href="https://github.com/johsua092-ui/xrouter"><img src="https://img.shields.io/badge/Release-v0.0.4-E56A4A?style=for-the-badge" alt="Release" /></a>
  <a href="https://www.npmjs.com/package/xrouter-ai"><img src="https://img.shields.io/npm/v/xrouter-ai.svg?style=for-the-badge&logo=npm&logoColor=white&color=CB3837" alt="npm" /></a>
  <a href="https://go.dev"><img src="https://img.shields.io/badge/Go%20Core-Planned-00ADD8?style=for-the-badge&logo=go&logoColor=white" alt="Go Core (Planned)" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License" /></a>
</p>

---

## ⚡ Overview

**X Router** is an ultra-lightweight, high-performance AI routing gateway running on **Node.js 26 (ESM)** with an embedded Next.js 14.2 dashboard, currently in transition toward a planned **Hybrid Go Core** architecture (see [Migration Plan](./docs/ROADMAP_GO_MIGRATION.md)).

It consolidates 40+ upstream AI providers (Claude, OpenAI, Antigravity, DeepSeek, River AI, OpenCode, Kilo, Grok, Gemini, and custom nodes) behind unified OpenAI and Anthropic-compatible wire surfaces with high-efficiency Node.js concurrency, zero-CGO SQLite WAL persistence, automated dead-account pruning, and integrated Telegram Bot Remote Control.

---

## 🏛️ Architecture

```text
 ┌────────────────────────────────────────────────────────────────────────┐
 │                           CLIENT INGRESS                               │
 │   OpenAI SDK / cURL                    Claude Code / Anthropic SDK     │
 │   POST /v1/chat/completions            POST /v1/messages               │
 └──────────────────┬─────────────────────────────────┬───────────────────┘
                    │                                 │
                    ▼                                 ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                              X ROUTER                                  │
 │                                                                        │
 │  [1. Authentication & Security Gate]                                   │
 │      • Virtual API Key validation & Rate Limiter (RPM/TPM)             │
 │      • IP Whitelist & Allowed Models filter                            │
 │                                                                        │
 │  [2. Cache-Aware Session Affinity] ⚡ NEW                             │
 │      • Matches conversation fingerprint & prompt cache TTL             │
 │      • Keeps turns glued to the warm account (5m Claude, 60m Gemini)   │
 │      • Up to 90% input token cost reduction & sub-second TTFT          │
 │                                                                        │
 │  [3. Token Savers & Prompt Injector Engine]                            │
 │      • RTK (Request Token Killer): de-duplicates tool results          │
 │      • Anti-Slop: strips repetitive AI cliches (Lite/Full/Ultra)       │
 │      • Uncensoring Kernel: raw prompt-path execution                   │
 │      • OpenAI Tool Bridge: structures prose tool invocations           │
 │                                                                        │
 │  [4. Multi-Account Ring & Failover Engine]                             │
 │      • Round-Robin / Fill-First account rotation                       │
 │      • Auto-Prune: instant purging of 401/403/exhausted accounts       │
 │      • Transparent format translation (OpenAI ↔ Claude ↔ Responses)   │
 └──────────────────┬─────────────────┬─────────────────┬─────────────────┘
                    │                 │                 │
                    ▼                 ▼                 ▼
             ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
             │  Anthropic  │   │  OpenAI /   │   │ DeepSeek /  │
             │   Claude    │   │ Antigravity │   │  River AI   │
             └─────────────┘   └─────────────┘   └─────────────┘
```

---

## 🌟 Why X Router? (Battle-Tested Advantages)

Unlike traditional generic reverse proxies (such as One-API, New-API, or raw LiteLLM), **X Router** was engineered specifically for high-load production environments, multi-account community distribution ("Bansos"), and aggressive token economy.

| Feature | Generic AI Gateways (One-API / LiteLLM) | **X Router** |
| :--- | :--- | :--- |
| **Bansos Faucet & Public Distribution** | ❌ None (Manual key creation only) | ✅ **1-Click Faucet & Anti-Abuse Voucher Engine** (Hardware fingerprinting, Turnstile, Audio PoW, Carrier /16 lock) |
| **Token Economy & Prompt Caching** | ⚠️ Destroys cache via naive round-robin | ✅ **Cache-Aware Smart Affinity** (up to 90% cost cut) + **RAM Exact Prompt Cache** (~10ms at 0 token) |
| **Multi-Cookie Provider Support** | ❌ Complex single-line manual concatenation | ✅ **Structured 2-Column Inputs** with real-time smart auto-split (Gemini `1PSID/1PSIDTS`, Grok `sso/sso-rw`) |
| **Dead Account / Key Handling** | ⚠️ Blacklists keys with manual reset required | ✅ **Zero-Maintenance Auto-Prune** (Instantly evicts expired/401/403/banned keys with zero cluster downtime) |
| **Provider Modularity** | ⚠️ Generic OpenAI endpoints only | ✅ **40+ Native Adapters** including OpenCode Free, Antigravity v2, Nous, Minimax Code, Kiro, & Claude Responses |
| **CLI & Desktop Integration** | ❌ Web-only / Server Docker only | ✅ **Global NPM Package (`xrouter-ai`)** with built-in MITM proxy, System Tray, & Terminal UI |

---

## 🌟 Key Features

### 1. 🎁 Public Faucet & Bulletproof "Bansos" Voucher Engine
Distributing free AI quotas to communities, students, or teams has never been this seamless and protected:
- **Instant Faucet Page (`/claim`)**: Share a clean, responsive link for users to claim API keys without registration.
- **Hardware & Biometric Anti-Farming**: Multi-layer abuse defense featuring hardware canvas/WebGL fingerprinting, audio hash detection, mouse trajectory velocity checks, and carrier `/16` IP subnet locking.
- **Multi-Level CAPTCHA**: Built-in zero-dependency Math/Audio Proof-of-Work with native Cloudflare Turnstile integration.
- **Dynamic Quota & Model Scoping**: Define exact allowed models, RPM/TPM limits, and token budgets (e.g. 1M tokens) per batch.
- **Seamless Key Reclaim**: Users who clear cookies can securely reclaim their existing key via persistent cryptographic receipts.

### 2. ⚡ Cache-Aware Smart Session Stickiness & RAM Cache
- **KV-Cache Preservation**: Vendor prompt caching (Claude ~5m, Gemini ~60m, DeepSeek) saves up to 90% input costs. Naive round-robin destroys this cache by scattering conversation turns across different accounts. X Router tracks conversation fingerprints and glues multi-turn chats to the warm account.
- **Exact Prompt RAM Cache**: Repeating prompts (cron bots, system evals, repetitive queries) are answered instantly in **~10ms using 0 upstream tokens**.

### 3. 🍪 Structured Dual-Column Web Cookie Management
Say goodbye to messy manual cookie formatting:
- Dedicated two-column inputs for multi-token sessions:
  - **Gemini Web**: `__Secure-1PSID` (Session) + `__Secure-1PSIDTS` (Timestamp).
  - **Grok Web**: `sso` + `sso-rw`.
- **Smart Auto-Split Parser**: Simply paste the raw browser cookie header into the first box, and X Router automatically splits, extracts, and populates both fields correctly in real-time.
- **Proxy-Aware Credential Validation**: Validates session cookies through your configured residential proxy pools to bypass cloud hosting IP blocks.

### 4. 🔌 Dual Wire Surfaces & Native Translators
- **OpenAI Compatible**: `https://<your-domain>/v1` (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`).
- **Anthropic Claude Compatible**: Native `/v1/messages` format translation with full support for Claude thinking blocks and tool calling.
- **Codex Responses Wire**: Seamless translation between Chat Completions and Responses API.

### 5. 🗑️ Auto-Prune Dead Keys & Connection Health
Zero-maintenance cluster reliability. When a provider connection encounters a permanent error (`401 Invalid Key`, `403 Banned`, `402 Quota Exhausted`, or `"insufficient_quota"`), X Router immediately purges the dead connection from the active pool to preserve cluster health.

### 6. 📊 Real-Time Visual Quota Progress Bars
Every client API key features a live animated quota progress bar in the dashboard. Displays token consumption with dynamic state colors:
- **Emerald**: < 75% utilized
- **Amber Warning**: 75% – 90% utilized
- **Pulsing Red**: > 90% or exhausted
- **Infinite Neon**: Unlimited budget keys

### 7. 🛡️ Security Audit Log & Automated Hardening
- **Security Audit Trail**: Logs sign-ins, lockouts, and automatically fingerprints malicious probes (SQLi, XSS, path traversal).
- **Settings History & Rollback**: Automatic before-image snapshots with instant 1-click revert.
- **Socket Stabilization**: Built-in `keepAliveTimeout` (65s) and `headersTimeout` (66s) socket tuning prevents 502 Bad Gateway race conditions behind Nginx and Cloudflare.

---

## 🚀 Quick Start

### 1. Automated Setup Wizard (`install.sh`) (Recommended)

Run the production setup wizard directly on your server with one command:

```bash
# Interactive setup wizard (prompts for port, password, and generates secure keys)
curl -fsSL https://raw.githubusercontent.com/johsua092-ui/x-router/main/install.sh | bash

# Or non-interactive one-liner with flags
bash install.sh --port 8080 --password "MySecretPass" --jwt-secret auto --salt auto -y
```

### 2. Global NPM Install

Install and run X Router globally on any server or desktop machine with a single command:

```bash
# Install globally via npm
npm install -g xrouter-ai

# Start X Router and open the dashboard
xrouter
# or use the full alias
xrouter-ai
```

You can also run directly without installation via `npx`:

```bash
npx xrouter-ai
```

**Common CLI Options:**
```bash
xrouter --port 8080      # Start on custom port
xrouter status           # Check running instances
xrouter --help           # Show all available commands
```

---

### 2. Manual / Development Setup (From Git)

```bash
# Clone the repository
git clone https://github.com/johsua092-ui/x-router.git
cd x-router

# Copy environment template (optional, customize your port & secrets)
cp .env.example .env

# Install dependencies & build
npm install
npm run build

# Start server
npm start
```

X Router automatically reads configuration from `.env` (such as `PORT`, `DATA_DIR`, `INITIAL_PASSWORD`).
If unconfigured, it defaults to `http://localhost:20128` (or `PORT` specified in your `.env`).

### 3. Production Service (systemd)

```ini
[Unit]
Description=X Router - AI Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/xrouter-remake
Environment=HOME=/root/xrouter-remake
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=DATA_DIR=/root/xrouter-remake/data
Environment=INITIAL_PASSWORD=xrouter123
Environment=BASE_URL=https://your-domain.com
Environment=PUBLIC_BASE_URL=https://your-domain.com
Environment=NEXT_PUBLIC_BASE_URL=https://your-domain.com
Environment=NEXT_TELEMETRY_DISABLED=1
ExecStart=/usr/local/bin/node custom-server.js --port 8080
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/root/xrouter-remake/data

[Install]
WantedBy=multi-user.target
```

---

## 💻 Client Integration

### 1. OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-domain.com/v1",
    api_key="sk-your-virtual-key"
)

response = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Explain quantum computing in one sentence."}]
)

print(response.choices[0].message.content)
```

### 2. Anthropic Python SDK

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="https://your-domain.com",
    api_key="sk-your-virtual-key"
)

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello Claude via X Router!"}]
)

print(message.content[0].text)
```

### 3. cURL (Streaming)

```bash
curl -N https://your-domain.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-virtual-key" \
  -d '{
    "model": "deepseek-ai/DeepSeek-V4.1-Flash",
    "messages": [{"role": "user", "content": "Write a fast fibonacci function in Rust."}],
    "stream": true
  }'
```

---

## 🛠️ Tech Stack & Future Roadmap

- **Current Runtime**: Node.js 26 (ESM) + Next.js 14.2 (App Router + Standalone)
- **Database**: SQLite WAL via `node:sqlite` / `better-sqlite3` (Schema v14)
- **Planned Architecture**: Single-repo Hybrid Golang Core with embedded Next.js static dashboard ([Read the Migration Plan](./docs/ROADMAP_GO_MIGRATION.md)).
- **Styling**: Tailwind CSS + Material Symbols + Semantic Color Tokens
- **State Management**: Zustand stores (Session, Tasks, Notifications)

---

## 🤝 Credits & Acknowledgements

Deep gratitude and respect to the builders and minds behind the foundations of X Router:

1. **[decolua](https://github.com/decolua)** — Founder and original creator of 9router (`decolua/9router`), pioneering unified AI gateway routing.
2. **[seren](https://github.com/serenhope)** — Upstream fork source (`serenhope/9router`), core architectural improvements, and model catalog intelligence.
3. **[Bayu (BvsshXyz)](https://github.com/BvsshXyz)** — Infrastructure architecture, remote daemon reliability, and high-performance server network bridges.
4. **[Naub (naummi)](https://github.com/naummi)** — Core model reverse-engineering, edge-case QA hunting, telemetry insights, and prompt intelligence.

---

## 📄 License

MIT © [X Router Contributors](https://github.com/johsua092-ui/x-router).
Built with craft and conviction.
