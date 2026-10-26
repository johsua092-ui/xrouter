import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const OFFICIAL_URL = "https://raw.githubusercontent.com/decolua/9router/refs/heads/master/CHANGELOG.md";

function readLocalChangelog(filename) {
  const dirs = [process.cwd(), "/root/xrouter", "/root/xrouter-remake"];
  for (const dir of dirs) {
    try {
      const p = path.join(dir, filename);
      if (fs.existsSync(p)) {
        const text = fs.readFileSync(/*turbopackIgnore: true*/ p, "utf8");
        if (text && text.trim()) return text;
      }
    } catch {}
  }
  return null;
}

async function fetchOfficialChangelog() {
  try {
    const res = await fetch(OFFICIAL_URL, { cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

// GET /api/changelog - { ok, go, node, official, custom }
export async function GET() {
  const go = readLocalChangelog("CHANGELOG.md");
  const node = readLocalChangelog("CHANGELOG-NODE.md");
  const official = await fetchOfficialChangelog();

  if (!official && !go && !node) {
    return NextResponse.json({ ok: false, go: null, node: null, official: null, custom: null });
  }
  return NextResponse.json({
    ok: true,
    go,
    node,
    official,
    custom: go,
  });
}
