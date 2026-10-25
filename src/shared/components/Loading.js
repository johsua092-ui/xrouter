"use client";

import { cn } from "@/shared/utils/cn";

// Spinner loading
export function Spinner({ size = "md", className }) {
  const sizes = {
    sm: "size-4",
    md: "size-6",
    lg: "size-8",
    xl: "size-12",
  };

  return (
    <span
      className={cn(
        "material-symbols-outlined animate-spin text-brand-500",
        sizes[size],
        className
      )}
    >
      progress_activity
    </span>
  );
}

// Full page loading
export function PageLoading({ message = "Loading..." }) {
  return (
    <div className="fixed inset-0 z-[120] flex flex-col items-center justify-center bg-bg">
      <Spinner size="xl" />
      <p className="mt-4 text-text-muted">{message}</p>
    </div>
  );
}

// Centered busy overlay for long operations (e.g. backup export/import).
// Renders above modals with a dark blurred backdrop, a large spinner
// centered on screen, an optional message, and an optional progress bar.
// Pass fixed={false} to render as an absolute fill inside a relative
// parent (e.g. inside a modal) instead of a fullscreen fixed overlay.
export function CenterLoading({ message, progress = null, fixed = true, className }) {
  const pct =
    typeof progress === "number" ? Math.min(100, Math.max(0, progress)) : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center justify-center bg-black/70",
        fixed ? "fixed inset-0 z-[70]" : "absolute inset-0 z-10 rounded-[6px]",
        className
      )}
    >
      <div className="flex flex-col items-center justify-center px-6 text-center">
        <Spinner size="xl" />
        {message ? (
          <p className="mt-4 text-sm font-medium text-white">{message}</p>
        ) : null}
        {pct !== null ? (
          <div className="mt-4 h-1.5 w-48 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-surface transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const BusyOverlay = CenterLoading;

// Blocking progress card for long operations (backup export/import, bulk
// imports, bulk adds). Card centered on screen over a dark blurred backdrop,
// with a spinner, title, message, optional percent, optional section line,
// and an optional progress bar. Extra info tolerated: callers pass
// { title, message, section, progress } where progress is 0-100 or null.
export function ProgressCard({ title, message, section, progress = null, fixed = true, className }) {
  const percent =
    typeof progress === "number" && Number.isFinite(progress)
      ? Math.min(100, Math.max(0, Math.round(progress <= 1 ? progress * 100 : progress)))
      : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center justify-center bg-black/70",
        fixed ? "fixed inset-0 z-[70]" : "absolute inset-0 z-10 rounded-[6px]",
        className
      )}
    >
      <div className="w-full max-w-sm rounded-[6px] border border-border bg-surface p-4 shadow-[var(--shadow-elev)] mx-4">
        <div className="flex items-center gap-3">
          <Spinner size="md" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-main">{title || "Working"}</p>
            {message ? <p className="truncate text-xs text-text-muted">{message}</p> : null}
          </div>
          {percent !== null ? (
            <span className="ml-auto shrink-0 text-xs text-text-muted">{`${percent}%`}</span>
          ) : null}
        </div>
        {section ? <p className="mt-2 text-xs text-text-muted">{section}</p> : null}
        {percent !== null ? (
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Skeleton loading
export function Skeleton({ className, ...props }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-[6px] bg-surface-2",
        className
      )}
      {...props}
    />
  );
}

// Card skeleton
export function CardSkeleton() {
  return (
    <div className="p-6 rounded-[6px] border border-border-subtle bg-surface shadow-[var(--shadow-elev)]">
      <div className="flex items-center justify-between mb-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="size-10 rounded-[6px]" />
      </div>
      <Skeleton className="h-8 w-16 mb-2" />
      <Skeleton className="h-3 w-20" />
    </div>
  );
}

export default function Loading({ type = "spinner", ...props }) {
  switch (type) {
    case "page":
      return <PageLoading {...props} />;
    case "skeleton":
      return <Skeleton {...props} />;
    case "card":
      return <CardSkeleton {...props} />;
    default:
      return <Spinner {...props} />;
  }
}
