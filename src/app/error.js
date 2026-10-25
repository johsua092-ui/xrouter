"use client";

import { useEffect } from "react";

export default function GlobalErrorBoundary({ error, reset }) {
  useEffect(() => {
    // Auto-heal seamlessly without requiring user interaction:
    // If the page glitched after sleep/AFK, immediately hard reload to sync fresh state.
    const lastReload = sessionStorage.getItem("xr_auto_reload_ts");
    const now = Date.now();
    if (!lastReload || now - Number(lastReload) > 4000) {
      sessionStorage.setItem("xr_auto_reload_ts", String(now));
      window.location.reload();
    }
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center bg-bg">
      <div className="size-10 rounded-full border-2 border-primary border-t-transparent animate-spin mb-3" />
      <span className="text-xs font-medium text-text-muted">Resuming session...</span>
    </div>
  );
}
