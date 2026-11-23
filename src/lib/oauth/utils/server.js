import http from "http";
import crypto from "crypto";
import { URL } from "url";
import { CODEX_CONFIG, TRAE_CONFIG, WINDSURF_CONFIG, ZED_HOSTED_CONFIG } from "../constants/oauth.js";
import {
  AWS_QUICK_CONFIG,
  buildSigninUrl as buildAwsQuickSigninUrl,
  buildAuthorizeUrl as buildAwsQuickAuthorizeUrl,
  registerAwsQuickClient as registerAwsQuickOidcClient,
  completeAwsQuickExchange as completeAwsQuickOidcExchange,
  parsePastedQuery as parseAwsQuickPastedQuery,
  discoveryOfQuery as awsQuickDiscoveryOfQuery,
} from "../providers/aws-quick.js";

// Loopback origin guard for local callback proxies.
// Legit OAuth redirects are top-level navigations (no `Origin` header); a cross-site
// page issuing `fetch(..., {mode:"no-cors"})` to scan + hit 127.0.0.1 always sends
// `Origin: https://attacker`. Reject any non-loopback Origin to block login-CSRF.
function isLoopbackOrigin(origin) {
  if (!origin) return true; // navigation redirect — allow
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}


/**
 * Start a local HTTP server to receive OAuth callback
 * @param {Function} onCallback - Called with query params when callback received
 * @param {number} fixedPort - Optional fixed port number (default: random)
 * @returns {Promise<{server: http.Server, port: number, close: Function}>}
 */
export function startLocalServer(onCallback, fixedPort = null) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);

      if (url.pathname === "/callback" || url.pathname === "/auth/callback") {
        const params = Object.fromEntries(url.searchParams);

        // Send success response to browser with auto-close attempt
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authentication Successful</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .success { color: #22c55e; font-size: 3rem; }
    h1 { margin: 1rem 0; }
    p { color: #666; }
    #countdown { font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <div class="success">&#10003;</div>
    <h1>Authentication Successful</h1>
    <p id="message">Closing in <span id="countdown">3</span> seconds...</p>
  </div>
  <script>
    let count = 3;
    const countdown = document.getElementById("countdown");
    const message = document.getElementById("message");
    const timer = setInterval(() => {
      count--;
      countdown.textContent = count;
      if (count <= 0) {
        clearInterval(timer);
        window.close();
        setTimeout(() => {
          message.textContent = "Please close this tab manually.";
        }, 500);
      }
    }, 1000);
  </script>
</body>
</html>`);

        // Call callback with params
        onCallback(params);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    // Listen on fixed port or find available port
    const portToUse = fixedPort || 0;
    server.listen(portToUse, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        close: () => server.close(),
      });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && fixedPort) {
        reject(new Error(`Port ${fixedPort} is already in use. Please close other applications using this port.`));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Wait for callback with timeout
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Object>} - Callback params
 */
export function waitForCallback(timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Authentication timeout"));
      }
    }, timeoutMs);

    const onCallback = (params) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(params);
      }
    };

    // Return the callback function
    resolve.__onCallback = onCallback;
  });
}

// Singleton proxy server for Codex OAuth callback on fixed port
let codexProxyServer = null;
let codexProxyTimeout = null;

const CODEX_PROXY_TIMEOUT_MS = 300000; // 5 minutes
const CODEX_PORT = CODEX_CONFIG.fixedPort;

// Pending exchange sessions keyed by state — used by server-side exchange mode
const pendingExchanges = new Map();

/**
 * Register a pending exchange session for server-side mode.
 * Modal client calls this before opening popup.
 */
export function registerCodexSession({ state, codeVerifier, redirectUri }) {
  if (!state || !codeVerifier || !redirectUri) return false;
  pendingExchanges.set(state, {
    codeVerifier,
    redirectUri,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

/**
 * Read session status (modal polls this).
 */
export function getCodexSessionStatus(state) {
  return pendingExchanges.get(state) || null;
}

/**
 * Clear a session (called after modal consumes status).
 */
export function clearCodexSession(state) {
  pendingExchanges.delete(state);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderCodexResultPage(success, message) {
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "&#10003;" : "&#10007;";
  const title = success ? "Authentication Successful" : "Authentication Failed";
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}.c{text-align:center;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1)}.i{color:${color};font-size:3rem}h1{margin:1rem 0}p{color:#666}</style>
</head><body><div class="c"><div class="i">${icon}</div><h1>${title}</h1><p>${safeMessage}</p><p>Closing in <span id="cd">3</span>s...</p>
<script>let n=3;const c=document.getElementById("cd");const t=setInterval(()=>{n--;c.textContent=n;if(n<=0){clearInterval(t);window.close();}},1000);</script>
</div></body></html>`;
}

/**
 * Start Codex proxy on fixed port 1455.
 * Mode A (server-side): if any session was registered, proxy auto-exchanges + saves DB.
 * Mode B (channel fallback): if no session, proxy 302 redirects to app port for legacy channel-based flow.
 */
export function startCodexProxy(appPort) {
  return new Promise((resolve) => {
    if (codexProxyServer) {
      resolve({ success: true });
      return;
    }

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");

      if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      const session = state ? pendingExchanges.get(state) : null;

      // Mode A: server-side exchange (session registered)
      if (session) {
        try {
          if (errorParam) {
            throw new Error(url.searchParams.get("error_description") || errorParam);
          }
          if (!code) throw new Error("No authorization code received");

          // Lazy import to avoid circular deps
          const { exchangeTokens } = await import("../providers.js");
          const { createProviderConnection } = await import("@/models");

          const tokenData = await exchangeTokens(
            "codex",
            code,
            session.redirectUri,
            session.codeVerifier,
            state
          );
          const connection = await createProviderConnection({
            provider: "codex",
            authType: "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          });

          session.status = "done";
          session.connectionId = connection.id;
          session.email = connection.email;

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(true, "You can close this window."));
        } catch (err) {
          session.status = "error";
          session.error = err.message;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, err.message));
        } finally {
          stopCodexProxy();
        }
        return;
      }

      // Mode B: legacy channel fallback — 302 redirect to app /callback
      const redirectUrl = `http://localhost:${appPort}/callback${url.search}`;
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      stopCodexProxy();
    });

    server.listen(CODEX_PORT, "127.0.0.1", () => {
      codexProxyServer = server;
      codexProxyTimeout = setTimeout(() => stopCodexProxy(), CODEX_PROXY_TIMEOUT_MS);
      resolve({ success: true });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve({ success: false, reason: "port_busy" });
      } else {
        resolve({ success: false, reason: err.message });
      }
    });
  });
}

/**
 * Stop the Codex proxy server and cleanup
 */
export function stopCodexProxy() {
  if (codexProxyTimeout) {
    clearTimeout(codexProxyTimeout);
    codexProxyTimeout = null;
  }
  if (codexProxyServer) {
    codexProxyServer.close();
    codexProxyServer = null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// xAI fixed-port proxy on 127.0.0.1:56121
// Same shape as the Codex proxy. Kept as a parallel implementation rather than
// generalizing the Codex one to keep the codex hot-path byte-equivalent.
// ───────────────────────────────────────────────────────────────────────────

let xaiProxyServer = null;
let xaiProxyTimeout = null;
const XAI_PROXY_TIMEOUT_MS = 300000; // 5 minutes
const XAI_PROXY_PORT = 56121;
const xaiPendingExchanges = new Map();

export function registerXaiSession({ state, codeVerifier, redirectUri }) {
  if (!state || !codeVerifier || !redirectUri) return false;
  xaiPendingExchanges.set(state, {
    codeVerifier,
    redirectUri,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

export function getXaiSessionStatus(state) {
  return xaiPendingExchanges.get(state) || null;
}

export function clearXaiSession(state) {
  xaiPendingExchanges.delete(state);
}

function renderXaiResultPage(success, message) {
  return renderCodexResultPage(success, message);
}

/**
 * Start xAI proxy on fixed port 56121.
 * Mode A (server-side): if any session was registered, proxy auto-exchanges + saves DB.
 * Mode B (channel fallback): if no session, proxy 302 redirects to app port.
 */
export function startXaiProxy(appPort) {
  return new Promise((resolve) => {
    if (xaiProxyServer) {
      resolve({ success: true });
      return;
    }

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      const session = state ? xaiPendingExchanges.get(state) : null;

      // Mode A: server-side exchange
      if (session) {
        try {
          if (errorParam) {
            throw new Error(url.searchParams.get("error_description") || errorParam);
          }
          if (!code) throw new Error("No authorization code received");

          const { exchangeTokens } = await import("../providers.js");
          const { createProviderConnection } = await import("@/models");

          const tokenData = await exchangeTokens(
            "xai",
            code,
            session.redirectUri,
            session.codeVerifier,
            state
          );
          const connection = await createProviderConnection({
            provider: "xai",
            authType: "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          });

          session.status = "done";
          session.connectionId = connection.id;
          session.email = connection.email;

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderXaiResultPage(true, "You can close this window."));
        } catch (err) {
          session.status = "error";
          session.error = err.message;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderXaiResultPage(false, err.message));
        } finally {
          stopXaiProxy();
        }
        return;
      }

      // Mode B: legacy fallback redirect
      const redirectUrl = `http://localhost:${appPort}/callback${url.search}`;
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      stopXaiProxy();
    });

    server.listen(XAI_PROXY_PORT, "127.0.0.1", () => {
      xaiProxyServer = server;
      xaiProxyTimeout = setTimeout(() => stopXaiProxy(), XAI_PROXY_TIMEOUT_MS);
      resolve({ success: true });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve({ success: false, reason: "port_busy" });
      } else {
        resolve({ success: false, reason: err.message });
      }
    });
  });
}

export function stopXaiProxy() {
  if (xaiProxyTimeout) {
    clearTimeout(xaiProxyTimeout);
    xaiProxyTimeout = null;
  }
  if (xaiProxyServer) {
    xaiProxyServer.close();
    xaiProxyServer = null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Trae dynamic-port proxy. Singleton session (one connect at a time per provider).
// Callback path = /callback with params refreshToken + loginHost.
// ───────────────────────────────────────────────────────────────────────────

let traeProxyServer = null;
let traeProxyTimeout = null;
let traeProxyPort = null;
let traeSession = null;

export function registerTraeSession({ state }) {
  if (!state) return false;
  traeSession = { state, status: "pending", createdAt: Date.now() };
  return true;
}
export function getTraeSessionStatus(state) {
  if (!traeSession) return null;
  if (state && traeSession.state !== state) return null;
  return traeSession;
}
export function clearTraeSession(state) {
  if (!state || (traeSession && traeSession.state === state)) traeSession = null;
}

export function startTraeProxy() {
  return new Promise((resolve) => {
    if (traeProxyServer) {
      resolve({ success: true, port: traeProxyPort, callbackUrl: `http://127.0.0.1:${traeProxyPort}${TRAE_CONFIG.callbackPath}` });
      return;
    }
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== TRAE_CONFIG.callbackPath && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const session = traeSession;
      if (!session) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Trae login session"));
        return;
      }
      // Anti-CSRF: reject cross-origin fetches (legit redirects send no Origin),
      // and reject state mismatch when state is present.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      const cbState = url.searchParams.get("state");
      if (cbState && session.state && cbState !== session.state) {
        session.status = "error";
        session.error = "Trae callback state mismatch";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, session.error));
        stopTraeProxy();
        return;
      }
      // Pass the raw callback query to exchangeTokens → parseTraeCallback
      const rawCallback = `${url.pathname}?${url.searchParams.toString()}`;
      try {
        const { exchangeTokens } = await import("../providers.js");
        const { createProviderConnection } = await import("@/models");
        const tokenData = await exchangeTokens("trae", rawCallback);
        const connection = await createProviderConnection({
          provider: "trae",
          authType: "oauth",
          ...tokenData,
          expiresAt: tokenData.expiresIn
            ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
            : null,
          testStatus: "active",
        });
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
      } catch (err) {
        session.status = "error";
        session.error = err.message;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, err.message));
      } finally {
        stopTraeProxy();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      traeProxyServer = server;
      traeProxyPort = server.address().port;
      traeProxyTimeout = setTimeout(() => stopTraeProxy(), TRAE_CONFIG.oauthTimeoutMs);
      resolve({ success: true, port: traeProxyPort, callbackUrl: `http://127.0.0.1:${traeProxyPort}${TRAE_CONFIG.callbackPath}` });
    });
    server.on("error", (err) => resolve({ success: false, reason: err.message }));
  });
}

export function stopTraeProxy() {
  if (traeProxyTimeout) { clearTimeout(traeProxyTimeout); traeProxyTimeout = null; }
  if (traeProxyServer) { traeProxyServer.close(); traeProxyServer = null; }
  traeProxyPort = null;
}

// ───────────────────────────────────────────────────────────────────────────
// Windsurf dynamic-port proxy. Singleton session.
// Callback path = /windsurf-auth-callback with params access_token (firebase JWT) + state.
// ───────────────────────────────────────────────────────────────────────────

let windsurfProxyServer = null;
let windsurfProxyTimeout = null;
let windsurfProxyPort = null;
let windsurfSession = null;

export function registerWindsurfSession({ state }) {
  if (!state) return false;
  windsurfSession = { state, status: "pending", createdAt: Date.now() };
  return true;
}
export function getWindsurfSessionStatus(state) {
  if (!windsurfSession) return null;
  if (state && windsurfSession.state !== state) return null;
  return windsurfSession;
}
export function clearWindsurfSession(state) {
  if (!state || (windsurfSession && windsurfSession.state === state)) windsurfSession = null;
}

export function startWindsurfProxy() {
  return new Promise((resolve) => {
    if (windsurfProxyServer) {
      resolve({ success: true, port: windsurfProxyPort, callbackUrl: `http://127.0.0.1:${windsurfProxyPort}${WINDSURF_CONFIG.callbackPath}` });
      return;
    }
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== WINDSURF_CONFIG.callbackPath) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const session = windsurfSession;
      if (!session) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Windsurf login session"));
        return;
      }
      // Anti-CSRF: reject cross-origin fetches, and require state present + matching.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      const cbState = url.searchParams.get("state");
      if (!cbState || !session.state || cbState !== session.state) {
        session.status = "error";
        session.error = "Windsurf callback state mismatch";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, session.error));
        stopWindsurfProxy();
        return;
      }
      const rawCallback = `${url.pathname}?${url.searchParams.toString()}`;
      try {
        const { exchangeTokens } = await import("../providers.js");
        const { createProviderConnection } = await import("@/models");
        const tokenData = await exchangeTokens("windsurf", rawCallback, null, null, session.state);
        const connection = await createProviderConnection({
          provider: "windsurf",
          authType: "api_key",
          ...tokenData,
          testStatus: "active",
        });
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
      } catch (err) {
        session.status = "error";
        session.error = err.message;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, err.message));
      } finally {
        stopWindsurfProxy();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      windsurfProxyServer = server;
      windsurfProxyPort = server.address().port;
      windsurfProxyTimeout = setTimeout(() => stopWindsurfProxy(), WINDSURF_CONFIG.oauthTimeoutMs);
      resolve({ success: true, port: windsurfProxyPort, callbackUrl: `http://127.0.0.1:${windsurfProxyPort}${WINDSURF_CONFIG.callbackPath}` });
    });
    server.on("error", (err) => resolve({ success: false, reason: err.message }));
  });
}

export function stopWindsurfProxy() {
  if (windsurfProxyTimeout) { clearTimeout(windsurfProxyTimeout); windsurfProxyTimeout = null; }
  if (windsurfProxyServer) { windsurfProxyServer.close(); windsurfProxyServer = null; }
  windsurfProxyPort = null;
}

// ───────────────────────────────────────────────────────────────────────────
// Zed RSA native-app proxy. Singleton session.
// Callback: GET http://127.0.0.1:<port>/?user_id=...&access_token=<RSA-encrypted>
// The proxy decrypts the access token using the private key stored in session.codeVerifier.
// ───────────────────────────────────────────────────────────────────────────

let zedProxyServer = null;
let zedProxyTimeout = null;
let zedProxyPort = null;
let zedSession = null;

export function registerZedSession({ state, codeVerifier, systemId }) {
  if (!state || !codeVerifier) return false;
  zedSession = {
    state,
    codeVerifier,
    systemId: systemId || null,
    status: "pending",
    createdAt: Date.now(),
  };
  return true;
}
export function getZedSessionStatus(state) {
  if (!zedSession) return null;
  if (state && zedSession.state !== state) return null;
  return zedSession;
}
export function clearZedSession(state) {
  if (!state || (zedSession && zedSession.state === state)) zedSession = null;
}

export function startZedProxy(preferredPort = 0) {
  return new Promise((resolve) => {
    if (zedProxyServer) {
      // Reuse the live listener, but renew its idle timeout so a previous
      // flow's deadline can never kill the flow that just adopted the port.
      if (zedProxyTimeout) clearTimeout(zedProxyTimeout);
      zedProxyTimeout = setTimeout(() => { console.log("[Zed proxy] timeout, stopping"); stopZedProxy(); }, ZED_HOSTED_CONFIG.oauthTimeoutMs);
      resolve({ success: true, port: zedProxyPort, callbackUrl: `http://127.0.0.1:${zedProxyPort}/` });
      return;
    }
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      // Log path + redacted params (access_token is the RSA-encrypted credential).
      const redacted = Object.fromEntries(url.searchParams);
      for (const k of ["access_token", "user_id", "code_verifier", "state"]) {
        if (redacted[k]) redacted[k] = "<redacted>";
      }
      console.log("[Zed proxy]", req.method, url.pathname, JSON.stringify(redacted));
      if (url.pathname !== "/" && url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const session = zedSession;
      if (!session) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Zed login session"));
        return;
      }
      // Anti-CSRF: Zed tokens are RSA-encrypted to our keypair so they can't be
      // forged cross-site, but still reject cross-origin fetches for defense-in-depth.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      // A genuine Zed redirect always carries user_id + access_token. Anything
      // else (probe, prefetch, stray navigation, favicon-style miss) is NOT
      // the callback: answer without touching the session and WITHOUT
      // stopping the server, so the real redirect can still land afterwards.
      const qp = url.searchParams;
      const hasZedParams =
        qp.has("user_id") || qp.has("userId") ||
        qp.has("access_token") || qp.has("accessToken") || qp.has("token");
      if (!hasZedParams) {
        console.log(`[Zed proxy] ignoring non-callback ${req.method} ${url.pathname} (session kept, server kept)`);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Waiting for Zed sign-in — this request carried no login data."));
        return;
      }
      // Pass raw callback path+query to exchangeTokens → parseZedCallbackPayload.
      // codeVerifier carries the encoded RSA private key for decryption.
      const rawCallback = url.search ? `${url.pathname}?${url.searchParams.toString()}` : url.pathname;
      try {
        const { exchangeTokens } = await import("../providers.js");
        const { createProviderConnection } = await import("@/models");
        const tokenData = await exchangeTokens(
          "zed",
          rawCallback,
          null,
          session.codeVerifier,
          session.state,
          session.systemId ? { systemId: session.systemId } : undefined,
        );
        const connection = await createProviderConnection({
          provider: "zed",
          authType: "oauth",
          ...tokenData,
          testStatus: "active",
        });
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
        stopZedProxy();
      } catch (err) {
        session.status = "error";
        session.error = err.message;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, err.message));
        // Intentionally NOT stopping here: the failure may belong to a
        // superseded attempt (e.g. an older popup landing after "Try Again"
        // registered a new keypair). The live attempt's genuine callback must
        // still land. The idle timeout + modal close bound the listener.
      }
    });
    const tryPort = Number(preferredPort) || 0;
    server.on("error", (err) => {
      // If the preferred port (e.g. 58443) is busy, fall back to a random port.
      if (err.code === "EADDRINUSE" && tryPort !== 0) {
        console.log(`[Zed proxy] port ${tryPort} busy, falling back to random`);
        server.listen(0, "127.0.0.1", () => {
          zedProxyServer = server;
          zedProxyPort = server.address().port;
          zedProxyTimeout = setTimeout(() => stopZedProxy(), ZED_HOSTED_CONFIG.oauthTimeoutMs);
          console.log(`[Zed proxy] listening on random port ${zedProxyPort}`);
          resolve({ success: true, port: zedProxyPort, callbackUrl: `http://127.0.0.1:${zedProxyPort}/` });
        });
      } else {
        console.log(`[Zed proxy] listen error: ${err.message}`);
        resolve({ success: false, reason: err.message });
      }
    });
    server.listen(tryPort, "127.0.0.1", () => {
      zedProxyServer = server;
      zedProxyPort = server.address().port;
      zedProxyTimeout = setTimeout(() => { console.log("[Zed proxy] timeout, stopping"); stopZedProxy(); }, ZED_HOSTED_CONFIG.oauthTimeoutMs);
      console.log(`[Zed proxy] listening on port ${zedProxyPort}`);
      resolve({ success: true, port: zedProxyPort, callbackUrl: `http://127.0.0.1:${zedProxyPort}/` });
    });
  });
}

export function stopZedProxy() {
  console.log(`[Zed proxy] stopping (port ${zedProxyPort || "-"})`);
  if (zedProxyTimeout) { clearTimeout(zedProxyTimeout); zedProxyTimeout = null; }
  if (zedProxyServer) { zedProxyServer.close(); zedProxyServer = null; }
  zedProxyPort = null;
}

// ───────────────────────────────────────────────────────────────────────────
// Xiaomi MiMo Desktop OAuth callback proxy
// Receives the ECDH-encrypted `u` param, decrypts it, stores the session.
// ───────────────────────────────────────────────────────────────────────────

let xiaomiMimoProxyServer = null;
let xiaomiMimoProxyPort = null;
let xiaomiMimoProxyTimeout = null;

const xiaomiMimoSessions = new Map();

export function registerXiaomiMimoSession({ state, privateKeyDer }) {
  if (!state || !privateKeyDer) return false;
  xiaomiMimoSessions.set(state, {
    privateKeyDer,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

export function getXiaomiMimoSessionStatus(state) {
  const s = xiaomiMimoSessions.get(state);
  if (!s) return null;
  // Don't leak the private key to the client
  return { status: s.status, result: s.result || null, error: s.error || null };
}

export function clearXiaomiMimoSession(state) {
  xiaomiMimoSessions.delete(state);
}

function renderXiaomiMimoResultPage(success, message) {
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "&#10003;" : "&#10007;";
  const title = success ? "Authentication Successful" : "Authentication Failed";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
  .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
  .icon { color: ${color}; font-size: 3rem; }
  h1 { margin: 1rem 0; font-size: 1.25rem; }
  p { color: #666; font-size: 0.875rem; }
</style>
</head>
<body>
  <div class="container">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message || (success ? "You can close this tab and return to X Router." : "Please try again.")}</p>
    ${success ? "<script>setTimeout(() => window.close(), 3000);</script>" : ""}
  </div>
</body>
</html>`;
}

/**
 * Start the Xiaomi Desktop OAuth callback proxy.
 * @returns {Promise<{success: boolean, port?: number, callbackUrl?: string, reason?: string}>}
 */
export function startXiaomiMimoProxy() {
  return new Promise((resolve) => {
    if (xiaomiMimoProxyServer) {
      resolve({
        success: true,
        port: xiaomiMimoProxyPort,
        callbackUrl: `http://127.0.0.1:${xiaomiMimoProxyPort}/`,
      });
      return;
    }

    const server = http.createServer(async (req, res) => {
      // Origin guard
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const url = new URL(req.url, "http://127.0.0.1");
      const u = url.searchParams.get("u");

      if (!u) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderXiaomiMimoResultPage(false, "Missing encrypted payload (u parameter)."));
        return;
      }

      // Try each pending session's private key — the callback URL carries no
      // state param, so we attempt decryption with every pending key.
      const pendingSessions = [...xiaomiMimoSessions.entries()]
        .filter(([, s]) => s.status === "pending");

      if (pendingSessions.length === 0) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderXiaomiMimoResultPage(false, "No active OAuth session. Please restart the login flow."));
        return;
      }

      try {
        const { decryptCallback } = await import("../providers/xiaomi-mimo.js");
        let result = null;
        let matchedState = null;

        for (const [state, session] of pendingSessions) {
          try {
            result = decryptCallback(session.privateKeyDer, u);
            matchedState = state;
            break;
          } catch {
            // Wrong key for this session — try next
          }
        }

        if (!result || !matchedState) {
          throw new Error("Could not decrypt with any pending session key");
        }

        if (!result.sk) {
          throw new Error("Decrypted payload missing sk (API key)");
        }

        // Store result only in the matched session
        const session = xiaomiMimoSessions.get(matchedState);
        if (session) {
          session.status = "done";
          session.result = {
            uid: result.uid,
            accessToken: result.sk,
            baseUrl: result.url || "https://api.xiaomimimo.com/v1",
          };

          // Auto-save provider connection server-side (Zero Drama OAuth)
          try {
            const { createProviderConnection } = await import("@/models");
            let passToken = null;
            try {
              const { readDesktopPassToken } = await import("open-sse/shared/mimoAccount.js");
              passToken = await readDesktopPassToken();
            } catch {}

            await createProviderConnection({
              provider: "xiaomi-mimo",
              authType: "oauth",
              accessToken: result.sk,
              refreshToken: null,
              expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
              email: result.uid ? `${result.uid}@xiaomi` : null,
              displayName: result.uid ? `Xiaomi ${result.uid}` : "Xiaomi MiMo",
              providerSpecificData: {
                uid: result.uid || null,
                baseUrl: result.url || "https://api.xiaomimimo.com/v1",
                authMethod: "oauth",
                mimoPassToken: passToken?.passToken || null,
                mimoUserId: passToken?.userId || null,
                mimoCUserId: passToken?.cUserId || null,
              },
            });
          } catch (saveErr) {
            console.error("[xiaomi-mimo oauth] auto create connection failed:", saveErr.message);
          }
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderXiaomiMimoResultPage(true, "Xiaomi account linked. You can close this tab."));
        console.log("[xiaomi-mimo oauth] callback decrypted, uid:", result.uid);
      } catch (err) {
        console.error("[xiaomi-mimo oauth] decrypt failed:", err.message);
        for (const [, session] of pendingSessions) {
          session.status = "error";
          session.error = err.message;
        }
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderXiaomiMimoResultPage(false, `Decryption failed: ${err.message}`));
      }
    });

    server.on("error", (err) => {
      console.log("[xiaomi-mimo oauth] listen error:", err.message);
      resolve({ success: false, reason: err.message });
    });

    server.listen(0, "127.0.0.1", () => {
      xiaomiMimoProxyServer = server;
      xiaomiMimoProxyPort = server.address().port;
      xiaomiMimoProxyTimeout = setTimeout(() => {
        console.log("[xiaomi-mimo oauth] timeout, stopping");
        stopXiaomiMimoProxy();
      }, 300000);
      console.log(`[xiaomi-mimo oauth] listening on port ${xiaomiMimoProxyPort}`);
      resolve({
        success: true,
        port: xiaomiMimoProxyPort,
        callbackUrl: `http://127.0.0.1:${xiaomiMimoProxyPort}/`,
      });
    });
  });
}

export function stopXiaomiMimoProxy() {
  console.log(`[xiaomi-mimo oauth] stopping (port ${xiaomiMimoProxyPort || "-"})`);
  if (xiaomiMimoProxyTimeout) { clearTimeout(xiaomiMimoProxyTimeout); xiaomiMimoProxyTimeout = null; }
  if (xiaomiMimoProxyServer) { xiaomiMimoProxyServer.close(); xiaomiMimoProxyServer = null; }
  xiaomiMimoProxyPort = null;
  // No callback can arrive once the listener is down, so drop every pending
  // session — each holds an X25519 private key and they would otherwise
  // accumulate for the process lifetime (one per /authorize call).
  xiaomiMimoSessions.clear();
}

// ───────────────────────────────────────────────────────────────────────────
// Amazon Quick (aws-quick) two-hop loopback proxy. Singleton server, dynamic
// port (AWS OIDC public clients accept any loopback URI with an empty path).
//   Hop 1: GET /callback?nonce&issuerUrl&tenantUrl&idcRegion…  → validate
//          nonce → dynamic OIDC client registration → 302 authorize (PKCE)
//   Hop 2: GET /?code&state → validate state → PKCE exchange → user-info →
//          settle the session result (exchange endpoint creates the connection)
// Server + sessions live on globalThis so Next hot-reload neither duplicates
// the listener nor drops pending login sessions.
// ───────────────────────────────────────────────────────────────────────────

const awsQuickRuntime = (globalThis.__awsQuickOAuthRuntime ??= {
  server: null,
  timeout: null,
  port: null,
  sessions: new Map(), // state → session
});

function findAwsQuickSessionByNonce(nonce) {
  if (!nonce) return null;
  for (const session of awsQuickRuntime.sessions.values()) {
    if (session.nonce === nonce) return session;
  }
  return null;
}

function settleAwsQuickSession(session, { tokens, userInfo }) {
  session.status = "done";
  session.result = {
    tokens,
    clientId: session.clientId,
    clientSecret: session.clientSecret,
    discovery: { ...(session.discovery || {}) },
    tenantUrl: session.discovery?.tenant_url || "",
    userInfo,
    stage: session.stage,
  };
}

/**
 * Create (or adopt, on a paste-back retry) the login session for one attempt.
 * The nonce binds hop-1 to this attempt; the PKCE pair is generated here and
 * never leaves the server.
 */
export function registerAwsQuickSession({ state, port, redirectUri, stage, appVersion }) {
  if (!state || !port || !redirectUri) return false;
  const existing = awsQuickRuntime.sessions.get(state);
  if (existing) {
    // Retry attempt: keep nonce/verifier/discovery, refresh the callback port.
    existing.port = port;
    existing.redirectUri = redirectUri;
    return true;
  }
  const nonce = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  awsQuickRuntime.sessions.set(state, {
    state,
    nonce,
    verifier,
    challenge,
    port,
    redirectUri,
    stage: stage || "prod",
    appVersion: appVersion || null,
    discovery: null,
    discoverySavedAt: null,
    clientId: null,
    clientSecret: null,
    status: "pending",
    result: null,
    error: null,
    createdAt: Date.now(),
  });
  return true;
}

/**
 * Build the URL the popup/paste flow opens for this attempt. With fresh saved
 * discovery (paste-back retry) it registers the OIDC client and returns the
 * authorize URL directly, skipping the discovery hop (magpie parity).
 */
export async function resolveAwsQuickAuthorizeUrl({ state, redirectUri, stage, appVersion }) {
  const session = awsQuickRuntime.sessions.get(state);
  if (!session) throw new Error("No active Amazon Quick login session; restart the login flow");
  const port = session.port;
  const stage_ = stage || session.stage || "prod";
  const discoveryFresh =
    session.discovery &&
    session.discoverySavedAt &&
    Date.now() - session.discoverySavedAt <= (AWS_QUICK_CONFIG.discoveryMaxAgeMs);
  if (discoveryFresh) {
    // takeDiscovery semantics: the saved hop-1 fields are consumed by this attempt.
    session.discoverySavedAt = null;
    const client = await registerAwsQuickOidcClient({
      discovery: session.discovery,
      redirectUri: session.redirectUri,
      stage: stage_,
    });
    session.clientId = client.clientId;
    session.clientSecret = client.clientSecret;
    session.discovery.idc_region = client.idcRegion;
    const authorizeUrl = buildAwsQuickAuthorizeUrl({
      clientId: client.clientId,
      redirectUri: session.redirectUri,
      state,
      codeChallenge: session.challenge,
      idcRegion: client.idcRegion,
      stage: stage_,
    });
    return {
      state,
      // authUrl mirrors authorizeUrl: the shared proxy-flow modal opens
      // authData.authUrl, the aws-quick paste-retry path reads authorizeUrl.
      authUrl: authorizeUrl,
      authorizeUrl,
      redirectUri: session.redirectUri,
      codeVerifier: null, // PKCE verifier stays server-side (session-scoped)
      flowType: "authorization_code",
      discoverySkipped: true,
    };
  }

  const authorizeUrl = buildAwsQuickSigninUrl({ port, nonce: session.nonce, appVersion: appVersion || session.appVersion, stage: stage_ });
  return {
    state,
    authUrl: authorizeUrl, // shared proxy-flow modal opens authData.authUrl
    authorizeUrl,
    redirectUri: session.redirectUri,
    codeVerifier: null,
    flowType: "authorization_code",
    discoverySkipped: false,
  };
}

export function getAwsQuickSessionStatus(state) {
  const s = awsQuickRuntime.sessions.get(state);
  if (!s) return null;
  // Tokens/clientSecret stay server-side — the /exchange endpoint reads the
  // session directly; the client only needs status + error.
  return { status: s.status, error: s.error || null, discoverySaved: !!(s.discovery && s.discoverySavedAt) };
}

/** Raw session incl. the settled result — server-side use only (/exchange). */
export function getAwsQuickSessionResult(state) {
  const s = awsQuickRuntime.sessions.get(state);
  if (!s) return null;
  return { status: s.status, error: s.error || null, result: s.result || null };
}

export function clearAwsQuickSession(state) {
  awsQuickRuntime.sessions.delete(state);
}

/**
 * Paste-back fallback: finish (or pre-stage) a login from the final address of
 * a browser that could not reach this machine's 127.0.0.1 listener.
 *   /callback?nonce&issuerUrl&… (hop 1) → rememberDiscovery + ask to retry
 *   /?code&state                (hop 2) → complete the exchange, settle session
 * @returns {Promise<{status: "discovery-saved"|"done", state: string}>}
 */
export async function pasteAwsQuickUrl(pasted) {
  const pasteError = () =>
    Object.assign(
      new Error("Not a completed-login address. Paste the full URL from the browser address bar after Amazon Quick sign-in finishes."),
      { kind: "paste" }
    );
  const q = parseAwsQuickPastedQuery(pasted);
  if (!q) throw pasteError();

  if (q.has("nonce")) {
    // Hop 1 reached the browser but not our listener: keep the discovery
    // fields so the next attempt goes straight to the OIDC authorize URL.
    const session = findAwsQuickSessionByNonce(q.get("nonce"));
    if (!session) throw pasteError();
    if (q.get("error")) {
      throw new Error(`Login failed: ${q.get("error")} ${q.get("error_description") || ""}`.trim());
    }
    session.discovery = awsQuickDiscoveryOfQuery(q);
    session.discoverySavedAt = Date.now();
    if (!session.discovery.issuer_url) throw new Error("discovery callback did not provide issuerUrl");
    return { status: "discovery-saved", state: session.state };
  }

  if (q.has("code")) {
    const session = q.get("state") ? awsQuickRuntime.sessions.get(q.get("state")) : null;
    if (!session) throw pasteError();
    try {
      const { tokens, userInfo } = await completeAwsQuickOidcExchange({ query: q, session });
      settleAwsQuickSession(session, { tokens, userInfo });
    } catch (e) {
      if (e?.kind === "mismatch") throw pasteError();
      session.status = "error";
      session.error = e.message;
      throw e;
    }
    return { status: "done", state: session.state };
  }

  if (q.has("error")) {
    throw new Error(`Login failed: ${q.get("error")} ${q.get("error_description") || ""}`.trim());
  }
  throw pasteError();
}

/**
 * Start the aws-quick loopback proxy (dynamic port). Both hops are handled
 * in-server; the session is settled (not persisted) for /exchange to consume.
 */
export function startAwsQuickProxy() {
  return new Promise((resolve) => {
    if (awsQuickRuntime.server) {
      // Reuse the live listener, but renew its idle timeout (zed pattern).
      if (awsQuickRuntime.timeout) clearTimeout(awsQuickRuntime.timeout);
      awsQuickRuntime.timeout = setTimeout(() => { console.log("[aws-quick oauth] timeout, stopping"); stopAwsQuickProxy(); }, AWS_QUICK_CONFIG.oauthTimeoutMs);
      resolve({ success: true, port: awsQuickRuntime.port, callbackUrl: `http://127.0.0.1:${awsQuickRuntime.port}/` });
      return;
    }

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Hop 1: discovery callback — validate nonce, register client, 302 authorize.
      if (url.pathname === "/callback") {
        if (!isLoopbackOrigin(req.headers.origin)) {
          res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
          return;
        }
        const q = url.searchParams;
        const session = findAwsQuickSessionByNonce(q.get("nonce"));
        if (!session) {
          // Stale/foreign link — answer without touching any session and keep
          // the server alive so the real callback can still land.
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, "No active Amazon Quick login matches this link. Restart the login flow."));
          return;
        }
        try {
          if (q.get("error")) {
            throw new Error(`Login failed: ${q.get("error")} ${q.get("error_description") || ""}`.trim());
          }
          session.discovery = awsQuickDiscoveryOfQuery(q);
          if (!session.discovery.issuer_url) throw new Error("discovery callback did not provide issuerUrl");
          const client = await registerAwsQuickOidcClient({
            discovery: session.discovery,
            redirectUri: session.redirectUri,
            stage: session.stage,
          });
          session.clientId = client.clientId;
          session.clientSecret = client.clientSecret;
          session.discovery.idc_region = client.idcRegion;
          const location = buildAwsQuickAuthorizeUrl({
            clientId: client.clientId,
            redirectUri: session.redirectUri,
            state: session.state,
            codeChallenge: session.challenge,
            idcRegion: client.idcRegion,
            stage: session.stage,
          });
          res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
          res.end();
          console.log(`[aws-quick oauth] hop-1 discovery ok, redirecting to authorize (state ${session.state.slice(0, 8)}…)`);
        } catch (err) {
          session.status = "error";
          session.error = err.message;
          console.log("[aws-quick oauth] hop-1 failed:", err.message);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, err.message));
          stopAwsQuickProxy();
        }
        return;
      }

      // Hop 2: OIDC redirect lands on "/" (public-client redirect URIs have an
      // empty path). A bare "/" visit shows the waiting page.
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const q = url.searchParams;
        const isCallback = q.has("code") || q.has("state") || q.has("error");
        if (!isCallback) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, "Waiting for Amazon Quick sign-in — complete the login in the quick.aws.com tab."));
          return;
        }
        if (!isLoopbackOrigin(req.headers.origin)) {
          res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
          return;
        }
        const session = q.get("state") ? awsQuickRuntime.sessions.get(q.get("state")) : null;
        if (!session) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, "No active Amazon Quick login session"));
          return;
        }
        try {
          const { tokens, userInfo } = await completeAwsQuickOidcExchange({ query: q, session });
          settleAwsQuickSession(session, { tokens, userInfo });
          const who = userInfo.email || userInfo.display_name || userInfo.user_name || "";
          console.log(`[aws-quick oauth] hop-2 exchange ok${who ? ` (${who})` : ""}`);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(true, who ? `Signed in as ${who}. You can close this window.` : "You can close this window."));
          stopAwsQuickProxy();
        } catch (err) {
          if (err?.kind === "mismatch") {
            // Not this login's callback (stale link) — keep waiting (magpie parity).
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderCodexResultPage(false, err.message));
            return;
          }
          session.status = "error";
          session.error = err.message;
          console.log("[aws-quick oauth] hop-2 failed:", err.message);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, err.message));
          stopAwsQuickProxy();
        }
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.on("error", (err) => {
      console.log("[aws-quick oauth] listen error:", err.message);
      resolve({ success: false, reason: err.message });
    });

    server.listen(0, "127.0.0.1", () => {
      awsQuickRuntime.server = server;
      awsQuickRuntime.port = server.address().port;
      awsQuickRuntime.timeout = setTimeout(() => {
        console.log("[aws-quick oauth] timeout, stopping");
        stopAwsQuickProxy();
      }, AWS_QUICK_CONFIG.oauthTimeoutMs);
      console.log(`[aws-quick oauth] listening on port ${awsQuickRuntime.port}`);
      resolve({
        success: true,
        port: awsQuickRuntime.port,
        callbackUrl: `http://127.0.0.1:${awsQuickRuntime.port}/`,
      });
    });
  });
}

export function stopAwsQuickProxy() {
  console.log(`[aws-quick oauth] stopping (port ${awsQuickRuntime.port || "-"})`);
  if (awsQuickRuntime.timeout) { clearTimeout(awsQuickRuntime.timeout); awsQuickRuntime.timeout = null; }
  if (awsQuickRuntime.server) { awsQuickRuntime.server.close(); awsQuickRuntime.server = null; }
  awsQuickRuntime.port = null;
}

