import { NextResponse } from "next/server";
import { createShareToken, getShareTokensForKey, revokeShareToken } from "@/lib/db/repos/abuseRepo.js";
import { getApiKeyById } from "@/lib/db/repos/apiKeysRepo.js";

export const dynamic = "force-dynamic";

/**
 * Usage-share links for one key. A token exposes that key's aggregates and nothing else:
 * no credential, no provider list, no ability to make a request.
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const shares = await getShareTokensForKey(id);
    const { origin } = new URL(request.url);
    return NextResponse.json({
      success: true,
      apiKeyId: id,
      shares: shares.map((s) => ({ ...s, url: `${origin}/share/${s.token}` })),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });

    const body = (await request.json().catch(() => ({}))) || {};
    // Default 30 days. `ttlDays: 0` mints a link that does not expire.
    const ttlDays = body.ttlDays === undefined ? 30 : Number(body.ttlDays) || 0;
    const result = await createShareToken(id, { label: body.label || key.name || "", ttlDays });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

    const { origin } = new URL(request.url);
    return NextResponse.json({
      success: true,
      share: { ...result.share, url: `${origin}/share/${result.share.token}` },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    await params;
    const { searchParams } = new URL(request.url);
    const token = searchParams.get("token");
    if (!token) return NextResponse.json({ error: "token is required" }, { status: 400 });
    const result = await revokeShareToken(token);
    return NextResponse.json({ success: result.ok, result });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
