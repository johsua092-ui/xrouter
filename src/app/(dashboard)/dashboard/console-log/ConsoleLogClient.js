"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, Input } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";

const LOG_LEVEL_COLORS = {
  LOG: "text-success",
  INFO: "text-info",
  WARN: "text-warning",
  ERROR: "text-danger",
  DEBUG: "text-info",
};

function colorLine(line, index) {
  // Detect log level from tags like [LOG], [INFO], [WARN], [ERROR], [DEBUG]
  let levelColor = "text-text-main/90";
  if (line.includes("[ERROR]") || line.includes("✗")) levelColor = "text-danger font-medium";
  else if (line.includes("[WARN]")) levelColor = "text-warning font-medium";
  else if (line.includes("[INFO]") || line.includes("▶")) levelColor = "text-info";
  else if (line.includes("[DEBUG]")) levelColor = "text-text-muted";
  else if (line.includes("✓") || line.includes("done") || line.includes("DONE")) levelColor = "text-success font-medium";

  return (
    <div className="flex gap-2.5 hover:bg-surface-3/50 px-1.5 py-0.5 rounded transition-colors font-mono">
      <span className="text-text-muted/60 select-none shrink-0 w-8 text-right tabular-nums">{index + 1}</span>
      <span className={`break-all ${levelColor}`}>{line}</span>
    </div>
  );
}

/** Minutes → something a human reads at a glance. 0 means the ban never lifts. */
function describeExpiry(row) {
  if (row.auto) return row.remainingSeconds ? `${Math.ceil(row.remainingSeconds / 60)}m left` : "active";
  if (!row.banExpiresAt) return "permanent";
  const ms = new Date(row.banExpiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.ceil(ms / 60000);
  return mins < 60 ? `${mins}m left` : `${Math.ceil(mins / 60)}h left`;
}

function BannedIpsPanel() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [form, setForm] = useState({ ip: "", reason: "manual", durationMinutes: 60 });

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/security/bans");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load bans");
      // Manual rows are durable; auto rows come from the jail and expire on their own.
      const merged = [
        ...(data.manual || []).map((r) => ({ ...r, auto: false })),
        ...(data.auto || []).map((r) => ({ ...r, auto: true })),
      ];
      setRows(merged);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const addBan = async () => {
    const ip = form.ip.trim();
    if (!ip) return;
    setBusy("add");
    setError("");
    try {
      const res = await fetch("/api/security/bans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip, reason: form.reason, durationMinutes: Number(form.durationMinutes) || 0 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to ban");
      setForm((f) => ({ ...f, ip: "" }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const unban = async (ip, isAuto) => {
    setBusy(ip);
    setError("");
    try {
      // An auto row lives in the jail; a durable row lives in SQLite. Clear both so
      // the address is genuinely free again whichever tier is holding it.
      await fetch(`/api/security/bans?ip=${encodeURIComponent(ip)}`, { method: "DELETE" });
      if (isAuto) {
        await fetch(`/api/security/jail?ip=${encodeURIComponent(ip)}`, { method: "DELETE" }).catch(() => {});
      }
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="border-t border-border p-4 space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-44">
          <label className="text-xs text-text-muted block mb-1">IP address</label>
          <Input
            value={form.ip}
            onChange={(e) => setForm((f) => ({ ...f, ip: e.target.value }))}
            placeholder="203.0.113.9"
          />
        </div>
        <div className="w-52">
          <label className="text-xs text-text-muted block mb-1">Reason</label>
          <Input
            value={form.reason}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
            placeholder="manual"
          />
        </div>
        <div className="w-36">
          <label className="text-xs text-text-muted block mb-1">Minutes (0 = forever)</label>
          <Input
            type="number"
            min="0"
            value={form.durationMinutes}
            onChange={(e) => setForm((f) => ({ ...f, durationMinutes: e.target.value }))}
          />
        </div>
        <Button size="sm" icon="block" onClick={addBan} disabled={busy === "add" || !form.ip.trim()}>
          {busy === "add" ? "Banning…" : "Ban IP"}
        </Button>
        <Button size="sm" variant="outline" icon="refresh" onClick={load} disabled={loading}>
          Refresh
        </Button>
      </div>

      {error ? <p className="text-xs text-danger">{error}</p> : null}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-muted text-left border-b border-border">
              <th className="py-1.5 pr-3 font-medium">IP</th>
              <th className="py-1.5 pr-3 font-medium">Source</th>
              <th className="py-1.5 pr-3 font-medium">Reason</th>
              <th className="py-1.5 pr-3 font-medium">Expires</th>
              <th className="py-1.5 pr-3 font-medium">Since</th>
              <th className="py-1.5 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-3 text-text-muted">
                  {loading ? "Loading…" : "No banned addresses."}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={`${row.auto ? "auto" : "manual"}:${row.ip}`} className="border-b border-border/50">
                  <td className="py-1.5 pr-3 font-mono text-text-main">{row.ip}</td>
                  <td className="py-1.5 pr-3">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[11px] ${
                        row.auto ? "bg-warning-bg text-warning" : "bg-danger-bg text-danger"
                      }`}
                    >
                      {row.auto ? "auto-jail" : "manual"}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-text-muted">{row.reason || "—"}</td>
                  <td className="py-1.5 pr-3 text-text-muted">{describeExpiry(row)}</td>
                  <td className="py-1.5 pr-3 text-text-muted">
                    {(row.banStartedAt || row.jailedAt || "").slice(0, 19).replace("T", " ") || "—"}
                  </td>
                  <td className="py-1.5 text-right">
                    <Button size="sm" variant="outline" onClick={() => unban(row.ip, row.auto)} disabled={busy === row.ip}>
                      {busy === row.ip ? "…" : "Unban"}
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-text-muted">
        Two tiers: <span className="text-danger">manual</span> bans are durable and survive restarts;{" "}
        <span className="text-warning">auto-jail</span> rows come from the fail2ban engine and lift themselves.
      </p>
    </div>
  );
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState("logs");
  const logRef = useRef(null);

  const handleClear = async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
      // UI cleared via SSE "clear" event
    } catch (err) {
      console.error("Failed to clear console logs:", err);
    }
  };

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "init") {
        setLogs(msg.logs.slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (msg.type === "line") {
        setLogs((prev) => {
          const next = [...prev, msg.line];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (msg.type === "lines") {
        setLogs((prev) => {
          const next = [...prev, ...msg.lines];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (msg.type === "clear") {
        setLogs([]);
      }
    };

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, tab]);

  return (
    <div className="">
      <Card>
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <div className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[18px] text-text-muted">receipt_long</span>
            {[
              { id: "logs", label: "Console Logs" },
              { id: "bans", label: "Banned IPs" },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-2.5 py-1 rounded text-sm transition-colors ${
                  tab === t.id ? "bg-surface-3 text-text-main font-medium" : "text-text-muted hover:text-text-main"
                }`}
              >
                {t.label}
              </button>
            ))}
            {tab === "logs" ? <span className="text-xs text-text-muted ml-1">({logs.length} lines)</span> : null}
          </div>
          {tab === "logs" ? (
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2 py-0.5 rounded ${connected ? "bg-success-bg text-success" : "bg-danger-bg text-danger"}`}>
                {connected ? "Connected" : "Disconnected"}
              </span>
              <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
                Clear
              </Button>
            </div>
          ) : null}
        </div>

        {tab === "bans" ? (
          <BannedIpsPanel />
        ) : (
          <div
            ref={logRef}
            className="bg-surface-2 dark:bg-[#0c0d0e] border-t border-border rounded-b-lg p-4 text-xs font-mono h-[calc(100vh-220px)] overflow-y-auto"
          >
            {logs.length === 0 ? (
              <span className="text-text-muted">No console logs yet.</span>
            ) : (
              <div className="space-y-0.5">
                {logs.map((line, i) => (
                  <div key={i}>{colorLine(line, i)}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
