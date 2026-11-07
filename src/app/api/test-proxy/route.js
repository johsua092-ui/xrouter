import { NextResponse } from "next/server";
import { Agent, fetch as undiciFetch } from "undici";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const proxyRaw = searchParams.get("proxy");
  let target = searchParams.get("target") || "https://opencode.ai/inference/v1/models";

  const t0 = Date.now();
  try {
    let dispatcher = undefined;
    if (proxyRaw) {
      const { ProxyAgent } = await import("undici");
      dispatcher = new ProxyAgent(proxyRaw);
    }

    const res = await undiciFetch(target, {
      method: "GET",
      dispatcher,
      headers: {
        "User-Agent": "opencode/latest/2.2.5/cli",
        "Authorization": "Bearer public",
      },
      signal: AbortSignal.timeout(6000),
    });

    const duration = Date.now() - t0;
    const ok = res.status >= 200 && res.status < 400;
    let snippet = "";
    try {
      const text = await res.text();
      snippet = text.slice(0, 1024);
    } catch {}

    return NextResponse.json({
      ok,
      status: res.status,
      target,
      proxy: proxyRaw || null,
      duration_ms: duration,
      snippet,
    });
  } catch (err) {
    const duration = Date.now() - t0;
    return NextResponse.json({
      ok: false,
      target,
      proxy: proxyRaw || null,
      duration_ms: duration,
      error: err?.message || String(err),
    });
  }
}
