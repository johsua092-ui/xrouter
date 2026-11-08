import { NextResponse } from "next/server";
import { getV2RayStatus, startV2RayFromLink, stopV2Ray } from "@/lib/v2ray/manager.js";

export async function GET() {
  try {
    const status = getV2RayStatus();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { link, name } = body;
    if (!link || typeof link !== "string" || !link.trim()) {
      return NextResponse.json({ error: "V2Ray link is required (vmess://, vless://, trojan://, ss://)" }, { status: 400 });
    }

    const result = await startV2RayFromLink(link.trim(), name);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const result = await stopV2Ray();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
