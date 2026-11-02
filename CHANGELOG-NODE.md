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

