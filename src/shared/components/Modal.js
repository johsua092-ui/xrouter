"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/shared/utils/cn";
import Button from "./Button";
import { useVisibleViewport } from "@/shared/hooks/useVisibleViewport";

/* Modal. Solid panel, single ember rule under the header, no traffic lights —
   the close affordance is one labelled button instead of three decorative
   dots. showTrafficLights is kept as an accepted prop so existing call sites
   keep working.

   Two structural rules, both learned from a phone (Samsung A72, tablet mode):
   1. The panel is portalled to document.body. The dashboard shell renders the
      page inside <main class="relative isolate">, and `isolate` opens a
      stacking context: a `fixed inset-0 z-50` overlay declared inside it can
      never rise above a sibling `z-30` app header. The header painted over
      the modal and ate the title. Portalling lifts the overlay out of that
      context so z-50 means z-50.
   2. The height cap comes from the MEASURED visible viewport
      (window.visualViewport), not from a CSS unit. `dvh` tracks the URL bar
      but still reports the layout viewport on a phone; `svh` is the smallest
      viewport, which is safe but wastes space. Measuring gives the exact
      number of pixels the user can see right now, so the header can never
      end up under the browser chrome. */
export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = "md",
  closeOnOverlay = true,
  className,
}) {
  const sizes = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-xl",
    full: "max-w-4xl",
  };

  const { height: visibleHeight } = useVisibleViewport();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen || !mounted) return null;

  // Measured cap wins once we have a number; the CSS fallback covers the very
  // first paint before the effect has run and any browser without
  // visualViewport.
  const measuredCap = visibleHeight
    ? { maxHeight: `${Math.max(160, visibleHeight - 24)}px` }
    : {};
  const fallbackCap = { maxHeight: "calc(min(100dvh, 100svh) - 1.5rem)" };

  const panel = (
    // Scroll lives on the overlay, not the panel: the panel is capped to the
    // visible viewport minus padding, so the header (title + close) is always
    // visible and only the body scrolls.
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto overscroll-contain p-3 sm:p-4">
      <div
        className="fixed inset-0 bg-black/70 fade-in"
        onClick={closeOnOverlay ? onClose : undefined}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative w-full flex flex-col bg-surface border border-border rounded-[6px]",
          "shadow-[var(--shadow-elev)] modal-in shrink-0 my-auto",
          measuredCap.maxHeight ? "" : fallbackCap.maxHeight,
          sizes[size],
          className
        )}
        style={measuredCap}
      >
        <div className="relative shrink-0 px-5 pt-4 pb-3">
          <div className="flex items-start justify-between gap-4">
            {title ? (
              <h2 className="text-[15px] font-semibold tracking-tight text-text-main min-w-0">
                {title}
              </h2>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mt-0.5 -mr-1 shrink-0 p-1.5 rounded-[6px] text-text-subtle hover:bg-surface-2 hover:text-text-main transition-colors"
            >
              <span className="material-symbols-outlined text-[18px] leading-none">close</span>
            </button>
          </div>
          <span className="ember-rule mt-3" aria-hidden="true" />
        </div>

        {/* min-h-0 lets this flex child shrink below its content size, so the
            scroll stays inside the body instead of pushing the header out. */}
        <div className="px-5 py-4 overflow-y-auto overscroll-contain custom-scrollbar min-h-0">{children}</div>

        {footer && (
          <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3.5 border-t border-border-subtle bg-bg-alt rounded-b-[12px]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  // Portal out of the dashboard's `isolate` stacking context so the modal is
  // never painted under the mobile app header.
  return createPortal(panel, document.body);
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title = "Confirm",
  message,
  children,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "danger",
  loading = false,
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelText}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </>
      }
    >
      {message && <p className="text-[13px] text-text-muted leading-relaxed">{message}</p>}
      {children}
    </Modal>
  );
}
