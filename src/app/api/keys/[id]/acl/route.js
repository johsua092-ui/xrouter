import { NextResponse } from "next/server";
import { getKeyAcl, setKeyAcl, deleteKeyAcl } from "@/lib/db/repos/abuseRepo.js";
import { getApiKeyById } from "@/lib/db/repos/apiKeysRepo.js";

export const dynamic = "force-dynamic";

/**
 * A key's deny-list and provider allowlist. Stored apart from `apiKeys` so that table
 * keeps the shape an older build expects — an export still restores elsewhere.
 *
 * Both fields take the same pattern language as `allowedModels`: exact ids, `prefix*`,
 * `*suffix`, or blank / `*` for "no restriction".
 */
async function loadKey(id) {
  try {
    return await getApiKeyById(id);
  } catch {
    return null;
  }
}

export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    const key = await loadKey(id);
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });
    const acl = await getKeyAcl(id);
    return NextResponse.json({
      success: true,
      apiKeyId: id,
      allowedModels: key.allowedModels || "*",
      deniedModels: acl.deniedModels,
      allowedProviders: acl.allowedProviders,
      notes: acl.notes,
      updatedAt: acl.updatedAt,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const key = await loadKey(id);
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });
    const body = (await request.json()) || {};
    const result = await setKeyAcl(id, {
      deniedModels: body.deniedModels,
      allowedProviders: body.allowedProviders,
      notes: body.notes,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ success: true, acl: result.acl });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/** Clear both restrictions; the key falls back to `allowedModels` alone. */
export async function DELETE(_request, { params }) {
  try {
    const { id } = await params;
    const result = await deleteKeyAcl(id);
    return NextResponse.json({ success: result.ok, result });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
