import { NextResponse } from "next/server";
import { validateApiKey } from "@/lib/localDb";
import { getSessionContext } from "@/lib/auth/dashboardPermissions";
import { collectFreePiStats } from "@/lib/freepiStats";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEADERS = { "Cache-Control": "no-store" };

/**
 * FreePI pool snapshot.
 * Readable by a dashboard session or by any valid API key, so the same URL can be
 * scraped by a monitor without a browser: `curl -H "Authorization: Bearer sk-…"`.
 */
async function authorize(request) {
  const header = request.headers.get("authorization") || "";
  if (/^bearer\s+/i.test(header)) {
    const token = header.replace(/^bearer\s+/i, "").trim();
    if (token) {
      try {
        const valid = await validateApiKey(token);
        if (valid) return true;
      } catch {
        /* fall through to session check */
      }
    }
  }
  try {
    const ctx = await getSessionContext();
    if (ctx?.session) return true;
    if (ctx && !ctx.session && ctx.permissions) return true; // auth disabled on this instance
  } catch {
    /* unauthorized */
  }
  return false;
}

export async function GET(request) {
  if (!(await authorize(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: HEADERS });
  }
  try {
    const stats = await collectFreePiStats();
    return NextResponse.json(stats, { headers: HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: HEADERS });
  }
}
