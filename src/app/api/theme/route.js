import { NextResponse } from "next/server";
import { getMeta, setMeta } from "@/lib/db/helpers/metaStore";

export const dynamic = "force-dynamic";

// GET /api/theme - fetch public/global theme preference set by instance owner
export async function GET() {
  try {
    const raw = await getMeta("global_theme_settings", null);
    if (!raw) {
      return NextResponse.json({
        ok: true,
        theme: "ember",
        accent: "orange",
        customColor: "#E56A4A",
      });
    }
    const parsed = JSON.parse(raw);
    return NextResponse.json({ ok: true, ...parsed });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      theme: "ember",
      accent: "orange",
      customColor: "#E56A4A",
    });
  }
}

// POST /api/theme - update global theme preference
export async function POST(request) {
  try {
    const body = await request.json();
    const theme = body.theme || "ember";
    const accent = body.accent || "orange";
    const customColor = body.customColor || "#E56A4A";

    await setMeta("global_theme_settings", JSON.stringify({ theme, accent, customColor }));
    return NextResponse.json({ ok: true, theme, accent, customColor });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
