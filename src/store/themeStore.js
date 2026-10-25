"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/config";

// Both modes are fully solid — frosted/translucent panels are gone in X Router.
// "ember" = warm charcoal panels with a faint brand-orange tint (default),
// "dark" = neutral solid dark panels.
export const THEME_IDS = ["ember", "dark", "light"];

export const ACCENT_PALETTES = [
  { id: "orange", label: "Ember Orange", primary: "#E56A4A", hover: "#c04a2c", filter: "none" },
  { id: "blue", label: "Electric Blue", primary: "#2563EB", hover: "#1D4ED8", filter: "hue-rotate(205deg) saturate(1.4)" },
  { id: "emerald", label: "Emerald Green", primary: "#059669", hover: "#047857", filter: "hue-rotate(130deg) saturate(1.2)" },
  { id: "purple", label: "Violet Purple", primary: "#7C3AED", hover: "#6D28D9", filter: "hue-rotate(245deg) saturate(1.3)" },
  { id: "rose", label: "Ruby Rose", primary: "#E11D48", hover: "#BE123C", filter: "hue-rotate(335deg) saturate(1.3)" },
  { id: "cyan", label: "Cyber Cyan", primary: "#0891B2", hover: "#0E7490", filter: "hue-rotate(175deg) saturate(1.4)" },
];

const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: "ember",
      accent: "orange",

      setTheme: (theme) => {
        const id = THEME_IDS.includes(theme) ? theme : "ember";
        set({ theme: id });
        applyTheme(id, get().accent || "orange");
      },

      setAccent: (accent) => {
        const valid = ACCENT_PALETTES.some((p) => p.id === accent) ? accent : "orange";
        set({ accent: valid });
        applyTheme(get().theme || "ember", valid);
      },

      toggleTheme: () => {
        const current = get().theme;
        const next = current === "light" ? "ember" : current === "ember" ? "dark" : "light";
        set({ theme: next });
        applyTheme(next, get().accent || "orange");
      },

      initTheme: () => {
        applyTheme(get().theme || "ember", get().accent || "orange");
      },
    }),
    {
      name: THEME_CONFIG.storageKey,
    },
  ),
);

// Apply theme & accent palette to document
function applyTheme(theme, accent = "orange") {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  
  if (theme === "light") {
    root.classList.remove("dark");
    root.classList.remove("ember");
  } else {
    root.classList.add("dark");
    root.classList.toggle("ember", theme === "ember");
  }

  const palette = ACCENT_PALETTES.find((p) => p.id === accent) || ACCENT_PALETTES[0];
  root.style.setProperty("--color-brand-500", palette.primary);
  root.style.setProperty("--color-brand-600", palette.hover);
  root.style.setProperty("--color-primary", palette.primary);
  root.style.setProperty("--color-primary-hover", palette.hover);
  root.style.setProperty("--logo-filter", palette.filter || "none");
}

export default useThemeStore;
