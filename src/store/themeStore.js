"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/config";

export const THEME_IDS = ["ember", "dark", "light"];

export const ACCENT_PALETTES = [
  { id: "orange", label: "Ember Orange", primary: "#E56A4A", hover: "#c04a2c", filter: "none" },
  { id: "blue", label: "Electric Blue", primary: "#2563EB", hover: "#1D4ED8", filter: "hue-rotate(195deg) saturate(1.8)" },
  { id: "emerald", label: "Emerald Green", primary: "#059669", hover: "#047857", filter: "hue-rotate(115deg) saturate(1.5)" },
  { id: "purple", label: "Violet Purple", primary: "#7C3AED", hover: "#6D28D9", filter: "hue-rotate(240deg) saturate(1.7)" },
  { id: "rose", label: "Ruby Rose", primary: "#E11D48", hover: "#BE123C", filter: "hue-rotate(330deg) saturate(1.6)" },
  { id: "cyan", label: "Cyber Cyan", primary: "#0891B2", hover: "#0E7490", filter: "hue-rotate(170deg) saturate(1.8)" },
];

export function darkenColor(hex, percent = 15) {
  let num = parseInt(String(hex).replace("#", ""), 16);
  if (isNaN(num)) return hex;
  let r = Math.max(0, (num >> 16) - Math.round(255 * (percent / 100)));
  let g = Math.max(0, ((num >> 8) & 0x00FF) - Math.round(255 * (percent / 100)));
  let b = Math.max(0, (num & 0x0000FF) - Math.round(255 * (percent / 100)));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export function hexToHueRotate(hex) {
  const rgb = parseInt(String(hex).replace("#", ""), 16);
  if (isNaN(rgb)) return "none";
  const r = (rgb >> 16) / 255;
  const g = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h = Math.round(h * 60);
  }
  const delta = (h - 12 + 360) % 360;
  return `hue-rotate(${delta}deg) saturate(1.4)`;
}

const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: "ember",
      accent: "orange",
      customColor: "#E56A4A",

      setTheme: (theme) => {
        const id = THEME_IDS.includes(theme) ? theme : "ember";
        set({ theme: id });
        applyTheme(id, get().accent || "orange", get().customColor || "#E56A4A");
        syncThemeToServer(id, get().accent || "orange", get().customColor || "#E56A4A");
      },

      setAccent: (accent) => {
        const isPreset = ACCENT_PALETTES.some((p) => p.id === accent);
        const valid = isPreset || accent === "custom" ? accent : "orange";
        set({ accent: valid });
        applyTheme(get().theme || "ember", valid, get().customColor || "#E56A4A");
        syncThemeToServer(get().theme || "ember", valid, get().customColor || "#E56A4A");
      },

      setCustomColor: (color) => {
        if (!color || typeof color !== "string") return;
        const normalized = color.startsWith("#") ? color : `#${color}`;
        set({ accent: "custom", customColor: normalized });
        applyTheme(get().theme || "ember", "custom", normalized);
        syncThemeToServer(get().theme || "ember", "custom", normalized);
      },

      toggleTheme: () => {
        const current = get().theme;
        const next = current === "light" ? "ember" : current === "ember" ? "dark" : "light";
        set({ theme: next });
        applyTheme(next, get().accent || "orange", get().customColor || "#E56A4A");
        syncThemeToServer(next, get().accent || "orange", get().customColor || "#E56A4A");
      },

      initTheme: async () => {
        // Apply current client store immediately
        applyTheme(get().theme || "ember", get().accent || "orange", get().customColor || "#E56A4A");

        // Sync with global theme from server so public portals and new devices inherit instance theme
        try {
          const res = await fetch("/api/theme", { cache: "no-store" });
          if (res.ok) {
            const data = await res.json();
            if (data?.ok) {
              const hasClientLocal = typeof window !== "undefined" && localStorage.getItem(THEME_CONFIG.storageKey);
              if (!hasClientLocal || data.accent === "custom" || data.theme) {
                set({
                  theme: data.theme || get().theme,
                  accent: data.accent || get().accent,
                  customColor: data.customColor || get().customColor,
                });
                applyTheme(data.theme || get().theme, data.accent || get().accent, data.customColor || get().customColor);
              }
            }
          }
        } catch {}
      },
    }),
    {
      name: THEME_CONFIG.storageKey,
    },
  ),
);

// Sync theme to server for global public portals
function syncThemeToServer(theme, accent, customColor) {
  if (typeof window === "undefined") return;
  fetch("/api/theme", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme, accent, customColor }),
  }).catch(() => {});
}

// Apply theme & accent palette to document
function applyTheme(theme, accent = "orange", customColor = "#E56A4A") {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  
  if (theme === "light") {
    root.classList.remove("dark");
    root.classList.remove("ember");
  } else {
    root.classList.add("dark");
    root.classList.toggle("ember", theme === "ember");
  }

  if (accent === "custom" && customColor) {
    const hover = darkenColor(customColor, 15);
    root.style.setProperty("--color-brand-500", customColor);
    root.style.setProperty("--color-brand-600", hover);
    root.style.setProperty("--color-primary", customColor);
    root.style.setProperty("--color-primary-hover", hover);
    root.style.setProperty("--brand-500", customColor);
    root.style.setProperty("--brand-600", hover);
    root.style.setProperty("--logo-filter", hexToHueRotate(customColor));
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) metaThemeColor.setAttribute("content", customColor);
    return;
  }

  const palette = ACCENT_PALETTES.find((p) => p.id === accent) || ACCENT_PALETTES[0];
  root.style.setProperty("--color-brand-500", palette.primary);
  root.style.setProperty("--color-brand-600", palette.hover);
  root.style.setProperty("--color-primary", palette.primary);
  root.style.setProperty("--color-primary-hover", palette.hover);
  root.style.setProperty("--brand-500", palette.primary);
  root.style.setProperty("--brand-600", palette.hover);
  root.style.setProperty("--logo-filter", palette.filter || "none");
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) metaThemeColor.setAttribute("content", palette.primary);
}

export default useThemeStore;
