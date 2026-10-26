"use client";

import { useState, useEffect } from "react";
import Modal from "./Modal";
import Button from "./Button";
import LogoMark from "./LogoMark";
import { GITHUB_CONFIG } from "@/shared/constants/config";

// Update notices live in their own banner, so this dialog stays about the repo.
export default function WelcomeModal() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const neverShow = localStorage.getItem("xrouter:welcomeNeverShow") === "true";
    const justLoggedIn = sessionStorage.getItem("xrouter:justLoggedIn") === "true";

    if (neverShow || !justLoggedIn) {
      setIsOpen(false);
    } else {
      sessionStorage.removeItem("xrouter:justLoggedIn");
      setIsOpen(true);
    }
  }, []);

  const handleDontShowAgain = () => {
    localStorage.setItem("xrouter:welcomeNeverShow", "true");
    setIsOpen(false);
  };

  const handleClose = () => {
    setIsOpen(false);
  };

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      closeOnOverlay={false}
      title="Selamat datang di X Router"
      size="md"
      footer={null}
    >
      <div className="space-y-5 text-text-main text-sm">
        <div className="relative flex flex-col items-center justify-center text-center px-6 pt-7 pb-6 gap-5 rounded-[6px] border border-border-subtle overflow-hidden">
          {/* Identity motif: the ember veil, rising behind the mark. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-28"
            style={{
              background:
                "radial-gradient(ellipse 70% 100% at 50% 0%, color-mix(in srgb, var(--color-primary) 26%, transparent), transparent 72%)",
            }}
          />
          <div className="relative h-16 w-16 rounded-[6px] border border-border-subtle overflow-hidden p-1 bg-surface-2">
            <LogoMark className="size-full" />
          </div>

          <div className="relative space-y-2 max-w-sm">
            <p className="text-base font-semibold tracking-tight">
              Gateway kamu sudah nyala
            </p>
            <p className="text-text-muted text-xs leading-relaxed">
              Endpoint OpenAI dan Anthropic siap dipakai. Katalog model lengkap, dan usage terpantau langsung dari dashboard ini.
            </p>
          </div>

          <div className="relative flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2 w-full">
            <a
              href={GITHUB_CONFIG.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 sm:flex-none"
            >
              <Button variant="outline" icon="star" fullWidth>
                Star di GitHub
              </Button>
            </a>
            <Button
              variant="primary"
              icon="arrow_forward"
              onClick={handleClose}
              className="flex-1 sm:flex-none whitespace-nowrap"
            >
              Masuk Dashboard
            </Button>
          </div>

          <button
            type="button"
            onClick={handleDontShowAgain}
            className="relative text-xs text-text-muted hover:text-text-main transition-colors"
          >
            Jangan tampilkan lagi
          </button>
        </div>
      </div>
    </Modal>
  );
}
