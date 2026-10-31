"use client";

// One auto-provision per page load: two concurrent loads (StrictMode remount)
// both seeing "no keys" would each create one, leaving a duplicate behind.
let defaultKeyProvisionInFlight = false;


import { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { Card, Button, Input, Select, Modal, CardSkeleton, Toggle, ConfirmModal, ModelSelectModal, SegmentedControl } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { nextResetAt, formatDuration } from "@/shared/utils/interval";
import { useNow } from "@/shared/hooks/useNow";
import {
  TUNNEL_BENEFITS,
  TUNNEL_PING_INTERVAL_MS,
  TUNNEL_PING_MAX_MS,
  STATUS_POLL_FAST_MS,
  REACHABLE_MISS_THRESHOLD,
  CLIENT_PING_FAST_MS,
} from "./endpointConstants";
import { clientPingUrl, clientPingAny } from "./endpointPing";
import { cn } from "@/shared/utils/cn";
import useSettingsStore from "@/store/settingsStore";
import EndpointRow from "./components/EndpointRow";
import BulkEditKeys from "./components/BulkEditKeys";
import StatusAlert from "./components/StatusAlert";
import Tooltip from "./components/Tooltip";
import SecurityWarning from "./components/SecurityWarning";

function formatTokensNumber(num) {
  if (!num || num <= 0) return "0";
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(2) + "B";
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
  return num.toLocaleString();
}

const RESET_INTERVAL_OPTIONS = [
  { value: "never", label: "Never reset" },
  { value: "5h", label: "Every 5 Hours (5h)" },
  { value: "7d", label: "Every 7 Days (7d)" },
  { value: "14d", label: "Every 14 Days (14d)" },
  { value: "30d", label: "Every 30 Days (30d)" },
  { value: "custom", label: "Custom Interval..." },
];

const PERMISSION_OPTIONS = [
  { key: "manageApiKeys", label: "Create, edit and delete API keys", icon: "key", desc: "Lets this key manage other API keys" },
  { key: "manageModels", label: "Create, edit and delete models", icon: "auto_awesome", desc: "Custom models, aliases and combos" },
  { key: "manageProviders", label: "Create, edit and delete providers", icon: "dns", desc: "Provider connections and API keys" },
  { key: "manageTools", label: "Use CLI tools and token saver", icon: "terminal", desc: "Request transformers and the CLI install page" },
  { key: "manageAdvanced", label: "Open console log, translator and proxy pools", icon: "terminal", desc: "Debugging and network plumbing" },
  { key: "managePlugins", label: "Manage custom plugins", icon: "widgets", desc: "Plugins that change how requests are handled" },
  { key: "manageMediaProviders", label: "Manage media providers", icon: "perm_media", desc: "Image, audio and embedding connections" },
  { key: "viewUsage", label: "View usage", icon: "bar_chart", desc: "Usage numbers for this key only" },
];

const EMPTY_PERMISSIONS = { manageApiKeys: false, manageModels: false, manageProviders: false, manageTools: false, manageAdvanced: false, managePlugins: false, manageMediaProviders: false, viewUsage: true };

const PERMISSIONS_LOCKED_REASON = "Locked. Sign in with the dashboard password to change permissions.";

function ResetCountdown({ resetInterval, lastResetAt }) {
  const now = useNow(true);
  if (!resetInterval || resetInterval === "never") return null;
  const due = nextResetAt(resetInterval, lastResetAt);
  if (!due) return null;
  const remaining = new Date(due).getTime() - now;
  return (
    <span className="text-xs max-w-full truncate px-2 py-0.5 rounded bg-surface-2 text-text-muted">
      {remaining <= 0 ? "Resetting..." : `Next reset: ${formatDuration(remaining)}`}
    </span>
  );
}

ResetCountdown.propTypes = {
  resetInterval: PropTypes.string,
  lastResetAt: PropTypes.string,
};

function PermissionsEditor({ value, onChange, allowed, locked, lockedReason }) {
  // A locked editor ignores whatever the parent holds and renders the default,
  // so what the form shows is what the key will actually be created with.
  const effective = locked ? EMPTY_PERMISSIONS : value;
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-text-main">Permissions</label>
      <p className="text-xs text-text-muted">
        What this key may do once it signs in. The sidebar and the forms it opens follow these.
      </p>
      {locked && (
        <p className="mt-1 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-xs text-text-muted">
          {lockedReason}
        </p>
      )}
      <div className="flex flex-col gap-1.5 mt-1">
        {PERMISSION_OPTIONS.map((opt) => {
          const unavailable = locked || !allowed[opt.key];
          const checked = Boolean(effective?.[opt.key]);
          const note = locked ? lockedReason : unavailable ? "Your key does not hold this permission" : opt.desc;
          return (
            <label
              key={opt.key}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2.5 transition-colors",
                unavailable ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:border-primary/40"
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--color-primary)] shrink-0"
                checked={checked}
                disabled={unavailable}
                onChange={(e) => onChange({ ...EMPTY_PERMISSIONS, ...value, [opt.key]: e.target.checked })}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium text-text-main">
                  <span className="material-symbols-outlined text-[16px] text-primary">{opt.icon}</span>
                  {opt.label}
                </span>
                <span className="text-xs text-text-muted">{note}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

PermissionsEditor.propTypes = {
  value: PropTypes.object,
  onChange: PropTypes.func.isRequired,
  allowed: PropTypes.object,
  locked: PropTypes.bool,
  lockedReason: PropTypes.string,
};

function generateSnippet(lang, apiKey, baseUrl) {
  const url = `${baseUrl}/v1/chat/completions`;
  const model = "gpt-4";
  if (lang === "curl") return `curl -X POST "${url}" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello"}]}'`;
  if (lang === "python") return `import requests\n\nresp = requests.post("${url}",\n headers={"Authorization": "Bearer ${apiKey}", "Content-Type": "application/json"},\n json={"model": "${model}", "messages": [{"role": "user", "content": "Hello"}]}\n)\nprint(resp.json())`;
  if (lang === "node") return `const resp = await fetch("${url}", {\n method: "POST",\n headers: { "Authorization": "Bearer ${apiKey}", "Content-Type": "application/json" },\n body: JSON.stringify({ model: "${model}", messages: [{ role: "user", content: "Hello" }] })\n});\nconst data = await resp.json();\nconsole.log(data);`;
  if (lang === "go") return `package main\n\nimport (\n\t"bytes"\n\t"fmt"\n\t"io"\n\t"net/http"\n)\n\nfunc main() {\n\tbody := []byte(\`{"model":"${model}","messages":[{"role":"user","content":"Hello"}]}\`)\n\treq, _ := http.NewRequest("POST", "${url}", bytes.NewBuffer(body))\n\treq.Header.Set("Authorization", "Bearer ${apiKey}")\n\treq.Header.Set("Content-Type", "application/json")\n\tresp, _ := http.DefaultClient.Do(req)\n\tdefer resp.Body.Close()\n\tb, _ := io.ReadAll(resp.Body)\n\tfmt.Println(string(b))\n}`;
  return "";
}

export default function APIPageClient({ machineId }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [keySearch, setKeySearch] = useState("");
  const [activeSnippetTab, setActiveSnippetTab] = useState("curl");
  const [showCodeSnippet, setShowCodeSnippet] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newCustomKey, setNewCustomKey] = useState("");
  const [newAppendSecret, setNewAppendSecret] = useState(true);
  const [newKeyLimit, setNewKeyLimit] = useState("");
  const [newKeyReset, setNewKeyReset] = useState("never");
  const [newKeyCustomReset, setNewKeyCustomReset] = useState("");
  const [newKeyAllowedModels, setNewKeyAllowedModels] = useState("*");
  const [newKeyRpm, setNewKeyRpm] = useState("");
  const [newKeyTpm, setNewKeyTpm] = useState("");
  const [newKeyIpWhitelist, setNewKeyIpWhitelist] = useState("");
  const [newKeyExpiresAt, setNewKeyExpiresAt] = useState("");
  const [editingKey, setEditingKey] = useState(null);
  const [editName, setEditName] = useState("");
  const [editLimit, setEditLimit] = useState("");
  const [editReset, setEditReset] = useState("never");
  const [editCustomReset, setEditCustomReset] = useState("");
  const [editAllowedModels, setEditAllowedModels] = useState("*");
  const [editRpm, setEditRpm] = useState("");
  const [editTpm, setEditTpm] = useState("");
  const [editIpWhitelist, setEditIpWhitelist] = useState("");
  const [editExpiresAt, setEditExpiresAt] = useState("");
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [pickerTarget, setPickerTarget] = useState(null); // 'create' | 'edit'
  const [createdKey, setCreatedKey] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [showSnippetModal, setShowSnippetModal] = useState(null); // key object or null
  const [snippetLang, setSnippetLang] = useState("curl");

  // Bulk edit state
  const [selectedKeyIds, setSelectedKeyIds] = useState(new Set());
  const [showBulkEdit, setShowBulkEdit] = useState(false);

  const [requireApiKey, setRequireApiKey] = useState(false);
 const [tunnelDashboardAccess, setTunnelDashboardAccess] = useState(false);
 const [authStatus, setAuthStatus] = useState(null);
 const [newKeyPermissions, setNewKeyPermissions] = useState({ ...EMPTY_PERMISSIONS });
 const [editPermissions, setEditPermissions] = useState({ ...EMPTY_PERMISSIONS });
 const isApiKeyUser = authStatus?.role === "apikey";
 const sessionApiKey = authStatus?.apiKey || null;
 // A key that is already inside the key table cannot hand out permissions, so the
 // whole block is inert and the value it writes is the default rather than whatever
 // the form last held. The API enforces the same rule; the point here is that the
 // form does not pretend to offer a choice it will not honour.
 const permissionsLocked = isApiKeyUser;
 const permissionsToSave = (current) => (permissionsLocked ? EMPTY_PERMISSIONS : current);
  // A key cannot edit, switch off or delete itself, so those controls are dimmed
  // instead of bouncing a 403 back at the user.
  const isOwnKey = (key) => isApiKeyUser && !!key && key.key === sessionApiKey;
  const creatorPermissions = authStatus?.permissions || { ...EMPTY_PERMISSIONS, manageApiKeys: true, manageModels: true, manageProviders: true, manageTools: true, manageAdvanced: true, managePlugins: true, manageMediaProviders: true };
 const creatorTokenLimit = authStatus?.tokenLimit || 0;
 const creatorAllowedModels = authStatus?.allowedModels || "*";
// A key that is itself limited to certain models can only hand those same models on.
const scopedModelPatterns =
  isApiKeyUser && creatorAllowedModels !== "*"
    ? String(creatorAllowedModels)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    : null;

 // Cloudflare Tunnel state
  const [tunnelChecking, setTunnelChecking] = useState(true);
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelReachable, setTunnelReachable] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tunnelPublicUrl, setTunnelPublicUrl] = useState("");
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelProgress, setTunnelProgress] = useState("");
  const [tunnelStatus, setTunnelStatus] = useState(null);
  const [showEnableTunnelModal, setShowEnableTunnelModal] = useState(false);
  const [showDisableTunnelModal, setShowDisableTunnelModal] = useState(false);

  // Tailscale state
  const [tsEnabled, setTsEnabled] = useState(false);
  const [tsReachable, setTsReachable] = useState(false);
  const [tsUrl, setTsUrl] = useState("");
  const [tsLoading, setTsLoading] = useState(false);
  const [tsProgress, setTsProgress] = useState("");
  const [tsStatus, setTsStatus] = useState(null);
  const [tsAuthUrl, setTsAuthUrl] = useState("");
  const [tsAuthLabel, setTsAuthLabel] = useState("");
  const [tsInstalled, setTsInstalled] = useState(null); // null=checking, true/false
  const [tsInstalling, setTsInstalling] = useState(false);
  const [tsInstallLog, setTsInstallLog] = useState([]);
  const [tsSudoPassword, setTsSudoPassword] = useState("");
  const [tsConnecting, setTsConnecting] = useState(false);
  const [showTsModal, setShowTsModal] = useState(false);
  const [showDisableTsModal, setShowDisableTsModal] = useState(false);
  const tsLogRef = useRef(null);

  // Debounce reachable=false: server may briefly return false during background refresh.
  // Only flip UI to "reconnecting" after N consecutive misses to avoid spinner flicker.
  const tunnelMissRef = useRef(0);
  const tsMissRef = useRef(0);
  // Browser-side reachable cache (independent of backend DNS quirks)
  const tunnelClientReachableRef = useRef(false);
  const tsClientReachableRef = useRef(false);
  // Track whether reachable=true was ever observed in this session.
  // Distinguishes "Checking..." (initial cold cache) from "Reconnecting..." (lost connection).
  const tunnelEverReachableRef = useRef(false);
  const tsEverReachableRef = useRef(false);
  const [tunnelEverReachable, setTunnelEverReachable] = useState(false);
  const [tsEverReachable, setTsEverReachable] = useState(false);

  // API key visibility toggle state
  const [visibleKeys, setVisibleKeys] = useState(new Set());

  // Client-side local/remote detection (UI hint only, not a security gate)
  const [isRemoteHost] = useState(() => {
    if (typeof window === "undefined") return false;
    return !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  });

  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    fetch("/api/auth/status")
      .then(res => res.json())
      .then(data => setAuthStatus(data))
      .catch(() => {});
  }, []);

  // Auto-scroll install log
  useEffect(() => {
    if (tsLogRef.current) tsLogRef.current.scrollTop = tsLogRef.current.scrollHeight;
  }, [tsInstallLog]);

  useEffect(() => {
    fetchData();
    loadSettings();
  }, []);

  // Live real-time key usage refresh (polls keys every 8s when tab visible)
  useEffect(() => {
    const pollTimer = setInterval(() => {
      if (document.hidden) return;
      fetch("/api/keys")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (Array.isArray(data?.keys)) {
            setKeys(data.keys);
          }
        })
        .catch(() => {});
    }, 8000);
    return () => clearInterval(pollTimer);
  }, []);

  // Status poll: only while degraded (not yet reachable). Stop once healthy to avoid spam.
  // Visibility re-check: refresh once when tab becomes visible.
  useEffect(() => {
    const anyEnabled = tunnelEnabled || tsEnabled;
    if (!anyEnabled) return;
    const tunnelHealthy = !tunnelEnabled || tunnelReachable;
    const tsHealthy = !tsEnabled || tsReachable;
    const allHealthy = tunnelHealthy && tsHealthy;
    const onVisible = () => { if (!document.hidden) syncTunnelStatus(); };
    document.addEventListener("visibilitychange", onVisible);
    if (allHealthy) return () => document.removeEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => { if (!document.hidden) syncTunnelStatus(); }, STATUS_POLL_FAST_MS);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tunnelEnabled, tsEnabled, tunnelReachable, tsReachable]);

  // Browser-side periodic ping: probes tunnel/tailscale URLs directly so UI stays
  // "reachable" even when backend DNS (1.1.1.1) hiccups on *.ts.net or *.trycloudflare.com.
  // Adaptive: slow when healthy, fast when degraded; pause when tab hidden.
  useEffect(() => {
    const probeBoth = async () => {
      if (document.hidden) return;
      if (tunnelEnabled && (tunnelUrl || tunnelPublicUrl)) {
        const ok = await clientPingAny(tunnelPublicUrl, tunnelUrl);
        tunnelClientReachableRef.current = ok;
        if (ok) { tunnelMissRef.current = 0; setTunnelReachable(true); if (!tunnelEverReachableRef.current) { tunnelEverReachableRef.current = true; setTunnelEverReachable(true); } }
        else { tunnelMissRef.current += 1; if (tunnelMissRef.current >= REACHABLE_MISS_THRESHOLD) setTunnelReachable(false); }
      } else {
        tunnelClientReachableRef.current = false;
      }
      if (tsEnabled && tsUrl) {
        const ok = await clientPingUrl(tsUrl);
        tsClientReachableRef.current = ok;
        if (ok) { tsMissRef.current = 0; setTsReachable(true); if (!tsEverReachableRef.current) { tsEverReachableRef.current = true; setTsEverReachable(true); } }
        else { tsMissRef.current += 1; if (tsMissRef.current >= REACHABLE_MISS_THRESHOLD) setTsReachable(false); }
      } else {
        tsClientReachableRef.current = false;
      }
    };
    const anyEnabled = (tunnelEnabled && (tunnelUrl || tunnelPublicUrl)) || (tsEnabled && tsUrl);
    if (!anyEnabled) return;
    probeBoth();
    const tunnelHealthy = !tunnelEnabled || tunnelReachable;
    const tsHealthy = !tsEnabled || tsReachable;
    if (tunnelHealthy && tsHealthy) return;
    const id = setInterval(probeBoth, CLIENT_PING_FAST_MS);
    return () => clearInterval(id);
  }, [tunnelEnabled, tunnelUrl, tunnelPublicUrl, tsEnabled, tsUrl, tunnelReachable, tsReachable]);

  // Client-side reachable only (server no longer probes; watchdog handles backend health).
  // Miss-debounce: only flip to false after N consecutive misses.
  const updateReachable = useCallback((_unused, clientRef, missRef, setter, everRef, everSetter) => {
    const reachable = clientRef.current;
    if (reachable) {
      missRef.current = 0;
      setter(true);
      if (!everRef.current) {
        everRef.current = true;
        everSetter(true);
      }
    } else {
      missRef.current += 1;
      if (missRef.current >= REACHABLE_MISS_THRESHOLD) setter(false);
    }
  }, []);

  // Trust user intent (settingsEnabled): UI stays "enabled" while watchdog restarts process
  const syncTunnelStatus = async () => {
    try {
      const statusRes = await fetch("/api/tunnel/status", { cache: "no-store" });
      if (!statusRes.ok) return;
      const data = await statusRes.json();
      const tEnabled = data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false;
      const tUrl = data.tunnel?.tunnelUrl || "";
      setTunnelUrl(tUrl);
      setTunnelPublicUrl(data.tunnel?.publicUrl || "");
      setTunnelEnabled(tEnabled);
      updateReachable(null, tunnelClientReachableRef, tunnelMissRef, setTunnelReachable, tunnelEverReachableRef, setTunnelEverReachable);

      const tsEn = data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false;
      const tsUrlVal = data.tailscale?.tunnelUrl || "";
      setTsUrl(tsUrlVal);
      setTsEnabled(tsEn);
      updateReachable(null, tsClientReachableRef, tsMissRef, setTsReachable, tsEverReachableRef, setTsEverReachable);
    } catch { /* ignore poll errors */ }
  };

  const loadSettings = async () => {
    setTunnelChecking(true);
    try {
      const [settingsData, statusRes] = await Promise.allSettled([
        useSettingsStore.getState().fetchSettings(),
        fetch("/api/tunnel/status", { cache: "no-store" })
      ]);
      const sVal = settingsData.status === "fulfilled" ? settingsData.value : null;
      if (sVal) {
        setRequireApiKey(sVal.requireApiKey || false);
        setRequireLogin(sVal.requireLogin !== false);
        setHasPassword(sVal.hasPassword || false);
        setTunnelDashboardAccess(sVal.tunnelDashboardAccess || false);
      }
      if (statusRes.status === "fulfilled" && statusRes.value.ok) {
        const data = await statusRes.value.json();
        const tEnabled = data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false;
        const tUrl = data.tunnel?.tunnelUrl || "";
        setTunnelUrl(tUrl);
        setTunnelPublicUrl(data.tunnel?.publicUrl || "");
        setTunnelEnabled(tEnabled);
        updateReachable(null, tunnelClientReachableRef, tunnelMissRef, setTunnelReachable, tunnelEverReachableRef, setTunnelEverReachable);

        const tsEn = data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false;
        const tsUrlVal = data.tailscale?.tunnelUrl || "";
        setTsUrl(tsUrlVal);
        setTsEnabled(tsEn);
        updateReachable(null, tsClientReachableRef, tsMissRef, setTsReachable, tsEverReachableRef, setTsEverReachable);
      }
    } catch (error) {
      console.log("Error loading settings:", error);
    } finally {
      setTunnelChecking(false);
    }
  };

  const handleTunnelDashboardAccess = async (value) => {
    try {
      const updated = await useSettingsStore.getState().patchSettings({ tunnelDashboardAccess: value });
      if (updated) setTunnelDashboardAccess(value);
    } catch (error) {
      console.log("Error updating tunnelDashboardAccess:", error);
    }
  };

  const handleRequireApiKey = async (value) => {
    try {
      const updated = await useSettingsStore.getState().patchSettings({ requireApiKey: value });
      if (updated) setRequireApiKey(value);
    } catch (error) {
      console.log("Error updating requireApiKey:", error);
    }
  };

  const fetchData = async () => {
    try {
      const fetchKeys = async () => {
        const res = await fetch("/api/keys");
        if (!res.ok) return [];
        const data = await res.json();
        return data.keys || [];
      };

      const fetchProvidersAndAliases = async () => {
        try {
          const [providersRes, aliasesRes] = await Promise.all([
            fetch("/api/providers"),
            fetch("/api/models/alias"),
          ]);
          if (providersRes.ok) {
            const pData = await providersRes.json();
            setActiveProviders(pData.connections || []);
          }
          if (aliasesRes.ok) {
            const aData = await aliasesRes.json();
            setModelAliases(aData.aliases || {});
          }
        } catch (e) {
          console.error("Error fetching providers/aliases:", e);
        }
      };

      fetchProvidersAndAliases();

      let existing = await fetchKeys();
      // Auto-provision a default key for first-time users so the endpoint works out of the box.
      if (existing.length === 0 && !defaultKeyProvisionInFlight) {
        defaultKeyProvisionInFlight = true;
        try {
          const createRes = await fetch("/api/keys", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Default Keys" }),
          });
          if (createRes.ok) existing = await fetchKeys();
        } catch { /* fall through to empty render */ }
        finally { defaultKeyProvisionInFlight = false; }
      }
      setKeys(existing);
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  // u2500u2500u2500 Cloudflare Tunnel handlers
  // Ping tunnel health until reachable. Race multiple URLs (shortlink + direct) — 1 OK is enough.
  const pingTunnelHealth = async (...urls) => {
    setTunnelLoading(true);
    setTunnelProgress("Waiting for tunnel ready...");
    const targets = urls.filter(Boolean).map((u) => `${u}/api/health`);
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      const ok = await Promise.any(targets.map(async (h) => {
        const p = await fetch(h, { mode: "cors", cache: "no-store" });
        if (p.ok) return true;
        throw new Error("not ready");
      })).catch(() => false);
      if (ok) {
        setTunnelEnabled(true);
        setTunnelLoading(false);
        setTunnelProgress("");
        return true;
      }
      // Every 5 pings (~10s), check if backend process still alive
      if ((Date.now() - start) % 10000 < TUNNEL_PING_INTERVAL_MS) {
        try {
          const statusRes = await fetch("/api/tunnel/status");
          if (statusRes.ok) {
            const status = await statusRes.json();
            if (!status.tunnel?.enabled) {
              setTunnelStatus({ type: "error", message: "Tunnel process stopped unexpectedly." });
              setTunnelLoading(false);
              setTunnelProgress("");
              return false;
            }
          }
        } catch { /* ignore */ }
      }
    }
    setTunnelStatus({ type: "error", message: "Tunnel created but not reachable. Please try again." });
    setTunnelLoading(false);
    setTunnelProgress("");
    return false;
  };

  const handleEnableTunnel = async () => {
    setShowEnableTunnelModal(false);
    setTunnelLoading(true);
    setTunnelStatus(null);
    setTunnelProgress("Creating tunnel...");

    // Poll download progress while enable request is pending
    let polling = true;
    const pollProgress = async () => {
      while (polling) {
        try {
          const r = await fetch("/api/tunnel/status");
          if (r.ok) {
            const s = await r.json();
            if (s.download?.downloading) {
              setTunnelProgress(`Downloading cloudflared... ${s.download.progress}%`);
            } else if (polling) {
              setTunnelProgress("Creating tunnel...");
            }
          }
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    pollProgress();

    try {
      const res = await fetch("/api/tunnel/enable", { method: "POST" });
      polling = false;
      const data = await res.json();
      if (!res.ok) {
        setTunnelStatus({ type: "error", message: data.error || "Failed to enable tunnel" });
        return;
      }

      const url = data.tunnelUrl;
      if (!url) {
        setTunnelStatus({ type: "error", message: "No tunnel URL returned" });
        return;
      }

      setTunnelUrl(url);
      setTunnelPublicUrl(data.publicUrl || "");
      await pingTunnelHealth(data.publicUrl, url);
    } catch (error) {
      setTunnelStatus({ type: "error", message: error.message });
    } finally {
      polling = false;
      setTunnelLoading(false);
      setTunnelProgress("");
    }
  };

  const handleDisableTunnel = async () => {
    setTunnelLoading(true);
    setTunnelStatus(null);
    try {
      const res = await fetch("/api/tunnel/disable", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setTunnelEnabled(false);
        setTunnelUrl("");
        setShowDisableTunnelModal(false);
        setTunnelStatus({ type: "success", message: "Tunnel disabled" });
      } else {
        setTunnelStatus({ type: "error", message: data.error || "Failed to disable tunnel" });
      }
    } catch (error) {
      setTunnelStatus({ type: "error", message: error.message });
    } finally {
      setTunnelLoading(false);
    }
  };

  // u2500u2500u2500 Tailscale handlers
  const checkTailscaleInstalled = async () => {
    setTsInstalled(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-check");
      if (res.ok) {
        const data = await res.json();
        setTsInstalled(data.installed);
        return data;
      }
    } catch { /* ignore */ }
    setTsInstalled(false);
    return { installed: false };
  };

  const handleInstallTailscale = async () => {
    setTsInstalling(true);
    setTsStatus(null);
    setTsInstallLog([]);
    try {
      const res = await fetch("/api/tunnel/tailscale-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sudoPassword: tsSudoPassword }),
      });
      setTsSudoPassword("");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const lines = part.split("\n");
          let event = "progress";
          let data = null;
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            if (line.startsWith("data: ")) {
              try { data = JSON.parse(line.slice(6)); } catch { /* skip */ }
            }
          }
          if (!data) continue;
          if (event === "progress") {
            setTsInstallLog((prev) => [...prev.slice(-50), data.message]);
          } else if (event === "done") {
            setTsInstalled(true);
            setTsInstalling(false);
            setShowTsModal(false);
            handleConnectTailscale();
            return;
          } else if (event === "error") {
            setTsStatus({ type: "error", message: data.error || "Install failed" });
          }
        }
      }
    } catch (e) {
      setTsStatus({ type: "error", message: e.message });
    } finally {
      setTsInstalling(false);
    }
  };

  // Ping Tailscale health until reachable
  const pingTsHealth = async (url) => {
    setTsProgress("Waiting for Tailscale ready...");
    const healthUrl = `${url}/api/health`;
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      try {
        const ping = await fetch(healthUrl, { mode: "no-cors", cache: "no-store" });
        if (ping.ok || ping.type === "opaque") return true;
      } catch { /* not ready yet */ }
    }
    return false;
  };

  // Show inline login button instead of auto-opening popup (browsers block popups
  // opened after async work because the user gesture is lost).
  const requestUserAuth = (url, label) => {
    setTsAuthUrl(url);
    setTsAuthLabel(label);
  };

  const clearUserAuth = () => {
    setTsAuthUrl("");
    setTsAuthLabel("");
  };

  const handleConnectTailscale = async () => {
    setShowTsModal(false);
    setTsConnecting(true);
    setTsLoading(true);
    setTsStatus(null);
    setTsProgress("Connecting...");
    clearUserAuth();
    try {
      const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
      const data = await res.json();

      if (res.ok && data.success) {
        setTsUrl(data.tunnelUrl || "");
        const reachable = await pingTsHealth(data.tunnelUrl);
        setTsEnabled(true);
        setTsStatus(reachable ? null : { type: "warning", message: "Connected but not reachable yet." });
        return;
      }

      if (data.needsLogin && data.authUrl) {
        requestUserAuth(data.authUrl, "Open Login Page");
        setTsProgress("Login required — click \"Open Login Page\" to continue");
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const r2 = await fetch("/api/tunnel/tailscale-check");
            if (r2.ok) {
              const check = await r2.json();
              if (check.loggedIn) {
                clearUserAuth();
                setTsProgress("Starting funnel...");
                const res2 = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
                const data2 = await res2.json();
                if (res2.ok && data2.success) {
                  setTsUrl(data2.tunnelUrl || "");
                  const ok2 = await pingTsHealth(data2.tunnelUrl);
                  setTsEnabled(true);
                  setTsStatus(ok2 ? null : { type: "warning", message: "Connected but not reachable yet." });
                } else if (data2.funnelNotEnabled && data2.enableUrl) {
                  await pollFunnelEnable(data2.enableUrl);
                } else {
                  setTsStatus({ type: "error", message: data2.error || "Failed to start funnel" });
                }
                return;
              }
            }
          } catch { /* retry */ }
        }
        clearUserAuth();
        setTsStatus({ type: "error", message: "Login timed out. Please try again." });
        return;
      }

      if (data.funnelNotEnabled && data.enableUrl) {
        await pollFunnelEnable(data.enableUrl);
        return;
      }

      setTsStatus({ type: "error", message: data.error || "Failed to connect" });
    } catch (error) {
      setTsStatus({ type: "error", message: error.message });
    } finally {
      setTsLoading(false);
      setTsConnecting(false);
      setTsProgress("");
      clearUserAuth();
    }
  };

  const pollFunnelEnable = async (enableUrl) => {
    requestUserAuth(enableUrl, "Open Funnel Settings");
    setTsProgress("Click \"Open Funnel Settings\" to enable Funnel...");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
        const data = await res.json();
        if (res.ok && data.success) {
          clearUserAuth();
          setTsUrl(data.tunnelUrl || "");
          const ok3 = await pingTsHealth(data.tunnelUrl);
          setTsEnabled(true);
          setTsStatus(ok3 ? null : { type: "warning", message: "Connected but not reachable yet." });
          return;
        }
        if (data.funnelNotEnabled) continue;
        if (data.error) {
          clearUserAuth();
          setTsStatus({ type: "error", message: data.error });
          return;
        }
      } catch { /* retry */ }
    }
    clearUserAuth();
    setTsStatus({ type: "error", message: "Timed out waiting for Funnel to be enabled." });
  };

  const handleDisableTailscale = async () => {
    setTsLoading(true);
    setTsStatus(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-disable", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setTsEnabled(false);
        setTsUrl("");
        setShowDisableTsModal(false);
        setTsStatus({ type: "success", message: "Tailscale disabled" });
      } else {
        setTsStatus({ type: "error", message: data.error || "Failed to disable Tailscale" });
      }
    } catch (e) {
      setTsStatus({ type: "error", message: e.message });
    } finally {
      setTsLoading(false);
    }
  };

  const handleOpenTsModal = async () => {
    setTsStatus(null);
    setTsInstallLog([]);
    const data = await checkTailscaleInstalled();
    if (data?.installed && data?.hasCachedPassword) {
      handleConnectTailscale();
    } else {
      setShowTsModal(true);
    }
  };

  const parseAllowedModelsList = (str) => {
    if (!str || str.trim() === "*" || str.trim() === "") return [];
    return str
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const setAllowedModelsList = (target, list) => {
    const joined = list.length === 0 ? "*" : list.join(", ");
    if (target === "create") setNewKeyAllowedModels(joined);
    else if (target === "edit") setEditAllowedModels(joined);
  };

  const currentAllowedModels = (target) =>
    parseAllowedModelsList(target === "create" ? newKeyAllowedModels : target === "edit" ? editAllowedModels : "");

  const addAllowedModel = (target, modelVal) => {
    const list = currentAllowedModels(target);
    if (!modelVal || list.includes(modelVal)) return;
    setAllowedModelsList(target, [...list, modelVal]);
  };

  const removeAllowedModel = (target, modelVal) => {
    setAllowedModelsList(target, currentAllowedModels(target).filter((m) => m !== modelVal));
  };

  // The picker modal serves whichever form opened it, so it routes by pickerTarget.
  const handleSelectModelForPicker = (model) => addAllowedModel(pickerTarget, model?.value);
  const handleDeselectModelForPicker = (model) => removeAllowedModel(pickerTarget, model?.value);


  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;
 const trimmedName = newKeyName.trim();
 if (keys.some((k) => k.name === trimmedName)) {
 alert(`A key named "${trimmedName}" already exists. Use a different name.`);
 return;
 }

    const limitNum = newKeyLimit ? Number(newKeyLimit) : 0;
    let finalReset = "never";
    if (limitNum > 0) {
      finalReset = newKeyReset === "custom" ? (newKeyCustomReset.trim() || "never") : newKeyReset;
    }

    if (creatorTokenLimit > 0 && limitNum > creatorTokenLimit) {
      alert(`Token limit cannot exceed your maximum (${creatorTokenLimit}).`);
      return;
    }

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newKeyName,
          customKey: newCustomKey.trim() || undefined,
          appendSecret: newAppendSecret,
          tokenLimit: limitNum,
          resetInterval: finalReset,
          allowedModels: newKeyAllowedModels.trim() || "*",
          rpmLimit: newKeyRpm ? Number(newKeyRpm) : 0,
          tpmLimit: newKeyTpm ? Number(newKeyTpm) : 0,
          ipWhitelist: newKeyIpWhitelist.trim(),
          expiresAt: newKeyExpiresAt || null,
          permissions: permissionsToSave(newKeyPermissions),
        }),
      });
      const data = await res.json();

      if (res.ok) {
        setCreatedKey(data.key);
        await fetchData();
        setNewKeyName("");
        setNewCustomKey("");
        setNewAppendSecret(true);
        setNewKeyLimit("");
        setNewKeyReset("never");
        setNewKeyCustomReset("");
        setNewKeyAllowedModels("*");
        setNewKeyRpm("");
        setNewKeyTpm("");
        setNewKeyIpWhitelist("");
        setShowAddModal(false);
        setNewKeyExpiresAt("");
        setNewKeyPermissions(EMPTY_PERMISSIONS);
 } else {
 alert(data?.error || "Failed to create key");
 }
    } catch (error) {
      console.log("Error creating key:", error);
    }
  };

 const handleDuplicateKey = (sourceKey) => {
 // Suggest a unique name like "X (copy)" / "X (copy 2)"
 let base = `${sourceKey.name} (copy)`;
 let candidate = base;
 let n = 2;
 while (keys.some((k) => k.name === candidate)) {
 candidate = `${base} ${n}`;
 n += 1;
 }
 setNewKeyName(candidate);
 setNewKeyLimit(sourceKey.tokenLimit ? String(sourceKey.tokenLimit) : "");
 const resVal = sourceKey.resetInterval || "never";
 if (["never", "5h", "7d", "14d", "30d"].includes(resVal)) {
 setNewKeyReset(resVal);
 setNewKeyCustomReset("");
 } else {
 setNewKeyReset("custom");
 setNewKeyCustomReset(resVal);
 }
 setNewKeyAllowedModels(sourceKey.allowedModels || "*");
 setNewKeyRpm(sourceKey.rpmLimit ? String(sourceKey.rpmLimit) : "");
 setNewKeyTpm(sourceKey.tpmLimit ? String(sourceKey.tpmLimit) : "");
 setNewKeyIpWhitelist(sourceKey.ipWhitelist || "");
 setNewKeyExpiresAt(sourceKey.expiresAt || "");
 setNewKeyPermissions(sourceKey.permissions || EMPTY_PERMISSIONS);
 setShowAddModal(true);
 };

  const handleUpdateKeyQuota = async (id, data) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setEditingKey(null);
      } else {
        const errBody = await res.json().catch(() => ({}));
        alert(errBody?.error || "Failed to update key");
      }
    } catch (error) {
      console.log("Error updating key:", error);
    }
  };

  const handleToggleKeyActive = async (key, isActive) => {
    const previous = key.isActive !== false;
    setKeys((prev) => prev.map((k) => (k.id === key.id ? { ...k, isActive } : k)));
    try {
      const res = await fetch(`/api/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        alert(errBody?.error || "Failed to update the key state.");
        setKeys((prev) => prev.map((k) => (k.id === key.id ? { ...k, isActive: previous } : k)));
      return;
    }
    } catch (error) {
      console.log("Error updating key state:", error);
      setKeys((prev) => prev.map((k) => (k.id === key.id ? { ...k, isActive: previous } : k)));
    }
    await fetchData();
  };

  const handleManualResetUsage = async (key) => {
    setConfirmState({
      title: "Reset Token Usage",
      message: `Reset used tokens for "${key.name}" back to 0?`,
      onConfirm: async () => {
        setConfirmState(null);
        await handleUpdateKeyQuota(key.id, {
          usedTokens: 0,
          lastResetAt: new Date().toISOString(),
        });
      },
    });
  };

  const handleDeleteKey = async (id) => {
    setConfirmState({
      title: "Delete API Key",
      message: "Delete this API key?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
          if (res.ok) {
            setKeys(keys.filter((k) => k.id !== id));
            setVisibleKeys(prev => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          } else {
            const errBody = await res.json().catch(() => null);
            alert(errBody?.error || "Delete failed");
          }
        } catch (error) {
          console.log("Error deleting key:", error);
        }
      }
    });
  };

  const maskKey = (fullKey) => {
    if (!fullKey || fullKey.length <= 10) return fullKey || "";
    return fullKey.slice(0, 6) + "•".repeat(fullKey.length - 10) + fullKey.slice(-4);
  };

  const toggleKeyVisibility = (keyId) => {
    setVisibleKeys(prev => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

  // Small "who made this key" label under the key name. The server resolves the
  // creator to a name, so the raw creator key never has to travel to the browser;
  // the same wording rules live in one helper so both key pages read alike.
  const creatorLabelFor = (key) => {
    const creator = key?.createdByName || "";
    if (creator) return `Created by ${creator}`;
    if (key?.createdBy === "dashboard") return "Created by dashboard";
    return "";
  };

  const [baseUrl] = useState(() => {
    if (typeof window !== "undefined") {
      return `${window.location.origin}/v1`;
    }
    return "/v1";
  });

  if (loading) {
    return (
      <div className="flex flex-col gap-6 max-w-full">
        <div className="p-6 rounded-[6px] border border-border-subtle bg-surface shadow-[var(--shadow-elev)] space-y-4">
          <div className="flex items-center justify-between">
            <div className="h-5 w-40 bg-surface-2 rounded animate-pulse" />
            <div className="h-6 w-20 bg-surface-2 rounded animate-pulse" />
          </div>
          <div className="h-10 w-full bg-surface-2 rounded animate-pulse" />
          <div className="h-4 w-3/4 bg-surface-2 rounded animate-pulse" />
        </div>
        <div className="p-6 rounded-[6px] border border-border-subtle bg-surface shadow-[var(--shadow-elev)] space-y-4">
          <div className="h-5 w-32 bg-surface-2 rounded animate-pulse" />
          <div className="h-24 w-full bg-surface-2 rounded animate-pulse" />
        </div>
      </div>
    );
  }

  const currentEndpoint = baseUrl;

  const filteredKeys = keys.filter((k) => {
    if (!keySearch.trim()) return true;
    const q = keySearch.trim().toLowerCase();
    return (k.name && k.name.toLowerCase().includes(q)) || (k.key && k.key.toLowerCase().includes(q));
  });

  const toggleKeySelection = (id) => {
    setSelectedKeyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllKeys = () => {
    if (selectedKeyIds.size === filteredKeys.length) {
      setSelectedKeyIds(new Set());
    } else {
      setSelectedKeyIds(new Set(filteredKeys.map((k) => k.id)));
    }
  };

  const handleBulkApply = async (patch) => {
    const ids = [...selectedKeyIds];
    if (ids.length === 0) return;
    try {
      const res = await fetch("/api/keys/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, patch }),
      });
      if (res.ok) {
        setKeys((prev) =>
          prev.map((k) => (selectedKeyIds.has(k.id) ? { ...k, ...patch } : k))
        );
      }
    } catch (err) {
      console.error("Error bulk applying:", err);
    }
    await fetchData();
    setSelectedKeyIds(new Set());
  };

  const handleBulkDelete = () => {
    const ids = [...selectedKeyIds];
    if (ids.length === 0) return;
    setConfirmState({
      title: `Delete ${ids.length} API Keys`,
      message: `Delete ${ids.length} selected API keys? This action cannot be undone.`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch("/api/keys/bulk", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids }),
          });
          if (res.ok) {
            setKeys((prev) => prev.filter((k) => !selectedKeyIds.has(k.id)));
            setSelectedKeyIds(new Set());
          } else {
            const err = await res.json().catch(() => null);
            alert(err?.error || "Bulk delete failed");
          }
        } catch (error) {
          console.error("Error bulk deleting keys:", error);
        }
      },
    });
  };

  const getCodeSnippet = (lang) => {
    const keyStr = keys[0] ? keys[0].key : "<YOUR_KEY>";
    if (lang === "curl") {
      return `curl ${currentEndpoint}/chat/completions \\
  -H "Authorization: Bearer ${keyStr}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello"}]}'`;
    }
    if (lang === "python") {
      return `from openai import OpenAI

client = OpenAI(base_url="${currentEndpoint}", api_key="${keyStr}")
res = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Hello"}]
)
print(res.choices[0].message.content)`;
    }
    if (lang === "node") {
      return `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${currentEndpoint}", apiKey: "${keyStr}" });
const res = await client.chat.completions.create({
  model: "deepseek-chat",
  messages: [{ role: "user", content: "Hello" }]
});
console.log(res.choices[0].message.content);`;
    }
    return "";
  };

  return (
    <div className="flex flex-col gap-5 pb-16 lg:pb-8">
      {/* 1. Master Gateway Console Card */}
      <div className="relative rounded-[6px] border border-border bg-surface p-4 sm:p-5 shadow-[var(--shadow-elev)] overflow-hidden">
        {/* Accent top stripe */}
        <span className="absolute top-0 inset-x-0 h-[2px] bg-brand-500" aria-hidden="true" />

        {/* Header */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="material-symbols-outlined text-primary text-[19px]">router</span>
            <h2 className="text-sm sm:text-base font-semibold text-text-main uppercase tracking-wider">
              Gateway Endpoint
            </h2>
            <span className="px-2 py-0.5 rounded-[4px] bg-success/15 border border-success/30 text-success text-[10.5px] font-mono flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-success animate-pulse" />
              ONLINE · 200 OK
            </span>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className={cn(
              "px-2 py-0.5 rounded-[4px] font-mono text-[10.5px] border flex items-center gap-1",
              requireApiKey
                ? "bg-brand-500/10 border-brand-500/30 text-primary"
                : "bg-warning/10 border-warning/30 text-warning"
            )}>
              <span className="material-symbols-outlined text-[13px]">
                {requireApiKey ? "lock" : "lock_open"}
              </span>
              <span>{requireApiKey ? "Auth Required" : "Public Endpoint"}</span>
            </span>
          </div>
        </div>

        {/* Primary URL Field with Integrated 1-Click Copy */}
        <div className="mt-3 flex items-center gap-1.5 rounded-[6px] border border-border bg-surface-2 p-1.5 transition-all focus-within:border-brand-500">
          <span className="px-2 py-0.5 rounded-[3px] bg-surface border border-border-subtle font-mono text-[10px] font-semibold text-primary shrink-0">
            OpenAI
          </span>
          <input
            type="text"
            readOnly
            value={currentEndpoint}
            className="flex-1 min-w-0 bg-transparent px-1.5 py-0.5 font-mono text-[11.5px] sm:text-xs text-text-main outline-none select-all"
          />
          <button
            type="button"
            onClick={() => copy(currentEndpoint, "gateway_url")}
            className="flex items-center gap-1 rounded-[4px] bg-surface px-2.5 py-1 text-xs font-medium text-text-main border border-border hover:border-brand-500 hover:text-primary transition-colors shrink-0 cursor-pointer shadow-xs"
            title="Copy Base URL"
          >
            <span className="material-symbols-outlined text-[15px] text-primary">
              {copied === "gateway_url" ? "check" : "content_copy"}
            </span>
            <span className="text-[11px]">{copied === "gateway_url" ? "Copied!" : "Copy"}</span>
          </button>
        </div>

        {/* Anthropic-Compatible Endpoint */}
        <div className="mt-1.5 flex items-center gap-1.5 rounded-[6px] border border-border bg-surface-2 p-1.5 transition-all focus-within:border-brand-500">
          <span className="px-2 py-0.5 rounded-[3px] bg-surface border border-border-subtle font-mono text-[10px] font-semibold text-[#d97757] shrink-0">
            Claude
          </span>
          <input
            type="text"
            readOnly
            value={currentEndpoint.replace(/\/v1$/, "")}
            className="flex-1 min-w-0 bg-transparent px-1.5 py-0.5 font-mono text-[11.5px] sm:text-xs text-text-main outline-none select-all"
          />
          <button
            type="button"
            onClick={() => copy(currentEndpoint.replace(/\/v1$/, ""), "anthropic_url")}
            className="flex items-center gap-1 rounded-[4px] bg-surface px-2.5 py-1 text-xs font-medium text-text-main border border-border hover:border-brand-500 hover:text-primary transition-colors shrink-0 cursor-pointer shadow-xs"
            title="Copy Anthropic Base URL"
          >
            <span className="material-symbols-outlined text-[15px] text-[#d97757]">
              {copied === "anthropic_url" ? "check" : "content_copy"}
            </span>
            <span className="text-[11px]">{copied === "anthropic_url" ? "Copied!" : "Copy"}</span>
          </button>
        </div>

        {/* Collapsible Quick Code Integration */}
        <div className="mt-3 pt-3 border-t border-border-subtle">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowCodeSnippet((prev) => !prev)}
              className="flex items-center gap-1.5 text-xs font-medium text-text-muted hover:text-primary transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px] text-primary">code</span>
              <span>{showCodeSnippet ? "Hide Client Code Snippets" : "Show Client Code Snippets"}</span>
              <span
                className="material-symbols-outlined text-[15px] transition-transform duration-200"
                style={{ transform: showCodeSnippet ? "rotate(180deg)" : "rotate(0deg)" }}
              >
                expand_more
              </span>
            </button>

            {showCodeSnippet && (
              <button
                type="button"
                onClick={() => copy(getCodeSnippet(activeSnippetTab), "snippet_code")}
                className="text-[11px] text-text-muted hover:text-primary flex items-center gap-1 font-mono transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[14px]">
                  {copied === "snippet_code" ? "check" : "content_copy"}
                </span>
                <span>{copied === "snippet_code" ? "Copied" : "Copy Code"}</span>
              </button>
            )}
          </div>

          {showCodeSnippet && (
            <div className="mt-2.5 space-y-2">
              <div className="flex items-center gap-1 text-xs">
                {[
                  { id: "curl", label: "cURL" },
                  { id: "python", label: "Python" },
                  { id: "node", label: "Node.js" },
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveSnippetTab(item.id)}
                    className={cn(
                      "px-3 py-1 rounded-[4px] font-mono text-[11px] uppercase transition-colors border cursor-pointer",
                      activeSnippetTab === item.id
                        ? "bg-brand-500 text-white border-brand-500 font-semibold"
                        : "bg-surface-2 border-border text-text-muted hover:text-text-main"
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <pre className="p-3 rounded-[6px] border border-border-subtle bg-bg font-mono text-[11px] text-text-main overflow-x-auto custom-scrollbar whitespace-pre-wrap leading-relaxed break-all">
                {getCodeSnippet(activeSnippetTab)}
              </pre>
            </div>
          )}
        </div>
      </div>

      {/* 2. Network Routing & Exposure Matrix */}
      {!isApiKeyUser && (
        <div className="rounded-[6px] border border-border bg-surface p-4 sm:p-5 shadow-[var(--shadow-elev)] space-y-3.5">
          {/* Section Header */}
          <div className="flex items-center justify-between border-b border-border-subtle pb-2.5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[19px]">cell_tower</span>
              <h3 className="text-xs sm:text-sm font-semibold uppercase tracking-wider text-text-main">
                Network Routing & Exposure
              </h3>
            </div>
            <span className="text-[11px] font-mono text-text-muted">3 Interfaces</span>
          </div>

          {/* Network Interfaces List */}
          <div className="space-y-2">
            {/* Route 1: Local Loopback Host */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3 rounded-[6px] border border-border-subtle bg-surface-2 hover:border-border transition-colors">
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-8 rounded-[5px] border border-border bg-surface flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-primary text-[17px]">computer</span>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-text-main">Local Host</span>
                    <span className="px-1.5 py-0.5 rounded-[3px] bg-success/15 border border-success/30 text-success text-[9.5px] font-mono font-medium">
                      ACTIVE
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-text-muted truncate mt-0.5" title={currentEndpoint}>
                    {currentEndpoint}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end shrink-0">
                <button
                  type="button"
                  onClick={() => copy(currentEndpoint, "local_url")}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-[4px] border border-border bg-surface text-text-main text-[11px] font-medium hover:border-brand-500 hover:text-primary transition-colors cursor-pointer shadow-xs"
                >
                  <span className="material-symbols-outlined text-primary text-[14px]">
                    {copied === "local_url" ? "check" : "content_copy"}
                  </span>
                  <span>{copied === "local_url" ? "Copied!" : "Copy URL"}</span>
                </button>
              </div>
            </div>

            {/* Route 2: Cloudflare Tunnel */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3 rounded-[6px] border border-border-subtle bg-surface-2 hover:border-border transition-colors">
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-8 rounded-[5px] border border-border bg-surface flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-primary text-[17px]">cloud_sync</span>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-text-main">Cloudflare Tunnel</span>
                    <span className={cn(
                      "px-1.5 py-0.5 rounded-[3px] text-[9.5px] font-mono font-medium border",
                      tunnelEnabled && tunnelReachable
                        ? "bg-success/15 border-success/30 text-success"
                        : tunnelEnabled
                          ? "bg-warning/15 border-warning/30 text-warning animate-pulse"
                          : "bg-surface border-border text-text-muted"
                    )}>
                      {tunnelEnabled && tunnelReachable ? "PUBLIC" : tunnelEnabled ? "CONNECTING" : "OFFLINE"}
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-text-muted truncate mt-0.5">
                    {tunnelEnabled && tunnelReachable
                      ? `${tunnelPublicUrl || tunnelUrl}/v1`
                      : tunnelLoading
                        ? (tunnelProgress || "Starting tunnel...")
                        : "Public internet access without open ports"}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-1.5 shrink-0">
                {tunnelEnabled && tunnelReachable ? (
                  <>
                    <button
                      type="button"
                      onClick={() => copy(`${tunnelPublicUrl || tunnelUrl}/v1`, "tunnel_url")}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-[4px] border border-border bg-surface text-text-main text-[11px] font-medium hover:border-brand-500 hover:text-primary transition-colors cursor-pointer shadow-xs"
                    >
                      <span className="material-symbols-outlined text-primary text-[14px]">
                        {copied === "tunnel_url" ? "check" : "content_copy"}
                      </span>
                      <span>{copied === "tunnel_url" ? "Copied!" : "Copy URL"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowDisableTunnelModal(true)}
                      className="p-1 rounded-[4px] border border-border bg-surface text-danger hover:bg-danger/10 transition-colors cursor-pointer"
                      title="Disable Tunnel"
                    >
                      <span className="material-symbols-outlined text-[15px]">power_settings_new</span>
                    </button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="cloud_upload"
                    loading={tunnelLoading}
                    onClick={() => {
                      if (!requireApiKey) {
                        setTunnelStatus({ type: "error", message: "Security required: Enable 'Require API key' before activating the tunnel." });
                        return;
                      }
                      setShowEnableTunnelModal(true);
                    }}
                    className="text-[11px] px-2.5 py-1 h-7.5"
                  >
                    Enable Tunnel
                  </Button>
                )}
              </div>
            </div>

            {/* Route 3: Tailscale Mesh */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3 rounded-[6px] border border-border-subtle bg-surface-2 hover:border-border transition-colors">
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-8 rounded-[5px] border border-border bg-surface flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-primary text-[17px]">vpn_lock</span>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-text-main">Tailscale Mesh</span>
                    <span className={cn(
                      "px-1.5 py-0.5 rounded-[3px] text-[9.5px] font-mono font-medium border",
                      tsEnabled && tsReachable
                        ? "bg-success/15 border-success/30 text-success"
                        : tsEnabled
                          ? "bg-warning/15 border-warning/30 text-warning animate-pulse"
                          : "bg-surface border-border text-text-muted"
                    )}>
                      {tsEnabled && tsReachable ? "MESH ACTIVE" : tsEnabled ? "CONNECTING" : "OFFLINE"}
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-text-muted truncate mt-0.5">
                    {tsEnabled && tsReachable
                      ? `${tsUrl}/v1`
                      : tsLoading
                        ? (tsProgress || "Connecting Tailscale...")
                        : "Private tailnet mesh network access"}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-1.5 shrink-0">
                {tsEnabled && tsReachable ? (
                  <>
                    <button
                      type="button"
                      onClick={() => copy(`${tsUrl}/v1`, "ts_url")}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-[4px] border border-border bg-surface text-text-main text-[11px] font-medium hover:border-brand-500 hover:text-primary transition-colors cursor-pointer shadow-xs"
                    >
                      <span className="material-symbols-outlined text-primary text-[14px]">
                        {copied === "ts_url" ? "check" : "content_copy"}
                      </span>
                      <span>{copied === "ts_url" ? "Copied!" : "Copy URL"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowDisableTsModal(true)}
                      className="p-1 rounded-[4px] border border-border bg-surface text-danger hover:bg-danger/10 transition-colors cursor-pointer"
                      title="Disable Tailscale"
                    >
                      <span className="material-symbols-outlined text-[15px]">power_settings_new</span>
                    </button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="vpn_lock"
                    loading={tsLoading || tsConnecting}
                    onClick={handleOpenTsModal}
                    className="text-[11px] px-2.5 py-1 h-7.5"
                  >
                    Connect Tailscale
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Security & Access Policy Strip */}
          <div className="mt-3 pt-3 border-t border-border-subtle flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs">
            <div className="flex items-center gap-3">
              <Toggle
                checked={requireApiKey}
                onChange={() => handleRequireApiKey(!requireApiKey)}
              />
              <div>
                <span className="font-semibold text-text-main">Require API Key Authentication</span>
                <p className="text-text-muted text-[11px]">
                  {requireApiKey ? "Active: requests without a valid key are rejected with HTTP 401" : "Warning: anyone can access your router endpoint without a key"}
                </p>
              </div>
            </div>

            {(tunnelEnabled || tsEnabled) && (
              <div className="flex items-center gap-3 pt-2 sm:pt-0 sm:border-l sm:border-border sm:pl-4">
                <Toggle
                  checked={tunnelDashboardAccess}
                  onChange={() => handleTunnelDashboardAccess(!tunnelDashboardAccess)}
                />
                <div>
                  <span className="font-semibold text-text-main">Allow Dashboard over Tunnel</span>
                  <p className="text-text-muted text-[11px]">Allow web GUI through tunnel URL</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3. API Keys Credential Vault */}
      <div className="space-y-3.5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 border-b border-border pb-2">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[19px]">vpn_key</span>
            <h2 className="text-sm sm:text-base font-semibold text-text-main uppercase tracking-wider">
              API Keys
            </h2>
            <span className="text-xs font-mono text-text-muted">({keys.length})</span>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[15px]">
                search
              </span>
              <input
                type="text"
                placeholder="Filter keys..."
                value={keySearch}
                onChange={(e) => setKeySearch(e.target.value)}
                className="w-36 sm:w-48 pl-8 pr-3 py-1 bg-surface-2 border border-border rounded-[6px] text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:border-brand-500"
              />
            </div>

            {selectedKeyIds.size > 0 && (
              <>
                <Button size="sm" variant="secondary" icon="edit" onClick={() => setShowBulkEdit(true)}>
                  Bulk Edit ({selectedKeyIds.size})
                </Button>
                <Button size="sm" variant="danger" icon="delete" onClick={handleBulkDelete}>
                  Bulk Delete ({selectedKeyIds.size})
                </Button>
              </>
            )}

            <Button size="sm" icon="add" onClick={() => setShowAddModal(true)}>
              Create Key
            </Button>
          </div>
        </div>

        {filteredKeys.length === 0 ? (
          <div className="text-center py-10 rounded-[6px] border border-dashed border-border bg-surface p-6">
            <span className="material-symbols-outlined text-3xl text-text-muted opacity-40 mb-2 block">
              vpn_key
            </span>
            <p className="text-xs font-medium text-text-main">No API keys found</p>
            <p className="text-[11px] text-text-muted mt-0.5 mb-3">
              {keySearch ? "No keys matching your search filter." : "Create your first key to start authenticating clients."}
            </p>
            <Button size="sm" icon="add" onClick={() => setShowAddModal(true)}>
              Create Key
            </Button>
          </div>
        ) : (
          <div className="space-y-2.5">
            {filteredKeys.map((key) => {
              const isQuotaExceeded = key.tokenLimit > 0 && (key.usedTokens || 0) >= key.tokenLimit;
              const isKeyDisabled = key.isActive === false;

              return (
                <div
                  key={key.id}
                  className={cn(
                    "group relative flex flex-col justify-between p-3.5 rounded-[6px] border bg-surface transition-all duration-150 shadow-[var(--shadow-elev)]",
                    isKeyDisabled
                      ? "opacity-60 border-border bg-surface-2"
                      : "border-border hover:border-brand-500/50 hover:bg-surface-2"
                  )}
                >
                  {!isKeyDisabled && (
                    <span className="absolute inset-y-0 left-0 w-[3px] bg-brand-500" aria-hidden="true" />
                  )}

                  {/* Top row: Status + Name + Creator + Actions */}
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        checked={selectedKeyIds.has(key.id)}
                        onChange={() => toggleKeySelection(key.id)}
                        className="size-3.5 accent-[var(--color-primary)] shrink-0 cursor-pointer"
                        aria-label={`Select ${key.name}`}
                      />
                      <span className={cn(
                        "size-2 rounded-full shrink-0",
                        !isKeyDisabled ? "bg-success" : "bg-warning"
                      )} />
                      <h4 className="text-xs sm:text-sm font-semibold text-text-main truncate">
                        {key.name}
                      </h4>
                      {creatorLabelFor(key) && (
                        <span className="text-[9.5px] font-mono text-text-muted px-1.5 py-0.5 rounded bg-surface-3 shrink-0">
                          {creatorLabelFor(key)}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <Toggle
                        size="sm"
                        checked={!isKeyDisabled}
                        disabled={isOwnKey(key)}
                        onChange={(nextActive) => handleToggleKeyActive(key, nextActive)}
                        title={isKeyDisabled ? "Activate key" : "Disable key"}
                      />

                      <div className="h-3.5 w-px bg-border mx-0.5" />

                      <button
                        type="button"
                        onClick={() => {
                          setEditingKey(key);
                          setEditName(key.name || "");
                          const lim = key.tokenLimit ? String(key.tokenLimit) : "";
                          setEditLimit(lim);
                          const resVal = key.resetInterval || "never";
                          if (["never", "5h", "7d", "14d", "30d"].includes(resVal)) {
                            setEditReset(resVal);
                            setEditCustomReset("");
                          } else {
                            setEditReset("custom");
                            setEditCustomReset(resVal);
                          }
                          setEditAllowedModels(key.allowedModels || "*");
                          setEditRpm(key.rpmLimit ? String(key.rpmLimit) : "");
                          setEditTpm(key.tpmLimit ? String(key.tpmLimit) : "");
                          setEditIpWhitelist(key.ipWhitelist || "");
                          setEditExpiresAt(key.expiresAt || "");
                          setEditPermissions(key.permissions || EMPTY_PERMISSIONS);
                        }}
                        disabled={isOwnKey(key)}
                        className="p-1 rounded hover:bg-surface-3 text-text-muted hover:text-primary transition-colors cursor-pointer"
                        title="Edit key"
                      >
                        <span className="material-symbols-outlined text-[15px]">edit</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDuplicateKey(key)}
                        disabled={isOwnKey(key)}
                        className="p-1 rounded hover:bg-surface-3 text-text-muted hover:text-primary transition-colors cursor-pointer"
                        title="Duplicate"
                      >
                        <span className="material-symbols-outlined text-[15px]">library_add</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleManualResetUsage(key)}
                        disabled={isOwnKey(key)}
                        className="p-1 rounded hover:bg-surface-3 text-text-muted hover:text-primary transition-colors cursor-pointer"
                        title="Reset token usage"
                      >
                        <span className="material-symbols-outlined text-[15px]">restart_alt</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteKey(key.id)}
                        disabled={isOwnKey(key)}
                        className="p-1 rounded hover:bg-danger/10 text-danger transition-colors cursor-pointer"
                        title="Delete key"
                      >
                        <span className="material-symbols-outlined text-[15px]">delete</span>
                      </button>
                    </div>
                  </div>

                  {/* Middle row: Monospace key credential bar */}
                  <div className="my-2 flex items-center justify-between gap-2 p-1.5 rounded-[4px] border border-border-subtle bg-surface-2 font-mono text-[11px]">
                    <span className="text-text-main truncate select-all">
                      {visibleKeys.has(key.id) ? key.key : maskKey(key.key)}
                    </span>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => toggleKeyVisibility(key.id)}
                        className="p-1 rounded hover:bg-surface-3 text-text-muted hover:text-text-main transition-colors cursor-pointer"
                        title={visibleKeys.has(key.id) ? "Hide key" : "Reveal key"}
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {visibleKeys.has(key.id) ? "visibility_off" : "visibility"}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => copy(key.key, key.id)}
                        className="p-1 rounded hover:bg-surface-3 text-text-muted hover:text-primary transition-colors cursor-pointer"
                        title="Copy key"
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {copied === key.id ? "check" : "content_copy"}
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* Real-time Visual Quota Progress Bar */}
                  {(() => {
                    const limit = key.tokenLimit || 0;
                    const used = key.usedTokens || 0;
                    const isUnlimited = limit <= 0;

                    if (isUnlimited) {
                      return (
                        <div className="my-2.5 flex flex-col gap-1">
                          <div className="flex items-center justify-between text-[11px] font-mono">
                            <span className="text-text-muted flex items-center gap-1.5">
                              <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                              <span>Live Quota Usage</span>
                            </span>
                            <span className="text-success font-semibold text-[10px] px-1.5 py-0.5 rounded bg-success-bg border border-success-border flex items-center gap-1">
                              <span>∞ Unlimited ({formatTokensNumber(used)} used)</span>
                            </span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-surface-3 overflow-hidden border border-border-subtle relative">
                            <div className="h-full bg-gradient-to-r from-emerald-500/20 via-emerald-400 to-emerald-500/20 w-full animate-pulse" />
                          </div>
                        </div>
                      );
                    }

                    const pct = Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
                    const remaining = Math.max(0, limit - used);
                    const isExhausted = used >= limit;
                    const isWarning = pct >= 75 && !isExhausted;

                    return (
                      <div className="my-2.5 flex flex-col gap-1">
                        <div className="flex items-center justify-between text-[11px] font-mono">
                          <span className="text-text-muted flex items-center gap-1.5">
                            <span className={cn(
                              "size-1.5 rounded-full shrink-0",
                              isExhausted ? "bg-danger animate-ping" : isWarning ? "bg-warning animate-pulse" : "bg-emerald-400"
                            )} />
                            <span>{pct}% Used ({formatTokensNumber(used)} / {formatTokensNumber(limit)})</span>
                          </span>
                          <span className={cn(
                            "font-semibold text-[10px] px-1.5 py-0.5 rounded border transition-colors",
                            isExhausted
                              ? "bg-danger-bg text-danger border-danger/30 font-bold"
                              : isWarning
                              ? "bg-warning-bg text-warning border-warning-border"
                              : "bg-surface-2 text-text-muted border-border-subtle"
                          )}>
                            {isExhausted ? "EXHAUSTED (0 LEFT)" : `${formatTokensNumber(remaining)} tokens left`}
                          </span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-surface-3 overflow-hidden border border-border-subtle relative p-[1px]">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all duration-700 ease-out shadow-xs",
                              isExhausted
                                ? "bg-gradient-to-r from-danger via-rose-500 to-danger animate-pulse"
                                : isWarning
                                ? "bg-gradient-to-r from-amber-500 via-orange-400 to-amber-500"
                                : "bg-gradient-to-r from-brand-500 via-emerald-400 to-brand-500"
                            )}
                            style={{ width: `${Math.max(pct, 2)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })()}

                  {/* Bottom row: Telemetry & Policy chips */}
                  <div className="flex flex-wrap items-center gap-1 text-[10.5px]">
                    <span className={cn(
                      "px-1.5 py-0.5 rounded-[3px] font-mono",
                      isQuotaExceeded
                        ? "bg-danger-bg text-danger font-semibold border border-danger/30"
                        : "bg-brand-500/10 text-primary border border-brand-500/20"
                    )}>
                      Tokens: {formatTokensNumber(key.usedTokens)} / {key.tokenLimit > 0 ? formatTokensNumber(key.tokenLimit) : "Unlimited"}
                    </span>

                    {key.tokenLimit > 0 && key.resetInterval && key.resetInterval !== "never" && (
                      <span className="px-1.5 py-0.5 rounded-[3px] bg-surface-2 border border-border-subtle text-text-muted font-mono">
                        Reset: every {key.resetInterval}
                      </span>
                    )}

                    {key.tokenLimit > 0 && key.resetInterval && key.resetInterval !== "never" && (
                      <ResetCountdown resetInterval={key.resetInterval} lastResetAt={key.lastResetAt} />
                    )}

                    <span className="px-1.5 py-0.5 rounded-[3px] bg-info-bg text-info border border-info-border font-mono">
                      Models: {key.allowedModels && key.allowedModels !== "*" ? key.allowedModels : "All"}
                    </span>

                    {(key.rpmLimit > 0 || key.tpmLimit > 0) && (
                      <span className="px-1.5 py-0.5 rounded-[3px] bg-info-bg text-info border border-info-border font-mono">
                        {key.rpmLimit > 0 ? `${key.rpmLimit} RPM` : ""}{key.rpmLimit > 0 && key.tpmLimit > 0 ? " · " : ""}{key.tpmLimit > 0 ? `${formatTokensNumber(key.tpmLimit)} TPM` : ""}
                      </span>
                    )}

                    {key.ipWhitelist && (
                      <span className="px-1.5 py-0.5 rounded-[3px] bg-success-bg text-success border border-success-border font-mono">
                        IP Guard
                      </span>
                    )}

                    {isKeyDisabled && (
                      <span className="px-1.5 py-0.5 rounded-[3px] bg-warning-bg text-warning border border-warning-border font-medium">
                        Disabled
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Key Modal */}
      <Modal
        isOpen={showAddModal}
        title="Create API Key"
        size="lg"
        onClose={() => {
          setShowAddModal(false);
          setNewKeyName("");
        }}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Key Name"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Production Key"
          />
          <Input
            label="Custom API Key (Optional)"
            value={newCustomKey}
            maxLength={newAppendSecret ? 19 : 35}
            onChange={(e) => setNewCustomKey(e.target.value)}
            placeholder="e.g. my-key, 1, api-dev, production-team (or leave empty to auto-generate)"
            hint={
              newAppendSecret
                ? "Mode Encrypt: Maksimal 19 digit (total output key 35 digit)."
                : "Mode Non-Encrypt: Maksimal 35 digit (panjang sesuai input 1-35 digit)."
            }
          />
          {newCustomKey.trim() && (
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface-2/40 px-3 py-2 text-xs">
              <div className="flex flex-col">
                <span className="font-medium text-text-primary">
                  {newAppendSecret ? "Mode Encrypt" : "Mode Non-Encrypt"}
                </span>
                <span className="text-text-muted">
                  {newAppendSecret 
                    ? `Input max 19 digit (Total key: 35 digit)` 
                    : `Input max 35 digit (Saat ini: ${newCustomKey.trim().replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 35).length} digit)`}
                </span>
              </div>
              <Toggle
                checked={newAppendSecret}
                onChange={() => setNewAppendSecret(!newAppendSecret)}
              />
            </div>
          )}
          <Input
            label="Token Limit (0 for unlimited)"
            type="number"
            value={newKeyLimit}
            onChange={(e) => setNewKeyLimit(e.target.value)}
            placeholder="e.g. 88000000"
            hint={creatorTokenLimit > 0 ? `Your maximum is ${creatorTokenLimit.toLocaleString()}` : "0 or leave empty for unlimited"}
          />
 {Number(newKeyLimit) > 0 && (
 <Select
 label="Auto Reset Interval"
 options={RESET_INTERVAL_OPTIONS}
 value={newKeyReset}
 onChange={(e) => setNewKeyReset(e.target.value)}
 />
 )}
          {Number(newKeyLimit) > 0 && newKeyReset === "custom" && (
            <Input
              label="Custom Interval (e.g. 10h, 3d)"
              value={newKeyCustomReset}
              onChange={(e) => setNewKeyCustomReset(e.target.value)}
              placeholder="10h"
            />
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="RPM Limit (0: unlimited)"
              type="number"
              value={newKeyRpm}
              onChange={(e) => setNewKeyRpm(e.target.value)}
              placeholder="0"
              hint="Max requests/min"
            />
            <Input
              label="TPM Limit (0: unlimited)"
              type="number"
              value={newKeyTpm}
              onChange={(e) => setNewKeyTpm(e.target.value)}
              placeholder="0"
              hint="Max tokens/min"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-text-main">
                Allowed Models
              </label>
              <Button
                size="sm"
                variant="ghost"
                icon="add"
                onClick={() => {
                  setPickerTarget("create");
                  setShowModelPicker(true);
                }}
              >
                Select Models
              </Button>
            </div>
            <Input
              value={newKeyAllowedModels}
              readOnly
              inputClassName="truncate font-mono"
              hint={isApiKeyUser && creatorAllowedModels !== "*" ? `Limited to your allowed models: ${creatorAllowedModels}` : "Pick models with Select Models. * allows all models."}
            />
            {parseAllowedModelsList(newKeyAllowedModels).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1">
                {parseAllowedModelsList(newKeyAllowedModels).map((m) => (
                  <span
                    key={m}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 text-primary font-mono text-xs"
                  >
                    {m}
                    <button
                      type="button"
                      onClick={() => removeAllowedModel("create", m)}
                      className="hover:text-danger transition-colors"
                    >
                      <span className="material-symbols-outlined text-[14px]">close</span>
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <Input
            label="IP Whitelist"
            value={newKeyIpWhitelist}
            onChange={(e) => setNewKeyIpWhitelist(e.target.value)}
            placeholder="e.g. 192.168.1.1, 103.20.10.5 (Leave empty to allow all)"
            hint="Leave empty to allow access from any IP address"
          />

 <Input
 label="Expiry Date (optional)"
 type="datetime-local"
 value={newKeyExpiresAt}
 onChange={(e) => setNewKeyExpiresAt(e.target.value)}
 hint="Key stops working after this date; leave empty for no expiry"
 />
          <PermissionsEditor
            value={newKeyPermissions}
            onChange={setNewKeyPermissions}
            allowed={creatorPermissions}
            locked={permissionsLocked}
            lockedReason={PERMISSIONS_LOCKED_REASON}
          />
          <div className="flex gap-2 w-full mt-2">
            <Button onClick={handleCreateKey} fullWidth disabled={!newKeyName.trim()} className="min-h-[44px]">
              Create
            </Button>
            <Button
              onClick={() => {
                setShowAddModal(false);
                setNewKeyName("");
              }}
              variant="ghost"
              fullWidth
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit Key Modal */}
      <Modal
        isOpen={!!editingKey}
        title={`Edit API Key: ${editingKey?.name || ""}`}
        size="lg"
        onClose={() => setEditingKey(null)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Key Name"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="Production Key"
          />
          <Input
            label="Token Limit (0 for unlimited)"
            type="number"
            value={editLimit}
            onChange={(e) => setEditLimit(e.target.value)}
            placeholder="e.g. 88000000"
          />
 {Number(editLimit) > 0 && (
 <Select
 label="Auto Reset Interval"
 options={RESET_INTERVAL_OPTIONS}
 value={editReset}
 onChange={(e) => setEditReset(e.target.value)}
 />
 )}
          {Number(editLimit) > 0 && editReset === "custom" && (
            <Input
              label="Custom Interval (e.g. 10h, 3d)"
              value={editCustomReset}
              onChange={(e) => setEditCustomReset(e.target.value)}
              placeholder="10h"
            />
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="RPM Limit (0: unlimited)"
              type="number"
              value={editRpm}
              onChange={(e) => setEditRpm(e.target.value)}
              placeholder="0"
              hint="Max requests/min"
            />
            <Input
              label="TPM Limit (0: unlimited)"
              type="number"
              value={editTpm}
              onChange={(e) => setEditTpm(e.target.value)}
              placeholder="0"
              hint="Max tokens/min"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-text-main">
                Allowed Models
              </label>
              <Button
                size="sm"
                variant="ghost"
                icon="add"
                onClick={() => {
                  setPickerTarget("edit");
                  setShowModelPicker(true);
                }}
              >
                Select Models
              </Button>
            </div>
            <Input
              value={editAllowedModels}
              readOnly
              inputClassName="truncate font-mono"
              hint="Pick models with Select Models. * allows all models."
            />
            {parseAllowedModelsList(editAllowedModels).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1">
                {parseAllowedModelsList(editAllowedModels).map((m) => (
                  <span
                    key={m}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 text-primary font-mono text-xs"
                  >
                    {m}
                    <button
                      type="button"
                      onClick={() => removeAllowedModel("edit", m)}
                      className="hover:text-danger transition-colors"
                    >
                      <span className="material-symbols-outlined text-[14px]">close</span>
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <Input
            label="IP Whitelist"
            value={editIpWhitelist}
            onChange={(e) => setEditIpWhitelist(e.target.value)}
            placeholder="e.g. 192.168.1.1, 103.20.10.5 (Leave empty to allow all)"
            hint="Leave empty to allow access from any IP address"
          />

 <Input
 label="Expiry Date (optional)"
 type="datetime-local"
 value={editExpiresAt}
 onChange={(e) => setEditExpiresAt(e.target.value)}
 hint="Key stops working after this date; leave empty for no expiry"
 />
          <PermissionsEditor
            value={editPermissions}
            onChange={setEditPermissions}
            allowed={creatorPermissions}
            locked={permissionsLocked}
            lockedReason={PERMISSIONS_LOCKED_REASON}
          />
          <div className="flex gap-2 w-full mt-2">
            <Button
              onClick={() => {
                if (!editingKey) return;
                const limitNum = editLimit ? Number(editLimit) : 0;
                let finalReset = "never";
                if (limitNum > 0) {
                  finalReset = editReset === "custom" ? (editCustomReset.trim() || "never") : editReset;
                }
                handleUpdateKeyQuota(editingKey.id, {
                  name: editName.trim() || editingKey.name,
                  tokenLimit: limitNum,
                  resetInterval: finalReset,
                  allowedModels: editAllowedModels.trim() || "*",
                  rpmLimit: editRpm ? Number(editRpm) : 0,
                  tpmLimit: editTpm ? Number(editTpm) : 0,
                  ipWhitelist: editIpWhitelist.trim(),
                  expiresAt: editExpiresAt || null,
                  permissions: permissionsToSave(editPermissions),
                });
              }}
              fullWidth
            >
              Save Changes
            </Button>
            <Button
              onClick={() => setEditingKey(null)}
              variant="ghost"
              fullWidth
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Created Key Modal */}
      <Modal
        isOpen={!!createdKey}
        title="API Key Created"
        onClose={() => setCreatedKey(null)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-warning-bg border border-warning-border rounded-lg p-4">
            <p className="text-sm text-warning mb-2 font-medium">
              Save this key now!
            </p>
            <p className="text-sm text-warning">
              Store this key now, because it is shown only once.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={createdKey || ""}
              readOnly
              className="flex-1 min-w-0 font-mono text-sm" inputClassName="truncate"
            />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              className="flex-shrink-0"
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      {/* Model Select Modal for API Keys */}
      {showModelPicker && (
        <ModelSelectModal
          isOpen={showModelPicker}
          onClose={() => setShowModelPicker(false)}
          onSelect={handleSelectModelForPicker}
          onDeselect={handleDeselectModelForPicker}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          showStudioTargets={true}
          title="Select Allowed Models"
          addedModelValues={parseAllowedModelsList(pickerTarget === "create" ? newKeyAllowedModels : editAllowedModels)}
          allowedModelPatterns={scopedModelPatterns}
          closeOnSelect={false}
        />
      )}

      {/* Enable Tunnel Modal */}
      <Modal
        isOpen={showEnableTunnelModal}
        title="Enable Tunnel"
        onClose={() => setShowEnableTunnelModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-surface-2 border border-border-subtle rounded-lg p-4">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-primary">cloud_upload</span>
              <div>
                <p className="text-sm text-text-main font-medium mb-1">
                  Cloudflare Tunnel
                </p>
                <p className="text-sm text-text-muted">
                  Expose your local X Router to the internet without port forwarding or a static IP, then use the URL in Cursor, Cline, and other tools from anywhere.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {TUNNEL_BENEFITS.map((benefit) => (
              <div key={benefit.title} className="flex flex-col items-center text-center p-3 rounded-lg bg-sidebar/50">
                <span className="material-symbols-outlined text-xl text-primary mb-1">{benefit.icon}</span>
                <p className="text-xs font-semibold">{benefit.title}</p>
                <p className="text-xs text-text-muted">{benefit.desc}</p>
              </div>
            ))}
          </div>

          <p className="text-xs text-text-muted">
            Needs outbound port 7844 (TCP/UDP) and may take 10-30s to connect.
          </p>

          <div className="flex gap-2">
            <Button onClick={handleEnableTunnel} fullWidth>
              Start Tunnel
            </Button>
            <Button onClick={() => setShowEnableTunnelModal(false)} variant="ghost" fullWidth>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Disable Cloudflare Tunnel Modal */}
      <Modal
        isOpen={showDisableTunnelModal}
        title="Disable Tunnel"
        onClose={() => !tunnelLoading && setShowDisableTunnelModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">The Cloudflare tunnel will disconnect and its URL will stop working.</p>
          <div className="flex gap-2">
            <Button onClick={handleDisableTunnel} fullWidth disabled={tunnelLoading} variant="danger">
              {tunnelLoading ? "Disabling..." : "Disable"}
            </Button>
            <Button onClick={() => setShowDisableTunnelModal(false)} variant="ghost" fullWidth disabled={tunnelLoading}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Tailscale Modal */}
      <Modal
        isOpen={showTsModal}
        title="Tailscale Funnel"
        onClose={() => { if (!tsInstalling) { setShowTsModal(false); setTsSudoPassword(""); setTsStatus(null); } }}
      >
        <div className="flex flex-col gap-4">
          {/* Checking state */}
          {tsInstalled === null && (
            <p className="text-sm text-text-muted flex items-center gap-2">
              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              Checking...
            </p>
          )}

          {/* Not installed */}
          {tsInstalled === false && !tsInstalling && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-muted">Install Tailscale to enable Funnel.</p>
              <div className="flex gap-2">
                <Button onClick={handleInstallTailscale} fullWidth>
                  Install Tailscale
                </Button>
                <Button onClick={() => setShowTsModal(false)} variant="ghost" fullWidth>Cancel</Button>
              </div>
            </div>
          )}

          {/* Installing with progress log */}
          {tsInstalling && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                Installing Tailscale...
              </div>
              {tsInstallLog.length > 0 && (
                <div ref={tsLogRef} className="bg-surface-2 rounded p-2 max-h-40 overflow-y-auto font-mono text-xs text-text-muted">
                  {tsInstallLog.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Installed: show Connect button */}
          {tsInstalled === true && !tsInstalling && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm text-success">
                <span className="material-symbols-outlined text-[16px]">check_circle</span>
                Tailscale installed
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => handleConnectTailscale()}
                  fullWidth
                >
                  Connect
                </Button>
                <Button onClick={() => setShowTsModal(false)} variant="ghost" fullWidth>Cancel</Button>
              </div>
            </div>
          )}

          {tsStatus && <StatusAlert status={tsStatus} />}
        </div>
      </Modal>

      {/* Disable Tailscale Modal */}
      <Modal
        isOpen={showDisableTsModal}
        title="Disable Tailscale"
        onClose={() => !tsLoading && setShowDisableTsModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">Tailscale Funnel will stop and its URL will become unreachable.</p>
          <div className="flex gap-2">
            <Button onClick={handleDisableTailscale} fullWidth disabled={tsLoading} variant="danger">
              {tsLoading ? "Disabling..." : "Disable"}
            </Button>
            <Button onClick={() => setShowDisableTsModal(false)} variant="ghost" fullWidth disabled={tsLoading}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Snippet Modal */}
<Modal
  isOpen={!!showSnippetModal}
  title="Code Snippet"
  onClose={() => setShowSnippetModal(null)}
>
  <div className="flex flex-col gap-4">
 <SegmentedControl
 options={[
 { value: "curl", label: "cURL" },
 { value: "python", label: "Python" },
 { value: "node", label: "Node.js" },
 { value: "go", label: "Go" },
 ]}
 value={snippetLang}
 onChange={setSnippetLang}
 size="sm"
 className="w-full sm:w-auto"
 />
    <pre className="bg-surface-2 border border-border/50 rounded-[6px] p-4 text-xs text-text-main font-mono overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
      {showSnippetModal && generateSnippet(snippetLang, showSnippetModal.key, typeof window !== "undefined" ? window.location.origin : "")}
    </pre>
    <Button
      onClick={() => {
        if (showSnippetModal) {
          const text = generateSnippet(snippetLang, showSnippetModal.key, typeof window !== "undefined" ? window.location.origin : "");
          navigator.clipboard.writeText(text);
        }
      }}
      icon="content_copy"
      fullWidth
    >
      Copy to Clipboard
    </Button>
  </div>
</Modal>


{/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />

      {/* Bulk Edit Modal */}
      {showBulkEdit && (
        <BulkEditKeys
          selectedCount={selectedKeyIds.size}
          onApply={handleBulkApply}
          onClose={() => setShowBulkEdit(false)}
        />
      )}
    </div>
  );
}


APIPageClient.propTypes = {
  machineId: PropTypes.string.isRequired,
};
