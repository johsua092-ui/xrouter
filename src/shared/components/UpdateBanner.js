"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import Button from "./Button";
import { ConfirmModal } from "./Modal";
import ManualUpdatePanel from "./ManualUpdatePanel";
import { GITHUB_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// Ten minutes between checks: fast enough that a release shows up while the tab is
// open, slow enough that GitHub is not polled on every navigation.
import ChangelogModal from "./ChangelogModal";

const POLL_MS = 60000;
const DISMISSED_KEY = "xrouter:dismissed_update";

function readDismissed() {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) || "";
  } catch {
    return "";
  }
}

/**
 * The one place update status lives: every install that sits behind the
 * repository is told about it here, on the dashboard itself.
 *
 * Sidebar used to carry a second copy of this (a text line, an "Update now"
 * button and the install command). Two copies drifted apart, and the sidebar one
 * appeared without any motion on route changes, so the flow lives here alone:
 * status line, copy command, the manual update panel, and dismissal. Nothing is
 * duplicated between the two surfaces.
 *
 * Driven by /api/version, which reports an update either from git (a checkout
 * that is N commits behind) or from the changelog (a newer release exists), so
 * a deploy without git history is still told to update.
 */
export default function UpdateBanner({ pollMs = POLL_MS }) {
  const [info, setInfo] = useState(null);
  const [dismissed, setDismissed] = useState("");
  const [isApiKeyUser, setIsApiKeyUser] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [shutdownCountdown, setShutdownCountdown] = useState(0);
  const { copied, copy } = useCopyToClipboard(2000);

  useEffect(() => {
    setDismissed(readDismissed());

    // Update notices are an administrator surface: a key-signed session skips it
    // instead of firing a request it may not read (same rule as Sidebar).
    let alive = true;
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then((data) => {
        if (alive && data?.role === "apikey") setIsApiKeyUser(true);
      })
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (isApiKeyUser) return undefined;

    let alive = true;
    const check = async () => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (alive && data?.hasUpdate) setInfo(data);
      } catch {
        // Offline or blocked: leave the last answer on screen.
      }
    };

    check();
    const id = setInterval(check, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs, isApiKeyUser]);

  // Shutdown countdown is owned here now that the panel lives here: copy the
  // command, wait out the countdown, then stop the server so the operator can
  // paste it into a terminal.
  useEffect(() => {
    if (shutdownCountdown <= 0) return undefined;
    const id = setTimeout(() => {
      fetch("/api/version/shutdown", { method: "POST" }).catch(() => {});
      setShutdownCountdown(0);
      setIsDisconnected(true);
    }, 1000);
    return () => clearTimeout(id);
  }, [shutdownCountdown]);

  const installCmd = info?.installCmd || UPDATER_CONFIG.installCmdLatest;

  const handleCopyAndShutdown = () => {
    navigator.clipboard?.writeText(installCmd).catch(() => { /* clipboard blocked */ });
    copy(installCmd);
    setShutdownCountdown(UPDATER_CONFIG.shutdownCountdownSec);
  };

  const handleCancel = () => {
    setIsUpdating(false);
    setShutdownCountdown(0);
  };

  if (isApiKeyUser) return null;

  // A newer release than the one dismissed re-opens the banner; the same one stays
  // closed for this browser.
  const identity = info?.latestVersion || "";
  const visible = Boolean(info) && Boolean(identity) && dismissed !== identity;

  // Keep the update flow reachable even after dismissal: the banner itself can be
  // dismissed, the manual update panel cannot be left without an exit.
  if (!info) return null;

  return (
    <>
      {visible && (
        <div className="mx-4 sm:mx-6 lg:mx-10 my-3 max-w-7xl slide-in-top">
          <div className="flex flex-col gap-3 rounded-[6px] border border-warning-border bg-warning-bg p-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2.5 min-w-0">
              <span className="material-symbols-outlined shrink-0 text-[20px] text-warning mt-0.5 sm:mt-0">system_update_alt</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-warning">
                  {info.behindBy ? `Update available: ${info.behindBy} commit${info.behindBy > 1 ? "s" : ""} behind` : `Update available: ${info.latestVersion}`}
                </p>
                <p className="text-xs text-text-muted">{summaryFor(info)}</p>
                {Array.isArray(info.releaseNotes) && info.releaseNotes.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {info.releaseNotes.slice(0, 3).map((note) => (
                      <li key={note} className="truncate text-xs text-text-muted" title={note}>{note}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 justify-end">
              <Button
                variant="outline"
                size="sm"
                icon={copied ? "check" : "content_copy"}
                onClick={() => copy(installCmd)}
                className="text-xs h-7 px-2"
              >
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon="system_update_alt"
                onClick={() => setShowConfirm(true)}
                className="text-xs h-7 px-2.5 font-semibold"
              >
                Update now
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon="receipt_long"
                onClick={() => setShowChangelog(true)}
                className="text-xs h-7 px-2"
              >
                Changelog
              </Button>
              <button
                type="button"
                onClick={() => {
                  try {
                    window.localStorage.setItem(DISMISSED_KEY, identity);
                  } catch {
                    // Storage blocked: the banner simply comes back after a reload.
                  }
                  setDismissed(identity);
                }}
                className="rounded p-1 text-text-muted transition-colors hover:text-warning cursor-pointer ml-1"
                title="Close"
                aria-label="Dismiss update notice"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <ChangelogModal isOpen={showChangelog} onClose={() => setShowChangelog(false)} />

      <ConfirmModal
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={() => {
          setShowConfirm(false);
          setIsUpdating(true);
        }}
        title="Update X Router"
        message={`Show install command for v${info.latestVersion || ""}? You can copy it and shutdown to install manually.`}
        confirmText="Show Command"
        cancelText="Cancel"
        variant="primary"
      />

      {(isDisconnected || isUpdating) && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-6 fade-in">
          {isUpdating ? (
            <ManualUpdatePanel
              latestVersion={info.latestVersion}
              installCmd={installCmd}
              copied={copied}
              onCopyAndShutdown={handleCopyAndShutdown}
              onCancel={handleCancel}
              countdown={shutdownCountdown}
              isDisconnected={isDisconnected}
            />
          ) : (
            <div className="text-center p-8">
              <div className="flex items-center justify-center size-16 rounded-full bg-danger-bg text-danger mx-auto mb-4">
                <span className="material-symbols-outlined text-[32px]">power_off</span>
              </div>
              <h2 className="text-xl font-semibold text-text-main mb-2">Server Disconnected</h2>
              <p className="text-text-muted mb-6">The proxy server has been stopped.</p>
              <Button variant="secondary" onClick={() => globalThis.location.reload()}>
                Reload Page
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** One line describing how far behind this install is. */
function summaryFor(info) {
  const behind = Number.isFinite(info.behindBy) ? info.behindBy : null;
  if (behind !== null && behind > 0) {
    return `This install is ${behind} commit${behind > 1 ? "s" : ""} behind master.`;
  }
  if (info.currentRelease) {
    return `${info.currentRelease} is installed and ${info.latestVersion} is published.`;
  }
  return `${info.latestVersion} is published on the repository.`;
}

UpdateBanner.propTypes = {
  pollMs: PropTypes.number,
};
