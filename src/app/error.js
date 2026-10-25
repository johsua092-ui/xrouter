"use client";

import { useEffect } from "react";
import Button from "@/shared/components/Button";

export default function GlobalErrorBoundary({ error, reset }) {
  useEffect(() => {
    // If chunk failed to load (server rebuild or stale cache after idle),
    // automatically hard-reload once to fetch fresh assets.
    if (
      error?.name === "ChunkLoadError" ||
      error?.message?.includes("Loading chunk") ||
      error?.message?.includes("Failed to fetch")
    ) {
      const lastReload = sessionStorage.getItem("xr_chunk_reload");
      const now = Date.now();
      if (!lastReload || now - Number(lastReload) > 10000) {
        sessionStorage.setItem("xr_chunk_reload", String(now));
        window.location.reload();
      }
    }
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center bg-bg">
      <div className="size-12 rounded-full bg-warning/15 flex items-center justify-center text-warning mb-4">
        <span className="material-symbols-outlined text-[28px]">refresh</span>
      </div>
      <h2 className="text-lg font-semibold text-text-main mb-1.5">Page Session Expired</h2>
      <p className="text-xs text-text-muted max-w-sm mb-5 leading-relaxed">
        The dashboard was idle in the background or a new version was deployed. Reload to continue.
      </p>
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          icon="refresh"
          onClick={() => {
            sessionStorage.removeItem("xr_chunk_reload");
            window.location.reload();
          }}
        >
          Reload Page
        </Button>
      </div>
    </div>
  );
}
