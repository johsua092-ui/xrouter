"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChangelogModal from "./ChangelogModal";
import { useSessionStore } from "@/store/sessionStore";
import { useTaskStore } from "@/store/taskStore";
import { revealBackgroundedTasks } from "./LongTaskBanner";

const POLL_MS = 60000;

const SEVERITY_STYLE = {
  error: { dot: "bg-red-500", text: "text-red-500", icon: "error" },
  warning: { dot: "bg-amber-500", text: "text-amber-500", icon: "warning" },
  info: { dot: "bg-primary", text: "text-primary", icon: "info" },
};

/**
 * Notification bell: quota pressure, updates and anything the scan route
 * derives. A key-signed session gets nothing - these messages describe this
 * install, not the caller's own key.
 */
export default function NotificationBell() {
  const role = useSessionStore((state) => state.role);
  const isAdmin = role !== "apikey";
  const [open, setOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [jobs, setJobs] = useState([]);
  const ref = useRef(null);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setItems(Array.isArray(data.notifications) ? data.notifications : []);
      setUnread(Number(data.unread) || 0);
    } catch {
      // A failed poll must not disturb the header.
    }
  }, [isAdmin]);

  // Conditions are derived server-side (deduped); polling keeps the badge fresh
  // without a socket, and the scan is cheap because nothing new is written twice.
  useEffect(() => {
    if (!isAdmin) return undefined;
    load();
    fetch("/api/notifications/scan", { cache: "no-store" }).catch(() => {});
    const timer = setInterval(() => {
      load();
      fetch("/api/notifications/scan", { cache: "no-store" }).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [isAdmin, load]);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Running server-side operations. Listed here so a job that outlived the page
  // that started it is still reachable: the banner sits collapsed in a corner
  // with nothing pointing at it, and "where did that import go" has no answer
  // without this list.
  const loadJobs = useCallback(async () => {
    if (!isAdmin) return;
    const live = [];
    try {
      // The proxy-import job predates the generic runner and keeps its own
      // store, so both lists are read and shown as one queue: to the operator
      // "an operation I started is still running" does not depend on which
      // subsystem happens to own it.
      const [imports, generic] = await Promise.all([
        fetch("/api/proxy-pools/import-jobs", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : { jobs: [] }))
          .catch(() => ({ jobs: [] })),
        fetch("/api/dashboard-jobs", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : { jobs: [] }))
          .catch(() => ({ jobs: [] })),
      ]);

      for (const job of Array.isArray(imports.jobs) ? imports.jobs : []) {
        if (job.status === "queued" || job.status === "running") {
          live.push({
            id: job.id,
            taskId: "proxy-pools-import",
            title: "Importing proxies",
            message: job.message || "",
            progress: Number(job.progress) || 0,
            href: "/dashboard/proxy-pools",
          });
        }
      }
      for (const job of Array.isArray(generic.jobs) ? generic.jobs : []) {
        if (job.status === "queued" || job.status === "running") {
          live.push({
            id: job.id,
            // The banner for this job is keyed the same way on the task store,
            // which is how the click below knows whether to reopen a banner it
            // is already rendering or to navigate to the page that owns it.
            taskId: `dashboard-job-${job.kind}`,
            title: job.title || job.kind,
            message: job.message || "",
            progress: Number(job.progress) || 0,
            href: "/dashboard/proxy-pools",
          });
        }
      }
      live.sort((a, b) => (a.id < b.id ? 1 : -1));
      setJobs(live);
    } catch {
      // A failed poll must not disturb the header.
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    loadJobs();
    const timer = setInterval(loadJobs, 4000);
    return () => clearInterval(timer);
  }, [isAdmin, loadJobs]);

  // The task store holds whatever banner is mounted; when a job is showing there
  // already the bell only mirrors its state, and clicking must not expand two
  // cards for one operation. (The selector returns the store array itself, not
  // a derived .map(): a derived array is a new reference every render, which
  // re-subscribes the component on every paint and loops the page to death.)
  const tasks = useTaskStore((state) => state.tasks);
  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);

  const markAllRead = async () => {
    setUnread(0);
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", id: "all" }),
      });
      if (res.ok) {
        const data = await res.json();
        if (Number.isFinite(data.unread)) setUnread(data.unread);
      }
    } catch {
      load();
    }
  };

  if (!isAdmin) return null;

  const visible = items.filter((n) => !n.cleared);

  return (
    <div className="relative z-[60]" ref={ref}>
      <button
        type="button"
        onClick={() =>
          setOpen((v) => {
            // Refresh on open: a poll interval is right for the badge, but a
            // user opening the panel is asking "what is running right now"
            // and must not wait out the remainder of a 4s tick.
            if (!v) loadJobs();
            return !v;
          })
        }
        className="relative flex items-center justify-center size-8 rounded-[10px] text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors"
        title="Notifications"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        aria-expanded={open}
      >
        <span className="material-symbols-outlined text-[20px]">notifications</span>
        {unread > 0 && (
          <span
            className={`absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-bold leading-[15px] text-white ${
              items.some((n) => !n.read && n.severity === "error") ? "bg-red-500" : "bg-primary"
            }`}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[min(340px,calc(100vw-2rem))] rounded-xl border border-border-subtle bg-surface shadow-2xl z-[9999] overflow-hidden">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border-subtle">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Notifications
            </span>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-[11px] text-primary hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>

          {jobs.length > 0 && (
            <>
              <div className="px-3.5 pt-3 pb-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Running in background
                </span>
              </div>
              {jobs.map((job) => {
                const pct = Number(job.progress) || 0;
                const alreadyShown = taskIds.includes(job.taskId);
                return (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      // Expand the collapsed corner card instead of rendering a
                      // second copy of it. Navigation lands where the operator
                      // started the run, so the task store reconnects and the
                      // banner reopens on the run itself.
                      revealBackgroundedTasks();
                      if (!alreadyShown && typeof window !== "undefined") {
                        window.location.assign(job.href || "/dashboard/proxy-pools");
                      } else if (typeof window !== "undefined") {
                        window.dispatchEvent(new CustomEvent("9r:reveal-tasks"));
                      }
                    }}
                    className="block w-full text-left border-b border-border-subtle/60 last:border-0"
                  >
                    <span className="flex items-start gap-2 px-3.5 py-2.5 transition-colors hover:bg-surface-2">
                      <span className="material-symbols-outlined text-[16px] mt-0.5 shrink-0 text-primary">
                        progress_activity
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-text-main">
                          {job.title}
                        </span>
                        <span className="block text-[11px] text-text-muted mt-0.5 break-words">
                          {job.message || `${pct}%`}
                        </span>
                        <span className="mt-1.5 block h-1 overflow-hidden rounded bg-border">
                          <span
                            className="block h-full bg-primary transition-[width] duration-300"
                            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                          />
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-primary">
                        {pct}%
                      </span>
                    </span>
                  </button>
                );
              })}
            </>
          )}
          <div className="max-h-[min(380px,60vh)] overflow-y-auto">
            {visible.length === 0 ? (
              // Only claim "nothing" when the panel really is empty: a running
              // job listed just above contradicts it.
              <div className="px-4 py-5 text-center">
                <p className="text-xs text-text-muted">
                  {jobs.length > 0 ? "No notifications." : "No new notifications."}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setChangelogOpen(true);
                  }}
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-text-main hover:border-primary/40 hover:text-primary transition-colors"
                >
                  <span className="material-symbols-outlined text-[14px]">history</span>
                  <span>View Changelog</span>
                </button>
              </div>
            ) : (
              visible.map((n) => {
                const style = SEVERITY_STYLE[n.severity] || SEVERITY_STYLE.info;
                const body = (
                  <>
                    <span className={`flex items-start gap-2 px-3.5 py-2.5 transition-colors hover:bg-surface-2 ${n.read ? "opacity-65" : ""}`}>
                      <span className={`material-symbols-outlined text-[16px] mt-0.5 shrink-0 ${style.text}`}>
                        {style.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-text-main">{n.title}</span>
                        {n.body && (
                          <span className="block text-[11px] text-text-muted mt-0.5 break-words">
                            {n.body}
                          </span>
                        )}
                        <span className="block text-[10px] text-text-muted/70 mt-1">
                          {new Date(n.at).toLocaleString()}
                        </span>
                      </span>
                      {!n.read && <span className={`size-1.5 rounded-full mt-1.5 shrink-0 ${style.dot}`} />}
                    </span>
                  </>
                );
                // Every entry opens the changelog: the bell says something
                // changed, and the changelog says what.
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setChangelogOpen(true);
                    }}
                    className="block w-full text-left border-b border-border-subtle/60 last:border-0"
                  >
                    {body}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      <ChangelogModal isOpen={changelogOpen} onClose={() => setChangelogOpen(false)} />
    </div>
  );
}