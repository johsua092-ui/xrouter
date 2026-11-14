import { NextResponse } from "next/server";
import { disableTailscale } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";

// Mutating handler — build-time evaluation would freeze the response and make the
// dashboard's Tailscale button a no-op (same class of bug as the tunnel routes).
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function POST() {
  try {
    const result = await disableTailscale();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tailscale monitor update failed:", error.message));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tailscale disable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
