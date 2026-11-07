// Origin / fetch-destination gate for state-changing API requests.
// Complements SameSite=lax cookies: even if a cookie policy ever loosens, a
// cross-site browser POST never reaches a handler. Non-browser clients (no
// Origin / no Sec-Fetch-Site headers) pass untouched.
// Build-time & runtime conflict prevention: avoid having both middleware.js and proxy.js in src/
// Xiaomi MiMo reverse proxy logic is safely routed through src/lib/mimoReverseProxy.js
import { NextResponse } from "next/server";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function proxy(request) {
  if (!MUTATING.has(request.method)) return NextResponse.next();

  // Auth login/logout and status routes need to be accessible from any client
  const pathname = request.nextUrl.pathname;
  if (pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const origin = request.headers.get("origin");
  if (origin) {
    let sameHost = false;
    try {
      const originHost = new URL(origin).host;
      const originHostname = new URL(origin).hostname;
      const hostWithoutPort = host ? host.split(":")[0] : "";
      sameHost = originHost === host || originHostname === hostWithoutPort || originHostname === host;
    } catch {
      sameHost = false;
    }
    if (!sameHost) {
      return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
    }
  }

  const site = request.headers.get("sec-fetch-site");
  if (site && !["same-origin", "same-site", "none"].includes(site)) {
    return NextResponse.json({ error: "Cross-site request blocked" }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  // Dashboard API surface only: always same-origin. /v1* is deliberately left
  // out — it serves cross-origin consumers (CORS ACAO:*) with API-key auth.
  matcher: ["/api/:path*"],
};
