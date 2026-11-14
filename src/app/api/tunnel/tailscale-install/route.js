import os from "os";
import { execSync } from "child_process";
import { installTailscale, loadState, generateShortId } from "@/lib/tunnel";
import { getCachedPassword, loadEncryptedPassword, initDbHooks } from "@/mitm/manager";
import { getSettings, updateSettings } from "@/lib/localDb";

// Streaming install handler — runs shell probes and spawns a process. It is an
// App Route handler returning a ReadableStream, so it is dynamic by construction:
// a request body and a live stream cannot be prerendered. No `export const` here
// because "use server" files may only export async functions.
export const runtime = "nodejs";

initDbHooks(getSettings, updateSettings);

const EXTENDED_PATH = `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ""}`;

function hasBrew() {
  try { execSync("which brew", { stdio: "ignore", windowsHide: true, env: { ...process.env, PATH: EXTENDED_PATH } }); return true; } catch { return false; }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const platform = os.platform();
  const isWindows = platform === "win32";
  const isBrew = platform === "darwin" && hasBrew();
  const isRoot = typeof process.getuid === "function" ? process.getuid() === 0 : false;
  const needsPassword = !isWindows && !isBrew && !isRoot;

  const sudoPassword = body.sudoPassword || getCachedPassword() || await loadEncryptedPassword() || "";

  if (needsPassword && !sudoPassword.trim()) {
    return new Response(JSON.stringify({ error: "Sudo password is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const shortId = loadState()?.shortId || generateShortId();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        const result = await installTailscale(sudoPassword, shortId, (msg) => {
          send("progress", { message: msg });
        });
        send("done", { success: true, authUrl: result?.authUrl || null });
      } catch (error) {
        console.error("Tailscale install error:", error);
        const msg = error.message?.includes("incorrect password") || error.message?.includes("Sorry")
          ? "Wrong sudo password"
          : error.message;
        send("error", { error: msg });
      } finally {
        if (!closed) { try { controller.close(); } catch {} }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
