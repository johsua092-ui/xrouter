"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG } from "@/shared/constants/config";
import HeaderMenu from "@/shared/components/HeaderMenu";
import LogoMark from "@/shared/components/LogoMark";
import { useNavigation } from "@/shared/hooks/useNavigation";
import { MEDIA_ITEMS } from "@/shared/constants/navigation";

/* Suspended Studio Rail. Navigation is a floating, rounded instrument dock
   docked to the left edge with 10px margin. Can be compact (58px icon-only)
   or pinned/expanded (216px). Flyout sub-menus expand rightward into the canvas.
   Active item is marked with a glowing ember indicator. */

function RailRow({ href, icon, label, active, open, onClick, badge = null }) {
  const inner = (
    <>
      <span
        className={cn(
          "material-symbols-outlined shrink-0 text-[18px] leading-none transition-colors",
          active ? "text-primary font-semibold" : "text-text-main/70"
        )}
      >
        {icon}
      </span>
      {open && (
        <span className={cn("flex-1 truncate whitespace-nowrap text-[12.5px] leading-none", active ? "font-semibold text-primary" : "text-text-main/80")}>
          {label}
        </span>
      )}
      {open && badge}
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-r bg-primary shadow-[0_0_8px_rgba(var(--color-primary-rgb,229,106,74),0.6)]" aria-hidden="true" />
      )}
    </>
  );

  const cls = cn(
    "relative flex h-7.5 w-full items-center gap-2 rounded-[5px] transition-colors duration-150 cursor-pointer",
    open ? "px-2" : "justify-center px-0",
    active ? "bg-primary/15 text-primary font-medium border border-border-subtle" : "text-text-main/80 hover:bg-surface-2 hover:text-text-main"
  );

  if (href) {
    return (
      <Link href={href} onClick={onClick} title={label} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} title={label} className={cls}>
      {inner}
    </button>
  );
}

RailRow.propTypes = {
  href: PropTypes.string,
  icon: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  active: PropTypes.bool,
  open: PropTypes.bool,
  onClick: PropTypes.func,
  badge: PropTypes.node,
};

function GroupRow({ icon, label, active, open, expanded, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-expanded={expanded}
      className={cn(
        "relative flex h-7.5 w-full items-center gap-2 rounded-[5px] transition-colors duration-150 cursor-pointer",
        open ? "px-2" : "justify-center px-0",
        active || expanded ? "bg-primary/15 text-primary border border-border-subtle font-medium" : "text-text-main/80 hover:bg-surface-2 hover:text-text-main"
      )}
    >
      <span
        className={cn(
          "material-symbols-outlined shrink-0 text-[18px] leading-none transition-colors",
          active || expanded ? "text-primary" : "text-text-main/70"
        )}
      >
        {icon}
      </span>
      {open && (
        <>
          <span className={cn("flex-1 truncate whitespace-nowrap text-left text-[12.5px] leading-none", (active || expanded) && "font-semibold text-primary")}>
            {label}
          </span>
          <span
            className="material-symbols-outlined text-[14px] leading-none text-text-subtle transition-transform duration-200"
            style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            chevron_right
          </span>
        </>
      )}
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-r bg-primary shadow-[0_0_8px_rgba(var(--color-primary-rgb,229,106,74),0.6)]" aria-hidden="true" />
      )}
    </button>
  );
}

GroupRow.propTypes = {
  icon: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  active: PropTypes.bool,
  open: PropTypes.bool,
  expanded: PropTypes.bool,
  onClick: PropTypes.func,
};

function Flyout({ children }) {
  return (
    <div className="fade-in absolute left-full top-1 z-50 ml-2.5 w-[240px] rounded-[6px] border border-border bg-surface p-1.5 shadow-[var(--shadow-elev)]">
      {children}
    </div>
  );
}

Flyout.propTypes = { children: PropTypes.node };

export function FlyoutLink({ href, icon, label, active, onClick, badge = null }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      title={label}
      className={cn(
        "flex items-center gap-2 rounded-[4px] px-2.5 py-[6px] transition-colors",
        active ? "bg-primary/15 text-primary font-medium" : "text-text-main/80 hover:bg-surface-2 hover:text-text-main"
      )}
    >
      <span className={cn("material-symbols-outlined shrink-0 text-[15px] leading-none transition-colors", active ? "text-primary" : "text-text-main/70")}>
        {icon}
      </span>
      <span className={cn("flex-1 truncate text-[12px] leading-none", active && "font-semibold text-primary")}>{label}</span>
      {badge}
    </Link>
  );
}

FlyoutLink.propTypes = {
  href: PropTypes.string.isRequired,
  icon: PropTypes.string,
  label: PropTypes.string.isRequired,
  active: PropTypes.bool,
  onClick: PropTypes.func,
  badge: PropTypes.node,
};

export default function LeftRail() {
  const pathname = usePathname();
  const [pinned, setPinned] = useState(true);
  const [expandedGroup, setExpandedGroup] = useState(null);
  const [displayPort, setDisplayPort] = useState("8080");
  const railRef = useRef(null);

  const {
    navItems,
    workshopItems,
    debugItems,
    systemItems,
    canOpenMedia,
    showSystemGroup,
    isApiKeyUser,
    hasMediaNew,
    isActive,
  } = useNavigation();

  useEffect(() => {
    try {
      const saved = localStorage.getItem("xrouter_left_rail_pinned");
      if (saved !== null) {
        setPinned(saved === "true");
      }
    } catch {}

    // Derive live port from window location or health endpoint
    if (typeof window !== "undefined") {
      if (window.location.port) {
        setDisplayPort(window.location.port);
      } else {
        // Reverse proxy without port (80/443), query server health probe
        fetch("/api/health", { cache: "no-store" })
          .then((r) => r.json())
          .then((d) => {
            if (d?.port) setDisplayPort(String(d.port));
          })
          .catch(() => {});
      }
    }
  }, []);

  const handleTogglePin = (e) => {
    e?.preventDefault();
    e?.stopPropagation();
    setPinned((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("xrouter_left_rail_pinned", String(next));
      } catch {}
      return next;
    });
  };

  const open = pinned;

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) window.location.assign("/login");
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  useEffect(() => {
    setExpandedGroup(null);
  }, [pathname]);

  useEffect(() => {
    if (!expandedGroup) return;
    const onDocClick = (e) => {
      if (railRef.current && !railRef.current.contains(e.target)) {
        setExpandedGroup(null);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [expandedGroup]);

  // Split nav items into core routing vs telemetry for clean visual hierarchy
  const coreRoutingHrefs = ["/dashboard/endpoint", "/dashboard/providers", "/dashboard/combos"];
  const coreRouting = navItems.filter((i) => coreRoutingHrefs.includes(i.href));
  const telemetry = navItems.filter((i) => !coreRoutingHrefs.includes(i.href));

  return (
    <aside
      ref={railRef}
      onMouseLeave={() => {
        setExpandedGroup(null);
      }}
      className={cn(
        "relative isolate hidden my-2 ml-2 h-[calc(100vh-16px)] flex-col rounded-[8px] border border-border bg-surface select-none lg:flex z-30 shrink-0 shadow-lg",
        open ? "w-[212px] overflow-hidden" : "w-[52px]"
      )}
      aria-label="Application navigation"
    >
      {/* Brand header */}
      <div className={cn(
        "flex h-12 items-center border-b border-border px-2 shrink-0 bg-surface-2 gap-1.5",
        open ? "justify-between" : "justify-center relative"
      )}>
        {open ? (
          <>
            <Link
              href="/dashboard/endpoint"
              className="flex items-center gap-2 overflow-hidden transition-opacity hover:opacity-90 min-w-0 flex-1"
              title="X Router Dashboard"
            >
              <div className="size-7 rounded-[5px] border border-primary/40 bg-surface-2 flex items-center justify-center shrink-0 shadow-xs overflow-hidden p-0.5">
                <LogoMark className="size-full" />
              </div>
              <div className="min-w-0 flex flex-col flex-1">
                <span className="text-[11.5px] font-bold tracking-wider uppercase text-text-main truncate">
                  {APP_CONFIG.name}
                </span>
                <span className="text-[9.5px] font-mono text-text-muted truncate">
                  v{APP_CONFIG.version}
                </span>
              </div>
            </Link>

            <button
              type="button"
              onClick={handleTogglePin}
              className="p-1.5 rounded-[5px] text-text-muted hover:text-text-main hover:bg-surface-3 transition-colors cursor-pointer shrink-0 border border-transparent hover:border-border"
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              <span className="material-symbols-outlined text-[17px] leading-none text-primary">
                left_panel_close
              </span>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={handleTogglePin}
            className="size-8 rounded-[6px] text-text-muted hover:text-text-main hover:bg-surface-3 transition-colors cursor-pointer flex items-center justify-center shrink-0 border border-border/60 hover:border-primary/50"
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <span className="material-symbols-outlined text-[18px] leading-none text-primary">
              left_panel_open
            </span>
          </button>
        )}
      </div>

      {/* Main navigation list */}
      <div className="flex-1 overflow-y-auto px-2 py-2.5 custom-scrollbar space-y-3">
        {/* Core Routing */}
        <div className="space-y-0.5">
          {open && (
            <div className="px-2 pb-1 text-[9.5px] font-mono uppercase tracking-wider text-text-subtle">
              Routing
            </div>
          )}
          {coreRouting.map((item) => (
            <RailRow
              key={item.href}
              href={item.href}
              icon={item.icon}
              label={item.label}
              active={isActive(item.href)}
              open={open}
              onClick={() => setExpandedGroup(null)}
            />
          ))}
        </div>

        {/* Telemetry & Policies */}
        <div className="space-y-0.5 pt-1 border-t border-border-subtle">
          {open && (
            <div className="px-2 pb-1 text-[9.5px] font-mono uppercase tracking-wider text-text-subtle">
              Operations
            </div>
          )}
          {telemetry.map((item) => (
            <RailRow
              key={item.href}
              href={item.href}
              icon={item.icon}
              label={item.label}
              active={isActive(item.href)}
              open={open}
              onClick={() => setExpandedGroup(null)}
            />
          ))}
          {!isApiKeyUser && (
            <RailRow
              href="/dashboard/vouchers"
              icon="card_giftcard"
              label="Vouchers & Market"
              active={isActive("/dashboard/vouchers")}
              open={open}
              onClick={() => setExpandedGroup(null)}
            />
          )}
        </div>

        {/* Extensions & System */}
        {(workshopItems.length > 0 || showSystemGroup) && (
          <div className="space-y-0.5 pt-1 border-t border-border-subtle">
            {open && (
              <div className="px-2 pb-1 text-[9.5px] font-mono uppercase tracking-wider text-text-subtle">
                Extensions
              </div>
            )}
            {/* Feature+ Group */}
            {workshopItems.length > 0 && (
              <div>
                <GroupRow
                  icon="auto_awesome"
                  label="Features"
                  active={workshopItems.some((i) => isActive(i.href))}
                  open={open}
                  expanded={expandedGroup === "workshop"}
                  onClick={() => setExpandedGroup((prev) => (prev === "workshop" ? null : "workshop"))}
                />
                {expandedGroup === "workshop" && (
                  <div className={cn("mt-1 space-y-0.5", open ? "pl-3 border-l-2 border-border-subtle ml-3" : "px-0")}>
                    {workshopItems.map((item) => (
                      open ? (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={() => setExpandedGroup(null)}
                          title={item.label}
                          className={cn(
                            "flex items-center gap-2 rounded-[4px] px-2 py-1 text-[12px] transition-colors",
                            isActive(item.href)
                              ? "bg-primary/15 text-primary font-medium"
                              : "text-text-main/70 hover:bg-surface-2 hover:text-text-main"
                          )}
                        >
                          <span className={cn("material-symbols-outlined shrink-0 text-[15px] leading-none", isActive(item.href) ? "text-primary" : "text-text-main/60")}>
                            {item.icon}
                          </span>
                          <span className="truncate">{item.label}</span>
                        </Link>
                      ) : (
                        <RailRow
                          key={item.href}
                          href={item.href}
                          icon={item.icon}
                          label={item.label}
                          active={isActive(item.href)}
                          open={false}
                          onClick={() => setExpandedGroup(null)}
                        />
                      )
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* System Group */}
          {showSystemGroup && (
            <div>
              <GroupRow
                icon="tune"
                label="System"
                active={
                  systemItems.some((i) => isActive(i.href)) ||
                  debugItems.some((i) => isActive(i.href)) ||
                  MEDIA_ITEMS.some((i) => isActive(i.href))
                }
                open={open}
                expanded={expandedGroup === "system"}
                onClick={() => setExpandedGroup((prev) => (prev === "system" ? null : "system"))}
              />
              {expandedGroup === "system" && (
                <div className={cn("mt-1 space-y-0.5", open ? "pl-3 border-l-2 border-border-subtle ml-3" : "px-0")}>
                  {canOpenMedia && (
                    <div className={cn("mb-1 pb-1", open ? "border-b border-border-subtle" : "")}>
                      {open && (
                        <div className="px-1 py-0.5 text-[9.5px] font-medium text-text-subtle uppercase">
                          Media Engines
                        </div>
                      )}
                      {MEDIA_ITEMS.map((item) => (
                        open ? (
                          <Link
                            key={item.href}
                            href={item.href}
                            onClick={() => setExpandedGroup(null)}
                            title={item.label}
                            className={cn(
                              "flex items-center gap-2 rounded-[4px] px-2 py-1 text-[12px] transition-colors",
                              pathname.startsWith(item.href)
                                ? "bg-primary/15 text-primary font-medium"
                                : "text-text-main/70 hover:bg-surface-2 hover:text-text-main"
                            )}
                          >
                            <span className={cn("material-symbols-outlined shrink-0 text-[15px] leading-none", pathname.startsWith(item.href) ? "text-primary" : "text-text-main/60")}>
                              {item.icon}
                            </span>
                            <span className="truncate">{item.label}</span>
                          </Link>
                        ) : (
                          <RailRow
                            key={item.href}
                            href={item.href}
                            icon={item.icon}
                            label={item.label}
                            active={isActive(item.href)}
                            open={false}
                            onClick={() => setExpandedGroup(null)}
                          />
                        )
                      ))}
                    </div>
                  )}

                  {debugItems.map((item) => (
                    open ? (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setExpandedGroup(null)}
                        title={item.label}
                        className={cn(
                          "flex items-center gap-2 rounded-[4px] px-2 py-1 text-[12px] transition-colors",
                          isActive(item.href)
                            ? "bg-primary/15 text-primary font-medium"
                            : "text-text-main/70 hover:bg-surface-2 hover:text-text-main"
                        )}
                      >
                        <span className={cn("material-symbols-outlined shrink-0 text-[15px] leading-none", isActive(item.href) ? "text-primary" : "text-text-main/60")}>
                          {item.icon}
                        </span>
                        <span className="truncate">{item.label}</span>
                      </Link>
                    ) : (
                      <RailRow
                        key={item.href}
                        href={item.href}
                        icon={item.icon}
                        label={item.label}
                        active={isActive(item.href)}
                        open={false}
                        onClick={() => setExpandedGroup(null)}
                      />
                    )
                  ))}

                  {systemItems.map((item) => (
                    open ? (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setExpandedGroup(null)}
                        title={item.label}
                        className={cn(
                          "flex items-center gap-2 rounded-[4px] px-2 py-1 text-[12px] transition-colors",
                          isActive(item.href)
                            ? "bg-primary/15 text-primary font-medium"
                            : "text-text-main/70 hover:bg-surface-2 hover:text-text-main"
                        )}
                      >
                        <span className={cn("material-symbols-outlined shrink-0 text-[15px] leading-none", isActive(item.href) ? "text-primary" : "text-text-main/60")}>
                          {item.icon}
                        </span>
                        <span className="truncate">{item.label}</span>
                      </Link>
                    ) : (
                      <RailRow
                        key={item.href}
                        href={item.href}
                        icon={item.icon}
                        label={item.label}
                        active={isActive(item.href)}
                        open={false}
                        onClick={() => setExpandedGroup(null)}
                      />
                    )
                  ))}
                  </div>
                  )}
                  </div>
                  )}
                  </div>
                  )}
                  </div>

      {/* Footer controls & user menu */}
      <div className="border-t border-border p-2 bg-surface-2 flex items-center justify-between gap-2 shrink-0">
        <div className={cn("flex items-center gap-2 min-w-0 overflow-hidden", !open && "w-full justify-center")}>
          {!isApiKeyUser ? (
            <HeaderMenu onLogout={handleLogout} />
          ) : (
            <div className="flex items-center justify-center p-2 rounded-[6px] text-primary" title="API Session Active">
              <span className="material-symbols-outlined text-[20px]">key</span>
            </div>
          )}
          {open && (
            <div className="min-w-0 flex flex-col">
              <span className="text-[11.5px] font-semibold text-text-main truncate">
                {isApiKeyUser ? "API Session" : "Instance Admin"}
              </span>
              <span className="text-[9.5px] text-success flex items-center gap-1 font-mono">
                <span className="size-1.5 rounded-full bg-success shrink-0" />
                Live {displayPort}
              </span>
            </div>
          )}
        </div>
        {open && isApiKeyUser && (
          <button
            onClick={handleLogout}
            className="flex items-center justify-center p-1.5 rounded-[6px] text-primary hover:bg-primary/10 transition-colors"
            title="Log Out"
          >
            <span className="material-symbols-outlined text-[18px]">logout</span>
          </button>
        )}
      </div>
    </aside>
  );
}
