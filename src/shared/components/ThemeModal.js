"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import useThemeStore, { THEME_IDS, ACCENT_PALETTES } from "@/store/themeStore";

const MODES = [
  {
    id: "dark",
    icon: "dark_mode",
    label: "Dark",
    desc: "Solid dark panels on a neutral warm base",
    swatches: ["#1a1a1a", "#262626", "#303030", "#333333"],
  },
  {
    id: "ember",
    icon: "local_fire_department",
    label: "Ember",
    desc: "Warm charcoal panels with a brand accent tint",
    swatches: ["#171310", "#201914", "#2b211a", "#33261d"],
  },
  {
    id: "light",
    icon: "light_mode",
    label: "Light",
    desc: "Clean light panels on soft ivory background",
    swatches: ["#FDFAF6", "#F7F3EE", "#ffffff", "#f4f4f5"],
  },
];

/**
 * Theme picker rendered as a centered modal, matching Change Log.
 *
 * The previous version expanded inline inside the grid menu, which pushed the
 * account rows downward and read as a dropdown rather than a destination. The
 * portal/overlay/animation here are the same ones ChangelogModal uses so the
 * two feel identical.
 */
function hexToRgb(hex) {
  const clean = String(hex || "").replace("#", "");
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16) || 0;
    const g = parseInt(clean[1] + clean[1], 16) || 0;
    const b = parseInt(clean[2] + clean[2], 16) || 0;
    return { r, g, b };
  }
  const num = parseInt(clean, 16);
  if (isNaN(num)) return { r: 229, g: 106, b: 74 };
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function rgbToHsb(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : Math.round((d / max) * 100);
  const v = Math.round(max * 100);
  return { h, s, b: v };
}

function hsbToRgb(h, s, b) {
  s /= 100;
  b /= 100;
  const k = (n) => (n + h / 60) % 6;
  const f = (n) => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
  return {
    r: Math.round(f(5) * 255),
    g: Math.round(f(3) * 255),
    b: Math.round(f(1) * 255),
  };
}

function rgbToHex(r, g, b) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/**
 * Enhanced Photoshop-style Custom Palette Picker
 */
function PhotoshopColorPicker({ color, onChange, onApply, isActive }) {
  const [internalHex, setInternalHex] = useState(color || "#E56A4A");
  const rgb = hexToRgb(internalHex);
  const hsb = rgbToHsb(rgb.r, rgb.g, rgb.b);
  const [hue, setHue] = useState(hsb.h);
  const [sat, setSat] = useState(hsb.s);
  const [bri, setBri] = useState(hsb.b);
  const spectrumRef = useRef(null);
  const isDraggingSpectrum = useRef(false);
  const rafId = useRef(null);

  useEffect(() => {
    if (color && color !== internalHex) {
      setInternalHex(color);
      const curRgb = hexToRgb(color);
      const curHsb = rgbToHsb(curRgb.r, curRgb.g, curRgb.b);
      setHue(curHsb.h);
      setSat(curHsb.s);
      setBri(curHsb.b);
    }
  }, [color]);

  const updateFromHsb = (newH, newS, newB) => {
    setHue(newH);
    setSat(newS);
    setBri(newB);
    const newRgb = hsbToRgb(newH, newS, newB);
    const newHex = rgbToHex(newRgb.r, newRgb.g, newRgb.b);
    setInternalHex(newHex);

    // Throttle parent state update with requestAnimationFrame
    if (rafId.current) cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(() => {
      onChange(newHex);
    });
  };

  const handleSpectrumMove = (e) => {
    if (!spectrumRef.current) return;
    const rect = spectrumRef.current.getBoundingClientRect();
    const clientX = e.clientX ?? (e.touches && e.touches[0]?.clientX) ?? 0;
    const clientY = e.clientY ?? (e.touches && e.touches[0]?.clientY) ?? 0;
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const newSat = Math.round((x / rect.width) * 100);
    const newBri = Math.round((1 - y / rect.height) * 100);
    updateFromHsb(hue, newSat, newBri);
  };

  const handlePointerDown = (e) => {
    isDraggingSpectrum.current = true;
    handleSpectrumMove(e);
    if (e.target.setPointerCapture && e.pointerId !== undefined) {
      try { e.target.setPointerCapture(e.pointerId); } catch {}
    }
  };

  const handlePointerMove = (e) => {
    if (isDraggingSpectrum.current) {
      handleSpectrumMove(e);
    }
  };

  const handlePointerUp = (e) => {
    isDraggingSpectrum.current = false;
    if (e.target.releasePointerCapture && e.pointerId !== undefined) {
      try { e.target.releasePointerCapture(e.pointerId); } catch {}
    }
  };

  return (
    <div className="flex flex-col gap-2.5 p-3 rounded-[6px] border border-border bg-surface-2/70 select-none">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wider flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[15px]">palette</span>
          X Router Custom Studio Palette
        </span>
        <button
          type="button"
          onClick={onApply}
          className={cn(
            "px-3 py-1 rounded-[4px] text-xs font-semibold transition-all shadow-xs cursor-pointer",
            isActive
              ? "bg-primary text-white ring-1 ring-primary/40"
              : "bg-surface text-text-muted hover:text-text-main border border-border hover:bg-surface-2"
          )}
        >
          {isActive ? "Active Palette" : "Apply Palette"}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-start">
        {/* 2D Saturation / Brightness Gradient Canvas */}
        <div className="sm:col-span-7 flex flex-col gap-2">
          <div
            ref={spectrumRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onClick={handleSpectrumMove}
            style={{
              backgroundColor: `hsl(${hue}, 100%, 50%)`,
              touchAction: "none",
            }}
            className="relative h-36 w-full rounded-[4px] overflow-hidden cursor-crosshair shadow-inner border border-black/20"
          >
            {/* White to transparent horizontal gradient (Saturation) */}
            <div className="absolute inset-0 bg-gradient-to-r from-white to-transparent pointer-events-none" />
            {/* Transparent to black vertical gradient (Brightness) */}
            <div className="absolute inset-0 bg-gradient-to-t from-black to-transparent pointer-events-none" />

            {/* Target circular picker cursor */}
            <div
              className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_2px_rgba(0,0,0,0.8)] pointer-events-none"
              style={{
                left: `${sat}%`,
                top: `${100 - bri}%`,
                backgroundColor: color,
              }}
            />
          </div>

          {/* Vertical/Horizontal Hue Rainbow Bar */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-text-muted w-3 text-center">H</span>
            <input
              type="range"
              min="0"
              max="360"
              value={hue}
              onChange={(e) => updateFromHsb(Number(e.target.value), sat, bri)}
              className="w-full h-3 rounded-full appearance-none cursor-pointer outline-none shadow-xs"
              style={{
                background: "linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)",
              }}
            />
          </div>
        </div>

        {/* Numeric Telemetry & Color Space Breakdown (Photoshop Style) */}
        <div className="sm:col-span-5 flex flex-col gap-2 bg-surface p-2.5 rounded-[5px] border border-border text-xs font-mono">
          {/* Swatch Preview */}
          <div className="flex items-center gap-2 pb-2 border-b border-border-subtle">
            <div
              className="h-7 flex-1 rounded-[4px] border border-border shadow-xs"
              style={{ backgroundColor: internalHex }}
            />
            <div className="flex flex-col text-[11px] leading-tight">
              <span className="font-semibold text-text-main">{internalHex}</span>
              <span className="text-[9px] text-text-muted">HEX CODE</span>
            </div>
          </div>

          {/* HSB & RGB Grid Inputs */}
          <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">H:</span>
              <span className="text-text-main font-medium">{hue}°</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">R:</span>
              <span className="text-text-main font-medium">{rgb.r}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">S:</span>
              <span className="text-text-main font-medium">{sat}%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">G:</span>
              <span className="text-text-main font-medium">{rgb.g}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">B:</span>
              <span className="text-text-main font-medium">{bri}%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">B:</span>
              <span className="text-text-main font-medium">{rgb.b}</span>
            </div>
          </div>

          {/* Quick HEX Input */}
          <div className="pt-1.5 border-t border-border-subtle flex items-center gap-1.5">
            <span className="text-[10px] text-text-muted">#</span>
            <input
              type="text"
              maxLength={7}
              value={internalHex}
              onChange={(e) => {
                const val = e.target.value;
                if (/^#[0-9A-Fa-f]{0,6}$/.test(val) || /^[0-9A-Fa-f]{0,6}$/.test(val)) {
                  const formatted = val.startsWith("#") ? val : `#${val}`;
                  setInternalHex(formatted);
                  if (formatted.length === 7) {
                    onChange(formatted);
                  }
                }
              }}
              className="w-full px-1.5 py-0.5 rounded-[3px] border border-border bg-surface-2 text-xs font-mono text-center text-text-main uppercase focus:border-primary focus:outline-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ThemeModal({ isOpen, onClose }) {
  const theme = useThemeStore((state) => state.theme);
  const accent = useThemeStore((state) => state.accent || "orange");
  const customColor = useThemeStore((state) => state.customColor || "#E56A4A");
  const setTheme = useThemeStore((state) => state.setTheme);
  const setAccent = useThemeStore((state) => state.setAccent);
  const setCustomColor = useThemeStore((state) => state.setCustomColor);
  const modalRef = useRef(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    const onOutside = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !mounted || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
      />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Theme"
        className="relative w-full bg-surface border border-border rounded-[6px] shadow-[var(--shadow-elev)] animate-in fade-in zoom-in-95 duration-200 max-w-lg max-h-[90vh] overflow-y-auto custom-scrollbar"
      >
        <div className="flex items-center justify-between gap-3 p-3 border-b border-border-subtle">
          <h2 className="text-lg font-semibold text-text-main">Theme</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-text-muted hover:text-text-main hover:bg-surface-2 transition-all cursor-pointer"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="p-3 flex flex-col gap-2">
          <div className="text-xs font-semibold text-text-muted px-1 uppercase tracking-wider">Appearance Mode</div>
          {THEME_IDS.map((id) => {
            const mode = MODES.find((m) => m.id === id);
            if (!mode) return null;
            const active = id === theme;
            return (
              <button
                key={id}
                onClick={() => setTheme(id)}
                aria-pressed={active}
                className={cn(
                  "flex items-center gap-3 w-full p-2.5 rounded-[6px] border text-left transition-colors",
                  active
                    ? "border-primary/50 bg-primary/10"
                    : "border-border-subtle hover:bg-surface-2",
                )}
              >
                <span className="flex shrink-0 overflow-hidden rounded-[6px] border border-border">
                  {mode.swatches.map((c, i) => (
                    <span key={i} className="block h-8 w-3" style={{ backgroundColor: c }} />
                  ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "flex items-center gap-2 text-sm font-medium",
                      active ? "text-primary" : "text-text-main",
                    )}
                  >
                    <span className="material-symbols-outlined text-[18px]">{mode.icon}</span>
                    {mode.label}
                  </span>
                  <span className="block mt-0.5 text-xs text-text-muted">{mode.desc}</span>
                </span>
                {active && (
                  <span className="material-symbols-outlined text-[18px] text-primary shrink-0">
                    check
                  </span>
                )}
              </button>
            );
          })}

          <div className="text-xs font-semibold text-text-muted px-1 mt-3 uppercase tracking-wider">Accent Color Palette</div>
          <div className="grid grid-cols-3 gap-2">
            {ACCENT_PALETTES.map((pal) => {
              const active = pal.id === accent;
              return (
                <button
                  key={pal.id}
                  onClick={() => setAccent(pal.id)}
                  className={cn(
                    "flex items-center gap-2 p-2 rounded-[6px] border text-left transition-all",
                    active ? "border-primary bg-primary/10 shadow-sm" : "border-border-subtle hover:bg-surface-2"
                  )}
                >
                  <span className="h-4 w-4 rounded-full shrink-0 shadow-sm" style={{ backgroundColor: pal.primary }} />
                  <span className={cn("text-xs font-medium truncate", active ? "text-primary" : "text-text-main")}>
                    {pal.label.split(" ")[1] || pal.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Custom Accent Palette (Photoshop Studio Color Picker) */}
          <div className="mt-3 pt-3 border-t border-border-subtle flex flex-col gap-2">
            <PhotoshopColorPicker
              color={customColor}
              onChange={(newHex) => setCustomColor(newHex)}
              onApply={() => setAccent("custom")}
              isActive={accent === "custom"}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

ThemeModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};