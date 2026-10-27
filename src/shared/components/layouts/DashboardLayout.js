"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useNotificationStore } from "@/store/notificationStore";
import LeftRail from "../LeftRail";
import MobileNav from "../MobileNav";
import PageHeading from "../PageHeading";
import StatusBar from "../StatusBar";
import WelcomeModal from "../WelcomeModal";
import UpdateBanner from "../UpdateBanner";
import TaskDock from "../TaskDock";

/* Toast variants pull from the semantic token triplet, so the same toast is
   legible in Ember dark and in light without a dark: override per variant. */
function getToastStyle(type) {
  if (type === "success") {
    return { wrapper: "border-success/40 bg-success/12 text-success", icon: "check_circle" };
  }
  if (type === "error") {
    return { wrapper: "border-danger/40 bg-danger/12 text-danger", icon: "error" };
  }
  if (type === "warning") {
    return { wrapper: "border-warning/40 bg-warning/12 text-warning", icon: "warning" };
  }
  return { wrapper: "border-border bg-surface text-text-main", icon: "info" };
}

/* Pages that render their own hero / heading block, so the layout heading band
   would duplicate them. Keyed by the exact pathname or a prefix. */
const PAGES_WITH_OWN_HEADING = [
  "/dashboard",
  "/dashboard/endpoint",
  "/dashboard/basic-chat",
  "/dashboard/providers/new",
  "/dashboard/plugins",
  "/dashboard/api-key-usage",
  "/dashboard/translator",
  "/dashboard/model-bypass",
  "/dashboard/arena",
  "/dashboard/model-editor",
  "/dashboard/prompt-injection",
  "/dashboard/combos",
  "/dashboard/prd-builder",
  "/dashboard/connection",
];

function hasOwnHeading(pathname) {
  if (!pathname) return false;
  if (pathname === "/dashboard" || pathname === "/dashboard/endpoint") return true;
  if (PAGES_WITH_OWN_HEADING.some((p) => p !== "/dashboard" && (pathname === p || pathname.startsWith(`${p}/`)))) return true;
  // Provider / media-provider detail pages draw their own hero with the logo.
  if (/^\/dashboard\/providers\/[^/]+$/.test(pathname)) return true;
  if (/^\/dashboard\/media-providers\/[^/]+\/[^/]+$/.test(pathname)) return true;
  if (/^\/dashboard\/cli-tools\/[^/]+$/.test(pathname)) return true;
  return false;
}

export default function DashboardLayout({ children }) {
  const pathname = usePathname();
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);

  // Security: Inactivity / Idle Timeout (OWASP protection for public PCs / warnet)
  // Auto-logs out if no keyboard/mouse/touch interaction for 60 minutes.
  useEffect(() => {
    const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes of true inactivity
    let lastActive = Date.now();

    const recordActivity = () => {
      lastActive = Date.now();
    };

    const events = ["mousemove", "keydown", "click", "touchstart", "scroll"];
    events.forEach((evt) => window.addEventListener(evt, recordActivity, { passive: true }));

    const idleTimer = setInterval(() => {
      if (Date.now() - lastActive > IDLE_TIMEOUT_MS) {
        // True inactivity reached: terminate session to protect warnet / shared devices
        fetch("/api/auth/logout", { method: "POST" })
          .finally(() => {
            window.location.href = "/login?reason=idle_timeout";
          });
      }
    }, 30000); // Check every 30 seconds

    return () => {
      events.forEach((evt) => window.removeEventListener(evt, recordActivity));
      clearInterval(idleTimer);
    };
  }, []);

  const isChat = pathname === "/dashboard/basic-chat";
  const showHeading = !hasOwnHeading(pathname);

  return (
    // The root owns the stacking context (relative + z-0). It must NOT be
    // `isolate` on the inner <main>: an `isolate` there opens a nested
    // stacking context, which traps every `fixed inset-0 z-50` overlay
    // declared inside the page below the `z-30` mobile app header — the
    // header then paints over the modal and hides its title row.
    <div className="relative z-0 flex h-screen w-full overflow-hidden bg-bg">
      {/* Toasts - High z-index to stay above charts, cards, and page headings */}
      <div className="fixed top-4 right-4 z-[9999] flex w-[min(92vw,380px)] flex-col gap-2 pointer-events-none">
        {notifications.map((n) => {
          const style = getToastStyle(n.type);
          return (
            <div
              key={n.id}
              role="status"
              className={`slide-in-right pointer-events-auto rounded-[6px] border px-3.5 py-2.5 shadow-[var(--shadow-elev)] ${style.wrapper}`}
            >
              <div className="flex items-start gap-2">
                <span className="material-symbols-outlined mt-0.5 shrink-0 text-[18px] leading-5">{style.icon}</span>
                <div className="min-w-0 flex-1">
                  {n.title ? <p className="mb-0.5 text-xs font-semibold">{n.title}</p> : null}
                  <p className="whitespace-pre-wrap break-words text-xs">{n.message}</p>
                </div>
                {n.dismissible ? (
                  <button
                    type="button"
                    onClick={() => removeNotification(n.id)}
                    className="opacity-70 transition-opacity hover:opacity-100"
                    aria-label="Dismiss notification"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <WelcomeModal />

      {/* Left-docked navigation (desktop) */}
      <LeftRail />

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
      <TaskDock />

      {/* Docked mobile top bar */}
      <div className="relative z-50">
        <MobileNav />
      </div>

      <div className="relative z-40">
        <UpdateBanner />
      </div>

        {/* No `isolate` here on purpose. `isolate` opens a stacking context,
            which traps every `fixed inset-0 z-50` overlay declared inside the
            page below the `z-30` mobile app header — the header then paints
            over the modal and hides its title row. The veil is the only
            element that needs to sit behind the content, and it already uses
            `-z-10` against the root stacking context. */}
        <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="ember-veil pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />
          {showHeading ? <PageHeading className="shrink-0" /> : null}
          <div
            className={
              isChat
                ? "flex min-h-0 flex-1 flex-col overflow-hidden"
                : "min-h-0 flex-1 overflow-y-auto custom-scrollbar"
            }
          >
            <div className={isChat ? "flex h-full w-full flex-col" : "w-full px-4 py-5 lg:px-8 lg:py-6"}>
              {children}
            </div>
          </div>
        </main>

        {/* Instrument status strip */}
        <StatusBar />
      </div>
    </div>
  );
}
