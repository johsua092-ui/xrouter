"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import useSettingsStore from "@/store/settingsStore";
import LogoMark from "@/shared/components/LogoMark";

// const VISIBLE_MEDIA_KINDS = ["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"];
const VISIBLE_MEDIA_KINDS = ["embedding", "image", "video", "tts", "stt", "systemone"];
// Combined entry: webSearch + webFetch share one page at /dashboard/media-providers/web
const COMBINED_WEB_ITEM = { id: "web", label: "Web Fetch & Search", icon: "travel_explore", href: "/dashboard/media-providers/web" };

const navItems = [
  { href: "/dashboard/endpoint", label: "Endpoint & Key", icon: "api" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns" },
  // { href: "/dashboard/basic-chat", label: "Basic Chat", icon: "chat" }, // Hidden
  { href: "/dashboard/combos", label: "Combo & Vision Adapter", icon: "layers" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
  { href: "/dashboard/token-saver", label: "Token Saver", icon: "savings" },
  // { href: "/dashboard/pxpipe", label: "PXPIPE", icon: "image" },
  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal" },
];

// Custom features added by this fork — open-ended, new tools land here too.
const workshopItems = [
  { href: "/dashboard/arena", label: "Compare Models", icon: "swords" },
  { href: "/dashboard/model-editor", label: "Custom Models", icon: "auto_awesome" },
  { href: "/dashboard/prompt-injection", label: "Prompt Injection", icon: "tune" },
  { href: "/dashboard/plugins", label: "Custom Plugins", icon: "widgets" },
  { href: "/dashboard/prd-builder", label: "PRD Builder", icon: "description" },
];

const debugItems = [
  { href: "/dashboard/console-log", label: "Console Log", icon: "monitor" },
  { href: "/dashboard/translator", label: "Translator", icon: "translate" },
];

const systemItems = [
  { href: "/dashboard/profile", label: "Settings", icon: "settings" },
  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
];

function SectionLabel({ children }) {
  return (
    <div className="flex items-center gap-2.5 px-3 pt-5 pb-1.5">
      <span className="micro-label">{children}</span>
      <span className="ember-rule-left flex-1 opacity-60" aria-hidden="true" />
    </div>
  );
}

function NavLink({ href, icon, label, active, onClick, sub = false }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      title={label}
      className={cn(
        "relative flex min-w-0 items-center gap-2.5 rounded-[8px] transition-colors duration-150",
        sub ? "ml-3 pl-3 pr-2.5 py-[5px]" : "px-2.5 py-[7px]",
        active
          ? "bg-brand-500/12 text-text-main font-semibold"
          : "text-text-muted hover:bg-surface-2 hover:text-text-main"
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[2px] rounded-r-full bg-primary" />
      )}
      <span
        className={cn(
          "material-symbols-outlined shrink-0 leading-none",
          sub ? "text-[15px]" : "text-[17px]",
          active ? "text-primary" : "group-hover:text-primary transition-colors"
        )}
      >
        {icon}
      </span>
      <span className="text-[13px] leading-none min-w-0 truncate">{label}</span>
    </Link>
  );
}

NavLink.propTypes = {
  href: PropTypes.string.isRequired,
  icon: PropTypes.string,
  label: PropTypes.string.isRequired,
  active: PropTypes.bool,
  onClick: PropTypes.func,
  sub: PropTypes.bool,
};

export default function Sidebar({ onClose }) {
  const pathname = usePathname();
  const [mediaOpen, setMediaOpen] = useState(false);
  const [enableTranslator, setEnableTranslator] = useState(false);
  const [authStatus, setAuthStatus] = useState(null);

  useEffect(() => {
    fetch("/api/auth/status")
      .then(res => res.json())
      .then(data => setAuthStatus(data))
      .catch(() => {});
  }, []);

  const isApiKeyUser = authStatus?.role === "apikey";
  const permissions = authStatus?.permissions || { manageApiKeys: true, manageModels: true, manageProviders: true, manageTools: true, manageAdvanced: true, managePlugins: true, manageMediaProviders: true, viewUsage: true };

  const filteredNavItems = navItems.filter((item) => {
    if (!isApiKeyUser) return true;
    if (item.href === "/dashboard/endpoint") return permissions.manageApiKeys;
    if (item.href === "/dashboard/providers") return permissions.manageProviders;
    if (item.href === "/dashboard/combos") return permissions.manageModels;
    if (item.href === "/dashboard/usage") return permissions.viewUsage;
    if (item.href === "/dashboard/api-key-usage") return permissions.viewUsage || permissions.manageApiKeys;
    if (item.href === "/dashboard/quota") return permissions.manageProviders;
    if (item.href === "/dashboard/token-saver" || item.href === "/dashboard/cli-tools") return permissions.manageTools;
    return false;
  });

  const filteredWorkshopItems = workshopItems.filter((item) => {
    if (!isApiKeyUser) return true;
    if (
      item.href === "/dashboard/model-editor" ||
      item.href === "/dashboard/arena" ||
      item.href === "/dashboard/prompt-injection" ||
      item.href === "/dashboard/prd-builder"
    ) {
      return permissions.manageModels;
    }
    if (item.href === "/dashboard/plugins") return permissions.managePlugins;
    return false;
  });

  const filteredDebugItems = debugItems.filter((item) => {
    if (!isApiKeyUser) return true;
    return permissions.manageAdvanced;
  });

  const filteredSystemItems = systemItems.filter((item) => {
    if (!isApiKeyUser) return true;
    return permissions.manageAdvanced;
  });

  const canOpenMedia = !isApiKeyUser || permissions.manageMediaProviders;

  // Settings are an administrator surface, so a key-signed session skips them
  // instead of firing requests it may not read.
  useEffect(() => {
    if (isApiKeyUser) return;
    useSettingsStore.getState().fetchSettings().then((data) => {
      if (data?.enableTranslator) setEnableTranslator(true);
    });
  }, [isApiKeyUser]);

  const isActive = (href) => {
    if (href === "/dashboard/endpoint") {
      return pathname === "/dashboard" || pathname.startsWith("/dashboard/endpoint");
    }
    return pathname.startsWith(href);
  };

  const mediaActive = pathname.startsWith("/dashboard/media-providers");
  const hasMediaNew = MEDIA_PROVIDER_KINDS.some(
    (k) => VISIBLE_MEDIA_KINDS.includes(k.id) && k.isNew
  );

  return (
    <aside className="flex w-[248px] flex-col bg-surface border-r border-border min-h-full">
      {/* Brand block — logo, wordmark, version. The one place the ember
          gradient is allowed, so the shell reads as X Router immediately. */}
      <div className="shrink-0 px-3 pt-3 pb-3 border-b border-border-subtle">
        <Link
          href="/dashboard"
          className="flex items-center gap-2.5 rounded-[9px] p-1.5 -m-1.5 transition-colors hover:bg-surface-2"
        >
          <span className="relative flex items-center justify-center size-8 shrink-0 rounded-[9px] overflow-hidden ring-1 ring-primary/30 bg-surface-2 p-0.5">
            <LogoMark className="size-full" />
          </span>
          <span className="flex flex-col min-w-0">
            <span className="text-[14px] font-semibold tracking-tight text-text-main leading-tight truncate">
              {APP_CONFIG.name}
            </span>
            <span className="text-[10px] font-mono text-text-subtle leading-tight tabular-nums">
              v{APP_CONFIG.version}
            </span>
          </span>
        </Link>

        {isApiKeyUser && (
          <div className="mt-2.5 flex items-center gap-1.5 px-2 py-1 rounded-[6px] bg-brand-500/12 border border-brand-500/25 text-[11px] text-primary font-medium">
            <span className="material-symbols-outlined text-[14px] leading-none">key</span>
            <span className="truncate">{authStatus?.displayName || "API Key User"}</span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-1.5 space-y-px overflow-y-auto custom-scrollbar">
        {filteredNavItems.map((item) => (
          <NavLink
            key={item.href}
            href={item.href}
            icon={item.icon}
            label={item.label}
            active={isActive(item.href)}
            onClick={onClose}
          />
        ))}

        {/* FEATURE+ section — custom tools added by this fork */}
        {filteredWorkshopItems.length > 0 && (
          <>
            <SectionLabel>Feature+</SectionLabel>
            {filteredWorkshopItems.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                icon={item.icon}
                label={item.label}
                active={isActive(item.href)}
                onClick={onClose}
              />
            ))}
          </>
        )}

        {/* System section — an API key session sees only the parts it may use */}
        {(!isApiKeyUser || canOpenMedia || filteredSystemItems.length > 0 || filteredDebugItems.length > 0) && (
          <>
            <SectionLabel>System</SectionLabel>

            {/* Media Providers accordion */}
            {canOpenMedia && (
              <button
                onClick={() => setMediaOpen((v) => !v)}
                className={cn(
                  "relative w-full flex items-center gap-2.5 px-2.5 py-[7px] rounded-[8px] transition-colors text-left",
                  mediaActive
                    ? "bg-brand-500/12 text-text-main font-semibold"
                    : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                )}
              >
                {mediaActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[2px] rounded-r-full bg-primary" />
                )}
                <span className={cn("material-symbols-outlined text-[17px] leading-none shrink-0", mediaActive && "text-primary")}>
                  perm_media
                </span>
                <span className="text-[13px] leading-none flex-1 min-w-0 truncate" title="Media Providers">
                  Media Providers
                </span>
                {hasMediaNew && (
                  <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-[4px] bg-brand-500/15 text-primary shrink-0">
                    Baru
                  </span>
                )}
                <span
                  className="material-symbols-outlined text-[15px] leading-none shrink-0 transition-transform duration-200"
                  style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}
                >
                  expand_more
                </span>
              </button>
            )}
            {canOpenMedia && mediaOpen && (
              <div className="space-y-px">
                {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                  <NavLink
                    key={kind.id}
                    href={`/dashboard/media-providers/${kind.id}`}
                    icon={kind.icon}
                    label={kind.label}
                    active={pathname.startsWith(`/dashboard/media-providers/${kind.id}`)}
                    onClick={onClose}
                    sub
                  />
                ))}
                <NavLink
                  key={COMBINED_WEB_ITEM.id}
                  href={COMBINED_WEB_ITEM.href}
                  icon={COMBINED_WEB_ITEM.icon}
                  label={COMBINED_WEB_ITEM.label}
                  active={pathname.startsWith(COMBINED_WEB_ITEM.href)}
                  onClick={onClose}
                  sub
                />
              </div>
            )}

            {filteredSystemItems.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                icon={item.icon}
                label={item.label}
                active={isActive(item.href)}
                onClick={onClose}
              />
            ))}

            {/* Debug items (inside System section, before Settings) */}
            {filteredDebugItems.map((item) => {
              const show = item.href !== "/dashboard/translator" || enableTranslator;
              return show ? (
                <NavLink
                  key={item.href}
                  href={item.href}
                  icon={item.icon}
                  label={item.label}
                  active={isActive(item.href)}
                  onClick={onClose}
                />
              ) : null;
            })}

            {/* Settings ships via filteredSystemItems — no second hardcoded row. */}
          </>
        )}
      </nav>

      {/* Footer — repository link, keeps the shell from ending in dead space */}
      <div className="shrink-0 px-2 py-2.5 border-t border-border-subtle">
        <a
          href="https://github.com/johsua092-ui/x-router"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2.5 px-2.5 py-[7px] rounded-[8px] text-text-subtle hover:text-text-main hover:bg-surface-2 transition-colors"
        >
          <svg className="size-[15px] shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
          </svg>
          <span className="text-[11px] leading-none">johsua092-ui/x-router</span>
        </a>
      </div>
    </aside>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
};
