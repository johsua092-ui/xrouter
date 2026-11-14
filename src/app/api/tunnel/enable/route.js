import { NextResponse } from "next/server";
import { enableTunnel } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";

// This handler spawns a process and writes tunnel state, so it must never be
// evaluated once at build time. Without this Next statically optimised the POST
// into a frozen `.body` payload: the dashboard's enable button hit the build-time
// snapshot and `enableTunnel()` was never actually invoked, so the toggle never
// moved off "off". Same class of bug as the status probe — every mutating tunnel
// route needs the opt-out, not just the GET probe.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

// The spawn is done when cloudflared is up and the URL is registered; the
// 15 s post-spawn health probe inside enableTunnel only decides which URL to
// advertise. Waiting on it here held the response for ~23 s (probe + DNS warmup),
// long past the browser's patience, so the toggle appeared to do nothing.
// Kick monitoring off in the background and answer as soon as the tunnel exists.
export async function POST() {
  try {
    const result = await enableTunnel();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tunnel monitor start failed:", error.message));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tunnel enable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
