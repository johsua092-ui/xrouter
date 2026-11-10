"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Modal, Input } from "@/shared/components";

/**
 * Usage-share links for one key.
 *
 * A link shows that key's totals and nothing else — no credential, no model list, and
 * no way to make a request — so it is safe to hand to whoever bought access to the key.
 * Revoking deletes the token outright; the page 404s from the next request on.
 */
export default function KeyShareModal({ keyId, keyName, onClose }) {
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [ttlDays, setTtlDays] = useState("30");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/keys/${keyId}/share`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load share links");
      setShares(data.shares || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [keyId]);

  const create = async () => {
    setBusy("create");
    setError("");
    try {
      const res = await fetch(`/api/keys/${keyId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 0 means the link never expires; anything else is a number of days.
        body: JSON.stringify({ ttlDays: Number(ttlDays) || 0, label: keyName || "" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create link");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const revoke = async (token) => {
    setBusy(token);
    setError("");
    try {
      const res = await fetch(`/api/keys/${keyId}/share?token=${encodeURIComponent(token)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to revoke");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const copy = async (url, token) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(token);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setError("Clipboard blocked by the browser — copy the link manually.");
    }
  };

  const describeExpiry = (iso) => {
    if (!iso) return "never expires";
    const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
    if (days <= 0) return "expired";
    return `${days}d left`;
  };

  return (
    <Modal isOpen onClose={onClose} title={`Share usage — ${keyName || "key"}`}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          Each link opens a read-only totals page for this key (<code>/share/&lt;token&gt;</code>). No credential is
          exposed and the link cannot make requests.
        </p>

        <div className="flex items-end gap-2">
          <div className="w-40">
            <label className="text-xs text-text-muted block mb-1">Lifetime (days, 0 = never)</label>
            <Input value={ttlDays} onChange={(e) => setTtlDays(e.target.value)} type="number" min="0" />
          </div>
          <Button size="sm" icon="add_link" onClick={create} disabled={busy === "create"}>
            {busy === "create" ? "Creating…" : "Create link"}
          </Button>
        </div>

        {error ? <p className="text-xs text-danger">{error}</p> : null}

        <div className="border border-border rounded-lg divide-y divide-border max-h-64 overflow-y-auto">
          {loading ? (
            <p className="p-3 text-xs text-text-muted">Loading…</p>
          ) : shares.length === 0 ? (
            <p className="p-3 text-xs text-text-muted">No share links yet.</p>
          ) : (
            shares.map((s) => (
              <div key={s.token} className="p-3 flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs text-text-main truncate">{s.url || `/share/${s.token}`}</div>
                  <div className="text-[11px] text-text-muted">
                    {describeExpiry(s.expiresAt)} · {s.viewCount || 0} view{(s.viewCount || 0) === 1 ? "" : "s"}
                    {s.lastViewedAt ? ` · last ${s.lastViewedAt.slice(0, 10)}` : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  icon={copied === s.token ? "check" : "content_copy"}
                  onClick={() => copy(s.url || `/share/${s.token}`, s.token)}
                >
                  {copied === s.token ? "Copied" : "Copy"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => revoke(s.token)} disabled={busy === s.token}>
                  {busy === s.token ? "…" : "Revoke"}
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

KeyShareModal.propTypes = {
  keyId: PropTypes.string.isRequired,
  keyName: PropTypes.string,
  onClose: PropTypes.func.isRequired,
};
