import { NextResponse } from "next/server";
import { validateApiKey } from "@/lib/localDb";
import { collectFreePiStats } from "@/lib/freepiStats";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEADERS = { "Cache-Control": "no-store" };

/**
 * FreePI pool snapshot for monitors: `/v1/freepi/stats` (API-key auth, like every
 * other /v1 endpoint) so a scraper needs no dashboard session.
 * The dashboard panel uses /api/providers/freepi/stats, which is session-authed.
 */
function extractKey(request) {
  const auth = request.headers.get("authorization") || "";
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return request.headers.get("x-api-key") || request.nextUrl.searchParams.get("key") || "";
}

export async function GET(request) {
  const key = extractKey(request);
  if (!key) {
    return NextResponse.json({ error: "API key required" }, { status: 401, headers: HEADERS });
  }
  let valid = false;
  try {
    valid = Boolean(await validateApiKey(key));
  } catch {
    valid = false;
  }
  if (!valid) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401, headers: HEADERS });
  }

  try {
    const stats = await collectFreePiStats();
    return NextResponse.json(stats, { headers: HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: HEADERS });
  }
}
