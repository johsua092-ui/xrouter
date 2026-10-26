"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import PropTypes from "prop-types";
import ChangelogModal from "./ChangelogModal";
import { ConfirmModal } from "./Modal";
import ThemeModal from "./ThemeModal";

function MenuItem({ icon, label, onClick, trailing, danger }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 w-full px-4 py-2.5 text-sm transition-colors ${
        danger
          ? "text-danger hover:bg-danger-bg"
          : "text-text-main hover:bg-surface-2"
      }`}
    >
      <span className={`material-symbols-outlined text-[20px] ${danger ? "" : "text-text-muted"}`}>
        {icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
      {trailing && <span className="text-base">{trailing}</span>}
    </button>
  );
}

MenuItem.propTypes = {
  icon: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  onClick: PropTypes.func.isRequired,
  trailing: PropTypes.node,
  danger: PropTypes.bool,
};

export default function HeaderMenu({ onLogout }) {
  const [isOpen, setIsOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [themeModalOpen, setThemeModalOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const menuRef = useRef(null);

  const handleShutdown = async () => {
    setIsShuttingDown(true);
    try {
      await fetch("/api/version/shutdown", { method: "POST" });
    } catch (e) {
      // Expected to fail as server shuts down; ignore error
    }
    setIsShuttingDown(false);
    setShutdownOpen(false);
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const close = () => setIsOpen(false);

  return (
    <>
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setThemeModalOpen(true)}
          className="flex items-center justify-center p-2 rounded-[6px] text-text-muted hover:text-text-main hover:bg-surface-2 transition-all cursor-pointer"
          title="Theme & Appearance"
        >
          <span className="material-symbols-outlined">grid_view</span>
        </button>

        {isOpen && (
          <div className="absolute right-0 top-full mt-2 w-60 bg-surface border border-border-subtle rounded-[6px] shadow-[var(--shadow-elev)] z-50 slide-in-top overflow-hidden py-1">
            <MenuItem
              icon="history"
              label="Change Log"
              onClick={() => { close(); setChangelogOpen(true); }}
            />
            <MenuItem
              icon="palette"
              label="Theme"
              onClick={() => { close(); setThemeModalOpen(true); }}
            />
            <Link
              href="/dashboard/profile"
              onClick={close}
              className="w-full px-3 py-2 text-left text-sm flex items-center gap-2.5 text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[18px]">settings</span>
              <span>Settings</span>
            </Link>
            <MenuItem
              icon="power_settings_new"
              label="Shutdown"
              danger
              onClick={() => { close(); setShutdownOpen(true); }}
            />
            <MenuItem
              icon="logout"
              label="Logout"
              danger
              onClick={() => { close(); onLogout(); }}
            />
          </div>
        )}
      </div>

      <ChangelogModal isOpen={changelogOpen} onClose={() => setChangelogOpen(false)} />
      <ThemeModal isOpen={themeModalOpen} onClose={() => setThemeModalOpen(false)} />
      <ConfirmModal
        isOpen={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title="Close Proxy"
        message="Are you sure you want to close the proxy server?"
        confirmText="Close"
        cancelText="Cancel"
        variant="danger"
        loading={isShuttingDown}
      />
    </>
  );
}

HeaderMenu.propTypes = {
  onLogout: PropTypes.func.isRequired,
};
