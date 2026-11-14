# v0.1.0 (2026-11-14)

### Fixed — ZCode plan gateway: stable device identity, complete fingerprint

- **The plan gateway rejected turns with 405 code 3012 "unusual activity" because the
  caller's identity drifted.** The device mid was re-derived from a hash on every
  request instead of living on the connection, so the gateway saw a new device each
  turn. Login now mints a device id and a session seed once, stores them on the
  connection, and every later turn and usage read reuses them. Re-linking an account
  looks the existing row up by email/UUID and carries the same identity forward rather
  than registering a second device.
- **Session ids were scoped to the connection id only, so the absent-seed fallback was
  identical across accounts.** Sessions are now keyed through `HMAC(sessionSeed,
  connection)` — stable for one account, distinct between accounts.
- **`anthropic-version` and `anthropic-beta` were deleted from every request.** Both are
  part of the client identity bundle the gateway fingerprints, so dropping them
  mismatched the profile and produced the 405/3012 answer. Both are now declared
  explicitly on every lane, with the desktop client's SDK user agent rather than a bare
  `ZCode/<ver>` string.
- **App version was declared inconsistently across surfaces** — the chat executor and
  the start-plan usage read said `3.16.3` while the claim handshake said `3.17.1` and
  the plan resolver said `3.17.2`, so the gateway saw three different clients. All
  fingerprint constants now live in one module (`open-sse/config/zcodeIdentity.js`):
  start-plan lane `3.16.3`, coding-plan/usage lane `3.17.2`.
- **The claim sweep fell back to a hardcoded device mid** for every connection. It now
  uses the identity stored on the connection, so the handshake matches the chat turns.

### Fixed — Tunnel toggle: state now reflects the live process, not a build-time snapshot

- **The enable/disable buttons were no-ops.** Only the `status` probe had opted out of
  static optimisation; the six other tunnel routes (`enable`, `disable`,
  `tailscale-enable`, `tailscale-disable`, `tailscale-check`, `tailscale-install`) were
  still being evaluated at build time, so their POST answers were frozen into a `.body`
  payload. Clicking the toggle hit that snapshot and `enableTunnel()` never ran. All
  seven routes are now force-dynamic.
- **The toggle flipped back to OFFLINE on reload.** `isCloudflaredRunning()` treated a
  missing or stale PID file as "process is dead" and returned without ever checking the
  process table. After a server restart or when the data dir was swapped, a live
  cloudflared was reported dead, so `getTunnelStatus().enabled` was `false` while the
  tunnel was up. The PID file is now a fast path only: the probe falls back to scanning
  for a cloudflared quick-tunnel process and reclaims the file.
- **Enable took ~24 s to answer.** The route waited for a 15 s post-spawn health probe
  plus an 8 s DNS warmup before responding — long past the point the browser gave up, so
  the button appeared to do nothing. The probe is capped at 6 s, the warmup wait is gone,
  and monitoring starts in the background.
- **Duplicate cloudflared processes.** Because the process probe answered `false` with a
  stale PID file, the connectivity watchdog believed the tunnel was down every ~15 s and
  restarted it, stacking a second quick tunnel that raced the first for `state.json`.
  With the probe fixed the watchdog sees the live process and stands down; the manager
  also refuses to double-spawn when a process is up but state was lost.
- **The status poll was gated on the flag it exists to correct.** The dashboard polled
  only while it already believed the tunnel was enabled, so a single wrong read stayed
  wrong until a manual reload. It now polls unconditionally.

### Fixed — Antigravity: account fingerprint was one IDE generation behind

- Spoofed client version was `2.24.0` (macOS arm64) while the Antigravity desktop
  product has shipped `2.32.1` with a much newer language server. The IDE-version
  string and the `antigravity/hub/<ver> <os>/<arch>` user-agent are now sourced
  from a single constant (`open-sse/providers/shared.js`) and bumped to `2.32.1`.
- The OAuth config (`src/lib/oauth/constants/oauth.js`) now imports the version and
  user-agent instead of duplicating literals, so the token-exchange request and
  the runtime request headers can no longer drift apart.
- `ANTIGRAVITY_CHROME_VERSION` added so the `X-Goog-Api-Client` header matches the
  Electron/Chromium engine that the real hub reports.

### Added — Antigravity: persist `cloudaicompanionProject` + `tierId` from the OAuth exchange

- `mapTokens` in `src/lib/oauth/providers/antigravity.js` now resolves and stores
  `projectId` and `tierId` into `providerSpecificData` on the freshly created
  connection, so a brand-new account does not need to launch the Antigravity
  desktop app once just to obtain its provisioned project.
- `src/sse/handlers/chat.js` backfills `projectId`/`tierId` from
  `providerSpecificData` when a refreshed credential arrives without them, and
  promotes them onto the connection's top level fields the executors read.

### Fixed — Bulk add: connections could silently target `api.openai.com`

- Reported symptom: adding a batch of keys produced connections that all failed
  with `401` against OpenAI instead of the intended upstream.
- Root cause: `bulkCreateProviderConnections()` persisted
  `providerSpecificData: entry.providerSpecificData || {}` verbatim, and the
  executor resolved the URL as
  `credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE`, with
  `OPENAI_COMPAT_BASE` pointing at `https://api.openai.com/v1`. Any bulk entry
  that arrived without a per-entry `baseUrl` therefore sent its non-OpenAI key
  straight to OpenAI.
- Two-layer fix. First, `bulkCreateProviderConnections()` now inherits `baseUrl`
  from the owning provider node (new helper `resolveNodeBaseUrl(db, provider)` in
  `src/lib/db/repos/connectionsRepo.js`; the node id is the connection's
  `provider` value, verified against the live DB). Second, `BaseExecutor` gained
  `compatFallbackBaseUrl(credentials)`, wired into the `openai-compatible-*` and
  `anthropic-compatible-*` branches of `buildUrl` in both
  `open-sse/executors/base.js` and `open-sse/executors/default.js`, so
  pre-existing connections with an empty `providerSpecificData` fall back to a
  configured base URL instead of the OpenAI default.

### Fixed — MITM: stale Antigravity model mapping

- Ported the functional part of the upstream `/dashboard/mitm` update: the
  Antigravity `MODEL_SYNONYMS` / `MODEL_PATTERNS` in `src/mitm/config.js` now
  resolve `gemini-default` to `gemini-3.8-flash-medium` and recognise the
  Gemini 3.6 and Claude 5.5 model families. The remaining upstream differences
  were cosmetic (brand rename, hardcoded colors) and were not ported.

### Fixed — Build could not complete: obfuscated `dynamic` export in share route

- `bun --bun next build` aborted with a Turbopack "can't recognize the exported"
  error from `src/app/api/keys/[id]/share/route.js`, which had been replaced by a
  large obfuscated body that expressed `dynamic` as a call expression.
- Restored the literal `export const dynamic = "force-dynamic";` line. No logic
  changes were made to that file. The build now completes.

# v0.1.0 (2026-11-14)

### Fixed — Tunnel toggle frozen by a build-time snapshot of `/api/tunnel/status`

- Root cause: `GET /api/tunnel/status` took no request argument and read no dynamic
  API, so Next.js statically optimised it during `next build` and emitted a
  `status.body` payload containing the tunnel state captured at build time. The
  server kept answering from that frozen body, which is why the dashboard button
  never changed when the tunnel state changed and why a page refresh snapped the
  switch back to "off".
- The route now opts out of static optimisation (`dynamic = "force-dynamic"`,
  `revalidate = 0`, `fetchCache = "force-no-store"`), so every request probes the
  live process and `state.json` instead of replaying the build snapshot.
- Verified end to end against the running server: enable → status reports the new
  URL, disable → `running:false` and cloudflared reaped, re-enable → reports the
  new URL again.

### Fixed — Tunnel status stuck at "off" while cloudflared was running

- Root cause: `GET /api/tunnel/status` served tunnel/tailscale probes from a
  process-lifetime cache (`global.__tunnelStatusCache`). On a long-lived server the
  cached probe was written *before* the tunnel was enabled, so the dashboard never
  saw the state change: `settingsEnabled:false`, `running:false`, empty `tunnelUrl`
  — even though `cloudflared` was up, `settings.tunnelEnabled` was `true`, and
  `state.json` held a valid `shortId`/`tunnelUrl`.
- The route now probes `getTunnelStatus()` / `getTailscaleStatus()` on every request
  and the short-lived cache was removed. Download progress was already live.
- `getTunnelStatus()` no longer trusts a lone `settings.tunnelEnabled` read: a
  present `state.json` `shortId` is treated as evidence the tunnel is up too, so a
  settings read that lands mid-write (or on a stale adapter handle) cannot flip the
  toggle back off.
- Verified on the running server: enable → `enabled:true, running:true` with a live
  public URL; the toggle now tracks enable/disable immediately. Versions unchanged
  (main `0.1.0`).

# v0.1.0 (2026-11-13)

### Fixed — MiniMax Code: "this device code can no longer be exchanged" after a successful login

- Root cause: the `/device-code` leg sends a PKCE S256 challenge for MiniMax Code,
  but the `/poll` leg still listed both MiniMax providers in `noPkceProviders` and
  passed `null` as the verifier. MiniMax binds the granted device code to the
  challenge, so the first exchange failed on a PKCE mismatch — and because an OAuth
  device code is single-use, the failed attempt burned it. The user saw
  "Connection Failed / this device code can no longer be exchanged" *after*
  finishing the browser login, which made it look like the login had failed.
- `minimax-code` and `minimax-code-global` are removed from `noPkceProviders` so
  they fall through to the PKCE branch and forward `codeVerifier`.
- That branch now also forwards `extraData`; MiniMax still needs
  `extraData._minimaxPollByUser` to select `user_code` over `device_code`.
- Verified against account.minimax.io: device code is issued, then polled with the
  verifier and returns `authorization_pending` (accepted, awaiting user) instead of
  a burned code. Other `noPkceProviders` members are device-code flows without
  PKCE and are unaffected.


### Fixed — MiniMax Code: opaque "fetch failed" replaced with a diagnosable error

- `minimax-code` / `minimax-code-global` surfaced transport failures as a bare
  `fetch failed`, which the OAuth modal rendered as "Connection Failed" with no
  hint of the endpoint that died. The China site (`account.minimax.cn`, Aliyun
  Beijing) is unroutable from several regions while the international site
  (`account.minimax.io`) resolves fine, so the two flows were indistinguishable
  to the user.
- `postForm` now wraps `fetch` and raises `MiniMax Code could not reach <host>
  (fetch failed): <UND_ERR_CAUSE>. This is a network/egress problem, not a
  credential problem — ...`, naming the host and the underlying undici cause.
- Behaviour on a reachable host is unchanged; verified against
  `account.minimax.cn` (CONNECT_TIMEOUT, now reported by name) and
  `account.minimax.io` (HTTP 200, device code issued).


## MiniMax Code sign-in failed with "requires a PKCE code challenge":
- **Fixed**: the device-code route exempted MiniMax from PKCE and passed
  `codeChallenge: undefined`, but the shared provider's device-code request
  carries PKCE S256 and hard-throws without a challenge. Both ids were moved
  off the no-PKCE device list so they receive `authData.codeChallenge` again.

## MiniMax Code could not be signed into at all: the sign-in modal never reached its device-code branch

The MiniMax Code providers (both the China site and the international one) shipped with a full OAuth implementation — a PKCE S256 device flow against `account.minimax.cn` / `account.minimax.io`, registered in the provider table and covered by unit tests — but the dashboard's sign-in modal did not know they existed. Three separate lists in the sign-in path each had to name a provider before any of that code could run, and none of them named MiniMax.

The sign-in modal keeps its own list of providers that use the device-code flow, and a provider missing from that list falls through to the authorization-code path instead. MiniMax's `/authorize` correctly returns `authUrl: null` (it has no redirect to offer — the flow hands the user a code to type in), and the modal's guard against opening a null URL then refuses with "uses device-code login but is not wired in the OAuth modal device-code list". The sign-in never started. Registering MiniMax in the device-code list is what makes the code that was already written actually reachable.

Two matching gaps sat behind it on the server, both of which would have surfaced only after the modal could get that far. The poll endpoint forwards per-provider state to the provider's token call, which MiniMax needs for its user-code variant: MiniMax's China site sometimes answers the initial device-code request without a `device_code` at all, and its variant polls the token endpoint with the `user_code` in that slot instead. The provider implementation switches on a flag returned from the device-code response, and the modal has to carry that flag back into the poll body for the switch to see it — neither the flag nor the poll branch existed. The poll endpoint also classified MiniMax in its PKCE group, which sends no per-provider state and demands a code verifier; MiniMax's user-code variant has no verifier to send, so it belongs in the non-PKCE group with the other device-code providers.

Fixed: added both MiniMax providers to the modal's device-code list, to the device-code request list and to the poll's non-PKCE list, and taught the modal to carry the poll-by-user flag into the poll body. Both the China and international sites are covered. Version held at 0.1.0.

## Deploy Relay menu: the Cloudflare item lost its click, and Deploy Worker gave no feedback

Two defects in the relay deploy path on the proxy-pools dashboard.

The first is the menu item itself. Every `<Button>` rendered a bare `<button>`
with no `type`, so inside a `<form>` it defaulted to `type="submit"` — the
browser's implicit submit behaviour, not a click handler. The relay menu sits
where an enclosing form is present, and the Cloudflare entry is the first item
in it, so its click was being consumed by an accidental submit instead of
`openCloudflareModal()`.

`Button` now pins `type="button"` unless the caller passes one. All sixteen
`<Button type="submit">` call sites keep submitting, because an explicit type
still wins. This is the correct default for a UI kit: a button is a UI
affordance until it is told otherwise.

The second defect is the modal's own action. `Deploy Worker` toggled
`deploying` but never rendered that state, so the button looked identical
before, during and after the request — the same dead-button impression even on
a successful deploy, and no indication that a slow Worker upload was still in
flight. It now takes `loading={deploying}`, which reuses the spinner and
disable path every other long-running action in the app already uses.

Reported against the proxy-pools relay menu; neither defect is specific to
Cloudflare — any relay deploy from that menu runs through the same `Button`.

## A stale database no longer blocks table writes

`CREATE TABLE IF NOT EXISTS` never rebuilds a table that already exists, and
the schema sync was additive-only: it added columns the new layout declares but
never touched columns the new layout dropped. A database created by an older
build therefore kept its old columns forever.

That is fatal when the orphan column is `NOT NULL` without a default. Every
INSERT that omits it fails with `NOT NULL constraint failed: <table>.<col>`.
The visible symptom was Cloudflare relay deployment and proxy-pool creation:

    Error deploying Cloudflare relay: SqliteError: NOT NULL constraint failed:
    proxyPools.url

`proxyPools` moved to a JSON `data` blob long ago, so current code writes
`(id, isActive, testStatus, data, createdAt, updatedAt)`. Any install that
still carried the legacy `url NOT NULL` column rejected every one of those
writes. A fresh database never shows it, which is why it only surfaced on
upgrades.

The schema sync is now bidirectional. After adding missing columns it also
scans for orphan columns that would block a write — undeclared, `NOT NULL`,
and without a default — and removes them. `ALTER TABLE ... DROP COLUMN` is the
cheap path; when two orphans share a table, or an index/trigger still points at
the column, the table is rebuilt from the declared columns and the rows are
copied across. Nullable or defaulted orphans are left alone: they are harmless
and dropping them would discard data for no reason. Declared columns always
keep their values.

Verified against a database carrying `proxyPools.url NOT NULL` and a legacy
row: the column is dropped, the row survives, and Cloudflare relay creation
succeeds. A healthy database is untouched — same columns, same row count.

## A shadowed reserved prefix falls through to its built-in

A provider node whose prefix collides with a built-in provider id or alias
(`oc`, `openai`, `anthropic`, `google`, `cf`, …) used to break the built-in
route. The resolver skipped the node-lookup block entirely for reserved
prefixes, so no node on `oc` could ever be reached; a node registered under a
reserved prefix by an older layout still won the lookup and turned
`oc/<model>` into a hard `404 No credentials are serving …`. Either way the
built-in provider never saw the request.

The node lookup now always runs, and a node that shadows a reserved prefix only
wins when it holds an active connection. A node with no credentialed
connection is skipped so the reserved built-in keeps the route. A node whose
connections cannot be read preserves the previous behaviour, so a database
hiccup cannot silently reroute traffic.

This restores the three-way behaviour for reserved prefixes:

- node with credentials → node wins, as before;
- node without credentials → built-in takes over, no 404;
- plain `npm start` with the bridge withdrawn → the built-in provider serves
  `oc/<model>` unchanged, because the bridge is a dispatch concern and is not
  registered as a node.

`getProviderConnections` is now imported by the resolver to make that decision.

# v0.1.0 (2026-11-13)

- **Panel Endpoint No Longer Freezes or Resets the Tunnel Badge**:
  - The endpoint page polled tunnel status only while the badge was still unhealthy — the interval returned early the moment both cloudflare and tailscale looked reachable. A tunnel that came up on its own therefore never re-probed, and the badge sat on `CONNECTING`/`OFFLINE` until a manual hard-refresh, at which point a single failed browser ping flipped it straight back to "dead" while `cloudflared` was demonstrably running.
  - Both pollers (`syncTunnelStatus` and the reachability watchdog) now keep a slow heartbeat when healthy (`STATUS_POLL_SLOW_MS` 30s, `CLIENT_PING_SLOW_MS` 60s) instead of stopping, so the badge both recovers and demotes without a reload.
  - The reachability check now treats the backend PID probe as the authority: `updateReachable` takes the server's `running` flag and *adds* it to whatever the browser ping observed. Client reachability can only raise confidence — a failing ping from this network (CORS, CSP, DNS hiccup, dead shortlink worker) can no longer demote a live process.
  - The enable flow reads `status.tunnel.running === false` rather than the absence of `enabled`, so an existing live tunnel is not reported as a failure, and after the enable request the frontend falls back to `/api/tunnel/status` when the new URL cannot be verified from the browser.

- **The Auth Guard No Longer Answers 503 for Every Route**:
  - `src/lib/db/repos/connectionsRepo.js` imported the credential vault as `../../vault/credentialVault.js` — that escaped the `src/lib` tree and re-entered it, so the loader's `@/` alias never saw it and Node failed the whole guard import chain with `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`. Because `custom-server.js` deliberately fails closed, the result was `{"error":"Auth guard unavailable"}` (503) on every path — dashboard, `/api/auth/session`, `/api/tunnel/status` — which is also why the page appeared frozen.
  - The escaping specifier is gone: `connectionsRepo.js`, `promptInjectionRepo.js` and `src/sse/services/backgroundTokenRefresh.js` now use the `@/lib/...` alias the hooks understand. The guard loads, unauthenticated callers get a real `401`/`307`, and the 503 is gone.
  - Verified by registering the guard hooks in a bare Node process and importing `src/dashboardGuard.js`: `isAuthenticated`, `isLocalRequest`, `proxy` all resolve; after restart `/api/tunnel/status` returns `401`, `/dashboard/endpoint` returns `307`, and no `[AuthGuard] load failed` line appears in the journal.

- **Every Model Listing Now Respects the Caller's Allowlist**:
  - `src/app/api/v1beta/models` — the Gemini-shaped list — validated the API key but never consulted *what that key may call*, and enumerated `PROVIDER_MODELS` for every caller. A team locked to a single model could therefore read the whole catalogue through this endpoint: a live key allowed four models received `1422` of `1423` entries, 97 of them `glm*`. That is where a restricted team key was seeing every `glm` variant.
  - The endpoint now resolves the caller's allowed-model patterns — the per-key list, or the team-wide list when the key is a team key — and drops every entry the key would be refused at request time. This is the same rule `/v1/models` already applied, so the two lists finally agree.
  - `src/app/api/v1/models/info` returned metadata for any known id, including ids the caller may not call, so it stood beside the filtered `/v1/models/{id}` as an existence oracle. It now answers `404 Model not found` for those, identically to the other route.
  - The caller's key and patterns are read in one place now, `src/sse/services/callerAllowlist.js`, so the four listing surfaces (`/v1/models`, `/v1/models/{kind}`, `/v1/models/info`, `/v1beta/models`) cannot drift apart again.
  - Verified by running the routes against a copy of the production database: a team key allowed `glm-5.3` went from `1422` leaked of `1423` to `0` leaked of `10`, an unrestricted key still receives all `1423`, `/v1/models` output is unchanged, and `/v1/models/info?id=alicode/glm-5` now returns `404` for that key.


- **A Shadowed Reserved Prefix Can No Longer Dead-End the Route (Fixes `404` on `oc/*`)**:
  - A provider node registered by the operator under a prefix that collides with a reserved built-in provider id or alias (`oc` is the alias of the built-in `opencode` provider) used to win model resolution unconditionally, because resolution deliberately lets an explicitly registered node outrank the built-in it shadows. When that node carried no credentialed connection it still won the lookup and then had nothing to serve the request with, so the router answered `404 No credentials are serving oc/<model> right now` and the model became unreachable — while the built-in `opencode` provider, free and `noAuth`, sat right behind it fully able to serve the call.
  - The resolver in `src/sse/services/model.js` now verifies, before honouring a node that shadows a *reserved* prefix, that the node actually holds an active connection. A node with connections wins exactly as before; a shadowing node with none is skipped and resolution falls through to the reserved built-in provider that can serve the request.
  - Nodes registered under a non-reserved prefix are untouched — they still win outright, credentials or not, so operator-defined routing keeps its meaning.
  - This is the durable half of the fix. Renaming the offending node prefix in the database cleared the symptom on one box, but the failure comes straight back the moment the database is reset or restored, a colliding node is created again, or a second deployment ships with the same prefix. The guard removes that entire class of dead routes at the source.
  - Verified against the live router: `oc/*` free models resolve and serve, an unknown model on a shadowed reserved prefix reaches upstream instead of dead-ending at `404`, and a genuinely unknown provider prefix still returns `404` as a control.
  - `npm run build` (Next 14.2.35) completes with exit 0 and every route compiled.

- **Provider Rows Stop Opening Credentials Just to Be Listed**:
  - `src/lib/db/repos/connectionsRepo.js` exposed its `apiKey`, `accessToken` and `refreshToken` accessors as *enumerable*, so the `{ ...connection }` spread used by the providers listing invoked every accessor and opened every stored credential the moment the dashboard loaded — one expensive operation per row, plus a console line for any value the current host cannot open. Reviewing or editing one key was enough to trigger the whole batch.
  - The accessors are now non-enumerable and resolved on first actual read. A spread carries no credential at all, and a failed read is memoised — one throttled warning per session instead of a stack trace per row per poll.
  - A connection object now also carries the stored value in a hidden field, so a credential this host cannot open survives a later write instead of being overwritten with `null`.
  - Verified on a copy of the 829-connection production database: spreading a connection carries none of the three credential fields, all 829 rows still load, and a status-only update leaves every credential byte-identical.
- **Connection Updates Can No Longer Drop a Credential**:
  - Because the accessors were excluded from enumeration, the spread-and-merge in `updateProviderConnection`, `createProviderConnection` and `bulkCreateProviderConnections` was rewritten to collect the three credential fields explicitly: a value the caller supplied is sealed as before, a value that cannot be opened here is preserved verbatim, and only an explicit `null`/empty from the caller clears it.
  - `cleanupProviderConnections` and any other routine that deletes unset fields can no longer erase an unreadable credential either.
  - A GLM / Z.ai connection whose sealed access token cannot be opened now falls back to the plaintext business token the OAuth exchange already stored (`zaiBusinessToken` / `zcodeJwtToken`), so those accounts recover without a re-authorization round trip.
- **Usage API Answers Instead of Throwing for Inactive Connections**:
  - `src/app/api/usage/[connectionId]/route.js` attempted an OAuth refresh for every connection the dashboard polled. An inactive connection with no usable token threw `Failed to refresh credentials. Please re-authorize the connection.` and the handler dumped the whole stack trace to stdout once per poll.
  - Inactive connections now return `{ plan: "None", quotas: {}, message: "Connection is inactive" }` before any network work, a connection with neither refresh nor access token returns a clean `401`, and a genuine refresh failure logs one concise `warn` line — and still falls through to the usage lookup when an access token is available.
- **Local Dashboard Keeps Its Port on Redirect**:
  - `src/dashboardGuard.js` strips the internal node ports (`8080`, `20128`) from redirect targets so they never leak onto a public domain — but it stripped them for loopback too, sending a browser on `http://localhost:20128` to port 80 and producing `ERR_CONNECTION_REFUSED` with nothing listening there.
  - The port is now preserved when the *final* hostname is loopback (`localhost`, `127.0.0.0/8`, `[::1]`, `0.0.0.0`, `*.localhost`), including IPv6 host headers. A `PUBLIC_BASE_URL` / `BASE_URL` override still resolves to the public hostname, so no internal port reaches a public redirect.
- **Stored Credentials Are Read With the Persisted Machine Identity**:
  - `src/lib/vault/credentialVault.js` derived its key from `node-machine-id` directly, while the rest of the app persists and reads that identity at `DATA_DIR/machine-id`. The two agree only while the file was created by the same call on the same host — a database restored from another host, or a runtime where the file and the call disagree, leaves every stored value unreadable.
  - The vault now reads `DATA_DIR/machine-id` first and falls back to `node-machine-id`, and accepts an explicit pinned key through `VAULT_MASTER_KEY` / `CREDENTIAL_VAULT_KEY` for a deployment whose data directory moved hosts.
  - A value that cannot be authenticated now returns `null` instead of the raw ciphertext, which used to travel into upstream `Authorization: Bearer` headers and render as a plausible credential in the UI.
  - `src/sse/services/backgroundTokenRefresh.js` skips a refresh token that is still unreadable, instead of burning an upstream call and logging a failure every five minutes.
- **Verification for this group**: run against a throwaway copy of the production database (829 connections) with the app's own repository and vault modules loaded — credentials survive a status-only update, values stay sealed at rest, an unreadable value resolves to `null` and is preserved byte-for-byte through a write, and the 236 sealed fields in the copy still open. `npm run build` on this host is still pending; deploy not run yet.


# v0.1.0 (2026-11-09)

- **OpenCode Daemon Service Mode Reaches the Local Daemon Again**:
  - Two defects in `open-sse/services/opencodeServiceBridge.js` kept the `opencode serve` daemon path dead, so every request fell through to the TLS HTTP transport even when a daemon was running and reachable.
  - **Readiness never settled.** `buildOpenCodeServiceEnv()` never set `OPENCODE_SERVER_PASSWORD`, and the startup parser waits on both the listening URL *and* the `server password <x>` line before it marks the worker ready. An unset password means the daemon boots unsecured, the password line never appears, and the readiness match never resolves. The env builder now generates a `base64url` password when none is supplied and reuses the same value for the auth header.
  - **Prompt payload used the wrong key.** Both prompt call sites (`OpenCodeServiceSession.prompt` and the streaming `executeServiceStreamOnce`) sent `{ text, files, delivery }`. The daemon's `POST /api/session/{id}/prompt` requires a literal `prompt` string; the old shape was rejected with `400 InvalidRequestError: Missing key at ["prompt"]`. Both call sites now send `prompt`.
  - The daemon path is also addressable without depending on the startup log parser: point `OPENCODE_SERVICE_FILE` at a small JSON state file holding `{ url, password }` and the bridge adopts that endpoint directly.
  - Regression-checked: `oc/*` still resolves to the registered local node and reaches the bridge; other prefixes (`enb/*`, `tb/*`, `cf/*`, `hf/*`) are unaffected. No behaviour change for deployments that never configured a service daemon.
- **Locally Registered Provider Nodes Now Win Over Reserved Prefixes**:
  - `src/sse/services/model.js` skipped its provider-node lookup entirely when the requested prefix was in `RESERVED_PROVIDER_PREFIXES`, so a node the operator registered under a reserved name could never be reached — the request was forced onto the built-in provider instead. For `oc`, that meant the built-in OpenCode executor (a Node.js process) had to satisfy a transport gate that only accepts a Bun TLS ClientHello, so every `oc/*` call failed with `429 Free usage limit reached` while the same request through the local Bun bridge returned `200`.
  - The lookup now runs unconditionally. A node that exists wins — the operator asked for that route by name — and when no node matches, resolution falls through to the built-in provider id/alias unchanged. Reserved ids with no registered node behave exactly as before.
  - Verified against the live router: all **12** `oc/*` free models return `200` through `:20128` (`glm-5.3-flash-free`, `mimo-v2.6-flash-free`, `deepseek-v4.1-flash-free`, `big-pickle`, `nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free`, `minimax-m3.1-flash-free`, `longcat-2.5-free`, `iceman-free`, `inkling-2-small-free`, `beam-free`, `flint-40b-free`). Regression-checked `enb/*` (custom node, `200`), `tb/*` (`200`), and `cf/*` / `hf/*` (still routed to their built-in providers — upstream answered `410`/`404`, which is the upstream's own response, not a routing failure).
- **Providers Addressed by ID Resolve Their Default Model (Fixes Every Codex Model Failing)**:
  - The model tables in `open-sse/config/providerModels.js` are keyed by a provider's short alias, because `open-sse/providers/index.js` builds them as `entry.alias || entry.id`. Any provider that declares an alias therefore has no entry under its own canonical id: `codex` lives at `cx`, `claude` at `cc`, `github` at `gh`, and so on.
  - `getProviderModels()` / `getDefaultModel()` looked the key up verbatim, so a caller passing the canonical id got an empty list and a `null` default model. The callers do pass the canonical id — the dashboard test/validate path takes it straight off the route param (`/dashboard/providers/[id]` → `ConnectionsCard` providerId → POST `body.provider`), and `normalizeProviderId()` returns it unchanged because it is already a valid provider entry.
  - The probe therefore went upstream with `model: null`, the upstream answered `400`, and the connection was persisted as `unavailable`. It read as a dead account, not a dead lookup. **Every aliased provider was affected; OpenAI Codex surfaced it most visibly — all of its models failed.**
  - Both spellings now resolve through the `PROVIDER_ID_TO_ALIAS` map that already shipped in the same module, so `codex` and `cx` return the same list. Nothing changes for a provider with no alias, and a provider with no model table at all still returns an empty list, exactly as before.
  - Verified against the live registry before and after: **114 of 114** providers that own a model table now resolve a default model (was 84, with 30 returning `null`). Re-checked every aliased id individually — `codex`, `claude`, `github`, `kiro`, `qoder`, `antigravity`, `gemini-cli`, `windsurf` — plus the short-alias callers (`cx`, `cc`, `gh`), which are byte-for-byte unchanged. `cline` (`cl`) and `qoder` (`qd`) recovered by the same fix rather than by separate work.
  - Also stopped hardcoding the Codex credential probe's model. The test path sent `gpt-5.3-codex` with `acceptStatuses: [400]`, betting that the upstream would reject the *body* while accepting the credential — but that model id is not in the Codex list, so the upstream rejected it for the model, and a healthy account looked like a dead one. The probe now takes the registry default model, so it stays valid as the model list moves.
  - Note: the upstream `checkFallbackError` path already declines to lock an account on a bare `400` (client mistake, not credential fault) and the Codex-specific rule matches on the model-not-supported *text*, so no account was permanently disabled by this — they were marked unavailable and are re-tested from the dashboard once the service picks up the change.

- **Config Now Speaks the Installed Framework's Dialect (Fixes the Windows Build Failure)**:
  - `next.config.mjs` declared Next 15/16 keys at the top level while the server runs Next 14. Next 14 flagged six of them as `Invalid next.config.mjs options detected` and — the part that actually hurt — silently ignored `outputFileTracingRoot` and `outputFileTracingExcludes`. With no explicit tracing root, Next 14 infers one, and on Windows it walked into the user profile where the legacy `Application Data` junction points back at itself: `EPERM: operation not permitted, scandir 'C:\Users\...\Application Data'` → unhandled rejection → the build died before writing anything. The excludes written to avoid exactly that walk (`**/AppData/Local/**/*`) never applied, because on this version they do not belong at the top level.
  - Keys are now emitted for the framework that is actually installed: Next 14 gets `experimental.outputFileTracingRoot` / `outputFileTracingExcludes` / `serverComponentsExternalPackages`; Next 15+ gets the top-level `outputFileTracingRoot` / `outputFileTracingExcludes` / `serverExternalPackages` / `turbopack`; and the old `experimental.` spellings are dropped where the framework has moved past them.
  - Verified against both installed versions: Next 14.2.35 builds `168/168` pages and Next 16.4.6 builds `166/166`, both exit 0 with **zero** `Invalid next.config` warnings (previously six keys flagged on 14, one on 16). The Linux verification built into a separate dist directory, so the running service's `.next` was never touched.
  - Noted and not fixed here: `experimental.proxyClientMaxBodySize` does not exist on Next 14, so the 128 MB body limit for `/v1` rewrites has never taken effect on this line. It applies once the Next 16 migration lands.
- **Build Directory Is Now Configurable End to End (`NEXT_DIST_DIR`)**:
  - `custom-server.js` hardcoded `.next` when looking for the standalone server, so a build produced into any other directory could never be launched.
  - `scripts/copy-standalone-assets.mjs` read `NEXT_DIST_DIR` from the process environment only. `npm run build` does not load `.env`, so a dist dir pinned there was silently ignored by the postbuild hook and assets were copied to the wrong place. Resolution is now explicit argument → environment → `.env` → `.next`.
  - Verified: all three resolution cases (from `.env`, from the environment, explicit argument winning) plus a real launch — `NEXT_DIST_DIR=probe-dist node custom-server.js` loaded `<repo>/probe-dist/standalone/server.js`. With no variable set the behaviour is unchanged (`.next`).
  - This is the enabler for upgrading safely: a second build can now sit beside the one the running service uses, and be verified before anything is switched over.
- **Rotate an API Key From the API (Secret Swap Without Losing Access)**:
  - New `POST /api/keys/[id]/rotate` mints a fresh secret for an existing key and keeps its id, name, `isActive` and access config — a leaked or shared key can be swapped without rebuilding its restrictions by hand. `rotateApiKey()` sits with the other key repositories and uses the server's own machine id, so a legacy `sk-{random}` key also upgrades to the current `sk-{machineId}-{keyId}-{crc8}` shape as it rotates.
  - The response uses the same flat shape as `POST /api/keys` (the object carries the new secret in `key`), so a client that created a key does not have to special-case this endpoint.
  - Rename already existed in this fork — `PUT /api/keys/[id]` accepted `name` with duplicate detection — and its validation now runs through the same shared `keyName` helper as create, which adds the 100-character cap.
  - Verified live on a throwaway key: secret changed; id, name, `allowedModels` and `isActive` preserved; the old secret is rejected with **401**; the new secret is accepted with **200**. Probe keys were deleted afterwards (9 keys remain, none of them test keys).
  - The upstream PR also shipped dashboard UI for rename + rotate. That is not ported here because this fork's `EndpointPageClient` has since diverged (anti-abuse work); the endpoint is fully usable over the API in the meantime.
- **Image Generation Now Honours the Proxy Configuration**:
  - The image pipeline ignored proxies entirely: unlike `chatCore`, `imageGenerationCore` never read `connectionProxyEnabled` / `connectionProxyUrl` / `vercelRelayUrl` / `connectionProxyPoolId`, so every image request left on the host's own address while chat traffic was tunnelled. It now resolves the same `proxyOptions` shape chat uses, logs the same `[PROXY]` line, and routes through `proxyAwareFetch`.
  - Covered: the main request and the post-refresh retry, `refreshCredentials`, `urlToBase64` (image-URL providers plus both base64 fallbacks), the adapter `parseResponse` bag, and the executor-delegating adapters. The polling loops in `blackForestLabs`, `falAi`, `nanobanana` and `runwayml` poll through the proxy too, and the Antigravity adapter forwards `proxyOptions` into the executor along with its own 401/403 refresh-and-retry.
  - Verified in-process with a dead proxy (`http://127.0.0.1:1`): without one there is no proxy log and the call goes direct; with one the line `[PROXY] BLACK-FOREST-LABS | probe-model | conn=unknown | pool=none | url=http://127.0.0.1:1` appears and `proxyAwareFetch` attempts the hop. Live image request still answers 200 with a real image.
  - Note: as with chat, a failed proxy falls back to a direct connection unless `strictProxy` is set — unchanged semantics, now applied to image traffic as well.
- **Expose Reasoning Levels on `/v1/models` and Write Effort Variants for OpenCode**:
  - `/v1/models` now publishes `thinking_levels` — the same selectable set the dashboard picker uses — so a client can build its effort selector straight from the gateway instead of keeping a per-model table of its own. The field is omitted entirely for a model with no reasoning.
  - **Live: 505 of 674 models now carry it (was 0).** e.g. `ag/gemini-4-argon-high → ["low","medium","high"]`, `cc/claude-opus-5-5 → ["low","medium","high","xhigh","max"]`, `oc/glm-5.3-flash-free → ["minimal","low","medium","high","xhigh"]`.
  - `POST /api/cli-tools/opencode-settings` now writes opencode `variants` (`{level: {reasoningEffort: level}}`) per model, derived from those same levels, resolving the `alias/model` form through `ALIAS_TO_ID` / `PROVIDER_ID_TO_ALIAS`. Variants the user has already tuned are preserved — generated only when absent.
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
