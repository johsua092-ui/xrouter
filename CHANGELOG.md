# v0.0.8 (2026-11-05)

- **Fix GLM & ZCode Event Gift Card Balance Overwrite Bug**:
  - Fixed dictionary key collision in `parseZcodeStartPlanBalance` (`zcode.js`) and `getGlmUsage` (`glm.js`) where multiple entitlements sharing model name `GLM-5.3-Flash` (such as 500M Weekend Build / 300M Global Build and 5M Start Plan) overwrote each other.
  - Distinctly labels event gift bansos buckets with associated plan names (e.g. `GLM-5.3-Flash (ZCODE WEEKEND BUILD)`), displaying both massive gift card balances and daily start plan quotas in full.
  - Added active plan badge to connection header on the Quota Tracker card.

- **Update Contributor Credits in README & CHANGELOG**:
  - Cleaned up contributor credits: Naub (`naummi`) is designated as Lead System Architect, Core Model Reverse-Engineering, Protocol Decryption, and Frontier Gateway Intelligence alongside decolua and Bayu.

- **Update README Contributor Rankings**:
  - Elevated Naub (`naummi`) to position #1 with elite title: *Lead System Architect, Core Model Reverse-Engineering, Protocol Decryption, and Frontier Gateway Intelligence*.
- **Streamline ZCode Web Bridge**:
  - Removed obsolete Step 2 manual rewards link in favor of 1-Click Auto Claim with Aliyun Traceless Captcha bypass.

- **Google Server-Side Antigravity Project ID Provisioning (True Haizhu Protocol)**:
  - Eliminated client-side random project string generation (`cloudaicompanion-proj-...`).
  - Implemented true server-side provisioning flow matching `HaizhuAntigravity`: sends `Client-Metadata` headers and triggers `onboardUser` polling followed by `loadCodeAssist` re-fetch to extract the genuine Google-assigned project ID.

- **Fix GLM Quota Card Display for Bansos & Event Gifts**:
  - Fixed condition in `ProviderLimits/index.js` where `quota.message` was intercepting and suppressing `QuotaTable`, hiding claimed event gift tokens and bansos balances.
  - Enhanced `open-sse/services/usage/glm.js` and `open-sse/services/usage/zcode.js` to ensure token grant balances (e.g. 300M / 500M gifts) properly set `totalTokens` and `usedTokens` and render in the quota card.

- **Integrate Aliyun Traceless Captcha Solver for ZCode Gift Cards (300M/500M Event Claim)**:
  - Added official Aliyun Web SDK Traceless Captcha engine integration in `src/app/api/usage/[connectionId]/zcode-bridge/route.js` using ZCode active scene `11xygtvd` and prefix `no8xfe` to auto-resolve `captchaVerifyParam` without manual slider interaction.
  - Added automatic plan resolution in `src/app/api/usage/[connectionId]/glm-claim/route.js` for `claim_auto` payload to sweep active campaign gifts (e.g. `zcode-v3-start-plan-1030-wk`, `zcode-v3-start-plan-nt-1026`).

- **Generate Canonical `cloudaicompanion-proj-...` Project ID Fallback**:
  - Replaced random adjective-noun (`swift-spark-...`) project generation with canonical Google format `cloudaicompanion-proj-${crypto.randomBytes(8).toString('hex')}` across `open-sse/executors/antigravity.js`, `open-sse/translator/formats/gemini.js`, and `open-sse/services/projectId.js`.
  - Added auto-generation and persistence of `cloudaicompanion-proj-...` in `src/sse/handlers/chat.js` and `src/lib/oauth/providers/antigravity.js` when Google API does not return a project ID, ensuring new accounts can immediately serve requests.

- **Antigravity Fatal Account State & Ban Detection**:
  - Added explicit error mapping rules in `errorConfig.js` for Google Antigravity fatal codes: `TOS_VIOLATION`, `ACCOUNT_STATE_INVALID`, `RESTRICTED_AGE`, `VALIDATION_REQUIRED`, and location restrictions.
  - Automatically locks and isolates banned/suspended accounts to avoid polling dead credentials.

- **Fix OpenCode MiMo Tool Call Unaliasing (`run_command` -> original tool name)**:
  - Added `state.toolNameMap` unaliasing resolution in `openai-to-claude.js` response translator so concealed caller tools (e.g. `run_command` aliased from client terminal tools) are accurately restored before sending back to Claude Code / Roo / Cline, eliminating `Model generated invalid tool call: run_command` errors.

- **Antigravity Auto-Onboarding for New Accounts (Haizhu Protocol)**:
  - Fixed inverted `if (projectId)` condition in `src/lib/oauth/providers/antigravity.js` so un-onboarded accounts automatically poll `onboardUser` to provision a `cloudaicompanionProject` on first login.
  - Aligned onboarding payload with Google Antigravity v1.107.0 specifications (`ideType: ANTIGRAVITY`, `ideName: antigravity`, `ideVersion: 1.107.0`) in `open-sse/services/projectId.js`.
  - Tuned onboarding polling parameters to 6 attempts with 5-second intervals for fast, reliable project ID resolution.

- **Sync ZCode Allowed Models (Clean Stale Legacy Models)**:
  - Removed deprecated `GLM-5.2` and `GLM-5-Turbo` from ZCode registry and `ZCODE_START_MODELS` list. Upstream ZCode Start Plan now strictly allows only `GLM-5.3` and `GLM-5.3-Flash`, preventing upstream `400 code 3006 model not allowed` errors during model testing and routing.

- **OpenCode Precise 429 Retry-After & FreeUsageLimit Parsing**:
  - Implemented `parseError` in `OpenCodeExecutor` to extract upstream `resets_at`, `resets_in_seconds`, and HTTP `retry-after` headers, preventing blind immediate retries that trigger client rate limit warnings.

- **UI Button for Start Plan Free Tier Handshake**:
  - Added dedicated one-click button in `ProviderLimits/index.js` ("Activate Start Plan (8M Token Free Tier)") to trigger the 4-step handshake directly from the UI without needing external captcha.

- **ZCode Start Plan Free Tier Handshake Activation & Connection Sweep**:
  - Implemented 4-step sequential handshake in `open-sse/services/usage/glm.js` (`checkAndClaimZcodeStartPlan`):
    - `GET /api/v1/marketing/touch?seq=1`
    - `GET /api/v1/incentive/referral/summary`
    - `GET /api/v1/zcode-plan/billing/preview?app_version=3.17.1`
    - `GET /api/v1/zcode-plan/billing/balance?app_version=3.17.1`
  - Added support for auto-provisioned Start Plan ID `zcode-v3-start-plan-0817` (8M tokens: 3M GLM-5.3 + 5M GLM-5.3-Flash).
  - Added GLM connection sweep & sync endpoint in `src/app/api/usage/[connectionId]/glm-claim/route.js` to automatically set `isActive = true` when `zcode-v3-start-plan-0817` is present, or `isActive = false` when empty/exhausted to avoid 1005 loop.
  - Bumped gateway and CLI package versions to `0.0.8`.

# v0.0.7 (2026-11-04)

- **ZCode & GLM Stability Overhaul (Anti-405/3012 & Anti-3009 Concurrency Pacing)**:
  - Implemented `KeyedMutex` in `ZCodeExecutor` enforcing strict 1-concurrency per account with 1500ms post-stream pacing delay to eliminate upstream `429 code 3009` and prevent subsequent `405 code 3012` softblocks.
  - Added stream release hook (`hookStreamRelease`) to safely unlock account mutex on stream completion or client disconnect.
  - Added comprehensive OpenAI-to-Anthropic tool and message normalizers (`normalizeZcodeTools`, `normalizeZcodeToolChoice`, and `normalizeZcodeMessages` with strict user/assistant role alternation).
  - Enhanced `normalizeStartPlanResponse` mapping both code 1005 (quota) and code 3009 (concurrency limit) to HTTP 429 for seamless multi-account rotation.
  - Fixed `extra?.proxyUrl` null-reference bug during directFetch proxy resolution.

- **Automated Security Secret Generation in Setup Wizard**:
  - Configured `install.sh` to automatically generate `JWT_SECRET` (64-char hex) and `MACHINE_ID_SALT` (32-char hex) alongside `API_KEY_SECRET` without requiring interactive manual prompts.
  - Documented automatic secret generation behavior in `README.md` while maintaining support for explicit CLI flag overrides.

- **CodeBuddy / WorkBuddy Support & Hunyuan hy4 Model Addition**:
  - Registered `hy4` alongside `hy4-preview` in `codebuddy-cn` and `codebuddy-intl` registries, capability mapping, and thinking levels.
  - Added `workbuddy` / `workbuddy-cn` and `workbuddy-ai` / `workbuddy-intl` provider aliases across gateway registries and Go Core model listing.

- **Port PR #5459: Track and Display Separate Gemini 4 Argon Quota**:
  - Added dedicated `/argon/i` matcher in `open-sse/services/usage/antigravity-weekly.js` to extract `gemini_argon_weekly` and `gemini_argon_session` independently from Gemini (Flash / Pro).
  - Isolated `argonModels` from regular Gemini session exhaustion in `open-sse/services/usage/google.js`.
  - Added dashboard representation and sort mapping for `gemini_argon` / `gemini_argon_session` in `ProviderLimits/utils.js`.
  - Implemented `gemini_argon` model family support and `getAntigravityModelQuota` resolver in `src/sse/services/antigravityQuota.js` and `auth.js`.

- **Harden OpenCode Proxy Resilience & Failover**:
  - Added seamless try/catch daemon failover to Direct TLS client (`opencodeTlsFetch`) in `OpenCodeExecutor.execute` to prevent 502 crashes during proxy network glitches.
  - Enabled SOCKS5 proxy support in daemon environment (`ALL_PROXY` / `all_proxy`) and added auto-protocol normalization for raw host:port proxies.
  - Passed `useServiceDaemon` strategy state to no-auth credential resolution and shortened proxy quarantine cooldown to 3m for rapid auto-recovery.

- **Low-Spec Environment Optimization (1GB RAM / 1 Core / 1GB Disk)**:
  - Configured Node gateway runtime with `--expose-gc --max-old-space-size=512` in `package.json` and CLI launcher, with automated background V8 garbage collection when heap crosses 300MB.
  - Tuned Go Core SQLite cache to `cache_size(-1000)` (~1MB) and disabled memory-mapped I/O `mmap_size(0)` in `internal/database/db.go` to prevent virtual memory ballooning on 1GB hosts.
  - Reduced Go Core memory limit to `GOMEMLIMIT=64MiB` with aggressive OS page return `GODEBUG=madvdontneed=1` in `Dockerfile.go`.

- **OpenCode Proxy & Protocol Alignment Fixes**:
  - Aligned `OPENCODE_UA` to official OpenCode v2.2.5 (`opencode/latest/2.2.5/cli`).
  - Added native `ws` dependency and `globalThis.WebSocket` fallback in `OpenCodeClientMcpRelay.connect` to resolve MCP tool communication in Node.js runtime.
  - Guarded `opencodeTlsFetch` to filter serverless HTTP relays (Vercel/Workers) from raw TCP CONNECT proxy tunneling.

- **Fix OpenCode Daemon Binary Resolution & Service Integration**:
  - Added robust absolute binary path resolution (`resolveOpencodeBin`) checking `/usr/local/bin/opencode` and `~/.opencode/bin/opencode` before falling back to PATH.
  - Aligned native on-demand daemon runner in `opencodeServiceBridge.js` with OpenCode v2.2.5 (`/api/session` and `/api/session/:id/prompt`), bypassing Cloudflare WAF bot blocks.

- **Fix ZCode WAF 3012 by Aligning System Prefix with Proven Capture**:
  - Restored verified `seg0` + `seg1` system prefix from `Zcode2api` research (`UPSTREAM-3012.md`), eliminating the unexpected `Gen UI` visualization block that triggered upstream template divergence.
  - Aligned lightweight 4-header client profile (`ZCode/3.16.3 ai-sdk/anthropic/3.0.81`) for Start-Plan lane.
  - Normalized model aliases to uppercase canonical (`GLM-5.3-Flash`, `GLM-5.3`).

- **Align Start-Plan metadata.user_id with Official ZCode Specification**:
  - Implemented official JSON-serialized `metadata.user_id = {"device_id": mid, "account_uuid": "", "session_id": sid}` as proven by ZCode repo `anthropic-request-metadata.ts` to fully satisfy upstream WAF validation.

- **Option B Native ZCode Electron Engine (Stripped Headless Daemon)**:
  - Integrated native headless ZCode binary (`/opt/zcode-engine/zcode`) running `bridge-worker.mjs` on localhost:29999.
  - Automatically auto-spawns on demand with a 10-minute idle reaper (RSS ~85MB, 0% GUI/GPU overhead).
  - Wired directly into `ZCodeExecutor` with seamless failover to `zcodeTlsFetch`.

- **Fix GLM & ZCode Start-Plan Base Endpoint & Business Token Refresh**:
  - Restored Start-Plan base URLs to `https://zcode.z.ai/api/v1/zcode-plan/anthropic` to prevent 401 `token expired or incorrect` caused by Ultra Gateway rejecting start-plan JWTs.
  - Allowed `refreshZcodeJwt` in `ZCodeExecutor.refreshCredentials` to use `credentials.accessToken` as fallback when `oauthAccessToken` is absent.

- **Add Remote Proxy Test Endpoint to Go Core**:
  - Implemented `/api/test-proxy` in `internal/gateway/server.go` allowing remote diagnostic testing of proxy endpoints directly from Koyeb cloud infrastructure.

- **Add Lightweight Dockerfile.go for Koyeb & Container Deployments**:
  - Created multi-stage `Dockerfile.go` for static Zero-CGO compilation with minimal ~25MB Alpine runner image.
  - Set default `GOMEMLIMIT=128MiB` and non-root execution for 24/7 cloud stability without OOM.

- **Migrate ZCode & GLM Default Base to Ultra Gateway**:
  - Switched default start-plan and registry base URLs from deprecated `/api/v1/zcode-plan/anthropic` to official ZCode v3.17 Ultra Gateway (`https://zcode.z.ai/api/v1/ultra-zai/anthropic`), completely bypassing legacy 3012 WAF edge blocks.
  - Enforced strict proxy mode in `opencodeTlsClient.js` and `zcodeTlsClient.js`: when a proxy is configured, requests strictly route through the proxy with zero silent direct IP leakages.

- **Harden OpenCode Proxy Error Pattern Matching**:
  - Expanded `isProxyErr` in `opencodeTlsClient.js` to catch `operation timed out`, `timed out`, `timeout`, and `broken pipe` so slow or dead proxies immediately trigger direct TLS failover.

- **Fix ZCode WAF 3012 TLS Cipher Fingerprint & Header Alignment**:
  - Upgraded `zcodeTlsClient.js` to `chrome_133` BoringSSL cipher list with strict Post-Quantum key exchange emulation.
  - Replaced `HTTP-Referer` with standard browser `Origin: https://zcode.z.ai` and `Referer: https://zcode.z.ai/`.
  - Preserved `directFetch` in `ZCodeExecutor` retry loop with rotated UUIDv4 `userId` and fresh session salt.

- **Fix ZCode WAF 3012 by Dropping Anthropic-Beta & Lock Client to 3.16.3**:
  - Removed `CLAUDE_API_HEADERS` ("Anthropic-Beta: claude-code-...") from `open-sse/providers/registry/glm.js` that triggered WAF code 3012 bot detection.
  - Stripped `anthropic-beta` in `ZCodeExecutor.buildHeaders` and pinned client version to `3.16.3`.

- **Fix Bulk API Key Import & Parameter Overflows**:
  - Fixed `TypeError: normalizeProviderId is not a function` in `/api/providers/bulk` by importing `resolveProviderId`.
  - Implemented synchronous single-transaction `bulkCreateProviderConnections` in `connectionsRepo.js` to eliminate nested transaction exceptions and instantly insert 2000+ keys.
  - Chunked bulk DELETE queries into 500 IDs per statement to stay well below SQLite host parameter limits.

- **Native Chrome BoringSSL TLS Client for ZCode & GLM (WAF 3012 Bypass)**:
  - Directly integrated `zcodeTlsFetch` (`wreq-js` Chrome 131 BoringSSL / Post-Quantum TLS 1.3) into `ZCodeExecutor` for both `zcode` and `glm` providers.
  - Eliminated Cloudflare/Z.ai edge HTTP 405 `code: 3012 (request has been blocked due to unusual activity)`.
  - Full proxy awareness via `directFetchProxy` with zero external ports or daemon overhead.

- **Fix ZCode Start Plan 3012 WAF & Subscription Auto-Lane Bypass**:
  - Restored complete `# ZCode Desktop Context` stock system prompt blocks in `zcodePrompt.js` required by zcode.z.ai WAF.
  - Skip unnecessary `/api/biz/subscription/list` checks when a valid start-plan `zcodeJwtToken` is present to eliminate false token-expired warnings.
  - Unified model casing (`GLM-5.3-Flash`, `glm-5.3-flash`, `GLM-5.3`, `glm-5.3`) across both `zcode` and `glm` providers.

- **Fix ZCode Daemon Port Collision & Direct Failover**:
  - Moved ZCode native daemon bridge to dedicated port `29999` to avoid collision with internal Next.js/gateway proxies on port `28888`.
  - Added automatic instant failover in `open-sse/executors/zcode.js`: if local daemon responds with 401/403/502, request immediately falls back to direct upstream TLS HTTP.
  - Disabled erroneous OAuth refresh loop on GLM and ZCode connections in `open-sse/services/tokenRefresh.js`.

- **ZCode Native Headless Daemon Bridge (Option A)**:
  - Added lightweight on-demand ZCode headless daemon bridge in `open-sse/services/zcodeServiceBridge.js` on localhost:28888.
  - Implemented 10-minute idle reaper to guarantee zero background memory leaks / OOM prevention.
  - Wired seamless routing in `open-sse/executors/zcode.js` prioritizing the local daemon with transparent fallback to direct TLS HTTP.

- **OpenCode Direct Fetch Proxy & ProxyConnect Recovery**:
  - Wired `directFetchProxy: true` in `open-sse/executors/opencode.js` so connection proxy pools correctly utilize `wreq-js` TLS impersonation instead of failing open to undici.
  - Added direct TLS impersonation recovery on dead proxy tunnel failures in `open-sse/services/opencodeTlsClient.js`.

- **Port Decolua Upstream Engine Stabilizations**:
  - **PR #5374**: Abort upstream stream controller immediately on client disconnect without 500ms lag.
  - **PR #5431**: Drop Claude Code identity system prompt blocks on `anthropic` API key requests to prevent misleading credit error 400.
  - **PR #5321**: Added `gemini-3.8-flash-tts` and `gemini-3.8-flash-lite-tts` models to Gemini provider registry and TTS catalog.

- **Fix OpenCode TLS ProxyConnect Fallback**:
  - Added dead proxy detection on `wreq-js` tunnel/ProxyConnect failure in `opencodeTlsClient.js`.
  - Fallback request automatically bypasses dead proxy to native direct fetch without dropping the completion turn.

- **GLM Reset Card Grant Type & Cooldown Recovery (OmniRoute PR #18840 & #18864 Port)**:
  - Preserved provider `grantType` in GLM reset card parsing, request bodies, and route handlers without inventing or stripping namespaces.
  - Added automatic connection health and cooldown recovery after confirmed reset card redemption, clearing `testStatus: active`, `rateLimitedUntil: null`, and `modelLock_*` locks.

- **ZCode Ultra Gateway & Dual-Authorization Architecture (v3.17.2 Port)**:
  - Added official Ultra Gateway base endpoints (`/api/v1/ultra-zai/anthropic` and `/api/v1/ultra/anthropic`) discovered from ZCode 3.17.2 monorepo reverse engineering.
  - Added native `X-ZCode-Authorization: Bearer <zcodeJwtToken>` dual-authorization header alongside standard model API key in `open-sse/executors/zcode.js`.
  - Bumped internal ZCode client version references to `3.17.2` while keeping the lightweight pure HTTP wire architecture intact.

- **ZCode & GLM Concurrency Limit Cooldown & Stable Device MID**:
  - Added specific error classification rule for upstream concurrency limit errors in errorConfig.js to apply short 5-second cooldown instead of punitive exponential account lockout.
  - Added deterministic x-device-mid UUID generation via stableDeviceMid(credentials) in open-sse/executors/zcode.js matching desktop Electron client behavior.
  - Updated ZCode runtime system prompts in open-sse/services/zcodePrompt.js to canonical 3.17.1 ContextBuilder structure.

- **Fix ZCode Upstream 3012 Prompt-Shape Rejection**:
  - Aligned ZCode system prompt to canonical 3.16.3 desktop asset (>1500 chars) including full `# ZCode Desktop Context` block.
  - Hardened 3-block system alignment in `alignZcodeSystem` to prevent duplicating stock ZCode prompt blocks when caller passes pre-formed system blocks.
  - Ensured compliance with upstream ZCode gateway content inspection on `/api/v1/zcode-plan/anthropic/v1/messages`.

- **Fix Standalone Preloaded wreq-js Instance & Zero-Import ZCode TLS Impersonation**:
  - Preloaded `wreq-js` instance into `globalThis.__xrouter_wreq__` in both `custom-server.js` and standalone `server.js` before Next.js server initialization.
  - Prioritized `globalThis.__xrouter_wreq__` directly in `zcodeTlsClient.js` and `opencodeTlsClient.js`, bypassing webpack chunk dynamic import isolation completely (`Cannot find package 'wreq-js'`).
  - Cleaned up entrypoint require hook injection in `scripts/copy-standalone-assets.mjs`.
- **Fix Standalone Webpack Scope wreq-js Native Loader & 3012 WAF Bypass**:
  - Resolved `eval("require")` reference failure in Webpack standalone chunk scope where `require` was not in lexical scope, leading to `wreq-js unavailable` and failing open to native fetch.
  - Implemented global require bootstrap hook (`globalThis.__xrouter_native_require__`) initialized at entrypoint (`custom-server.js` and standalone `server.js`).
  - Added multi-tier resolution using `process.getBuiltinModule("module")`, dynamic `Function` constructor require/import completely invisible to Webpack AST analysis, candidate `package.json` resolution, and direct `.cjs` file resolution.
  - Hardened both `zcodeTlsClient.js` and `opencodeTlsClient.js` against standalone Next.js bundling quirks.
- **Fix Standalone & CLI wreq-js Native Loader & 3012 WAF Bypass**:
  - Fixed webpack module bundling issue where `import("node:module")` resolved to undefined, causing `cjs fallback: e is not a function` and failing open to native fetch.
  - Replaced broken webpack-intercepted loader in `zcodeTlsClient.js` and `opencodeTlsClient.js` with multi-tier native require (`__non_webpack_require__` / `eval("require")`), candidate package.json `createRequire`, and direct filesystem resolution.
  - Added `serverComponentsExternalPackages: externalPkgs` to `next.config.mjs` experimental block for Next.js 14 compatibility so `wreq-js` is properly treated as an external package.
  - Added `wreq-js` and `@wreq-js` native bindings to `cli/scripts/build-cli.js` bundle step (`ensureModuleInBundle`) to ensure CLI packages ship with TLS impersonation.
  - Updated `scripts/copy-standalone-assets.mjs` to copy native bindings across all standalone output targets.
- **Fix Standalone wreq-js & Native Bindings Resolution**:
  - Fixed `Cannot find module 'wreq-js'` in Next.js standalone mode by copying `node_modules/wreq-js` and native bindings `node_modules/@wreq-js` in `scripts/copy-standalone-assets.mjs`.
  - Added robust fallback module resolution across ESM import, CJS require, and root `package.json` resolution in `zcodeTlsClient.js` and `opencodeTlsClient.js`, preventing fallback to native fetch and 405/3012 bot blocks.
- **ZCode TLS Impersonation (BoringSSL Chrome 131) & Edge Anti-Abuse 3012 Bypass**:
  - Hardened ZCode HTTP transport via `wreq-js` (`zcodeTlsClient.js`) delivering Chrome 131 BoringSSL / Post-Quantum TLS 1.3 ClientHello matching desktop Electron and Ciii-ATM/zcode-gateway, with connection proxy pool integration.
  - Dropped `anthropic-beta` headers by default to match official desktop client behavior.
  - Aligned ZCode system prompt to official 1213-char prefix, dropping desktop visualization placeholder that tripped edge WAF rules.
  - Normalized GLM model IDs to PascalCase (`GLM-5.3-Flash`, `GLM-5.3`, `GLM-5.2`, `GLM-5-Turbo`) and stripped `context_management` and `tool.strict`.
  - Locked ZCode client version to `3.16.3` and aligned OS version to valid Windows build `10.0.26100`.

# v0.0.7 (2026-11-02)

- **ZCode & GLM Concurrency Lock & Disconnect Guard**:
  - Implemented per-token FIFO concurrency queue (concurrency = 1) in `ZCodeExecutor` via `KeyedMutex` to eliminate request collisions (error 1113 / quota conflict).
  - Added immediate upstream abort and socket teardown upon client disconnect to prevent hanging SSE slots on Z.ai.
  - Ensured reliable lock release across stream completion, client cancellation, and upstream error branches.

# v0.0.6 (2026-11-02)

- **GLM / ZCode Auth Spoofing & Circuit Breaker Recovery**:
  - Spoofed official desktop client fingerprint (`X-Device-Mid`, `win32-x64`, `10.0.26300`) across `ZCodeExecutor` and connection test utilities to prevent Z.ai edge 405/3012 bot blocks.
  - Added auto-recovery canary probe (10m TTL) for circuit breaker `EXHAUSTED` state, preventing accounts from getting permanently locked/skipped after transient errors.
  - Routed GLM test probes through `fetchWithConnectionProxy` with complete client header impersonation.

# v0.0.5 (2026-10-31)

- **Koma Free Zero-Auth Provider (Unlimited Tokens & Native Tool Calling)**:
  - Added `koma-free` (alias `koma`) with vLLM engine support (`koma/apple`).
  - Auto-generated ephemeral UUID pairs (`X-Koma` / `X-Session`) per request for unlimited keyless throughput.
  - Native OpenAI function calling support (`finish_reason: "tool_calls"`).
  - Prevented premature stream disconnect on Google's initial 186-byte handshake frame for Gemini 4 Argon.
  - Updated `CHANGELOG-NODE.md` with latest v0.0.5 features so the Node.js legacy tab in dashboard is no longer stuck.
  - Pointed GLM website and apiKeyUrl in `glm.js` to `https://chat.z.ai` instead of `open.bigmodel.cn`.
  - Passed token units through `QuotaTable.js` so GLM / ZCode quotas display total millions of tokens (e.g. `5.0M tok (100%)`).
  - Fixed Cloudflare and Tailscale Funnel tunnels to target `getAppPort()` instead of hardcoded 20128 so funnels work dynamically under custom ports and dev servers.
  - Switched from fragile BardFrontendService to battle-tested `gemini-web.js` with `batchexecute?rpcids=otAQ7b` payload structure.
  - Added `webCookieToolBridge.js` for native OpenAI tool calling support on browser sessions.
  - Added SAPISID authentication hashing (`SAPISIDHASH`) and inner slot payload formatting with full Gemini 4 Argon support (hex `95a4c0abcba24364`, mode 8).
  - No headless browser/Playwright required: runs pure high-speed HTTP wire protocol without consuming RAM or CPU.
  - Bound `const provider = connection?.provider || ""` inside `EditConnectionModal.js` to prevent React client-side exception when mounting the provider settings page.
  - Added `zcode` / `zc` provider parser case in `ProviderLimits/utils.js` so quotas render cleanly without null property crash.
  - Added safety fallback for missing `quota.remaining` percentage calculation in `QuotaTable.js`.
  - Added `zcode` icon alias to `providerIcon.js` and fallback text in `ProviderIcon.js`.
  - Added dedicated 3rd input column for `__Secure-1PSIDCC` in `AddApiKeyModal.js` and `EditConnectionModal.js` with auto-split parsing across all three cookies.
  - Added `undici` agent with 64KB `maxHeaderSize` in `testUtils.js` to prevent `UND_ERR_HEADERS_OVERFLOW` on Google Set-Cookie responses.
  - Added native `zcode` provider (`open-sse/providers/registry/zcode.js`, alias `zc`) supporting both coding plans (project tokens via Z.AI org APIs) and start plans (`https://zcode.z.ai/api/v1/zcode-plan/anthropic`).
  - Added `ZCodeExecutor` (`open-sse/executors/zcode.js`) with client version 3.16.3 fingerprinting, UUIDv7 `x-query-id`, and ZCode 3-block system prompt alignment to avoid HTTP 405 "unusual activity" gates.
  - Added start plan balance usage resolution (`open-sse/services/usage/zcode.js`), fetching `billing/balance` with stable device identity (`X-Device-Mid`) to detect ZCode Start Plan and Weekend Build 500M token grants.
  - Linked `glm` provider usage to auto-detect ZCode start-plan balances when a `zcodeJwtToken` exists on the connection.
  - Added support for absolute expiry formatting (`absoluteReset: true`) in `QuotaTable.js` and `utils.js`.
  - Added ZCode CLI OAuth device login flow (`src/lib/oauth/providers/zcode.js`).
  - Fixed ZCode device-code poll route: added `zcode` to `noPkceProviders` so `extraData` with `_zcodePollToken` is forwarded properly during device flow polling.
- **OpenCode Enhancements & Hardening (PR #5310, #5328, #5338 Port)**:
  - Gated tool name anti-WAF bypass (`open-sse/utils/opencodeFingerprint.js`): declared tools matching `/terminal/i` are aliased to `run_command` to evade 429 FreeUsageLimitError gates.
  - Streaming timeout protection (`open-sse/executors/opencode.js`): disabled total timeout (`timeoutMs: 0`) on streaming responses to prevent 120s drops.
  - OpenCode native MCP service bridge and daemon routing fallback (`open-sse/services/opencodeServiceBridge.js`).
  - Added additional free-tier models (`gpt-4o-mini-free`, `claude-3-haiku-free`, `llama-3.1-8b-free`, `mixtral-8x7b-free`) to OpenCode registry.
- **Fix DeepSeek Web (dsw) DSML Tool Calls Leak (`<｜｜DSML｜｜ calls>` dialect)**:
  - DeepSeek V3/V4 web models emit tool calls using a nested block dialect (`<｜｜DSML｜｜ calls>` containing `<｜｜DSML｜｜ invoke name="...">` and `<｜｜DSML｜｜ parameter name="...">`) with double fullwidth pipes (`｜｜`).
  - Previously, `cleanDeepSeekToken` and `filterDsmlStream` only checked for single pipes (`[｜|]`), and non-greedy regex prematurely stopped at parameter closing tags, leaking the outer tags into chat outputs.
  - Upgraded `parseDsmlToolCalls` in `open-sse/utils/dsmlToolCalls.js` to parse both the nested `<... calls>` dialect and direct `<...:toolName>` format into standard tool call objects.
  - Upgraded `cleanDeepSeekToken` and `filterDsmlStream` in `open-sse/executors/deepseek-web.js` to suppress the full calls block during streaming and strip all nested tags without leaking.
- **Fix Zhipu Z.ai Web (zw) 503 / 502 Auth Crash (`reading 'header'`)**:
  - `open-sse/providers/registry/zai-web.js`: added `combined: true` to `transport.auth` so cookie-authenticated web sessions apply the `Authorization: Bearer <token>` header properly.
  - `open-sse/executors/default.js`: made `applyAuth` and `setAuth` resilient against missing/split descriptors to prevent `TypeError: Cannot read properties of undefined (reading 'header')`.
  - `open-sse/executors/default.js`: `resolveAuthDescriptor` now respects `transport.auth.header` instead of assuming `Cookie` for all `authType: "cookie"` providers.
  - Fixed endpoint 404: updated `baseUrl` from `https://chat.z.ai/api` to `https://chat.z.ai/openai/chat/completions` as verified from reverse-engineering the production web client bundle.
  - Added connection test in `testUtils.js` querying `https://chat.z.ai/api/v1/users/user` to eliminate "Provider test not supported" error in dashboard.
- **Fix Gemini Web 401 Cookie Freshness & Session Extraction**:
  - `open-sse/executors/gemini-web.js`: stopped auto-rotating fresh cookies before initial use — `autoRotateGeminiCookies` calls Google's sentinel endpoint with dummy payloads, which was corrupting freshly pasted cookies on datacenter IPs before `fetchSessionParams` ran.
  - `fetchSessionParams` now attempts session extraction directly with the user's cookie first, falling back to rotation only if extraction fails.
  - Enhanced `SNlM0e` and `cfb2h` regex to tolerate arbitrary whitespace variations across Google page markup.
  - Diagnostic error reporting: now explicitly identifies Google login redirects, consent gates, and ÜberProxy IP blocks rather than emitting a generic "cookie expired" error.
- **Restore Antigravity & Gemini CLI Localhost Callback (Decolua Original)**:
  - Restored Decolua's original `http://localhost:${port}/callback` redirect URI in `OAuthModal.js`.
  - Fixes Google OAuth Error 400 `redirect_uri_mismatch`: Google Cloud Console only permits `localhost` callback URIs for Desktop Client IDs; public origins like `x.aikernel.qzz.io/callback` are rejected by Google.
  - Remote browser sessions now correctly follow the copy-paste callback code flow without hitting Google access blocked errors.
- **Super-Fast Key Bulk Operations & Atomic Deletion**:
  - Replaced sequential per-key fetch loop in `handleBulkApply` with a single atomic `PATCH /api/keys/bulk` request.
  - Added native `DELETE /api/keys/bulk` endpoint with single-transaction SQLite deletion (`DELETE FROM apiKeys WHERE id IN (...)`) for sub-millisecond execution.
  - Added 1-click "Bulk Delete" button to Endpoint API Keys interface when keys are selected.
- **Fix Custom Key Provider Management Permissions**:
  - Updated `permissionPaths.js` to allow API keys with `manageProviders` permission to access `/api/oauth` endpoints for adding OAuth providers (Google Antigravity, Claude, Codex, GitHub, Qoder, etc.).
  - Added read-access permissions for `/api/settings` and `/api/proxy-pools` so restricted provider manager sessions can load provider configs and proxy bindings without 403 Forbidden.
- **ZCode Web Claim Launcher (1-Click Bridge without Electron)**:
  - Created standalone web launcher route at `/api/usage/[connectionId]/zcode-bridge`.
  - Injects stored `zcodejwttoken`, `oauth:zai:access_token`, and active provider into client session to open official ZCode Rewards & Coding Plan pages (`https://zcode.z.ai/en/rewards`) directly in any desktop/mobile browser.
  - Added "Buka ZCode Web Claim" action button in `ProviderLimits` modal for immediate browser access.
  - Ultra-lightweight (~2KB HTML), zero external deps, full dark mode, and zero emoji.
- **Clean Up GLM Gift Card Modal & Task Logic**:
  - Removed confusing manual "Direct Plan ID Claim" input box to keep UI clean and intuitive.
  - Automatically filter out already-active plans to prevent "target not found" errors on duplicate claims.
  - Surfaced referral code directly on reward task cards (`Code: 7KAJNBVR`) so users immediately know their bind code for task progression.
  - Enhanced error handling on in-progress referral tasks with actionable instructions instead of raw server error codes.
  - Zero emoji design convention strictly preserved using Material Symbols font icons.
- **Fix GLM Quota Surface Absolute Token Grants (500M gift card visible)**:
  - `parseGlmQuotaResponse` now reads absolute token amounts (`totalTokens`/`usedTokens`/`total`/`used` in tokens) from Z.ai's monitor, exposed as a distinct `Tokens (grant)` quota row.
  - `QuotaTable` renders grant rows as compact token counts (`500M tok` / `0 / 500M`) with a full `0 / 500,000,000 tokens` tooltip — the ZCODE Weekend Build 500M gift is now visible instead of an empty-looking percentage bar.
  - Root cause note: reset cards (`FIVE_HOUR`/`WEEK`) are a separate category from token gift cards; the reset-card inventory being empty is expected when no resets exist, while the token grant now shows up in the quota monitor.

# v0.0.4 (2026-10-30)

- **Fix DeepSeek Web (dsw) Tool Calling Preserving DSML**: 
  - `collectSSEContent()` now surfaces `rawContent` in addition to DSML-stripped `content`, and both stream + non-stream tool-mode paths parse tool calls from the RAW text — so `<|DSML|:tool>` tags survive `cleanDeepSeekToken` and reach `parseToolCallReply`.
  - Reproducing case: `dsw/deepseek-v4.1-pro` (and any dsw model) returned pure text with `calls:[]` because the DSML tool-call block was stripped before parsing. Now `search_web` etc. resolve to proper `tool_calls` deltas.
- **Add DeepSeek V5 Support**:
  - `open-sse/providers/registry/deepseek.js`: added `deepseek-v5-pro` and `deepseek-v5-flash` (API key).
  - `open-sse/providers/registry/deepseek-web.js`: added `deepseek-v5-chat` and `deepseek-v5-reasoner` (DeepSeek Web cookie).
  - `capabilities.js` + `pricing.js`: wired V5 thinking/tool-calling caps and per-token pricing (mirrors V4 rates).
  - DeepSeek Web executor already sanitizes DSML markup (stream + non-stream) and routes `reasoner` → `reasoning_content`, so no thinking-token/cookie leak on V5.
- **Fix Antigravity & Gemini CLI Remote OAuth Redirect URI**:
  - Dynamically use `window.location.origin/callback` in `OAuthModal.js` when accessing via custom domain or remote host, instead of hardcoding `http://localhost:${port}/callback`.
  - Updated backend `/api/oauth/[provider]/[action]` fallback to resolve from request origin instead of static `localhost:8080`.
- **Fix Antigravity 403 UberProxy Error Handling (Fast Fail + Clean Message)**:
  - `open-sse/executors/antigravity.js`: a 403 block page from Google edge (UberProxy HTML) no longer cycles the 3 sandbox mirror hosts (~90s of doomed retries) - fallback is vetoed immediately on 403 since the block is account/edge-level and identical across mirrors.
  - Clients now receive a clean actionable message ("Google edge blocked this account/IP (UberProxy 403)...") instead of a 14KB raw HTML blob.
- **Optimize Bulk Add Naming (Key-Only Fast Path)**:
  - Key-only bulk lines (no `name|` prefix) now number immediately as "Key 1..N" without per-line collision scans against existing connections, keeping huge pastes (500+ keys) at O(1) per line (3ms for 500 keys vs 2000 existing) in `src/shared/utils/bulkAdd.js`.
- **Fix README Go Core vs Node.js Runtime Inconsistency**:
  - Overview badge + intro now state the real runtime: Node.js 26 (ESM) + Next.js 14.2, with Go Core explicitly marked as **Planned** (per docs/ROADMAP_GO_MIGRATION.md), resolving the documented README contradiction.
- **Upstream 9Router Sync (2026-10-28 Merge)**:
  - Added `gpt-6.1-terra` to Codex registry (`open-sse/providers/registry/codex.js`), capabilities (500k context window), and pricing tables (`open-sse/providers/capabilities.js`, `pricing.js`).
  - Applied Claude 5.5 adaptive thinking rules to Copilot dotted model IDs (`claude-opus-5.5`, `claude-sonnet-5.5`, `claude-haiku-5.5`) in `capabilities.js` and `thinkingUnified.js`.
  - Enforced Gemini Protobuf type predicates in `cleanJSONSchemaForAntigravity` (`open-sse/translator/formats/gemini.js`), preventing `$type == Type.ARRAY` schema validation errors.
  - Handled SSE stream errors in non-streaming responses (`open-sse/handlers/chatCore/nonStreamingHandler.js`).
  - Preserved opaque `LLM|id|secret` token formats during bulk-import in `src/shared/utils/bulkAdd.js`.
  - Normalized NVIDIA NIM assistant reasoning aliases (`reasoning` -> `reasoning_content`) in `open-sse/translator/concerns/paramSupport.js`.
  - Aligned CommandCode headers (`x-command-code-version: 1.88.0`, `x-project-slug`, stable threadId session UUID).
- **Fix Provider Connection PUT Endpoint Dropping Cookie Updates**:
  - Fixed `src/app/api/providers/[id]/route.js` rejecting `apiKey` updates on `authType === "cookie"` connections (`existing.authType === "apikey"` check), which caused new cookies saved from Edit Connection modal to be silently discarded.
  - Skipped OAuth token refresh loop in `open-sse/handlers/chatCore.js` for cookie-based providers (`gemini-web`, etc.), eliminating bogus `[TOKEN_REFRESH] All 3 retry attempts failed` logs on 401.
- **Sync Edit Connection Modal with Multi-Cookie Web Providers**:
  - Brought dual-column cookie UI (`__Secure-1PSID` & `__Secure-1PSIDTS` for `gemini-web`, and `sso` & `sso-rw` for `grok-web`) with auto-split parser into `EditConnectionModal.js`, matching `AddApiKeyModal`.
  - Added Proxy Pool selector to `EditConnectionModal.js` so users can bind or re-route existing web-cookie connections to proxy pools directly from the edit modal.
- **Fix Gemini Web `sessionCache is not defined` ReferenceError**:
  - Re-instantiated in-memory `sessionCache = new Map()` in `open-sse/executors/gemini-web.js`, fixing HTTP 502 crashes during session initialization.
- **DeepSeek Web Scraper WASM Hardware Acceleration**:
  - Imported official DeepSeek compiled WebAssembly SHA-3 solver (`sha3_wasm.wasm`) into `open-sse/lib/`.
  - Upgraded `solveDeepSeekPowAsync` (`deepseek-pow-worker.js`) with WASM SIMD acceleration, reducing PoW challenge solve latency by ~10x-20x (<10ms) while keeping background worker resilience and JS Keccak fallback.
- **Notification Bell & Changelog Access UX**:
  - Replaced dead-end "Nothing to report." text in `NotificationBell.js` with an actionable `View Changelog` shortcut button, allowing instant access to release notes even when there are no active alert conditions.
  - Bumped release changelog heading date to `2026-10-28`.
- **Route OpenCode Free-Tier TLS Fetch Through Connection Proxies (PR #5297)**:
  - Backported upstream PR #5297 (`b630c92d`): wired `directFetchProxy` across `BaseExecutor`, `OpenCodeExecutor`, and `proxyAwareFetch`.
  - Impersonating TLS fetch (`wreq-js`) now rides on the connection proxy pool instead of falling back to native Node TLS on proxied paths, eliminating 429 `FreeUsageLimitError` rejections when using proxy pools with OpenCode free tier.
- **Complete GLM Reset Cards PR #5269 Port**:
  - Embedded `resetCards` inventory directly inside `getGlmUsage` response (`open-sse/services/usage/glm.js`), so cards populate automatically in `ProviderLimits` Quota Tracker.
  - Fully integrated PR #5269 UI components with `ConfirmModal` child support, recovery info persistence, and GLM reset card redemption modal.
- **Gemini Web Model Switching & Side-Channel Header (`x-goog-ext-525001261-jspb`)**:
  - Implemented Gemini Web reverse protocol side-channel headers (`x-goog-ext-525001261-jspb`, `x-goog-ext-73010989-jspb`, `x-goog-ext-73010990-jspb`) with model hash and mode mapping (`gemini-4-argon`: mode 8 / `95a4c0abcba24364`, `gemini-3.8-flash`: mode 1 / `56fdd199312815e2`, `gemini-3.1-pro`: mode 3 / `e6fa609c3fa255c0`).
  - Fixed `UND_ERR_HEADERS_OVERFLOW` (fetch failed) by setting `maxHeaderSize: 64KB` across direct and proxy dispatchers.
- **Fix GLM Usage Empty Card & Quota Normalization**:
  - Added `case "glm"` and `case "glm-cn"` in `parseQuotaData` (`ProviderLimits/utils.js`) to properly map GLM rate-limit windows.
  - Handled Z.ai upstream `code 500` ("当前用户不存在coding plan") and empty quota responses in `open-sse/services/usage/glm.js`, surfacing a clear message instead of an empty box.
  - Added an empty state fallback in `ProviderLimits/index.js` when zero quotas are available.
- **GLM Auto-Redeem Reset Card on Quota Depleted (Error 1113)**:
  - Integrated runtime hook in `open-sse/handlers/chatCore.js` that automatically fetches available 5-hour/weekly reset cards from Z.ai and redeems them on-the-fly when receiving HTTP 429 `code 1113` ("Insufficient balance or no resource package"), immediately retrying inference seamlessly without dropping the stream.
- **Fix Gemini Web Session Parameter Parsing**:
  - Expanded regex pattern in `open-sse/executors/gemini-web.js` to match both key-value format and array-wrapped format (`["SNlM0e", "..."]` and `["cfb2h", "..."]`), preventing session initialization failures.
  - Removed flawed `browserTlsClient.js` dependency that threw `Cannot read properties of undefined (reading 'resolve')`.
- **Fix PageHeading Text Clipping**:
  - Adjusted line height from `leading-none` to `leading-normal` with vertical padding in `PageHeading.js` and `micro-label`, preventing letter descenders (like 'g' and 'y' in "Usage & Analytics") from being clipped by overflow boundaries.
- **Fix wreq-js Webpack Server External Packaging**:
  - Added `wreq-js` to `serverExternalPackages` and `config.externals` in `next.config.mjs`, fixing webpack bundling issue where dynamic `createRequire().resolve` was stripped to `(void 0).resolve`, preventing `[BrowserTLS] Cannot read properties of undefined (reading 'resolve')` crashes.
- **Fix Gemini Web Cookie Modal Saving & Validation Timeout**:
  - Prevented saving hang on `gemini-web` cookie modal by making save flow fast-path and adding abort controller on validation.
  - Wired `connectionProxyPoolId` & `proxyPoolId` resolution seamlessly in `resolveConnectionProxyConfig`.
- **Harden Z.ai GLM Coding API Key Auto-Minting**:
  - Routed Z.ai business token exchange through `proxyAwareFetch` with timeout bounds, preventing `fetch failed` errors during coding plan resolution.
- **Editable HSB & RGB Numeric Controls in Custom Palette**:
  - Replaced static text labels for HSB (H, S, B) and RGB (R, G, B) with live editable numeric input controls.
  - Added bi-directional real-time color syncing across HSB, RGB, HEX, rainbow slider, and 2D spectrum canvas.
- **Antigravity Spoofing & Wire Optimization (via chaos-03x/dsh-agy)**:
  - Injected official internal Google bypass sentinel `skip_thought_signature_validator` for Antigravity functionCall parts without cached signatures.
  - Aligned `ClientMetadata` body payload to exact protobuf enum strings (`ideType: "ANTIGRAVITY"`, `ideVersion: "1.2.10"`, `platform: "DARWIN_ARM64"`) and stripped fake `Client-Metadata` HTTP header.
  - Implemented 4-stage load-bearing endpoint fallback in transport baseUrls: `daily -> prod -> daily-sandbox -> autopush` for automatic 429/capacity failover.
  - Added Claude model family output token clamp (64,000) and automatic headroom adjustment when `thinkingBudget` is active (`maxOutputTokens > thinkingBudget`).
- **Full-Spectrum Web-Cookie Impersonation via wreq-js**:
  - Armored all web-cookie providers (`gemini-web`, `deepseek-web`, `kimi-web`, `arena-ai`, `grok-web`, `chatgpt-web`, `claude-web`, `copilot-web`, `zai-web`, `duckduckgo-web`, `yuanbao-web`, `notion-web`) with `wreq-js` Chrome 133 BoringSSL ClientHello and Post-Quantum TLS 1.3 fingerprinting.
  - Routed all web-cookie domain requests in `proxyAwareFetch` through `browserTlsFetch` with proxy pool awareness and session pooling.
  - Replaced direct `fetch` in `deepseek-web`, `kimi-web`, and `arena-ai` executors with `proxyAwareFetch` to defeat WAF and bot-challenge gates.
- **Fix Zai GLM Coding OAuth Polling & Callback**:
  - Wrapped Z.ai coding-plan API key resolution in a safe fallback to OAuth access token when automatic plan key minting fails upstream, avoiding stuck authorization state.
  - Hardened OAuth modal polling error handling to catch and surface non-pending errors instead of polling indefinitely.
- **Fix Gemini Web Cookie Validation & Proxy Resolution**:
  - Fixed `validate` endpoint ignoring `providerSpecificData` (Proxy Pool) for `gemini-web`, added full browser `sec-ch-ua` headers via `proxyAwareFetch`.
  - Added JSON array cookie import support and structural validation fallback for Google datacenter IP challenge.
- **CodeBuddy Headers Injection (#5271)**:
  - Injected official CodeBuddy plugin channel headers (`X-Request-ID`, `X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID`) into `open-sse/executors/default.js` and registered `codebuddyHeaders` hook in `codebuddy-intl` and `codebuddy-cn` registries, resolving `HTTP 400 code 11128 request illegal` channel verification failures.
- **GLM Reset Cards Integration (#5269)**:
  - Added GLM international 5-hour and weekly reset cards endpoints in `open-sse/services/usage/glm.js` and `/api/usage/[connectionId]/glm-reset-cards/route.js`.
- **Fix Kimi & Official Provider Metadata Override Bug**:
  - Scoped MoonshotAI Compatible labeling and custom SVG overrides strictly to custom compatible endpoints (`isCompatible`), preventing official OAuth providers like Kimi from falsely displaying "MoonshotAI Compatible".
  - Removed false positive top hairline accent from inactive providers; hairline accent now strictly requires `connected > 0`.
- **Adaptive SVG & Palette Tinting for Custom Compatible Providers**:
  - Replaced static <img> file references with `CustomCompatibleIcon` component that directly inherits active theme variables.
  - In light mode: clean white background (`#ffffff`) with crisp black squircle border outline (`stroke="black"`).
  - In dark mode: dark sleek background (`#0a0a0a`) with white squircle border outline (`stroke="white"`).
  - Brand symbols (OpenAI flower, Anthropic delta, Moonshot lines) dynamically render in active theme color (`var(--color-primary)`) across all 6 stock palettes and custom hex palettes.
  - Fixed dark mode icon leaking into light mode.
- **Provider Identity & Metadata Fixes**:
  - Fixed MoonshotAI Compatible cards displaying "OpenAI Compatible" subtitle; now correctly labeled as "MoonshotAI Compatible".
  - Dedicated custom Moonshot vector badge loaded for all Moonshot/Kimi compatible endpoints.
- **Official Default Password Update**:
  - Changed default instance password from `synapse123` to `xrouter123` across Go runtime, Next.js dashboard guard, settings routes, and login screens.
- **Provider Cleanup**:
  - Completely purged deprecated and broken `hoplite` provider registry, executor, OAuth flow, and token refresh logic.
- **OpenCode Hardened Fingerprint & TLS Impersonation**:
  - Integrated `wreq-js` engine delivering native BoringSSL / Chrome 133 Post-Quantum Kyber TLS 1.3 ClientHello, bypassing upstream anti-relay bot checks.
  - Aligned wire protocol, system `<env>` marker, and session timestamp generation with OpenCode CLI 1.19.4.
  - Added full 11 canonical tool fingerprint schemas (`bash`, `read`, `edit`, `glob`, `grep`, `skill`, `task`, `todowrite`, `webfetch`, `websearch`, `write`) with in-place caller tool collision normalization.
  - Implemented egress rate-limit cooldown tracking and automatic proxy fallback.
- **OAuth Fix**:
  - Resolved `getProviderNames is not defined` ReferenceError in `/api/oauth/[provider]/[action]`.
- **Upstream Decolua Integration (23-26 Oct)**:
  - Integrated upstream core fixes across Claude adaptive thinking (Haiku 5.5), DeepSeek model routing (`deepseek-flash`), Kimi K3.1 Pro cataloging, Copilot model catalog updates, Monaco 0.57.0 upgrade, and SQLite null-byte sanitization.
- **Official Version Bump v0.0.4**:
  - Upgraded core X Router engine and global CLI to version 0.0.4.
- **Dedicated Custom Compatible Provider SVGs**:
  - Replaced generic icon fallbacks with dedicated vector SVG marks for Custom OpenAI Compatible, Anthropic Compatible, and Moonshot Compatible provider cards.
  - Implemented automatic Light/Dark mode contrast adaptation for custom SVG icons.
- **Provider Theme Palette Synchronization**:
  - Removed hardcoded orange (`brand-500`) accents from provider category pills, search inputs, and card connection status hairlines, dynamically harmonizing them with the active theme primary color.
- **Pinned Theme Modal Header**:
  - Converted Theme Modal container to a flex column layout with a sticky/fixed header strip. The title and close button now remain permanently pinned at the top while scrolling color options.
- **Update Check Cache Reset & Synchronization**:
  - Synchronized git revision detection directly with VPS local checkout, resolving persistent false-positive update notifications.
- **Telegram Bot Controller Service**:
  - Integrated full-featured Telegram bot service from source package (`telegramBotService.js` / `.cjs`).

# v0.0.3 (2026-10-25)

## Core & Stability Fixes
- **Cleaned Intrusive Error Boundary**:
  - Removed synthetic `src/app/error.js` that intercepted mobile clients into a perpetual "Resuming session..." spinner, restoring native Next.js layout resilience.
- **Reverse Proxy Redirect & Mixed-Content Fix**:
  - Fixed mobile browser "This page couldn't load" crash caused by loopback reverse-proxy hostname resolution overriding public domain with internal `127.0.0.1:8080`.
  - Preserved `X-Forwarded-Host` and `X-Forwarded-Proto` for all dashboard and auth redirects to prevent protocol downgrade and port leakage.
  - Added direct fallback to `PUBLIC_BASE_URL` and `BASE_URL` environment variables when reverse proxy drops host headers.
  - Enforced `Cache-Control: no-store, no-cache, must-revalidate` on dashboard and login routes so Cloudflare edge never caches dynamic session pages.
- **Canonical Model Discovery & Allowlist Filter**:
  - Adopted clean `buildModelsList` architecture in `GET /v1/models` with full capability metrics (`context_length`, `max_completion_tokens`), custom models, studio targets, and no-auth providers.
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
- **Live Git SHA Priority in Update Check**:
  - Prioritized `readGitRevision()` over baked-in `process.env.APP_REVISION` in `updateCheck.js` so running instances immediately reflect local working copy commits without false 1-commit-behind notices.
- **Changelog Fallback Search Path**:
  - Enhanced `/api/changelog` to search across `/root/xrouter`, `/root/xrouter-remake`, and process cwd so changelog notes always render properly and never display "Nothing to report".
- **Network IP Banner Print Resolution**:
  - Fixed Next.js bootstrap logger interception in `custom-server.js` to iterate all arguments rather than just `args[0]`, ensuring `- Network:` output replaces `0.0.0.0` with the actual public/LAN IP (`${lanIp}`) during `npm start`.
- **Theme-Bound Button & Form Controls**:
  - Bound `Button.js` and `Toggle.js` directly to `bg-primary` and `hover:bg-primary-hover` instead of hardcoded `bg-brand-600`, ensuring submit buttons (such as "Masuk dengan API Key" on the login page) accurately reflect the active theme accent (pink, blue, etc.).
- **Global Theme Persistence Across All Public Surfaces**:
  - Implemented `/api/theme` server endpoint to persist the instance owner's active theme and accent palette in the database `_meta` store.
  - Public portals (login page, `/claim`, usage dashboard under API key) now automatically inherit the owner's chosen palette (e.g. Pink/Custom or any accent) across all devices and visitors.
- **Removed Theme Trigger on Public/ApiKey Views**:
  - Hid theme trigger button when logged in via API key and kept the `/claim` portal clean without unnecessary theme controls.
  - Synchronized API Session logout button color with the current brand/theme palette (`text-primary hover:bg-primary/10`).
- **Cleaned Duplicate Warning Icon in MITM Banner**:
  - Removed redundant inline `warning` icon span inside the paragraph in `MitmPageClient.js`, keeping one clean warning icon on the left.
- **Desktop Sidebar Proportional Slimdown**:
  - Reduced desktop sidebar width from `240px` to `212px` (collapsed: `52px`) in `LeftRail.js`, perfectly balancing the desktop viewport.
- **OpenCode PR #5222 Merged (CLI `<env>` Marker & Shell Fingerprint Fix)**:
  - Backported upstream PR #5222 / commit `25878ce`: added the CLI `<env>` environment marker to system prompts across flat, chat, and Claude request shapes.
  - Updated tool parameter schemas for `read` (offset/limit) and `shell` with dynamic OS-specific wording (Linux/bash, macOS/zsh, Windows/powershell).
  - Bumped OpenCode CLI User-Agent to `2.1.4` and eliminated 429 FreeUsageLimitError on `oc/*` models.
- **Developer Access Portal Logo & Palette Button**:
  - Replaced generic shield icon on `/claim` with official adaptive `LogoMark`.
  - Added dedicated Palette Theme button on the `/claim` header to allow live switching between Dark, Light, and custom accent themes.
- **Changelog Public Route Authorization**:
  - Whitelisted `/api/changelog` in `dashboardGuard.js` so client sessions and unauthenticated modal viewers can read the release changelog without encountering a 401 Unauthorized "Nothing to report" state.
- **Fixed Inverted Version Update Notification Bug**:
  - Enforced strict version ordering (`compareReleases === 1`) in `updateCheck.js` so that when `v0.0.4` is installed, older remote versions (like `v0.0.3`) will never trigger false "Update available" banners.
- **Adaptive LogoMark in Light Mode**:
  - Restored dynamic background fill (`fill-surface-2 dark:fill-[#18191C]`) on `LogoMark` so the squircle container matches light mode surfaces rather than remaining hardcoded black.
- **Desktop Sidebar Compact Sizing**:
  - Reduced sidebar navigation row heights and padding in `LeftRail.js` (`h-7.5 px-2`), delivering a tighter and more proportional desktop layout.
- **Single Unified Theme Button (Across from GitHub in Menu)**:
  - Removed duplicate palette icon from the mobile top bar so that there is exactly 1 palette button on mobile, placed in the drawer footer across from the GitHub link.
- **Fine-Tuned ModelRow Buttons & Restored Clean 'close' Icon**:
  - Restored clean `close` (X) icon across all model chip action buttons instead of the circled block symbol.
  - Reduced test, copy, and close button icons by an additional ~5% (from `12px` to `11px`) for subtle and refined visual balance.
- **Compact UI Optimization (-5% proportional scale)**:
  - Scaled down the navigation rows in `MobileNav.js` with tighter padding (`px-2.5 py-2`) and smaller font size (`text-[12.5px]`), reducing oversized drawer items.
  - Scaled down model chips and action buttons in `ModelRow.js`: reduced icon sizes to `12px/13px`, model code to `text-[10.5px]`, padding to `px-2 py-1`, creating a clean, compact, non-bulky layout for both mobile and desktop.
- **Telegram Bot Controller Service Extracted & Integrated**:
  - Safely imported and integrated `telegramBotService.js` and `telegramBotService.cjs` (grammy long-polling controller with in-place UI and 16 dashboard operations) into `src/shared/services/`.
- **ModelRow Compact Proportional UI**:
  - Compacted the model chips in Provider details (`ModelRow.js`) with reduced padding, smaller fonts (`text-[11px]`), and streamlined action buttons, making the desktop and mobile interface clean, proportional, and no longer oversized.
- **Dedicated Mobile Theme Trigger & Direct Opening**:
  - Mounted dedicated palette button directly on the mobile top bar and inside the drawer footer, resolving user confusion on finding theme controls.
- **Zero-Lag Color Palette Studio**:
  - Integrated local state decoupling in `PhotoshopColorPicker` so sliding the custom palette updates smoothly at 60 FPS without UI stutter.
- **LogoMark SVG Fallback & Rendering Enforcement**:
  - Bound arrow strokes and center hub fill to `var(--color-brand-500, url(#xr-logo-gradient))` with absolute hex color stops `#E25539`/`#EB6446` in the definition.
  - Fixes mobile WebKit / Chromium bug where dynamic variables inside `<stop>` tags failed to resolve and caused the logo vector to render invisible.
- **Logo Permanence & SVG Visibility**:
  - Restored static container fill and distinct vector coloring in `LogoMark` with `#18191C` background and `#26282D` stroke, guaranteeing the X Router arrow logo never turns blank or transparent on mobile or light mode.
- **Palette Performance Optimization**:
  - Debounced real-time custom palette drag updates using `requestAnimationFrame`, eliminating UI lag while sliding colors.
  - Removed heavy CSS hue-rotate filters on SVG images in favor of direct CSS variable stroke fills.
- **Mobile Drawer Theme & Logo Visibility**:
  - Restored `HeaderMenu` (Theme Palette & System controls) to the mobile drawer footer so the theme button is always visible whether the drawer is open or closed.
  - Enhanced inline SVG rendering in `LogoMark` with fallback fills and explicit stroke mappings to ensure the X Router logo mark renders crisp on all mobile screens.
- **X Router Custom Studio Palette Renamed & Touch Fix**:
  - Rebranded color picker header to **X Router Custom Studio Palette** and replaced icon with `palette`.
  - Switched interaction to Pointer Events with `setPointerCapture` and `touch-action: none` to fix unclickable/frozen color picker on mobile and desktop browsers.
- **Photoshop-Style Custom Palette Studio**:
  - Upgraded Custom Palette into a full Photoshop-style color picker featuring a 2D Saturation/Brightness spectrum canvas, rainbow Hue slider, live Swatch comparison, RGB/HSB telemetry breakdown, and Hex input.
  - Automatically drives real-time reactive theme variables and reactive SVG logos without page refreshes.
- **Upstream 9router Improvements Cherry-Picked (from Decolua PRs)**:
  - **Missing Tool-Call ID & Pass-Through Repair** (PR #4992 / #4986): Auto-synthesizes missing tool call IDs in SSE deltas and normalizes tool names, preventing client SDK crashes.
  - **SQLite NUL Byte Stripping** (PR #5055 / #4917): Automatically strips `\0` bytes from parameters in `better-sqlite3` and `node:sqlite` adapters to prevent database worker crashes on binary payloads.
  - **Antigravity Hub 2.24.0 & Gemini 4 Argon** (PR #4816): Bumped User-Agent to `antigravity/hub/2.24.0 darwin/arm64` and registered `gemini-4-argon` variants (high/medium/low).
  - **Antigravity Reasoning Effort Mapping** (Commit 82aeb90): Maps `reasoning_effort` directly to `thinkingConfig.thinkingBudget`.
  - **Combo 4xx Graceful Advance** (Commit 5cdcddf): In model combos, 4xx errors gracefully advance to the next model candidate instead of dropping the request.
  - **Claude Redacted Thinking Passthrough** (PR #5229 / #5233): Transparently passes through redacted thinking chunks without tripping empty-content detectors.
  - **Qoder Model Queuing & Capabilities** (Commit 2720cd2): Restored `sonus` and `cantus` models with proper capability tags.
- **UI & Harvester Typography Fixes**:
  - Expanded Target input field and prevented text truncation in Auto-Harvester Engine.
  - Converted LogoMark to fully reactive SVG utilizing dynamic CSS variables (`--color-brand-500` and `--color-brand-600`) so logos dynamically shift color to match Custom Palettes.
- **Theme Icon Updated**:
  - Replaced the 4-square grid (`grid_view`) icon with the canonical theme palette (`palette`) icon on the trigger button in `HeaderMenu` for instant visual clarity.
- **Robust Typo Auto-Redirect (/dashbc -> /dashboard)**:
  - Added HTTP-level 307 interceptor in `custom-server.js` ensuring that requests to `/dashbc`, `/dashb`, etc., redirect directly to `/dashboard` before hitting Next.js 404 or throwing browser errors.
- **Client-Side Exception Fix (UpdateBanner State Sync)**:
  - Synchronized `isUpdating` state in `UpdateBanner.js` preventing runtime reference errors and white-screen crashes on client devices.
- **Provider-Level Dynamic Proxy Rotation (Round-Robin Live Pools)**:
  - Implemented dynamic "Proxy rotation: Round-robin (live pools) / live from DB" for standard authenticated providers.
  - Automatically queries active, healthy proxy pools from SQLite and rotates upstream egress per-request without manual connection rebinding.
- **OpenCode Free Tier Resilience & Auto-Rotation**:
  - Automatically detect upstream `FreeUsageLimitError` and evict stuck sessions immediately, re-minting clean credentials to bypass throttles without getting stuck in 429 loops.
- **Theme Centralization (4-Grid Icon Only)**:
  - Bound Theme & Appearance modal exclusively to the 4-box grid icon (`grid_view`) beside Instance Admin / Mobile Header.
  - Removed redundant theme settings section from `/dashboard/profile` as requested.
- **ADCode Provider Fully Removed**:
  - Cleanly purged all traces of deprecated `adcode` from provider registry, auth modals, and routes.
- **Theme & Palette Stability**:
  - Fixed client-side exception caused by duplicate portal mounting and restored canonical ThemeModal instance in HeaderMenu.
  - Aligned mobile and desktop navigation with upstream architecture (no stray modals or missing controls).
- **Cloudflare Tunnel Fallback**:
  - Auto-fallback to direct `trycloudflare.com` tunnel URL when shortlink worker (`abc-tunnel.us`) is unreachable, preventing tunnel setup failures.
- **Terminal Network Display**:
  - Display actual public/LAN IP address when server binds to `0.0.0.0` (matching canonical reference implementation).
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
