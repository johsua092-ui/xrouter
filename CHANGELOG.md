# v0.0.3 (2026-10-25)

## Core & Stability Fixes
- **Cleaned Intrusive Error Boundary**:
  - Removed synthetic `src/app/error.js` that intercepted mobile clients into a perpetual "Resuming session..." spinner, restoring native Next.js layout resilience.
- **Reverse Proxy Redirect & Mixed-Content Fix**:
  - Fixed mobile browser "This page couldn't load" crash caused by loopback reverse-proxy hostname resolution overriding public domain with internal `127.0.0.1:8080`.
  - Preserved `X-Forwarded-Host` and `X-Forwarded-Proto` for all dashboard and auth redirects to prevent protocol downgrade and port leakage.
  - Added direct fallback to `PUBLIC_BASE_URL` and `BASE_URL` environment variables when reverse proxy drops host headers.
  - Enforced `Cache-Control: no-store, no-cache, must-revalidate` on dashboard and login routes so Cloudflare edge never caches dynamic session pages.
- **Seren Canonical Model Discovery & Allowlist Filter**:
  - Adopted Seren's clean `buildModelsList` architecture in `GET /v1/models` with full capability metrics (`context_length`, `max_completion_tokens`), custom models, studio targets, and no-auth providers.
  - Aligned discovery (`/v1/models`) and chat gates (`/v1/chat/completions`): `allowedModels = 'all'` unlocks the entire catalog unrestricted, while specific model names restrict visibility and execution exclusively to that model.
- **Next.js 16 Compatibility**:
  - Cleaned deprecated `experimental` options in `next.config.mjs` (`outputFileTracingRoot`, `serverComponentsExternalPackages`) for flawless builds on Next 14, 15, and 16.
- **Security & Session Management (OWASP Compliance)**:
  - Maintained strict 24-hour maximum JWT session lifetime and added 60-minute inactivity auto-logout for shared and public devices (warnet safe).
- **Deep Thinking & GLM 5.3 Streaming Normalization**:
  - Captured `delta.thought` and `delta.reasoning` chunks and mapped them to `delta.reasoning_content` to eliminate false "EMPTY STREAM" drops on thinking models.
- **Theme & Branding Visual Polish**:
  - Added official **Light Mode** and 6 custom accent color palettes (Ember Orange, Electric Blue, Emerald Green, Violet Purple, Ruby Rose, Cyber Cyan).
  - Replaced static black-backed favicon image with adaptive `LogoMark` component supporting dual SVG marks and dynamic palette accenting.
  - Synchronized Console Log viewer background and line colors to Light Mode.
- **High-Performance Bulk Proxy Operations**:
  - Replaced slow sequential N-roundtrip HTTP deletion loop with atomic single-query `/api/proxy-pools/bulk` API call (750x speedup for 100+ proxies).
  - Added chunked batch deletion in SQLite repository (200 IDs per chunk) within a single transaction to stay well within parameter limits.
  - Added fast bulk status toggling via `PATCH /api/proxy-pools/bulk` with optimistic UI updates.
- **Ptero AI Integration**:
  - Added zero-auth anonymous Ptero AI provider with automatic nonce extraction and client-side token minting.
- **Master Jailbreak Kernel (4-in-1 Vault)**:
  - Unified Multi-Layer Kernel with TrustMeBro tool output cloaking in an encrypted, tamper-proof vault.
- **Theme & Palette Stability**:
  - Fixed client-side exception caused by duplicate portal mounting and restored canonical ThemeModal instance in HeaderMenu.
  - Aligned mobile and desktop navigation with upstream architecture (no stray modals or missing controls).
- **Cloudflare Tunnel Fallback**:
  - Auto-fallback to direct `trycloudflare.com` tunnel URL when shortlink worker (`abc-tunnel.us`) is unreachable, preventing tunnel setup failures.
- **Terminal Network Display**:
  - Display actual public/LAN IP address when server binds to `0.0.0.0` (matching Seren reference implementation).
- **Version Bump & Update Notifications**:
  - Bumped version across Go Core (`internal/config`), NPM package (`cli/`), and web app to `v0.0.3` with real-time update notifications.

# v0.0.2 (2026-10-24)

## Core & Architecture
- **Golang Core Performance & Footprint Optimization**:
  - Binary size compressed by 68% (from 12 MB to 3.8 MB) using `-trimpath`, `-ldflags="-s -w"`, and UPX LZMA packing.
  - Runtime memory scavenger tuned with `debug.SetGCPercent(50)` and default 64MiB soft limit for rapid OS memory reclamation.
  - Zero-allocation SSE stream proxying using `sync.Pool` byte buffers.
  - Optimized SQLite pool and pragma cache size (`cache_size=-2000`, `temp_store=MEMORY`) with zero feature or query modifications.
  - Bumped version string to `v0.0.2` in `internal/config/config.go` and `package.json`.

## Features & Improvements
- **Theme Accent Responsive Logo & Active States**:
  - Dynamically tint X Router logo/favicon using CSS `--logo-filter` matching chosen palette (Emerald Green, Electric Blue, Violet, Rose, Cyan, or Ember).
  - Synchronized navigation icons and text color across LeftRail and MobileNav drawer to cleanly adapt to Light Mode and selected accent palettes.
- **Embedded OpenCode Protocol Engine (Zero-Install / In-Memory)**:
  - Fully embedded the OpenCode client protocol, session minting, and canonical tool fingerprinting directly into X Router's native executor.
  - Zero external CLI installation required, zero idle RAM footprint, and keeps the Golang binary under 3.8 MB while remaining 100% cross-platform on Linux and Windows.
- **ADCode Full Auth Flow (Modal & Backend)**:
  - Added dedicated `AdcodeAuthModal` component supporting 3 authentication methods: Sign In, Daftar Akun, and Token Import.
  - Fixed Firebase Web Key configuration to use persistent base64 decoding so registration and login always succeed without requiring manual API keys.
  - Removed quick 1-click temporary domain registration.
- **Custom Plugins Persistence & Fix**:
  - Registered `openaiToolBridge`, `contextSqueezer`, and `antiSlop` in `CUSTOM_PLUGIN_KEYS` and backend dynamic persistence.
  - Fixed switch turning off when models were added, and preserved model selections on refresh.
- **Branding**:
  - Updated OpenSatan logo from official upstream assets.

## Bug Fixes
- **Ptero Executor Pipeline Alignment**: Structured executor return value to `{ response, url, headers, transformedBody }` across both streaming and non-streaming modes, resolving `TypeError: Cannot read properties of undefined (reading 'status')` in ChatCore dispatch.
- **Notification Dropdown Z-Index & Header Stacking Hierarchy**: Fixed notification dropdown from the bell button rendering underneath page tabs by elevating `NotificationBell` to `z-[60]` with a `z-[9999]` panel and wrapping `MobileNav` in `z-50`.
- **Model Import Double-Path Resolution**: Added automatic probe fallback in `/api/providers/[id]/models` so if `/v1/models` returns an empty array, it automatically attempts root `/models` (and vice-versa).
- **Direct Changelog Button on Update Banner**:
  - Added a dedicated 1-click `Changelog` button right inside the Update Banner so users can immediately view full release notes and what changed across Go and Node.js without needing to open the header menu.
- **Provider Import Auto URL Fallback**:
  - Auto-fallback `/v1/models` and `/models` on OpenAI-compatible providers (like Saga / Bebek) if upstream requires or drops the `/v1` prefix.
- **Ptero AI Non-Streaming JSON Response**:
  - Standardized Ptero executor to return a full standard `Response` object on non-stream calls, fixing `TypeError: Cannot read properties of undefined (reading 'status')`.
- **Ptero AI Provider Integration (Zero Auth / Anonymous)**:
  - Added native `ptero` provider from ptero.pro with dynamic nonce extraction and client-side anonymous token minting.
  - Exposes free models: `deepseek-v4.1-flash:free`, `ling-3.0-flash:free`, `glm-5.3-flash`, `mistral-nemo:minirouter`, `gpt-oss-20b`, and `apodex-1.1-mini:free`.
- **ProxyFetch Fail-Soft Direct Fallback**:
  - Prevented HTTP 502 crashes on proxy pool connection drops by gracefully falling back to direct requests when proxies hang.
- **Console Log Noise Cleanup**:
  - Stripped redundant `%s: %s` profiling statements and `console.time` leaks from dashboard guards.
- **Git Revision Resolution Across Working Dirs**: Updated `readGitRevision()` to look for `.git` in both process cwd and `/root/xrouter` repository root so update checks accurately report local git commit status.
- **Update Banner Z-Index Elevation**: Wrapped `UpdateBanner` in a dedicated `relative z-40` container in `DashboardLayout.js` so update alerts always render on top of tab bars and sticky navigation.
- **Theme Modes & Custom Accent Palettes**:
  - Added official **Light Mode** support alongside Dark and Ember.
  - Added 6 custom color palettes in Theme Modal: Ember Orange, Electric Blue, Emerald Green, Violet Purple, Ruby Rose, and Cyber Cyan, dynamically updating UI brand colors across the entire dashboard.
- **ADCode OAuth Test & Token Resolution**:
  - Supported token-based testing for ADCode OAuth connections to resolve `No access token` error in provider health checks.
- **Strict Model Key Scoping on /v1/models**: Restored API key requirement when `Require API Key` is enabled, and strictly scoped model discovery (`/v1/models` and `/models`) to only return the key's allowed models list (`allowedModels`). Unauthorized models no longer leak to restricted client keys.
- **ADCode Provider Connection Test Support**: Added provider test handler for `adcode` in `testUtils.js` verifying OAuth token presence instead of failing with `Provider test not supported`.
- **OpenCode Session CLI Fingerprinting**: Added dynamic `x-opencode-session` injection for OpenCode CLI header spoofing.
- **Toast Notifications Stacking Context (Fix Overlap)**: Elevated dashboard layout toast container to `z-[9999]` and lowered sticky page header to `z-30`, preventing notifications from rendering underneath card headers or chart elements.
- **Claude Native API Reasoning Effort Clean**: Stripped top-level `reasoning_effort` for native Anthropic API in `paramSupport.js` to avoid HTTP 400 Extra inputs errors.
- **Claude Tool Cloaking Idempotency**: Fixed tool name suffixing in `claudeCloaking.js` to prevent double-appending `_ide_ide` across multi-turn sessions.
- **Codex History Cleaning**: Filtered out foreign encrypted reasoning objects (like Grok xAI encrypted blocks) in `codex.js` before dispatch.
- **Grok CLI Reasoning Effort Support**: Expanded `supportsGrokCliReasoningEffort` to include Grok 4.6 and 4.7.
- **OpenCode Go Catalog Update**: Added `kimi-k3.1-pro` to the OpenCode Go registry models list.
- **Models Endpoint Latency Optimization (Instant <50ms)**: Bypassed blocking remote network requests on `/v1/models` and `/models`. Switched to an instant memory-first catalog resolution with zero blocking external calls, dropping discovery latency from 15s to 40ms.
- **Public Models Discovery (Fix 401)**: Open `/v1/models`, `/models`, `/model`, `/v1/model`, and `/api/models` for unauthenticated catalog inspection so clients and tools can discover models without getting rejected with 401 Unauthorized, while keeping inference `/v1/chat/completions` secured. Added root-level rewrites for `/models` and `/model`.
- **Kiro Model Normalization & Thinking**: Normalize Anthropic snapshot IDs and dash-formatted models onto Kiro upstream aliases in `resolveKiroModel()`, handle `claude-opus-4.7` and `xhigh` effort correctly, and fix MiniMax casing to `minimax-m2.5`.
- **OAuth Endpoint Guard**: Reject non-OAuth providers with a clean 400 Bad Request instead of throwing an unhandled 500 error in `GET /api/oauth/[provider]/[action]`.

# v0.0.1 (2026-10-20)

## Initial Release
- **X Router Go Core Engine**: Initial Go-based gateway architecture with SQLite persistent storage, API key authentication, and high-performance streaming proxy.
