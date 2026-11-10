import { NextResponse } from "next/server";
import { getIpBans, banIp, unbanIp, unbanIps, pruneExpiredIpBans } from "@/lib/db/repos/abuseRepo.js";
import { listJailedIps, isIpJailed } from "@/lib/security/ipJail.js";

export const dynamic = "force-dynamic";

/**
 * Manual bans (durable, SQLite `ipBans`) are listed next to the automatic jail
 * (`ipJail.js`, temporary, self-expiring). Two tiers on purpose: the jail reacts to
 * abuse on its own, this API is for a human deciding an address is done.
 */
export async function GET() {
  try {
    const [manual, auto] = [await getIpBans({ activeOnly: true }), listJailedIps()];
    const autoIps = new Set(auto.map((j) => j.ip));
    return NextResponse.json({
      success: true,
      manual: manual.map((b) => ({ ...b, auto: false })),
      auto: auto.map((j) => ({ ...j, auto: true })),
      // An address can be in both; the manual row is the one that survives a restart.
      totalManual: manual.length,
      totalAuto: auto.filter((j) => !autoIps.has(j.ip)).length,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = (await request.json()) || {};
    const { ip, reason = "manual", durationMinutes = 0, notes = "" } = body;
    if (!ip || typeof ip !== "string" || !ip.trim()) {
      return NextResponse.json({ error: "ip is required" }, { status: 400 });
    }
    const minutes = Number(durationMinutes) || 0;
    const result = await banIp(ip.trim(), {
      reason,
      notes,
      ttlMinutes: minutes,
      expiresAt: null,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({
      success: true,
      ban: result,
      // 0 minutes = permanent; anything else says when it lifts.
      permanent: minutes <= 0,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const one = searchParams.get("ip");
    if (one) {
      const result = await unbanIp(one);
      return NextResponse.json({ success: result.ok, result });
    }
    let ips = [];
    try {
      const body = await request.json();
      ips = Array.isArray(body?.ips) ? body.ips : [];
    } catch {}
    if (!ips.length) {
      const pruned = await pruneExpiredIpBans();
      return NextResponse.json({ success: true, pruned });
    }
    const result = await unbanIps(ips);
    return NextResponse.json({ success: result.ok, result });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/** Exposed for the dashboard so a jail row can be shown as already-covered. */
export async function HEAD(request) {
  const { searchParams } = new URL(request.url);
  const ip = searchParams.get("ip");
  return new NextResponse(null, { status: ip && isIpJailed(ip) ? 200 : 404 });
}
