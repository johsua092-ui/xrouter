# v0.1.0 (2026-11-09)

- **OpenCode Free Lane: Retry Transient Overload, Drop Spent Sessions**:
  - The free lane sheds load with `429 {"message":"The inference service is overloaded…"}` even after the request passes the TLS gate. The executor now classifies a gated rejection: `overloaded` → retry with backoff (8 attempts, 800 ms → 4 s, ~20 s total, abort-aware); any other 429 or a 403 → treat the session as spent and drop the memoised id, so the next request mints a fresh one instead of reusing a flagged session until restart. Every other response is handed back untouched, and the discarded 429's stream is released rather than left half-read.
  - Verified live: a real quota 429 (`Free usage limit reached`) is classified as session-spent and returns in ~4 s instead of looping for 20 s.
- **Stream Watchdog: One Budget, Two Named Phases + Antigravity Headroom**:
  - The stall timer now reports the phase it caught: with no upstream byte yet it aborts as `stream first-chunk timeout` (prefill), mid-stream as `stream stall timeout`.
  - Antigravity declares `stallTimeoutMs: 600000` — Argon high-reasoning prefill can exceed the global budget on large contexts.
  - `RESPONSES_EVENT.REASONING_TEXT_DELTA` added to the stream-event schema.
  - Note: the upstream companion change (releasing the empty-content peek on the first non-empty reasoning frame) belongs to the combo empty-failover subsystem, which this fork does not carry, so that release is not part of this port.
- **Port Upstream Fixes: Codex/Claude Identity Staleness, Antigravity Schemas, STT Multipart, Zed Tool Errors**:
  - **Codex identity**: advertises CLI `0.167.1` (was `0.159.0`). OpenAI began refusing `gpt-6.1-sol` from older identities with *"The 'gpt-6.1-sol' model requires a newer version of Codex"*.
  - **Codex extended context**: registered `gpt-6.1-sol[1m]` and `gpt-6.1-terra[1m]`, and taught `handleChat` to keep the `[1m]` marker when the registry genuinely resolves it — an extended-context request used to be stripped down to the base model and quietly ran on the base window. Client-annotation cases are still stripped as before.
  - **Claude identity**: advertises Claude Code `2.1.290` (was `2.1.280`, which Fable 5.2 rejects as `claude_code_version_too_old`), and registers `claude-fable-5-2` with its capabilities and pricing.
  - **Antigravity schemas**: `~optional` added to the unsupported annotations, so a tool schema carrying it no longer earns `400 INVALID_ARGUMENT: Unknown name "~optional"`.
  - **STT multipart**: uses undici's `FormData`. The global Web-API polyfill lacks undici's internal symbols, so Node's `fetch` fell back to `String(body)` and sent a literal `"[object FormData]"`.
  - **Zed / Claude wire**: every `tool_result` now carries `is_error` as a bool, so a failed tool call is no longer presented as a success.
  - Verified: the new codex identity, the `[1m]` marker resolving through `parseModel` / `isValidModel`, the new Claude model, `~optional` in the constraint list, and the extended-context capability; build clean and service live.
- **Fix 502 on Proxied OpenCode Requests — `cacheKey is not defined`**:
  - `opencodeTlsFetch` read a `cacheKey` that only existed inside `getSession`. When a proxied OpenCode call came back **429**, the cleanup line threw `ReferenceError: cacheKey is not defined`; the catch logged `[OpenCodeTLS] Session fetch failed (cacheKey is not defined)` and, in strict-proxy mode, rethrew it — which surfaced as **502** on proxied traffic while direct calls quietly fell back to native `fetch` and kept working. That asymmetry is exactly what the request log showed.
  - Proxy normalization and the cache key are now one pair of helpers — `normalizeProxyUrl()` / `sessionKeyFor()` — used by **both** functions, so a session is deleted under the same key it was stored with. The failure path also deletes the normalised key now instead of the raw `proxyUrl`, which used to miss the cache entry entirely and leave a broken session behind.
  - Verified two ways: driving the 429 branch through a local 429 server returns a `429` Response with no ReferenceError and no warning (it previously logged `Session fetch failed (cacheKey is not defined)`), and a live `oc/glm-5.3-flash-free` request through the router now answers **200** with the expected completion.
- **Share Monitor Restyled to the Workspace Theme, Now With Latency and Usage Detail**:
  - The public share page used a standalone dark palette of its own, so it ignored the workspace theme. Rebuilt in the dashboard's own instrument-plate language from the shared tokens — `rounded-[6px]`, one hairline border, divided header strip, ember accent bar, uppercase micro-labels, tabular figures — so it now follows the ember palette in both light and dark.
  - Added real readings rather than decoration: time-to-first-token and total latency (avg / p50 / p95 plus a spread bar, read from the retained request details), a 14-day requests-per-day column chart, a model-mix bar list, a succeeded/failed split, and a newest-first recent-requests table.
  - Every chart is hand-authored inline SVG bound to the theme's colour tokens — no chart library, no generated imagery, no placeholder data; a panel with nothing to show says so instead of drawing a zero.
  - Verified: `/share/<token>` answers 200 with every panel populated.
- **Fix Share Links Pointing at the Server's Own Bind Address**:
  - Links minted from a key row came out as `http://0.0.0.0:3000/share/<token>` — unopenable — because the URL was built from the Next server's own origin, and that server binds `0.0.0.0`. New `src/lib/publicUrl.js` resolves the origin from the host the caller actually used (`x-forwarded-host` + `x-forwarded-proto`, `x-9r-forwarded-host`, then `host`), falls back to a configured `PUBLIC_BASE_URL` / `BASE_URL` / `NEXT_PUBLIC_BASE_URL`, and only then to the request origin with a loopback/wildcard host rewritten. A bind address is never handed out.
  - `GET`/`POST /api/keys/[id]/share` now use it, and the share modal prefers the browser's own `window.location.origin` when displaying and copying a link — so the copied URL is the host the operator is actually on, whatever the proxy does.
  - Verified live: behind the proxy the link resolves to `https://x.aikernel.qzz.io/share/KYXy7rNbJZhneR_JWV85DElJ`; hit directly it resolves to `http://127.0.0.1:3000/share/<token>`. Equivalence of the resolver was checked against its predecessor across proxy, direct, wildcard, funnel and no-header requests — identical output on every case.
- **Anti-Abuse Controls Wired Into the Dashboard**:
  - **Console Log** now has two tabs: the live log, and a **Banned IPs** panel listing manual bans next to the automatic auto-jail rows — with a ban form (IP, reason, minutes; `0` = permanent), refresh, and an Unban that clears whichever tier is holding the address.
  - **Bulk edit keys** gained *Denied models pattern* and *Allowed providers*. They live in the separate `apiKeyAcls` table, so they travel as a nested `acl` and are written once per selected key rather than through `keys/bulk`.
  - Every key row has a **Share usage** action: mint a read-only `/share/<token>` link (default 30 days, `0` = never), copy it, watch its view count, revoke it.
- **Anti-Abuse Guard: Durable IP Bans, Per-Key Deny/Provider ACL, Public Usage Shares**:
  - Three **new** tables — `ipBans`, `apiKeyAcls`, `shareTokens` — with `SCHEMA_VERSION` 15 → 16 (additive sync creates them; the version bump also takes the pre-schema backup). They are separate on purpose: `apiKeys` and `teams` keep the exact shape an older build expects, so an exported database still restores into a build that has never heard of these tables.
  - New `src/lib/db/repos/abuseRepo.js`: ban CRUD + `isIpBanned` (an expired row prunes itself on read), per-key ACL get/set/delete, and share-token mint / resolve / revoke / touch. Model patterns reuse `allowedModels.js`, so a **deny** pattern means exactly what an **allow** pattern means (`gpt-4*`, `*opus`, exact id).
  - Enforcement in `validateApiKey` (`apiKeysRepo.js`): a banned client IP is refused **before any key is looked up** (new `IP_BANNED`, so a blocked client cannot probe which keys exist), and the key's — or its team's — `apiKeyAcls` row is consulted for `MODEL_DENIED` and `PROVIDER_NOT_ALLOWED`. `chat.js` maps all three reason codes to explicit 403s.
  - Routes: `GET/POST/DELETE /api/security/bans` (manual bans are listed beside the automatic jail `ipJail.js` already ran — two tiers: durable/human vs temporary/automatic), `GET/POST/DELETE /api/keys/[id]/acl`, `GET/POST/DELETE /api/keys/[id]/share`.
  - Public `GET /share/<token>`: a read-only monitor for one key — all-time / today / this month requests and tokens, error count, success rate, recorded cost, plus a view counter. Added to `PUBLIC_WEB_PAGES` so it needs no session. It answers with aggregates only; no key value, no provider credential, and no way to make a request.
  - Verified locally: ban → durable row with expiry and a 403 at the gate; a denied model on a real key → `403 {"message":"Model \"opencode/gpt-4o\" is denied for this API key"}`; `/share/<token>` renders unauthenticated with HTTP 200. All smoke-test rows (ban, ACL, share token) were reverted afterwards.
- **Retire Five Providers (DuckDuckGo Web, Koma Free, OpenSatan, Ptero, Kilo Gateway)**:
  - Deleted `open-sse/providers/registry/{duckduckgo-web,koma-free,opensatan,ptero,kilo-gateway}.js` and their executors `{koma-free,opensatan,ptero,kilo-gateway}.js`; removed every import/map/export from `providers/registry/index.js` and `executors/index.js`.
  - Dropped the leftover special-cases: the `opensatan` no-auth shortlist in `executors/base.js`, the `kilo-gateway` no-auth injection in `src/sse/services/auth.js`, the `kilo-gateway` validation case in `/api/providers/[id]/test/testUtils.js`, the icon-map entries in `providerIcon.js`, and the Telegram bot's provider menu + callback regex.
  - Purged any `providerConnections` rows for those ids (0 rows existed).
- **OpenCode UA Version Now Read From OpenCode's Own Updater**:
  - New `open-sse/services/opencodeVersion.js`: the version comes from `https://opencode.ai/update/api/latest/cli/npm`, refreshed in the background at most every 6h, with `2.2.5` as the cold-start floor and `OPENCODE_VERSION` as an explicit pin. Never blocks a request.
  - `executors/opencode.js` and `executors/opencode-zen.js` no longer carry hardcoded versions (`2.2.5` / `2.0.32`) — both compose the UA per request via `getOpencodeUa()`. The updater already names `2.2.6`, so the old literal was one release stale.
- **Fix Kilo Gateway 401 INVALID_TOKEN (Kilo Now Requires Auth)**:
  - `open-sse/providers/registry/kilo-gateway.js` was registered as keyless (`noAuth: true`, `authType: "none"`), but `api.kilo.ai/api/gateway/chat/completions` now returns `401 INVALID_TOKEN` for all 12 models (only `/models` is still public). Switched to `authType: "apikey"` / `authModes: ["apikey"]` with `hasFree: false` so the dashboard collects a real key.
  - Removed the hardcoded `kilo-gateway` no-auth bypass in `open-sse/executors/default.js#buildHeaders`, so the `Authorization: Bearer <key>` header is actually sent upstream.
- **Show Tailscale Funnel Local Port in Dashboard + Robust Status Detection**:
  - Added `getFunnelTargetPort()` (parses `funnel status --json` proxy target) and exposed `port`/`localPort` in `/api/tunnel/status` and `getTailscaleStatus()` in `src/lib/tunnel/tailscale/{tailscale,manager}.js`.
  - Endpoint card in `EndpointPageClient.js` now renders a `PORT <n>` badge and `Funnel https://...ts.net → 127.0.0.1:<port>` line; badge state now falls back to `running` when `settingsEnabled` is stale, fixing the false "OFFLINE".
- **Render Tailscale Auth URL Action Button in UI**:
  - Rendered explicit "Open Login Page" action button and copy button on the Tailscale card and inside the modal in `EndpointPageClient.js` when authentication is required, preventing dead states.
- **Fix Tailscale Dynamic Socket Detection (Resolves 'timed out without auth URL')**:
  - Dynamically detect and bind to the active system Tailscale daemon socket (`/run/tailscale/tailscaled.sock` or `/var/run/tailscale/tailscaled.sock`) when the local userspace socket is absent, allowing `tailscale up` and `tailscale status` to capture the login AuthURL immediately.
- **Fix Dashboard Freeze, Event Loop Stalls & High CPU on Large Connection Tables (11.8k+)**:
  - **Master Key Caching**: In `src/lib/vault/credentialVault.js`, cached the derived master key in memory to eliminate redundant synchronous `machineIdSync` sub-process calls on every single decryption.
  - **Lazy Credential Unsealing**: In `src/lib/db/repos/connectionsRepo.js`, implemented lazy property getters on `rowToConn` for `apiKey`, `accessToken`, and `refreshToken`, so loading table rows and route snapshots performs zero upfront AES decryptions until a specific connection is dispatched.
  - **Direct Provider Queries & Scoped Invalidation**: In `src/lib/db/repos/connectionsRepo.js`, updated `getProviderConnections` with a provider filter to hit SQLite directly via indexed query instead of rebuilding the monolithic 11.8k connection snapshot, increased snapshot TTL to 5 seconds, and scoped `invalidateConnectionSnapshot` strictly to structural routing mutations (ignoring volatile heartbeat/usage counter updates).
- **Fix ReferenceError in Cloudflare Tunnel Status**:
  - In `src/lib/tunnel/cloudflare/manager.js`, removed undefined `tunnelActive` variable on fallback check in `getTunnelStatus()`.
- **Fix Tailscale Root Installation on Linux**:
  - In `src/app/api/tunnel/tailscale-install/route.js` and `src/lib/tunnel/tailscale/tailscale.js`, enabled passwordless root execution and direct daemon spawning without sudo when running as UID 0.
- **Fix SQLite Fallback in Antigravity Tier Probe & Telegram Bot Service**:
  - Implemented dynamic fallback to `better-sqlite3` when `node:sqlite` is unavailable in `src/lib/usage/antigravityTier.js` and `src/shared/services/telegramBotService.cjs`, preventing build-time and runtime crashes in non-Node 22.5+ environments.
- **Restore Upstream Decolua Tailscale Flow, Port KiloCode Keyless Gateway, OpenCode-CC Hardening & Granular Auto-Backup**:
  - **Decolua Tailscale Flow**: Restored canonical upstream Decolua Tailscale manager, daemon spawning, installation route, and endpoint modal logic.
  - **KiloCode Keyless Gateway**: Registered `kilo-gateway` (`kgw`) with zero-auth public access and 10 verified free models (`nvidia/nemotron-3.5-super-vl:free`, `kilo-auto/free`, `stealth/glyph-cluster`, etc.).
  - **OpenCode Hardening (opencode-cc)**: Added 38,000-character tool surface limit in `open-sse/utils/opencodeFingerprint.js`, normalized `prompt_cache_retention` to `prompt_cache_options: { mode: "implicit" }`, and added 400ms burst pacing in `open-sse/executors/opencode.js`.
  - **Granular Auto-Backup Scope (Telegram 45MB Mitigation)**: Added section-level data selection in `src/lib/db/repos/autoBackupRepo.js`, `src/shared/services/telegramBackup.js`, and profile modal; excluded heavy usage logs by default to keep backups compact under Telegram limits.

# v0.1.0 (2026-11-08)

- **Complete Port of OhMyRouter Features (2.A, 2.B, 2.D, 2.E) with Model Bypass Vault Encryption**:
  - **2.A (Vercel Multi-Relay Deployment)**: Upgraded `/api/proxy-pools/vercel-deploy` and modal to support deploying up to 23 parallel Vercel Edge relays with auto-naming (`#1` to `#23`).
  - **2.B (P99.9 Microsecond Latency Profiler)**: Implemented `OverheadTracker` ring-buffer in `open-sse/utils/overheadTracker.js` with phases (`ingress.format_detect`, `upstream.execute`) and exposed telemetry report at `/api/telemetry/latency`.
  - **2.D (Hermes Sync + Model Bypass Encryption)**: Implemented `src/lib/persona/hermesSync.js` to mirror active persona to `$HERMES_HOME/SOUL.md` or `$SYNAPSE_HOME/SOUL.md` with automatic backups; encrypted all Model Bypass Prompt Injections at rest using AES-256-GCM Vault (`src/lib/vault/credentialVault.js`).
  - **2.E (State Snapshot Routing)**: Implemented in-memory 1-second route snapshot grouped by provider in `connectionsRepo.js` eliminating N+1 queries.

- **Fix Team Custom API Key Validation & Permitted Models Filtering**:
  - In `src/lib/db/repos/apiKeysRepo.js`, removed hardcoded `xteam-` prefix restrictions in `getApiKeyByKey()` and `validateApiKey()`, allowing any custom prefix or key name (e.g. `yteam-*`, `sk-*`, custom tokens) to authenticate against the `teams` table.
  - Linked `getAllowedModelsOfKey()` to the `teams` table so client requests fetching `/v1/models` with a team API key strictly see only their permitted models (e.g. `mine`).
  - In `src/lib/db/repos/allowedModels.js`, added support for JSON array format parsing in `parseAllowedModels()`.
  - Updated Teams UI input description in `src/app/(dashboard)/dashboard/teams/page.js` to highlight support for custom prefixes.

- **Eliminate Semantic Cache False Hits & Enable Remote Tunnel Access**:
  - Enforced strict token-identity sequence matching in `open-sse/rtk/semanticCache.js` so different prompts (even with similar keywords) never false-hit.
  - In `src/dashboardGuard.js`, allow authenticated dashboard sessions (`isAuthenticated`) to access tunnel management endpoints (`/api/tunnel/*`) remotely, fixing the 403 error that caused the Tailscale modal to dismiss prematurely.
  - In `EndpointPageClient.js`, surface HTTP error responses directly in `handleInstallTailscale()` and keep install logs visible on error.

- **Fix Tailscale Installation Flow (Decouple Login Timeout & Auto-Close Modal)**:
  - In `src/lib/tunnel/tailscale/tailscale.js`, decoupled installer from blocking `startLogin()` so `installTailscale()` finishes immediately upon package install without 15s login timeout.
  - In `EndpointPageClient.js`, keep Tailscale modal open on successful install showing installed status and explicit Connect action rather than abruptly dismissing the modal.

- **Fix Tailscale Daemon Execution on Linux Root Environments**:
  - In `src/lib/tunnel/tailscale/tailscale.js`, resolve absolute path for `tailscaled` daemon across `/usr/sbin`, `/usr/bin`, and `/usr/local/bin` candidates.
  - Bypass `sudo` spawning in `startDaemonWithPassword()` when running directly as root (`process.getuid() === 0`) to prevent sudo prompt hangs.

- **Complete Port of 9RouterX Features (A1, B1, B2, B4)**:
  - **A1 (OpenCode Stealth)**: Preserved Bun/BoringSSL exact HTTP/2 pseudo-header and header order (`content-type`, `authorization`, `user-agent`, `x-opencode-*`) to evade Cloudflare WAF 403 FreeTierError.
  - **B1 (Persona Enhancements)**: Implemented per-preset model exclusion rules and Gemini `safetySettings: BLOCK_NONE` API bypass in `promptInjectionRepo.js` and `openai-to-gemini.js`.
  - **B2 (Credential Vault)**: Implemented AES-256-GCM sealed credential storage in `src/lib/vault/credentialVault.js` with automatic seal/unseal hooks in `connectionsRepo.js` (backward compatible with plaintext legacy data).
  - **B4 (Multi-Key Policy Plans)**: Enforced Team & Plan governance constraints (RPM/TPM limit, daily/monthly spend USD cap, daily/monthly request volume caps) in `apiKeysRepo.js`.

- **Fix Tailscale Installer Sudo Password Requirement for Root Users**:
  - In `src/app/api/tunnel/tailscale-install/route.js` and `tailscale.js`, allow passwordless install when running as `root` (`process.getuid() === 0`) using direct `sh` spawn.
  - Added optional Sudo Password input field in Tailscale installation modal on Endpoint page so users can provide credentials when required.

- **Preserve Bun/BoringSSL HTTP Header Ordering in OpenCode Executor**:
  - Aligned header order in `open-sse/executors/opencode.js` with OpenCode CLI upstream fingerprint (`opencode_stealth.go` specification) to prevent Cloudflare WAF header-order flagging on free-tier requests.

- **Fix Stream Stall Timeout on Long-Running Reasoning Models (GLM-5.3-Flash)**:
  - Extended default stall watchdog `STREAM_STALL_TIMEOUT_MS` from 360s to 600s (10 minutes) in `runtimeConfig.js` and set explicit 600s stall threshold for `glm` provider.
  - Added downstream tap monitoring in `pipeWithDisconnect` (`open-sse/utils/streamHandler.js`) to continuously reset watchdog activity during slow token emission and reasoning phases.

- **Dynamic Cooldown Registry & Intelligent 429 Rate-Limit Quarantine (voidllm pattern)**:
  - Implemented `src/sse/services/cooldownRegistry.js` inspired by VoidLLM (`internal/cooldown/registry.go`).
  - Separates temporary rate limits (`HTTP 429` / `FreeUsageLimitError`) from permanent circuit-breaker failures, preventing premature key deletion.
  - Automatically isolates throttled accounts/models during their cooldown window and seamlessly fails over to backup connections without user interruption.
  - Opportunistic memory eviction and auto-healing on successful requests.

- **Dual-Stage Semantic Prompt Caching (messkan/prompt-cache pattern)**:
  - Upgraded `open-sse/rtk/semanticCache.js` from basic hash-only caching to a dual-stage caching engine: Tier 1 exact SHA-256 hash match (0ms) and Tier 2 lexical-semantic similarity engine combining word-level cosine similarity and character trigram Jaccard similarity.
  - Added configurable similarity threshold (`setSemanticSimilarityThreshold`, default 0.85) and separated metrics for exactHits vs semanticHits.
  - Fixed streaming handler completion caching to prevent raw stream payload bypass.

- **Fix OVH Cloud Kepler AI Base URL Endpoint & SQLite ALTER TABLE ADD COLUMN**:
  - Fixed 404 URL in `open-sse/providers/registry/ovh.js` and `open-sse/executors/default.js` by targeting `/chat/completions` instead of bare `/v1`.
  - Resolved SQLite restriction error `Cannot add a UNIQUE column` by splitting column addition and creating a separate unique index on `teams(apiKey)` in `teamsRepo.js` and `schema.js`.

- **Helicone-Grade Observability Enhancement in Request Logs**:
  - Enhanced request logging in `usageRepo.js` and `RequestLogger.js` with per-request real-time USD cost metrics and status badges inspired by Helicone observability patterns.
  - Added auto-rebind support in `testProxyUrl` and `proxy-pools/[id]/test` for `v2ray-builtin-tunnel` so Xray child processes automatically respawn if offline.

- **Enhance VMess TLS Profile Parsing (ALPN & Fingerprint)**:
  - Extracted `fp` and `alpn` parameters from VMess JSON configs in `src/lib/v2ray/parser.js` and forwarded to Xray TLS stream settings for optimal handshake negotiation.

- **Fix Teams Database Schema & Enforce Spend Limit (USD) Governance**:
  - Added self-healing `ensureTeamsSchema` in `teamsRepo.js` to ensure the `apiKey` column exists on the `teams` table, fixing `table teams has no column named apiKey`.
  - Implemented real-time spend limit enforcement in `validateApiKey` (`apiKeysRepo.js`) checking both `dailySpendLimitUsd` and `monthlySpendLimitUsd` from `usageHistory` costs.
  - Refined `getPricingForModel` fallback in `pricing.js` to prevent over-eager zeroing of models and ensure estimated cost in USD tracks appropriately.

- **Fix DefaultExecutor Authorization for Keyless OVH Provider**:
  - Added early check in `DefaultExecutor.buildHeaders()` to strip `Authorization` header for `ovh` and no-auth providers so upstream doesn't return `403 Forbidden: authentication failed`.

- **Backport Decolua Upstream PRs (#5486, #5508, #5509)**:
  - **PR #5486**: Preserved explicit `thinking.budget_tokens` on DeepSeek models (`thinkingUnified.js`) so compatible hosts don't reject requests as missing budget.
  - **PR #5508**: Sanitized third-party CLI agent markers (Claude Code, Cursor, Cline) in `codebuddy-intl.js` while preserving user system prompts to prevent Tencent WAF 11101 rejections.
  - **PR #5509**: Migrated `opencode-go` executor and registry from deprecated `/zen/go/v1` routes to official `/inference/go/v1` endpoints.

- **Fix Missing getSettings Import in Single Model Route**:
  - Imported `getSettings`, `isValidApiKey`, and `apiKeyGateFailure` in `src/app/api/v1/models/[...model]/route.js` to fix `ReferenceError: getSettings is not defined` when client fetches `/v1/models/{model}`.

- **Fix Xray Modern Outbound TLS Configuration**:
  - Removed deprecated `allowInsecure` property from Xray TLS outbound configurations in `src/lib/v2ray/parser.js` to ensure compatibility with Xray-core v26+.

- **Fix Model Test Endpoint Authorization in Permission Paths**:
  - Registered `/api/models/test` under `src/lib/auth/permissionPaths.js` with `manageModels`, `manageProviders`, and `manageApiKeys` permissions so dashboard UI model testing does not fail with 401 when Require API Key is active.

- **Fix OVH Keyless Auth & Internal Test Ping**:
  - Registered `providerId === "ovh"` in `src/sse/services/auth.js` to ensure virtual no-auth credentials are automatically supplied.
  - Fixed internal `pingModelByKind` to inject the gateway API key so `requireApiKey` validates properly on test probes.
  - Ensured standalone `.next/server/pages` is copied in `scripts/copy-standalone-assets.mjs` to resolve `_error.js` missing module warning.

- **Move Teams to Features Menu Group**:
  - Relocated `/dashboard/teams` from core routing nav items into `WORKSHOP_ITEMS` (Feature+ group) in navigation constants, Sidebar, and LeftRail as requested by Naub.

- **Port OpenCode Zen 4-Pillar Playbook Validations**:
  - Enforced atomic mathematical sequence clamping `counter = (counter + 1) & 0x0F` on `generateSessionId` to satisfy upstream backend's `0xfff - low < 16` integrity check.
  - Automatically deleted prohibited `tool_choice: "none"` across all request lanes to prevent upstream `403 FreeTierError`.
  - Clamped `reasoning_effort` (`xhigh`/`max` -> `high`) in `dropAdaptiveReasoningEffort` to avoid HTTP 400 parameter errors.

- **Native V2Ray / VLESS / Trojan Link Ingestion in Proxy Pools**:
  - Implemented `parseV2RayLink` in `src/lib/v2ray/parser.js` supporting `vmess://`, `vless://`, `trojan://`, and `ss://` with automatic TLS, WebSocket, Reality, and gRPC profile mapping.
  - Added Xray lifecycle manager (`src/lib/v2ray/manager.js`) auto-binding local SOCKS5 (`10855`) and HTTP (`10856`) proxy ports and registering directly into `proxyPools`.
  - Added UI modal in `/dashboard/proxy-pools` for 1-click V2Ray tunnel connection and proxy pool assignment.

- **Fix Keyless Models Internal Ping Authorization**:
  - Suppressed Bearer injection on internal health test probes for keyless models (`ovh/*`, `koma/*`, `opensatan/*`) in `ping.js`.
  - Added team API key authentication support in `validateApiKey` (`apiKeysRepo.js`).

- **Integrate Standard Categorized ModelSelectModal in Teams Page**:
  - Replaced ad-hoc model list with standard system `ModelSelectModal` (same component used in Endpoint & Combos) supporting categorized provider tabs, live search, prefix tags, and batch selection.

- **Upgrade Teams Governance with Auto-Key (`xteam-*`) and Model Picker**:
  - Implemented automatic high-entropy `xteam-*` API key generation with 1-click clipboard copy.
  - Added interactive search & multi-checkbox model picker to whitelist specific catalog models per team.
  - Linked virtual team authentication in `apiKeysRepo.js` so client requests with `xteam-*` authenticate automatically.

- **Fix Keyless Provider Base Executor Authorization**:
  - Automatically stripped `Authorization: Bearer` headers for `ovh` in `open-sse/executors/base.js` and `ping.js` to fix HTTP 403 error.

- **Dedicated Teams Governance Tab & UI in Dashboard**:
  - Added modern Next.js UI tab `/dashboard/teams` in sidebar and navigation with cards, live toggles, and edit modal for group spend/rate limits.
  - Connected `/api/teams` REST endpoints backed by local SQLite `teams` table.

- **Fix OVH Keyless Auth & Static Model Discovery**:
  - Suppressed Bearer header injection on keyless/noAuth providers in `open-sse/executors/base.js`.
  - Added dedicated static resolver for `ovh` in `/api/providers/[id]/models/route.js`.

- **Add Free Keyless Provider OVH Cloud (Kepler AI)**:
  - Registered `ovh` (`open-sse/providers/registry/ovh.js`) with keyless access to high-context reasoning models: `Qwen3.6-27B` (262K context), `Qwen3.8-27B` (262K context), `gpt-oss-120b` (131K context), and `Mistral-Small` (131K context).
  - Verified 100% native OpenAI tool calling & streaming compatibility.

- **Port Multi-Tenant Teams Schema & Endpoints to Go Core**:
  - Implemented `teams` SQLite database schema in `internal/database/db.go` with multi-tier quota limits (RPM, daily/monthly spend in USD, model whitelisting).
  - Implemented `/admin/v1/teams` REST endpoints in Go Core (`internal/gateway/server.go`) for team governance.

- **Register Gemini Web in Go Core Models Catalog**:
  - Registered `gemini-web/gemini-2.5-flash` and `gemini-web/gemini-2.5-pro` in Go Core `handleModels` catalog.

- **Align Go Core Diagnostic Proxy Subpath**:
  - Aligned default target in `handleTestProxy` (`internal/gateway/server.go`) to canonical `/inference/openai/v1/models`.

- **Port OpenCode Quota Classifier from Kandev PR #5120**:
  - Added explicit regex-aligned error rules for `FreeUsageLimitError`, `free usage limit reached`, and `AI_APICallError` in `open-sse/config/errorConfig.js` to trigger automatic routing failover to the next connection instead of surfacing generic runtime errors.

- **Documentation & Distribution Cleanup**:
  - Deprecated and removed global NPM package instructions (`npm install -g xrouter-ai`, `npx xrouter-ai`) and badges from `README.md` to align with the repository's native Git & Go Core distribution model.

- **Port Complete Magpie OpenCode Specification**:
  - Upgraded OpenCode fingerprint tool definitions to full 5 core tools (`edit`, `glob`, `grep`, `read`, `shell`) with exact upstream schemas.
  - Injected OpenTelemetry trace headers (`b3`, `traceparent`) on every request to pass OpenCode 2.2.5+ telemetry verification.

- **Fix Tailscale Installer Hanging ("Bengong") and Socket Detection**:
  - Streamed `child.stderr` in `installTailscaleLinux` so apt-get progress is pushed to the UI in real time rather than freezing.
  - Dynamically resolved active socket flag (`getActiveSocketFlag`) between system daemon (`/var/run/tailscale/tailscaled.sock`) and custom userspace socket.
  - Broadened `parseAuthUrl` regex to match any `https://login.tailscale.com/*` auth URL.

- **Align OpenCode Free Tier Endpoint Subpath**:
  - Pointed free-tier executor URL to canonical `/inference/openai/v1/*` matching official CLI binary reverse-engineering findings.

- **Port OpenCode Stale Limit Auto-Clear from OpenCode-Unlimited**:
  - Automatically clear sticky `provider.free-limit` cached error flags from local `opencode.db` on session eviction to prevent permanent rate-limit lockouts.

- **Harden OpenCode TLS Session Recycling on Rate Limit**:
  - Evict TLS session from cache immediately upon receiving HTTP 429 response in `opencodeTlsClient.js` to ensure the next request gets a fresh TLS handshake and bypasses sticky throttling buckets.

- **Port OpenCode Zen Dynamic Project ID Rotation (Bypass Quota Limit)**:
  - Integrated `generateRandomProjectId()` (40-hex git-commit-shaped hash) from `TiaraBasori/OpenCode2API` in `open-sse/executors/opencode.js`.
  - Replaced static `"global"` project header with dynamic rotation, isolating quota buckets per request to avoid premature HTTP 429 `FreeUsageLimitError`.

- **Fix NPM CLI Update Check False Downgrade Prompt**:
  - Filtered legacy `0.6.x` published registry versions in `cli/cli.js` from triggering an update prompt when running the new `0.1.0` series locally.

- **Version Bump to v0.1.0 (Node.js) & v0.0.1 (Go Core)**:
  - Advanced package version to `0.1.0` in `package.json` and `cli/package.json` for major feature milestone.
  - Reset Go Core micro-gateway version to `0.0.1` in `internal/config/config.go`.
  - Full feature parity between Go Core and Node.js runtime.

# v0.0.8 (2026-11-05)

- **Port Go Core Diagnostic Proxy Test to Node.js Gateway**:
  - Implemented `/api/test-proxy` endpoint in Next.js router (`src/app/api/test-proxy/route.js`) using `undici` and `ProxyAgent` for full feature parity with Go Core.

- **Fix Missing Gift Card Button for ZCode Connections**:
  - Expanded `isGlm` check in `ProviderLimits/index.js` to include `conn.provider === "zcode"`, ensuring connections registered under `zcode` display the Gift button alongside `glm`.
  - Updated bridge page copy as requested.

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

# v0.0.7 (2026-11-03)

## Updates & Improvements
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

## Updates & Improvements
- **ZCode & GLM Concurrency Lock & Disconnect Guard**:
  - Implemented per-token FIFO concurrency queue (concurrency = 1) in `ZCodeExecutor` via `KeyedMutex` to eliminate request collisions (error 1113 / quota conflict).
  - Added immediate upstream abort and socket teardown upon client disconnect to prevent hanging SSE slots on Z.ai.
  - Ensured reliable lock release across stream completion, client cancellation, and upstream error branches.

# v0.0.6 (2026-11-02)

## Updates & Improvements
- **GLM / ZCode Auth Spoofing & Circuit Breaker Recovery**:
  - Spoofed official desktop client fingerprint (`X-Device-Mid`, `win32-x64`, `10.0.26300`) across `ZCodeExecutor` and connection test utilities.
  - Added auto-recovery canary probe (10m TTL) for circuit breaker `EXHAUSTED` state.
  - Routed GLM test probes through `fetchWithConnectionProxy` with client header impersonation.

# v0.0.5 (2026-10-31)

## Updates & Improvements
- **Gemini Web Argon Handshake Stream Idle Guard**:
  - Prevented idle timeout from prematurely tripping on Google's initial 186-byte handshake frame for complex reasoning models like Gemini 4 Argon.
- **Node.js Engine & Go Core Synchronization**:
  - Unified Go Core and Node.js package versioning to v0.0.5.
  - Added BLA memory obfuscation and dynamic app port routing for Cloudflare/Tailscale funnels.

# v0.6.230 (2026-10-24)

## Features & Improvements
- **Node.js Gateway & Next.js Dashboard v0.6.230**:
  - Full parity with Go Core v0.0.2 routing, executor registry, and provider models.
  - Next.js 14 standalone distribution and runtime assets synchronization.

# v0.6.229 (2026-10-23)

## Security
- **The ADCode Firebase web key no longer ships in source**: it is read from `ADCODE_FB_KEY` at runtime instead of being embedded in the recipe blob. The blob was decryptable by anyone holding the tarball (the derivation salt ships next to it), so embedding the key there only obscured it. A missing key now raises an explicit configuration error rather than a generic auth failure.
- **Verified absent from every artefact**: the key returns zero matches in the source tree, both git HEADs, the Next build output, and the packed npm tarball. The only `AIza…` string left in the tarball belongs to an unrelated provider.
- **Recipe blob keeps the wire format only** (endpoints, client headers, user agent) and is versioned `v2` so a stale blob cannot be mistaken for the current one.

## Notes
- Self-hosters using ADCode must set `ADCODE_FB_KEY` (see `/etc/xrouter/adcode.env`); every other provider is unaffected.

# v0.6.228 (2026-10-23)

## Security
- **ADCode wire recipe is no longer readable from source**: the upstream endpoint, client headers (`x-adcode-*`), user agent and Firebase web key used to be spelled out in the executor and registry. They now live in an AES-256-GCM blob (`open-sse/recipe/adcodeRecipe.js`) decrypted at load time, so the recipe is not copy-pasteable from the repo or from an npm tarball. Rotation hook: `ADCODE_RECIPE_KEY`.
- **Registry stays metadata-only**: it is imported into client bundles, so it cannot pull in `node:crypto`; the executor builds the request URL itself.
- **Packaging leak closed**: the plaintext generator is no longer part of the tree, and stale `.next-cli-build` artefacts (which shipped the old plaintext chunks) were purged and rebuilt.

# v0.6.227 (2026-10-23)

## Updates & Bug Fixes
- **Update bell no longer lies**: a published build stamps `APP_REVISION` from its own checkout, which is a different git history than the repository the updater watches, so comparing those shas reported "update available" even on the newest release. The release version is now the only signal for published builds; the git signal is kept for the Go core.

# v0.6.226 (2026-10-23)

## Updates & Bug Fixes
- **ADCode chat now actually answers**: the included-AI gateway rejects requests carrying sampling knobs or internal bookkeeping fields with a generic 400 ("Send a supported chat request"). The executor strips `temperature`, `top_p`, `top_k`, penalties, `seed`, `stop`, `response_format`, `logprobs` and every internal `_`-prefixed field, and drops an empty `tools` array (502 upstream). All four models verified end-to-end through `/v1/chat/completions`.

# v0.6.225 (2026-10-23)

## Updates & New Features
- **ADCode / Tagflow AI Provider (native, bring-your-own-account)**: New `adcode` provider (alias `adc`) exposing `heabsy-glm53-flash-unc`, `heabsy-qwen38`, `heabsy-mimo-v26-flash` and `tagflow-code-27b` through the unified OpenAI surface. Credentials are your own Firebase refresh token; the executor mints and silently refreshes idTokens via `securetoken.googleapis.com`. No account is ever created for you.
- **Go Core v0.0.2**: version bump across `internal/config`, `package.json` and the CLI launcher, plus the dashboard release badge.
- **Changelog & Update Bell**: the "Upstream" tab now reads the real upstream feed (decolua/9router) instead of echoing this repo's own changelog, and the update check reads `CHANGELOG.md` instead of `README.md` so release notes actually reach the notification bell.

# v0.6.221 (2026-10-22)

## Updates & Bug Fixes
- **NoTrack Smart Context Squeezer**: Implement dynamic prompt & context folding in `NoTrackExecutor` that preserves the active user query and system prompt while compressing large intermediate turns to permanently stay within NoTrack's 4,000 character limit (eliminating HTTP 400 `user_input too long`).

# v0.6.220 (2026-10-22)

## Updates & Bug Fixes
- **Cloudflare Tunnel Reliability**: Fix healthcheck freeze and 60000ms timeout on Windows and Indonesian ISP networks by removing blocking UDP DNS queries (1.1.1.1:53), adding dual-endpoint verification (`trycloudflare.com` || `abc-tunnel.us`), and preventing infinite kill-respawn loops.

# v0.6.219 (2026-10-22)

## Updates & New Features
- **NoTrack AI Provider with Tool Bridge**: Added zero-auth privacy-first NoTrack AI provider with automatic session provisioning and full Tool Translation Bridge for native agentic tool calling on `notrack/notrack` and `notrack/chatgpt`.

# v0.6.218 (2026-10-22)

## Updates & Security Sanitization
- **UI Sanitization**: Removed internal key derivation and CRC hints from Voucher modal (`vouchers/page.js`) to protect proprietary key generation architecture.
- **Update Checker Isolation**: Perfectly isolated Go and JS/NPM update notification tracks.

# v0.6.217 (2026-10-22)

## Updates & Bug Fixes
- **Global NPM Package Auth Guard**: Bundle `open-sse/`, `jose`, `bcryptjs`, and `uuid` alongside `src/shared` and `src/lib` in `xrouter-ai` CLI bundle with enhanced module resolution hooks to permanently eliminate `{"error":"Auth guard unavailable"}` on clean environments (Windows 11, macOS, Linux).

# v0.6.216 (2026-10-22)

## Updates & New Providers
- **OpenSatan Provider**: Zero-auth uncensored provider integrating `gemma-4-26b-a4b-it-uncensored-abliterix-mlx-int5-affine` with Satan and Genie personas.
- **Update Checker & Notification Bell**: Point update inspection to public repository `johsua092-ui/xrouter` and NPM registry (`xrouter-ai`) so commit and release alerts reliably pop up on the header bell icon.

# v0.6.215 (2026-10-22)

## Updates & Contributors
- **Community & Contributors**: Official acknowledgement and appreciation for core contributors Bayu (BvsshXyz) and Naub (naummi).
- **Packaging & Polish**: Updated global npm metadata and documentation assets.

# v0.6.214 (2026-10-22)

## Updates & Bug Fixes
- **CLI Package Packaging**: Include complete `src/shared` and `src/lib` folders alongside `scripts/auth-guard-hooks.mjs` and built-in `NextResponse` fallback shim to fix `Auth guard unavailable` on all platforms (Windows, Linux, macOS) for `npm install -g xrouter-ai`.

# v0.6.212 (2026-10-22)

## Updates & Bug Fixes
- **CLI Package Packaging**: Include `scripts/` (`auth-guard-hooks.mjs`) and `src/dashboardGuard.js` in published npm package to fix `Auth guard unavailable` on `npm install -g xrouter-ai`.

# v0.6.211 (2026-10-22)

## Updates & Bug Fixes
- **Models & Catalogs**: Add Meta Muse Wonder 1.0 flagship and official Duck.ai 2026 models (GPT-6 Luna, Claude Haiku 4.5, Mistral Small 4, Gemma 4 31B).
- **Multi-Turn Bypass Hook**: Dual-anchor injection into both system and latest user turn to prevent multi-turn jailbreak decay.
- **TLS Security (PR #5095)**: Verify TLS certificates by default with log-safe origin masking.
- **Thinking Formats (PR #5105)**: Support nested reasoning format for OpenCode Go and Meta Muse responses endpoints.
- **CodeBuddy Intl Backoff (PR #5102)**: Exponential cooldown backoff for blocked CBAI connections.
- **Universal Non-Streaming Translator (PR #5094)**: Automatically translate non-streaming responses into the requesting client's format.
- **Model Cap (Issue #5097)**: Adjust OpenCode deepseek-v4.1-flash-free contextWindow to 327K to avoid Cloudflare 400 rejection.
- **Next.js 16 Compatibility**: Move proxy logic to dedicated `src/lib/mimoReverseProxy.js` to avoid Next.js 16 `middleware` vs `proxy` build errors.

# v0.6.208 (2026-10-21) · Connection Menu & Telegram Bot Full Control Integration

## New Features

### Connection Menu & Telegram Bot Controller
Added a dedicated **Connection** menu in the dashboard navigation (`/dashboard/connection`) for integrating external controllers and automated pipelines:
- **Telegram Bot Configuration**:
  - Encrypted credential storage for Telegram Bot Token at rest using machine-bound AES-256-GCM.
  - Authorized Admin User ID / Chat ID filter to ensure only the designated user can issue full control commands.
  - One-click **Test Connection** with real-time verification against Telegram's `getMe` API, surfacing live bot `@username`, name, and bot ID.
  - Auto-derived webhook endpoint (`/api/connection/telegram/webhook`).
- **Bot Engine & Command Bridge for @zphyrinee**:
  - REST command dispatcher endpoint (`/api/connection/telegram/command`) supporting token-authenticated executions.
  - Built-in command suite:
    - `/status`: Real-time system telemetry, uptime, memory, active connections, and proxy pool count.
    - `/providers`: Live breakdown of active vs total provider connections.
    - `/pools`: Health matrix of proxy pools (live vs dead/failed).
    - `/prune`: Immediate cleanup of dead proxy pools.
    - `/ping`: Heartbeat latency probe.
    - `/help`: Detailed command reference.
  - Integrated live command simulator inside the dashboard for testing bot responses.
  - Full webhook receiver handling incoming messages and auto-replying with formatted Markdown.

# v0.6.207 (2026-10-21) · Clean Custom API Key Creation UI & Max Digits Display

## Enhancements

### Custom API Key Modal — Simplified Mode Labels & Max Digits Guidance
Cleaned up the custom key input modal on the Endpoint page:
- Removed technical internal cryptographic details (`{keyId}-{crc8}`, etc.).
- Clearly surfaced concise max digit information for both modes:
  - **Mode Encrypt**: Max 19 digit input (total output key 35 digit).
  - **Mode Non-Encrypt**: Max 35 digit input (length matches input 1-35 digit).

# v0.6.206 (2026-10-21) · Fix 500 ReferenceError touchAffinity in Conversation Cache Affinity

## Bug Fixes

### Cache Affinity — ReferenceError: touchAffinity is not defined
When a conversation performed its second turn on any multi-account provider (e.g. `cbai/deepseek-v4.1-flash`), Cache-Aware Conversation Affinity detected a warm KV-cache match and attempted to stick to the same account. However, `touchAffinity` was missing from the import list in `src/sse/services/auth.js`, causing Node to throw `ReferenceError: touchAffinity is not defined` resulting in a hard `HTTP 500: Error code: 500` response from the second turn onward.
Fix: imported `touchAffinity` properly from `./conversationAffinity.js` and removed unused legacy imports.

# v0.6.205 (2026-10-20) · Aggressive Proxy Rotation, Anti-Collision Harvester, Mid-Stream Error Propagation & Antigravity 5h Quota

## New Features & Enhancements

### Aggressive Proxy Pool Rotation for Free Providers
Fixed an issue where a rejected proxy on OpenCode or other no-auth free providers would prematurely abort proxy rotation and fall back directly to the server's public IP address (which is immediately rejected with `403 FreeTierError` on datacenter IPs).
- When proxy pool rotation or an active pool is configured for OpenCode, failure on any single proxy immediately rotates aggressively to the next eligible active proxy in the pool across all candidates.
- If all proxies in the pool are exhausted, it fails cleanly with an error instead of leaking or burning the server's direct IP.
- When proxy rotation is turned off (`__none__`), direct VPS connection is used as normal.

### Egress IP Anti-Collision Deduplication on Proxy Harvest
Cloudflare WARP and free residential proxies often share the same public egress IP across multiple exit nodes, causing proxy pools to share a single upstream rate limit bucket.
- Proxy harvester test now automatically parses Cloudflare `cdn-cgi/trace` to extract the real public `ip` and country `loc`.
- Prevents importing duplicate proxies that exit through the same public IP as existing pool members, guaranteeing distinct rate-limit quota buckets.
- Automatically tags harvested proxies with their country code (e.g. `FreeProxy-...-[US]`).

### Antigravity Pro Tier 5-Hour Gemini Rolling Quota
Google Cloud Code API only returns weekly bucket summaries for Gemini on Pro / Standard tier accounts.
- Added automatic synthesis of the 5-hour rolling session window (`gemini_session`) from available models when upstream only provides the weekly bucket, matching the behavior of the Antigravity Desktop IDE.
- Supported alternate `response.groups` payload shapes in `parseWeeklyQuotaSummary`.

### Hardened OpenCode Free Gates (403/426 Mitigation)
- Updated OpenCode canonical User-Agent to `opencode/latest/2.0.32/cli` and adjusted version acceptance threshold to `>= 1.18` to prevent upstream `426 Upgrade Required`.
- Added developer context framing to prevent bare requests without system messages from being flagged as automated scraper probes.

## Bug Fixes

### Mid-Stream Upstream Failure Signal (OmniRoute #17292)
When an upstream SSE connection dropped mid-response (socket hang up, ECONNRESET, proxy reset) after initial chunks were forwarded, `createDisconnectAwareStream` previously called `controller.close()`, causing client coding agents (Cursor, Cline, Claude Code) to perceive a clean end-of-stream on a truncated 200 response and skip auto-retry.
Fix: If the client is still connected when an unexpected mid-stream abort occurs, propagate the failure via `controller.error(error)` so client agents accurately detect the truncated stream and trigger automatic retries.

### Fast Proxy Timeout & HTTP 524 Cloudflare Quarantine
When a proxy in the pool was dead or hanging on connection, Undici `ProxyAgent` had no connect timeout, causing requests to stall for up to 100+ seconds until Cloudflare returned `HTTP 524 (A timeout occurred)`. Furthermore, `proxyFetch` silently fell back to direct VPS fetch on proxy errors, bypassing the pool rotation loop.
Fix:
- Added strict 10s connect timeout and 20s headers timeout to `ProxyAgent`.
- Proxies returning HTTP 524, 502, 504, or connect timeouts are now automatically quarantined for 15 minutes.
- When proxy pool or OpenCode is used, proxy errors throw immediately so `chat.js` rotates to the next available proxy in the pool rather than falling back to direct server IP.

# v0.6.203 (2026-10-20) · Fix JB Rules Breach S4 not saved on Create + Auxiliary Title Gen 429

## Bug Fixes

### JB Rules — Breach S4 / normalizeTriggers not persisted on Create
The POST handler in `src/app/api/model-bypass/route.js` forgot to forward `normalizeTriggers` from the request body into `createPromptInjection()`. The DB function defaulted it to `false`, so even when the user checked "Trigger-Word Sanitizer (Breach S4)" the checkbox appeared unchecked after saving and required a manual Edit → re-check to activate.

Fix: added `normalizeTriggers: body.normalizeTriggers === true` to the `createPromptInjection` call. The UPDATE path already passed it correctly — only CREATE was missing it.

### Auxiliary Title Generation 429 FreeUsageLimitError (OpenCode)
`auxiliary.title_generation.provider` was set to `auto`, which resolved to the same OpenCode provider used for the main conversation and hit the free-tier rate limit immediately after each response.

Fix: set `auxiliary.title_generation.provider = dis` (the default provider) so title generation uses the default routing path, not the OpenCode free-tier pool.

