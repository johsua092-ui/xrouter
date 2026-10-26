"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG } from "@/shared/constants/config";
import { useNavigation } from "@/shared/hooks/useNavigation";
import { MEDIA_ITEMS } from "@/shared/constants/navigation";
import HeaderMenu from "@/shared/components/HeaderMenu";
import ThemeModal from "@/shared/components/ThemeModal";
import NotificationBell from "@/shared/components/NotificationBell";
import LogoMark from "@/shared/components/LogoMark";

/* Mobile navigation: a floating launcher in the bottom-left corner opens a
   full-height sheet. Nothing is docked to the top edge — the rail's mobile
   counterpart is an overlay, not a bar. */

function Section({ label, children }) {
  return (
    <div className="mb-1">
      {label && (
        <div className="flex items-center gap-2.5 px-3 pb-1 pt-3">
          <span className="micro-label">{label}</span>
          <span className="ember-rule-left flex-1 opacity-60" aria-hidden="true" />
        </div>
      )}
      {children}
    </div>
  );
}

Section.propTypes = { label: PropTypes.string, children: PropTypes.node };

function Row({ href, icon, label, active, onClick, badge = null }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-[7px] px-2.5 py-2 transition-colors",
        active ? "bg-primary/15 text-primary font-medium" : "text-text-main/80 hover:bg-surface-2 hover:text-text-main"
      )}
    >
      <span className={cn("material-symbols-outlined shrink-0 text-[18px] leading-none transition-colors", active ? "text-primary" : "text-text-main/70")}>
        {icon}
      </span>
      <span className={cn("flex-1 truncate text-[12.5px] leading-none", active && "font-semibold text-primary")}>{label}</span>
      {badge}
      {active && <span className="h-3.5 w-[2px] rounded-full bg-primary" aria-hidden="true" />}
    </Link>
  );
}

Row.propTypes = {
  href: PropTypes.string.isRequired,
  icon: PropTypes.string,
  label: PropTypes.string.isRequired,
  active: PropTypes.bool,
  onClick: PropTypes.func,
  badge: PropTypes.node,
};

export default function MobileNav() {
  const [open, setOpen] = useState(false);
  const [themeModalOpen, setThemeModalOpen] = useState(false);
  const pathname = usePathname();
  const { navItems, workshopItems, debugItems, systemItems, canOpenMedia, hasMediaNew, isApiKeyUser, isActive } =
    useNavigation();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [open]);

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) window.location.assign("/login");
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  return (
    <>
      {/* Mobile Top Bar — docked at top of viewport so it never scrolls away or disappears */}
      <header className="sticky top-0 z-40 flex h-12 w-full items-center justify-between border-b border-border bg-surface px-4 lg:hidden shrink-0 shadow-xs">
        <Link href="/dashboard/endpoint" className="flex items-center gap-2.5">
          <div className="size-7 rounded-[6px] border border-primary/40 bg-surface-2 flex items-center justify-center shrink-0 shadow-xs overflow-hidden p-0.5">
            <LogoMark className="size-full" />
          </div>
          <div className="flex flex-col">
            <span className="text-[12.5px] font-bold tracking-wider uppercase text-text-main leading-tight">
              {APP_CONFIG.name}
            </span>
            <span className="text-[9.5px] font-mono text-text-muted leading-tight">
              v{APP_CONFIG.version}
            </span>
          </div>
        </Link>

        <div className="flex items-center gap-2">
          <NotificationBell />
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation menu"
            className="flex h-8 items-center gap-1.5 rounded-[5px] border border-brand-500/40 bg-surface-2 px-3 text-text-main hover:border-brand-500 hover:bg-surface-3 transition-colors cursor-pointer shadow-xs active:scale-95"
          >
            <span className="material-symbols-outlined text-primary text-[19px] leading-none">menu</span>
            <span className="text-xs font-semibold tracking-wider uppercase text-text-main">MENU</span>
          </button>
        </div>
      </header>

      {open && (
        <div className="fixed inset-0 z-[70] lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/70"
          />
          <div className="slide-in-right absolute right-0 top-0 flex h-full w-[min(86vw,330px)] flex-col border-l border-border bg-surface">
            <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border-subtle px-3">
              <span className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-primary/40 bg-surface-2 p-1 shadow-xs">
                <LogoMark className="size-full" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] font-semibold leading-tight text-text-main">
                  {APP_CONFIG.name}
                </span>
                <span className="font-mono text-[10px] leading-tight tabular-nums text-text-subtle">
                  v{APP_CONFIG.version}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="ml-auto rounded-[6px] p-1.5 text-text-muted hover:bg-surface-2 hover:text-text-main"
              >
                <span className="material-symbols-outlined text-[19px] leading-none">close</span>
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2 custom-scrollbar">
              <Section>
                {navItems.map((item) => (
                  <Row
                    key={item.href}
                    href={item.href}
                    icon={item.icon}
                    label={item.label}
                    active={isActive(item.href)}
                  />
                ))}
                {!isApiKeyUser && (
                  <Row
                    href="/dashboard/vouchers"
                    icon="card_giftcard"
                    label="Vouchers & Market"
                    active={isActive("/dashboard/vouchers")}
                  />
                )}
              </Section>

              {workshopItems.length > 0 && (
                <Section label="Feature+">
                  {workshopItems.map((item) => (
                    <Row
                      key={item.href}
                      href={item.href}
                      icon={item.icon}
                      label={item.label}
                      active={isActive(item.href)}
                    />
                  ))}
                </Section>
              )}

              <Section label="System">
                {canOpenMedia &&
                  MEDIA_ITEMS.map((item) => (
                    <Row
                      key={item.href}
                      href={item.href}
                      icon={item.icon}
                      label={item.label}
                      active={pathname.startsWith(item.href)}
                      badge={
                        item.href === "/dashboard/media-providers/web" && hasMediaNew ? (
                          <span className="rounded-[3px] bg-brand-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
                            Baru
                          </span>
                        ) : null
                      }
                    />
                  ))}
                {systemItems.map((item) => (
                  <Row
                    key={item.href}
                    href={item.href}
                    icon={item.icon}
                    label={item.label}
                    active={isActive(item.href)}
                  />
                ))}
                {debugItems.map((item) => (
                  <Row
                    key={item.href}
                    href={item.href}
                    icon={item.icon}
                    label={item.label}
                    active={isActive(item.href)}
                  />
                ))}
              </Section>
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle px-3 py-2.5">
              <a
                href="https://github.com/johsua092-ui/x-router"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-[6px] p-2 text-text-muted hover:bg-surface-2 hover:text-text-main"
                title="GitHub Repository"
              >
                <svg className="size-[17px] shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
              </a>
              <div className="ml-auto flex items-center gap-1">
                {isApiKeyUser && (
                  <button
                    onClick={handleLogout}
                    className="flex items-center justify-center p-2 rounded-[6px] text-danger/80 hover:text-danger hover:bg-danger/10 transition-colors"
                    title="Log Out"
                  >
                    <span className="material-symbols-outlined text-[18px]">logout</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { setOpen(false); setThemeModalOpen(true); }}
                  aria-label="Theme & Appearance"
                  className="flex items-center justify-center p-2 rounded-[6px] text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors cursor-pointer"
                  title="Theme & Appearance"
                >
                  <span className="material-symbols-outlined text-primary text-[20px] leading-none">palette</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ThemeModal isOpen={themeModalOpen} onClose={() => setThemeModalOpen(false)} />
    </>
  );
}
