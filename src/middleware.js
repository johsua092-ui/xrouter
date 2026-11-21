// Origin / fetch-destination gate for state-changing API requests.
// Complements SameSite=lax cookies: even if a cookie policy ever loosens, a
// cross-site browser POST never reaches a handler. Non-browser clients (no
// Origin / no Sec-Fetch-Site headers) pass untouched.
// Build-time & runtime conflict prevention: avoid having both middleware.js and proxy.js in src/
// Xiaomi MiMo reverse proxy logic is safely routed through src/lib/mimoReverseProxy.js
import { NextResponse } from "next/server";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Sec-Fetch-Site values only a browser can produce for a same-site navigation.
// Browsers forbid scripts from setting Sec-Fetch-* headers, so a cross-site page
// can never forge `same-origin` — this is browser-attested proof of same-site.
const SAME_SITE = new Set(["same-origin", "same-site", "none"]);

// Env vars that may legitimately hold the public origin when the dashboard runs
// behind a tunnel / reverse proxy (Host gets rewritten on the way in).
const ORIGIN_ENV_KEYS = [
  "BASE_URL",
  "PUBLIC_BASE_URL",
  "NEXT_PUBLIC_BASE_URL",
  "APP_URL",
  "SITE_URL",
  "NEXTAUTH_URL",
];

function configuredHosts() {
  const hosts = new Set();
  for (const key of ORIGIN_ENV_KEYS) {
    const raw = process.env[key];
    if (!raw || typeof raw !== "string") continue;
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const url = new URL(candidate);
      if (url.host) hosts.add(url.host);
      if (url.hostname) hosts.add(url.hostname);
    } catch {
      // ignore malformed env values
    }
  }
  return hosts;
}

function requestHosts(request) {
  const hosts = new Set();
  for (const header of ["x-forwarded-host", "host"]) {
    const raw = request.headers.get(header);
    if (!raw) continue;
    // Proxy chains append: "public.host, internal.host" — the first entry is
    // the client-facing host the browser actually used.
    for (const part of raw.split(",")) {
      const value = part.trim();
      if (!value) continue;
      hosts.add(value);
      hosts.add(value.split(":")[0]);
    }
  }
  for (const host of configuredHosts()) hosts.add(host);
  return hosts;
}

export function middleware(request) {
  if (!MUTATING.has(request.method)) return NextResponse.next();

  // Auth login/logout and status routes need to be accessible from any client
  const pathname = request.nextUrl.pathname;
  if (pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  const site = request.headers.get("sec-fetch-site");

  // Fast path: the browser itself attests the request is same-site. Host-based
  // comparison is unreliable behind tunnels (abc-tunnel, cloudflared, ngrok)
  // and reverse proxies that rewrite Host — they produced false 403s on every
  // mutating dashboard call, e.g. the Muse device-code connect flow.
  if (site && SAME_SITE.has(site)) return NextResponse.next();

  const origin = request.headers.get("origin");
  if (origin) {
    const hosts = requestHosts(request);
    let sameHost = false;
    try {
      const originUrl = new URL(origin);
      sameHost = hosts.has(originUrl.host) || hosts.has(originUrl.hostname);
    } catch {
      sameHost = false;
    }
    if (!sameHost) {
      return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
    }
  }

  if (site && !SAME_SITE.has(site)) {
    return NextResponse.json({ error: "Cross-site request blocked" }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  // Dashboard API surface only: always same-origin. /v1* is deliberately left
  // out — it serves cross-origin consumers (CORS ACAO:*) with API-key auth.
  matcher: ["/api/:path*"],
};
