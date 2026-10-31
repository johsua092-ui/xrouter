import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { createProviderConnection } from "@/lib/db/repos/connectionsRepo.js";
import { normalizeProviderId } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

/**
 * POST /api/providers/bulk
 * Bulk inserts provider API keys in a single atomic database transaction.
 * Body: { provider: string, keys: Array<{ name: string, apiKey: string, providerSpecificData?: object }> }
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const provider = normalizeProviderId(body.provider);
    if (!provider) {
      return NextResponse.json({ error: "Provider is required" }, { status: 400 });
    }

    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (!keys.length) {
      return NextResponse.json({ error: "No keys provided" }, { status: 400 });
    }

    const db = await getAdapter();
    const created = [];
    const failed = [];

    // Atomic transaction for maximum throughput and zero disk latency
    db.transaction(() => {
      for (let i = 0; i < keys.length; i++) {
        const entry = keys[i];
        const apiKey = String(entry.apiKey || "").trim();
        const name = String(entry.name || `Key ${i + 1}`).trim();
        if (!apiKey) {
          failed.push({ index: i, error: "Empty API key" });
          continue;
        }

        try {
          const newConn = createProviderConnection({
            provider,
            authType: "apikey",
            name,
            apiKey,
            priority: 1,
            isActive: true,
            testStatus: "unknown",
            providerSpecificData: entry.providerSpecificData || {},
            allowOverwrite: true,
          });
          created.push(newConn.id);
        } catch (err) {
          failed.push({ index: i, error: err?.message || "Failed to create" });
        }
      }
    });

    return NextResponse.json({
      success: true,
      count: created.length,
      failed: failed.length,
      errors: failed.slice(0, 5),
    });
  } catch (error) {
    console.error("Error bulk creating provider keys:", error);
    return NextResponse.json({ error: "Failed to bulk create provider keys" }, { status: 500 });
  }
}

/**
 * DELETE /api/providers/bulk
 * Bulk deletes provider connections in a single atomic database query.
 * Body: { ids: Array<string> }
 */
export async function DELETE(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) {
      return NextResponse.json({ error: "No connection IDs provided" }, { status: 400 });
    }

    const db = await getAdapter();
    let deletedCount = 0;

    db.transaction(() => {
      const placeholders = ids.map(() => "?").join(",");
      const res = db.run(`DELETE FROM providerConnections WHERE id IN (${placeholders})`, ids);
      deletedCount = res?.changes ?? 0;
    });

    return NextResponse.json({
      success: true,
      deleted: deletedCount,
      requested: ids.length,
    });
  } catch (error) {
    console.error("Error bulk deleting provider connections:", error);
    return NextResponse.json({ error: "Failed to bulk delete provider connections" }, { status: 500 });
  }
}
