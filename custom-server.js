const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

let backgroundRefreshStarted = false;

// Arm the automatic-backup scheduler as soon as the HTTP server is listening.
// The Next-side bootstrap also starts it, but only when a page render runs;
// on a quiet server the timer would otherwise stay dead until the settings
// page is opened. configureTelegramBackup reads the stored config and no-ops
// when backups are disabled, so calling it unconditionally is safe.
let autoBackupStarted = false;
function startAutoBackupFromCustomServer() {
  if (autoBackupStarted) return;
  autoBackupStarted = true;
  const candidates = [
    path.join(__dirname, "src", "shared", "services", "telegramBackup.js"),
    path.join(__dirname, "..", "src", "shared", "services", "telegramBackup.js"),
  ];
  const modPath = candidates.find((p) => fs.existsSync(p));
  if (!modPath) {
    if (process.env.DEBUG_AUTO_BACKUP) console.error("[AutoBackup] module not found in standalone build");
    return;
  }
  import(pathToFileURL(modPath).href)
    .then((m) => {
      m.configureTelegramBackup().catch((e) => {
        console.error("[AutoBackup] configure failed:", e && e.message ? e.message : e);
      });
    })
    .catch((e) => {
      if (process.env.DEBUG_AUTO_BACKUP) console.error("[AutoBackup] import failed:", e && e.message ? e.message : e);
    });
}

let dbMaintenanceStarted = false;
function startDatabaseMaintenanceFromCustomServer() {
  if (dbMaintenanceStarted) return;
  dbMaintenanceStarted = true;
  const candidates = [
    path.join(__dirname, "src", "lib", "db", "repos", "dbMaintenanceRepo.js"),
    path.join(__dirname, "..", "src", "lib", "db", "repos", "dbMaintenanceRepo.js"),
  ];
  const modPath = candidates.find((p) => fs.existsSync(p));
  if (!modPath) return;
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startDatabaseMaintenanceScheduler();
      } catch (e) {
        console.error("[DatabaseMaintenance] start failed:", e?.message || e);
      }
    })
    .catch(() => {});
}

// In-memory sync check for jailed IPs in custom-server.js
let ipJailModule = null;
function checkIsIpJailed(ip) {
  if (!ip) return false;
  const clean = String(ip).trim().replace(/^::ffff:/, "");
  if (clean === "127.0.0.1" || clean === "::1" || clean === "localhost") return false;

  if (ipJailModule && typeof ipJailModule.isIpJailed === "function") {
    return ipJailModule.isIpJailed(clean);
  }

  // Lazy load IP Jail module
  const candidates = [
    path.join(__dirname, "src", "lib", "security", "ipJail.js"),
    path.join(__dirname, "..", "src", "lib", "security", "ipJail.js"),
  ];
  const modPath = candidates.find((p) => fs.existsSync(p));
  if (modPath) {
    import(pathToFileURL(modPath).href)
      .then((m) => {
        ipJailModule = m;
      })
      .catch(() => {});
  }
  return false;
}

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// --- Port/agent configuration from .env ---------------------------------
// .env.local and .env are the supreme configuration authority.
// Values defined in .env files override process defaults, and argv --port
// automatically syncs with PORT from .env.
function applyDotEnv() {
  for (const name of [".env.local", ".env"]) {
    let text;
    try {
      text = fs.readFileSync(path.join(__dirname, name), "utf8");
    } catch {
      continue; // no such file - fine
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || m[1] === "") continue;
      const key = m[1];
      const val = m[2].replace(/^(["'])(.*)\1$/, "$2").trim();
      // .env takes absolute precedence over unset or default process values
      process.env[key] = val;
    }
  }

  // Ensure PORT from .env dictates the server listen port (default to 20128 if unconfigured)
  const port = String(process.env.PORT || "20128");
  process.env.PORT = port;
  const argv = process.argv;
  let seen = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--port" || argv[i] === "-p") {
      if (seen) {
        argv.splice(i, 2);
        i--;
        continue;
      }
      argv[i + 1] = port;
      seen = true;
    } else if (argv[i].startsWith("--port=")) {
      argv[i] = `--port=${port}`;
      seen = true;
    }
  }
  if (!seen) argv.push("--port", port);
}
applyDotEnv();

// --- Dashboard auth guard (loader hooks: scripts/auth-guard-hooks.mjs) -----
// Upstream enforces auth in middleware.js -> proxy.js (Next.js 16, Node
// runtime). This fork runs Next.js 14, whose middleware is Edge-only, so the
// Node-dependent guard could never execute there: the app answered every
// /api/* route unauthenticated and never asked for a password. Wrapping the
// HTTP handler keeps src/dashboardGuard.js the single source of truth for which
// paths are public, so no path list is duplicated here.
let guardModulePromise = null;
function getGuardModule() {
  if (!guardModulePromise) {
    guardModulePromise = (async () => {
      const hooksPath = path.join(__dirname, "scripts", "auth-guard-hooks.mjs");
      const guardPath = path.join(__dirname, "src", "dashboardGuard.js");
      if (!fs.existsSync(hooksPath) || !fs.existsSync(guardPath)) return null;
      require("node:module").register(pathToFileURL(hooksPath).href);
      return await import(pathToFileURL(guardPath).href);
    })().catch((error) => {
      console.error("[AuthGuard] load failed:", error && (error.stack || error.message));
      return null;
    });
  }
  return guardModulePromise;
}

// M11 fix: normalize dot-segments before the skip test — the old unanchored
// prefix regex matched `/favicon.ico/../api/...` raw and skipped the guard.
const GUARD_SKIP = /^\/(_next\/(static|image)\/|favicon\.ico$)/;
function normalizedPathname(url) {
  const raw = String(url || "/");
  const qIndex = raw.indexOf("?");
  const pathOnly = qIndex === -1 ? raw : raw.slice(0, qIndex);
  try { return new URL(pathOnly, "http://x").pathname; } catch { return pathOnly; }
}
function denyService(res, status, message) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: message }));
}

// NextRequest-shaped view of a raw IncomingMessage: the guard reads only
// headers.get(), nextUrl.pathname/searchParams, cookies, method and url.
function toGuardRequest(req) {
  const url = req.url || "/";
  const qIndex = url.indexOf("?");
  const pathname = normalizedPathname(url); // M11: guard sees the path Next will actually route
  const search = qIndex === -1 ? "" : url.slice(qIndex + 1);
  const rawCookies = req.headers && req.headers.cookie ? req.headers.cookie : "";
  const standardHeaders = new Headers();
  if (req.headers) {
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) {
        if (Array.isArray(v)) v.forEach((val) => standardHeaders.append(k, val));
        else standardHeaders.set(k, v);
      }
    }
  }
  const proto = (req.headers && (req.headers["x-9r-forwarded-proto"] || req.headers["x-forwarded-proto"] || req.headers["x-forwarded-protocol"])) || "http";
  const host = (req.headers && (req.headers["x-9r-forwarded-host"] || req.headers["x-forwarded-host"] || req.headers["host"])) || "localhost";
  return {
    method: req.method || "GET",
    url: `${proto}://${host}${url}`,
    nextUrl: { pathname, searchParams: new URLSearchParams(search) },
    headers: standardHeaders,
    cookies: {
      get(name) {
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const m = rawCookies.match(new RegExp("(?:^|;\\s*)" + esc + "=([^;]*)"));
        return m ? { name, value: decodeURIComponent(m[1]) } : undefined;
      },
    },
  };
}

// True when the guard answered the request itself (deny or redirect).
async function runAuthGuard(req, res) {
  if (GUARD_SKIP.test(normalizedPathname(req.url))) return false;
  const guard = await getGuardModule();
  if (!guard) {
    if (!runAuthGuard._warned) {
      runAuthGuard._warned = true;
      // L2 fix: fail CLOSED — an unavailable guard must not open the gates.
      console.error("[AuthGuard] guard unavailable — FAILING CLOSED with 503 (src/ missing?)");
    }
    denyService(res, 503, "Auth guard unavailable");
    return true;
  }
  let response;
  try {
    response = await guard.proxy(toGuardRequest(req));
  } catch (error) {
    // L2 fix: guard execution failure fails closed (never fired in 3d of logs,
    // so no legitimate traffic depends on the old pass-through).
    console.error("[AuthGuard] proxy threw — FAILING CLOSED:", error && error.message);
    denyService(res, 503, "Auth guard error");
    return true;
  }
  if (!response || response.headers.get("x-middleware-next") === "1") return false;
  res.statusCode = response.status || 500;
  response.headers.forEach((value, key) => {
    if (key === "set-cookie") res.setHeader("set-cookie", Array.isArray(value) ? value : [value]);
    else if (key !== "content-length") res.setHeader(key, value);
  });
  if (response.body) {
    const buf = Buffer.from(await new Response(response.body).arrayBuffer());
    res.setHeader("content-length", buf.length);
    res.end(buf);
  } else {
    res.end();
  }
  return true;
}

function getLanIp() {
  try {
    const os = require("node:os");
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces || []) {
        if (i.family === "IPv4" && !i.internal) return i.address;
      }
    }
  } catch {}
  return null;
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const cfIp = req.headers["cf-connecting-ip"];
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp || cfIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // CF-Connecting-IP is set by Cloudflare edge and CANNOT be forged by the client.
    // If the TCP peer is loopback (Cloudflare tunnel), CF-Connecting-IP is the single source of truth.
    // NEVER allow attacker-controlled X-Forwarded-For or X-Real-IP to override or substitute!
    const realClientIp = (isLoopbackProxy && cfIp) ? String(cfIp).trim() : (isLoopbackProxy ? (xRealIp || (xff ? String(xff).split(",")[0].trim() : "")) : socketIp);
    const ip = realClientIp || socketIp;

    const trustedFwdHost = isLoopbackProxy ? req.headers["x-forwarded-host"] : null;
    const trustedFwdProto = isLoopbackProxy ? (req.headers["x-forwarded-proto"] || req.headers["x-forwarded-protocol"]) : null;

    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-forwarded-host"]; // L5: origin/host must never come from untrusted client headers
    delete req.headers["forwarded"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];

    if (trustedFwdHost) {
      const isHostLoopback = !req.headers["host"] || req.headers["host"].startsWith("127.0.0.1") || req.headers["host"].startsWith("localhost") || req.headers["host"].startsWith("[::1]");
      if (isHostLoopback) {
        req.headers["host"] = trustedFwdHost;
      }
      req.headers["x-9r-forwarded-host"] = trustedFwdHost;
    }
    if (trustedFwdProto) {
      req.headers["x-9r-forwarded-proto"] = trustedFwdProto;
    }

    if (!isLoopbackProxy) {
      // Strip forged Cloudflare headers sent directly to raw TCP socket
      delete req.headers["cf-ray"];
      delete req.headers["cf-ipcountry"];
      delete req.headers["cf-visitor"];
      delete req.headers["cf-connecting-ip"];
    } else {
      req.headers["cf-connecting-ip"] = ip;
    }

    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";

    // Fast-path IP Jail Gate: reject jailed attackers before running Next.js or SQLite queries
    if (ip && checkIsIpJailed(ip)) {
      denyService(res, 403, "Access denied: IP temporarily jailed due to repeated security violations.");
      return;
    }

    // Auth gate ahead of Next; runAuthGuard resolves false when the request
    // may pass through, true when it already answered (401 or redirect).
    return runAuthGuard(req, res)
      .then((handled) => { if (!handled) return handler(req, res); })
      .catch((error) => {
        // L2 fix: never fall back to passing the request through.
        console.error("[AuthGuard] request failed (failing closed):", error && error.message);
        denyService(res, 503, "Auth guard error");
      });
  };
  const server = origCreate(...rest, wrapped);
  // High-concurrency socket stabilization: prevent 502 races behind Nginx/Cloudflare
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.maxRequestsPerSocket = 0;
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
    startAutoBackupFromCustomServer();
    startDatabaseMaintenanceFromCustomServer();
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

// Intercept Next.js bootstrap output so - Network: always prints the real accessible IP instead of 0.0.0.0
try {
  const lanIp = getLanIp();
  if (lanIp) {
    const origLog = console.log;
    console.log = function (...args) {
      if (typeof args[0] === "string" && args[0].includes("- Network:") && args[0].includes("0.0.0.0")) {
        args[0] = args[0].replace("0.0.0.0", lanIp);
      }
      return origLog.apply(console, args);
    };
  }
} catch {}

if (require.main === module) {
  // If .next/standalone/server.js exists, prefer it directly so Next.js standalone output works properly
  const standaloneDirect = path.join(__dirname, "server.js");
  const standaloneDist = path.join(__dirname, ".next", "standalone", "server.js");
  if (fs.existsSync(standaloneDirect)) {
    require(standaloneDirect);
  } else if (fs.existsSync(standaloneDist)) {
    // Set cwd to standalone dir so Next standalone server finds its static & data
    process.chdir(path.join(__dirname, ".next", "standalone"));
    require(standaloneDist);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
