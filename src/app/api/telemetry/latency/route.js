import { NextResponse } from "next/server";
import { getOverheadReport, resetOverheadMetrics } from "open-sse/utils/overheadTracker.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/telemetry/latency
 * Returns P50, P90, P99, P99.9 latency overhead breakdown across router phases
 */
export async function GET() {
  try {
    return NextResponse.json({
      success: true,
      report: getOverheadReport(),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/telemetry/latency
 * Resets latency overhead buffer
 */
export async function POST() {
  try {
    resetOverheadMetrics();
    return NextResponse.json({ success: true, report: getOverheadReport() });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
