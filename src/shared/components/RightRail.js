"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG } from "@/shared/constants/config";
import LogoMark from "@/shared/components/LogoMark";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import HeaderMenu from "@/shared/components/HeaderMenu";
import { useNavigation } from "@/shared/hooks/useNavigation";
import { MEDIA_ITEMS } from "@/shared/constants/navigation";

/* Right rail. Navigation is docked to the right edge as a slim instrument
   column that widens on hover (or when pinned) to reveal labels; group
   flyouts open leftward into the content. The deliberate break from the
   upstream template: not a left sidebar, not a top bar, but a right-docked
   control rail whose active section is marked by an ember bar on the
   content-facing edge. */

function RailRow({ href, icon, label, active, open, onClick, badge = null }) {
  const inner = (
    <>
      <span
        className={cn(
          "material-symbols-outlined shrink-0 text-[19px] leading-none",
          active ? "text-primary" : "text-text-subtle"
        )}
      >
        {icon}
      </span>
      {open && (
        <span className={cn("flex-1 truncate whitespace-nowrap text-[13px] leading-none", active && "font-semibold")}>
          {label}
        </span>
      )}
      {open && badge}
      {active && (
        <span className="absolute -left-2 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-primary" aria-hidden="true" />
      )}
    </>
  );

  const cls = cn(
    "relative flex h-9 w-full items-center gap-3 rounded-[8px] transition-colors duration-150",
    open ? "px-2.5" : "justify-center px-0",
    active ? "text-text-main" : "text-text-muted hover:bg-surface-3 hover:text-text-main"
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
        "relative flex h-9 w-full items-center gap-3 rounded-[8px] transition-colors duration-150",
        open ? "px-2.5" : "justify-center px-0",
        active || expanded ? "text-text-main" : "text-text-muted hover:bg-surface-3 hover:text-text-main"
      )}
    >
      <span
        className={cn(
          "material-symbols-outlined shrink-0 text-[19px] leading-none",
          active || expanded ? "text-primary" : "text-text-subtle"
        )}
      >
        {icon}
      </span>
      {open && (
        <>
          <span className={cn("flex-1 truncate whitespace-nowrap text-left text-[13px] leading-none", active && "font-semibold")}>
            {label}
          </span>
          <span
            className="material-symbols-outlined text-[15px] leading-none text-text-subtle transition-transform duration-200"
            style={{ transform: expanded ? "rotate(-90deg)" : "rotate(0deg)" }}
          >
            chevron_left
          </span>
        </>
      )}
      {active && (
        <span className="absolute -left-2 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-primary" aria-hidden="true" />
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
    <div className="fade-in absolute right-full top-2.5 z-50 mr-2 w-[236px] rounded-[6px] border border-border bg-surface p-1.5 shadow-[var(--shadow-elev)]">
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
        "flex items-center gap-2.5 rounded-[6px] px-2.5 py-[7px] transition-colors",
        active ? "bg-brand-500/12 text-text-main" : "text-text-muted hover:bg-surface-2 hover:text-text-main"
      )}
    >
      <span className={cn("material-symbols-outlined shrink-0 text-[16px] leading-none", active && "text-primary")}>
        {icon}
      </span>
      <span className={cn("flex-1 truncate text-[12.5px] leading-none", active && "font-semibold")}>{label}</span>
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

export default function RightRail() {
  const pathname = usePathname();
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState(null);
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

  const open = hovered || pinned;

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
    setHovered(false);
  }, [pathname]);

  useEffect(() => {
    if (!expandedGroup) return;
    const onDocClick = (e) => {
      if (railRef.current && !railRef.current.contains(e.target)) setExpandedGroup(null);
    };
    const onEsc = (e) => e.key === "Escape" && setExpandedGroup(null);
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [expandedGroup]);

  const workshopActive = workshopItems.some((i) => isActive(i.href));
  const systemActive =
    pathname.startsWith("/dashboard/media-providers") ||
    systemItems.some((i) => isActive(i.href)) ||
    debugItems.some((i) => isActive(i.href)) ||
    isActive("/dashboard/profile");

  const searchVisible = useHeaderSearchStore((s) => s.visible);
  const searchQuery = useHeaderSearchStore((s) => s.query);
  const searchPlaceholder = useHeaderSearchStore((s) => s.placeholder);
  const setSearchQuery = useHeaderSearchStore((s) => s.setQuery);

  return (
    <aside
      ref={railRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "relative z-40 hidden h-full shrink-0 flex-col border-l border-border bg-surface-2 px-2 py-2.5 transition-[width] duration-200 ease-out lg:flex",
        open ? "w-[228px]" : "w-[60px]"
      )}
      aria-label="Main navigation"
    >
      {/* Brand */}
      <Link
        href="/dashboard"
        title={APP_CONFIG.name}
        className={cn(
          "flex h-10 items-center gap-2.5 rounded-[8px] transition-colors hover:bg-surface-3",
          open ? "px-2" : "justify-center"
        )}
      >
        <span
          className="relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border bg-surface-2 p-0.5"
          style={{ borderColor: "var(--color-primary, #E56A4A)" }}
        >
          <LogoMark className="size-full" />
        </span>
        {open && (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-semibold leading-tight tracking-tight text-text-main">
              {APP_CONFIG.name}
            </span>
            <span className="font-mono text-[10px] leading-tight tabular-nums text-text-subtle">
              v{APP_CONFIG.version}
            </span>
          </span>
        )}
      </Link>

      <span className="my-2 h-px w-full shrink-0 bg-border-subtle" aria-hidden="true" />

      {/* Primary sections */}
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden custom-scrollbar">
        {navItems.map((item) => (
          <RailRow
            key={item.href}
            href={item.href}
            icon={item.icon}
            label={item.label}
            active={isActive(item.href)}
            open={open}
          />
        ))}

        <span className="my-2 h-px w-full shrink-0 bg-border-subtle" aria-hidden="true" />

        {workshopItems.length > 0 && (
          <GroupRow
            icon="auto_awesome_motion"
            label="Feature+"
            active={workshopActive}
            open={open}
            expanded={expandedGroup === "workshop"}
            onClick={() => setExpandedGroup((g) => (g === "workshop" ? null : "workshop"))}
          />
        )}

        {showSystemGroup && (
          <GroupRow
            icon="settings_suggest"
            label="System"
            active={systemActive}
            open={open}
            expanded={expandedGroup === "system"}
            onClick={() => setExpandedGroup((g) => (g === "system" ? null : "system"))}
          />
        )}
      </nav>

      {/* Utilities */}
      <span className="my-2 h-px w-full shrink-0 bg-border-subtle" aria-hidden="true" />

      <div className="flex shrink-0 flex-col gap-0.5">
        {searchVisible && open && (
          <div className="relative mb-1">
            <span className="material-symbols-outlined pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[16px] text-text-muted">
              search
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 w-full rounded-[6px] border border-border bg-bg-alt pl-7 pr-2 text-[12.5px] focus:border-primary/50 focus:outline-none"
            />
          </div>
        )}
        {searchVisible && !open && (
          <RailRow icon="search" label="Search" open={false} onClick={() => setPinned(true)} />
        )}

        <RailRow
          icon={pinned ? "push_pin" : "keep"}
          label={pinned ? "Unpin rail" : "Pin rail open"}
          open={open}
          onClick={() => setPinned((v) => !v)}
        />
        {/* Settings is listed once, from systemItems, in the System group —
            a second copy here made the rail show it twice. */}
        <a
          href="https://github.com/johsua092-ui/x-router"
          target="_blank"
          rel="noopener noreferrer"
          title="GitHub Repository"
          className={cn(
            "flex h-9 items-center gap-3 rounded-[8px] text-text-muted transition-colors hover:bg-surface-3 hover:text-text-main",
            open ? "px-2.5" : "justify-center"
          )}
        >
          <svg className="size-[17px] shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
          </svg>
          {open && <span className="truncate text-[13px] leading-none">Repository</span>}
        </a>
        <div className={cn("flex h-9 items-center", open ? "justify-start" : "justify-center")}>
          <HeaderMenu onLogout={handleLogout} />
        </div>
      </div>

      {/* Group flyouts open leftward, into the content column. */}
      {expandedGroup === "workshop" && (
        <Flyout>
          {workshopItems.map((item) => (
            <FlyoutLink
              key={item.href}
              href={item.href}
              icon={item.icon}
              label={item.label}
              active={isActive(item.href)}
              onClick={() => setExpandedGroup(null)}
            />
          ))}
        </Flyout>
      )}

      {expandedGroup === "system" && (
        <Flyout>
          <div className="flex max-h-[calc(min(100dvh,100svh)-8rem)] flex-col overflow-y-auto overscroll-contain custom-scrollbar">
            {canOpenMedia && (
              <>
                <div className="px-2.5 pb-1 pt-2">
                  <span className="micro-label">Media Providers</span>
                </div>
                {MEDIA_ITEMS.map((item) => (
                  <FlyoutLink
                    key={item.href}
                    href={item.href}
                    icon={item.icon}
                    label={item.label}
                    active={pathname.startsWith(item.href)}
                    onClick={() => setExpandedGroup(null)}
                    badge={
                      item.href === "/dashboard/media-providers/web" && hasMediaNew ? (
                        <span className="rounded-[3px] bg-brand-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
                          Baru
                        </span>
                      ) : null
                    }
                  />
                ))}
                <div className="my-1.5 h-px bg-border-subtle" aria-hidden="true" />
              </>
            )}
            {systemItems.map((item) => (
              <FlyoutLink
                key={item.href}
                href={item.href}
                icon={item.icon}
                label={item.label}
                active={isActive(item.href)}
                onClick={() => setExpandedGroup(null)}
              />
            ))}
            {debugItems.map((item) => (
              <FlyoutLink
                key={item.href}
                href={item.href}
                icon={item.icon}
                label={item.label}
                active={isActive(item.href)}
                onClick={() => setExpandedGroup(null)}
              />
            ))}
            {/* Settings comes from systemItems — no second hardcoded row. */}
          </div>
        </Flyout>
      )}
    </aside>
  );
}

RightRail.propTypes = {};
