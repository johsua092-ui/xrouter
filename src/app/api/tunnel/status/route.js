import { NextResponse } from "next/server";
import { getTunnelStatus, getTailscaleStatus, getDownloadStatus } from "@/lib/tunnel";

// This probe reads live process/state files, so it must never be evaluated once at
// build time. Without this the route was statically optimised into a frozen `.body`
// payload and Next served that snapshot forever — the dashboard toggle kept showing
// the state captured during `next build`, so enabling the tunnel appeared to do
// nothing and reloading the page snapped back to "off".
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET() {
  try {
    // Probes must never be served from a long-lived stale snapshot: the dashboard polls this
    // right after enable/disable, and a cached probe leaves the toggle showing the old state.
    const [tunnel, tailscale] = await Promise.all([getTunnelStatus(), getTailscaleStatus()]);
    const download = getDownloadStatus();
    return NextResponse.json({ tunnel, tailscale, download });
  } catch (error) {
    console.error("Tunnel status error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
