/* Single source of truth for dashboard navigation. Both the right rail (desktop)
   and the mobile sheet read from here, so a section can never exist in one and
   be missing from the other. Permission gating is expressed once, in
   filterNavigation(), instead of being repeated per surface. */

import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";

export const VISIBLE_MEDIA_KINDS = ["embedding", "image", "video", "tts", "stt", "systemone"];

export const COMBINED_WEB_ITEM = {
  id: "web",
  label: "Web Fetch & Search",
  icon: "travel_explore",
  href: "/dashboard/media-providers/web",
};

export const NAV_ITEMS = [
  { href: "/dashboard/endpoint", label: "Endpoint", icon: "api" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns" },
  { href: "/dashboard/combos", label: "Combos", icon: "layers" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/quota", label: "Quota", icon: "data_usage" },
  { href: "/dashboard/token-saver", label: "Token Saver", icon: "savings" },
  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal" },
  { href: "/dashboard/connection", label: "Connection", icon: "hub" },
];

export const WORKSHOP_ITEMS = [
  { href: "/dashboard/teams", label: "Teams", icon: "groups" },
  { href: "/dashboard/arena", label: "Compare Models", icon: "swords" },
  { href: "/dashboard/model-editor", label: "Custom Models", icon: "auto_awesome" },
  { href: "/dashboard/plugins", label: "Custom Plugins", icon: "widgets" },
  { href: "/dashboard/model-bypass", label: "Model Bypass", icon: "bolt" },
  { href: "/dashboard/prd-builder", label: "PRD Builder", icon: "description" },
];

export const DEBUG_ITEMS = [
  { href: "/dashboard/console-log", label: "Console Log", icon: "monitor" },
  { href: "/dashboard/translator", label: "Translator", icon: "translate" },
];

export const SYSTEM_ITEMS = [
  { href: "/dashboard/profile", label: "Settings", icon: "settings" },
  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
];

export const MEDIA_ITEMS = [
  ...MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((k) => ({
    href: `/dashboard/media-providers/${k.id}`,
    label: k.label,
    icon: k.icon,
  })),
  COMBINED_WEB_ITEM,
];

export const DEFAULT_PERMISSIONS = {
  manageApiKeys: true,
  manageModels: true,
  manageProviders: true,
  manageTools: true,
  manageAdvanced: true,
  managePlugins: true,
  manageMediaProviders: true,
  viewUsage: true,
};

/* Resolve the visible navigation for the current identity. Admin (non-API-key)
   users see everything; API-key users are narrowed to what they may manage. */
export function filterNavigation({ isApiKeyUser, permissions, enableTranslator }) {
  const p = permissions || DEFAULT_PERMISSIONS;

  const navItems = NAV_ITEMS.filter((item) => {
    if (!isApiKeyUser) return true;
    if (item.href === "/dashboard/endpoint") return p.manageApiKeys;
    if (item.href === "/dashboard/providers") return p.manageProviders;
    if (item.href === "/dashboard/combos") return p.manageModels;
    if (item.href === "/dashboard/usage") return p.viewUsage;
    if (item.href === "/dashboard/quota") return p.manageProviders;
    if (item.href === "/dashboard/token-saver" || item.href === "/dashboard/cli-tools") return p.manageTools;
    if (item.href === "/dashboard/connection") return p.manageAdvanced || p.manageTools;
    return false;
  });

  const workshopItems = WORKSHOP_ITEMS.filter((item) => {
    if (!isApiKeyUser) return true;
    if (item.href === "/dashboard/teams") return p.manageApiKeys;
    if (
      item.href === "/dashboard/model-editor" ||
      item.href === "/dashboard/arena" ||
      item.href === "/dashboard/model-bypass" ||
      item.href === "/dashboard/prompt-injection" ||
      item.href === "/dashboard/prd-builder"
    )
      return p.manageModels;
    if (item.href === "/dashboard/plugins") return p.managePlugins;
    return false;
  });

  const debugItems = DEBUG_ITEMS.filter((item) => {
    if (isApiKeyUser && !p.manageAdvanced) return false;
    return item.href !== "/dashboard/translator" || enableTranslator;
  });

  const systemItems = SYSTEM_ITEMS.filter((item) => {
    // Settings is an administrator surface: /dashboard/profile carries no
    // permission in lib/auth/permissionPaths.js, so key-signed sessions must
    // not see it. Every other system item follows manageAdvanced.
    if (item.href === "/dashboard/profile") return !isApiKeyUser;
    return isApiKeyUser ? p.manageAdvanced : true;
  });

  const canOpenMedia = !isApiKeyUser || p.manageMediaProviders;

  const showSystemGroup =
    !isApiKeyUser || canOpenMedia || systemItems.length > 0 || debugItems.length > 0;

  return { navItems, workshopItems, debugItems, systemItems, canOpenMedia, showSystemGroup };
}

export const hasMediaNew = MEDIA_PROVIDER_KINDS.some(
  (k) => VISIBLE_MEDIA_KINDS.includes(k.id) && k.isNew
);
