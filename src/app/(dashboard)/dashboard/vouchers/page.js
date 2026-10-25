"use client";

import { useState, useEffect, useMemo } from "react";
import { cn } from "@/shared/utils/cn";
import { Badge, Button, Modal } from "@/shared/components";

function formatTokenLimit(n) {
  const v = Number(n);
  if (!v || v <= 0) return "Unlimited";
  if (v >= 1_000_000_000) {
    const val = v / 1_000_000_000;
    return `${Number.isInteger(val) ? val : val.toFixed(1)}B tokens`;
  }
  if (v >= 1_000_000) {
    const val = v / 1_000_000;
    return `${Number.isInteger(val) ? val : val.toFixed(1)}M tokens`;
  }
  if (v >= 1_000) {
    const val = v / 1_000;
    return `${Number.isInteger(val) ? val : val.toFixed(1)}K tokens`;
  }
  return `${v.toLocaleString()} tokens`;
}

export default function VouchersPage() {
  const [vouchers, setVouchers] = useState([]);
  const [claims, setClaims] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState("vouchers"); // "vouchers" | "claims"
  const [submitting, setSubmitting] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState("");

  // Model catalog for auto-detection picker
  const [catalogModels, setCatalogModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [selectedModels, setSelectedModels] = useState(["*"]); // array of model IDs or ["*"]

  const [form, setForm] = useState({
    code: "",
    name: "",
    description: "",
    tokenLimit: "100000",
    rpmLimit: "60",
    tpmLimit: "100000",
    expiresInDays: "30",
    maxUses: "1",
    isBansos: false,
  });

  const fetchVouchers = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/vouchers?claims=1");
      if (res.ok) {
        const data = await res.json();
        setVouchers(data.vouchers || []);
        setClaims(data.claims || []);
      }
    } catch (err) {
      console.error("Failed to load vouchers", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchCatalogModels = async () => {
    try {
      setLoadingModels(true);
      const res = await fetch("/api/models/catalog");
      if (res.ok) {
        const data = await res.json();
        setCatalogModels(data.models || []);
      }
    } catch (err) {
      console.error("Failed to load model catalog", err);
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    fetchVouchers();
    fetchCatalogModels();
  }, []);

  const filteredModels = useMemo(() => {
    if (!modelSearch.trim()) return catalogModels.slice(0, 100);
    const q = modelSearch.toLowerCase();
    return catalogModels.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    );
  }, [catalogModels, modelSearch]);

  const toggleModelSelection = (modelId) => {
    if (modelId === "*") {
      setSelectedModels(["*"]);
      return;
    }

    let next = selectedModels.filter((id) => id !== "*");
    if (next.includes(modelId)) {
      next = next.filter((id) => id !== modelId);
      if (next.length === 0) next = ["*"];
    } else {
      next.push(modelId);
    }
    setSelectedModels(next);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      setSubmitting(true);
      const allowedModelsStr = selectedModels.join(",");

      const res = await fetch("/api/vouchers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          allowedModels: allowedModelsStr,
          tokenLimit: Number(form.tokenLimit) || 0,
          rpmLimit: Number(form.rpmLimit) || 0,
          tpmLimit: Number(form.tpmLimit) || 0,
          expiresInDays: Number(form.expiresInDays) || 30,
          maxUses: Number(form.maxUses) || 1,
          isBansos: form.isBansos,
        }),
      });

      if (res.ok) {
        setShowModal(false);
        setForm({
          code: "",
          name: "",
          description: "",
          tokenLimit: "100000",
          rpmLimit: "60",
          tpmLimit: "100000",
          expiresInDays: "30",
          maxUses: "1",
          isBansos: false,
        });
        setSelectedModels(["*"]);
        fetchVouchers();
      } else {
        const err = await res.json();
        alert(err.error || "Failed to create voucher");
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (v) => {
    try {
      await fetch(`/api/vouchers/${v.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !v.isActive }),
      });
      fetchVouchers();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Are you sure you want to delete this voucher?")) return;
    try {
      await fetch(`/api/vouchers/${id}`, { method: "DELETE" });
      fetchVouchers();
    } catch (err) {
      console.error(err);
    }
  };

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text);
    setCopyFeedback(label);
    setTimeout(() => setCopyFeedback(""), 2000);
  };

  const publicClaimUrl = typeof window !== "undefined"
    ? `${window.location.origin}/claim`
    : "https://xrouter.consoleapi.qzz.io/claim";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-[4px] bg-primary/10 text-primary border border-primary/20">
              <span className="material-symbols-outlined text-[16px]">card_giftcard</span>
            </span>
            <h1 className="text-sm font-semibold tracking-tight text-text-main">
              Vouchers & Marketplace
            </h1>
          </div>
          <p className="mt-0.5 text-xs text-text-muted">
            Manage developer vouchers, public community faucets, and scoped credential passes.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <a
            href="/claim"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-[4px] border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium text-text-muted hover:text-text-main hover:border-primary/50 transition-colors"
          >
            <span className="material-symbols-outlined text-[14px]">open_in_new</span>
            Open Access Portal
          </a>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => setShowModal(true)}
            icon="add"
          >
            Create Voucher
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-border pb-2 text-xs">
        <button
          type="button"
          onClick={() => setActiveTab("vouchers")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-[4px] font-medium transition-colors cursor-pointer",
            activeTab === "vouchers"
              ? "bg-brand-500 text-white shadow-xs"
              : "text-text-muted hover:text-text-main hover:bg-surface-2"
          )}
        >
          <span className="material-symbols-outlined text-[14px]">confirmation_number</span>
          Vouchers ({vouchers.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("claims")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-[4px] font-medium transition-colors cursor-pointer",
            activeTab === "claims"
              ? "bg-brand-500 text-white shadow-xs"
              : "text-text-muted hover:text-text-main hover:bg-surface-2"
          )}
        >
          <span className="material-symbols-outlined text-[14px]">history</span>
          Claim Records ({claims.length})
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex h-48 items-center justify-center text-xs text-text-muted">
          Loading vouchers...
        </div>
      ) : activeTab === "vouchers" ? (
        vouchers.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-[6px] border border-dashed border-border p-12 text-center bg-surface">
            <span className="material-symbols-outlined text-4xl text-text-muted/60 mb-2">loyalty</span>
            <h3 className="text-sm font-semibold text-text-main">No Vouchers Configured</h3>
            <p className="mt-1 text-xs text-text-muted max-w-sm">
              Create a voucher pass or activate a 1-click community faucet to distribute authorized access keys.
            </p>
            <Button
              type="button"
              variant="primary"
              onClick={() => setShowModal(true)}
              className="mt-4"
              icon="add"
            >
              Create Voucher
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {vouchers.map((v) => {
              const isExhausted = v.maxUses > 0 && v.usedCount >= v.maxUses;
              const directLink = `${publicClaimUrl}?code=${v.code}`;

              return (
                <div
                  key={v.id}
                  className={cn(
                    "group relative flex flex-col justify-between rounded-[6px] border bg-surface p-4 transition-all duration-200 hover:border-brand-500/40 shadow-[var(--shadow-elev)]",
                    v.isActive && !isExhausted ? "border-border" : "border-border/50 opacity-80"
                  )}
                >
                  <div>
                    {/* Header */}
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          {v.isBansos && (
                            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-mono font-bold text-emerald-400 border border-emerald-500/30">
                              COMMUNITY FAUCET
                            </span>
                          )}
                          <span className="font-mono text-sm font-bold tracking-wider text-text-main">
                            {v.code}
                          </span>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(v.code, `code-${v.id}`)}
                            title="Copy Code"
                            className="text-text-muted hover:text-text-main transition-colors cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-[14px]">
                              {copyFeedback === `code-${v.id}` ? "check" : "content_copy"}
                            </span>
                          </button>
                        </div>
                        <h4 className="text-xs font-medium text-text-muted mt-0.5">{v.name}</h4>
                      </div>

                      <div className="flex items-center gap-1.5">
                        {isExhausted ? (
                          <Badge variant="warning" size="xs">Exhausted</Badge>
                        ) : v.isActive ? (
                          <Badge variant="success" size="xs" dot>Active</Badge>
                        ) : (
                          <Badge variant="neutral" size="xs">Disabled</Badge>
                        )}
                      </div>
                    </div>

                    {v.description && (
                      <p className="mt-2 text-xs text-text-muted line-clamp-2">{v.description}</p>
                    )}

                    {/* Metadata Grid */}
                    <div className="mt-3.5 grid grid-cols-2 gap-2 text-[11px] font-mono">
                      <div className="rounded-[4px] bg-surface-2 p-2 border border-border/50">
                        <span className="text-text-muted block text-[10px]">TOKEN QUOTA</span>
                        <span className="font-semibold text-text-main">
                          {formatTokenLimit(v.tokenLimit)}
                        </span>
                      </div>
                      <div className="rounded-[4px] bg-surface-2 p-2 border border-border/50">
                        <span className="text-text-muted block text-[10px]">USES</span>
                        <span className="font-semibold text-text-main">
                          {v.usedCount} / {v.maxUses === 0 ? "Infinite" : v.maxUses} claimed
                        </span>
                      </div>
                      <div className="rounded-[4px] bg-surface-2 p-2 border border-border/50">
                        <span className="text-text-muted block text-[10px]">EXPIRY</span>
                        <span className="text-text-main">
                          {v.expiresInDays === 0 ? "Never" : `${v.expiresInDays} days`}
                        </span>
                      </div>
                      <div className="rounded-[4px] bg-surface-2 p-2 border border-border/50">
                        <span className="text-text-muted block text-[10px]">MODELS</span>
                        <span className="text-text-main truncate block" title={v.allowedModels}>
                          {v.allowedModels === "*" ? "All Models (*)" : v.allowedModels}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="mt-4 pt-3 border-t border-border flex items-center justify-between text-xs">
                    <button
                      type="button"
                      onClick={() => copyToClipboard(directLink, `link-${v.id}`)}
                      className="inline-flex items-center gap-1 text-text-muted hover:text-brand-500 font-mono text-[11px] transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[13px]">link</span>
                      {copyFeedback === `link-${v.id}` ? "Copied Link" : "Copy Portal Link"}
                    </button>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggle(v)}
                        className="text-text-muted hover:text-text-main p-1 transition-colors cursor-pointer"
                        title={v.isActive ? "Disable Voucher" : "Enable Voucher"}
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {v.isActive ? "pause_circle" : "play_circle"}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(v.id)}
                        className="text-text-muted hover:text-red-500 p-1 transition-colors cursor-pointer"
                        title="Delete Voucher"
                      >
                        <span className="material-symbols-outlined text-[16px]">delete</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        /* Claims History Tab */
        <div className="overflow-hidden rounded-[8px] border border-border bg-surface-1">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-2 text-text-muted border-b border-border font-mono text-[11px]">
                <tr>
                  <th className="py-2.5 px-4 font-medium">TIMESTAMP</th>
                  <th className="py-2.5 px-4 font-medium">VOUCHER CODE</th>
                  <th className="py-2.5 px-4 font-medium">GENERATED KEY</th>
                  <th className="py-2.5 px-4 font-medium">CLIENT IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {claims.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-text-muted">
                      No claim records logged yet.
                    </td>
                  </tr>
                ) : (
                  claims.map((c) => (
                    <tr key={c.id} className="hover:bg-surface-2/40 transition-colors">
                      <td className="py-2.5 px-4 text-text-muted font-mono whitespace-nowrap">
                        {new Date(c.claimedAt).toLocaleString()}
                      </td>
                      <td className="py-2.5 px-4 font-mono font-semibold text-brand-500">
                        {c.voucherCode}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-text-main">
                        {c.apiKey.slice(0, 10)}...{c.apiKey.slice(-6)}
                      </td>
                      <td className="py-2.5 px-4 text-text-muted font-mono">
                        {c.clientIp || "Local/Loopback"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create Voucher Modal */}
      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title="Create Access Voucher / Faucet"
        size="md"
      >
        <form onSubmit={handleCreate} className="space-y-4 text-xs">
          {/* Community Faucet Toggle */}
          <div className="rounded-[6px] border border-border bg-surface-2 p-3 flex items-center justify-between">
            <div>
              <span className="font-semibold text-text-main block">Mark as Public 1-Click Faucet</span>
              <span className="text-[11px] text-text-muted block">
                Available on portal for instant key generation without entering code.
              </span>
            </div>
            <input
              type="checkbox"
              checked={form.isBansos}
              onChange={(e) => setForm({ ...form, isBansos: e.target.checked })}
              className="size-4 accent-brand-500 rounded cursor-pointer"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-mono text-text-muted mb-1">
                VOUCHER CODE
              </label>
              <input
                type="text"
                required
                maxLength={19}
                placeholder="e.g. XR-COMMUNITY-100K"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "-") })}
                className="w-full rounded-[5px] border border-border bg-surface-2 px-3 py-1.5 font-mono text-xs text-text-main focus:border-brand-500 focus:outline-none"
              />
              <p className="mt-1 text-[10px] text-text-muted">
                Max 19 characters (A-Z, 0-9, and hyphens).
              </p>
            </div>
            <div>
              <label className="block text-[11px] font-mono text-text-muted mb-1">
                CAMPAIGN NAME
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Developer Onboarding"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full rounded-[5px] border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-main focus:border-brand-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-mono text-text-muted mb-1">
              DESCRIPTION (OPTIONAL)
            </label>
            <input
              type="text"
              placeholder="Notes about cohort or distribution target..."
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full rounded-[5px] border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-main focus:border-brand-500 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-mono text-text-muted mb-1">
                TOKEN QUOTA
              </label>
              <input
                type="number"
                required
                placeholder="100000"
                value={form.tokenLimit}
                onChange={(e) => setForm({ ...form, tokenLimit: e.target.value })}
                className="w-full rounded-[5px] border border-border bg-surface-2 px-3 py-1.5 font-mono text-xs text-text-main focus:border-brand-500 focus:outline-none"
              />
              <span className="text-[10px] text-text-muted mt-0.5 block">0 = Unlimited</span>
            </div>
            <div>
              <label className="block text-[11px] font-mono text-text-muted mb-1">
                MAX CLAIMS
              </label>
              <input
                type="number"
                required
                placeholder="1"
                value={form.maxUses}
                onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
                className="w-full rounded-[5px] border border-border bg-surface-2 px-3 py-1.5 font-mono text-xs text-text-main focus:border-brand-500 focus:outline-none"
              />
              <span className="text-[10px] text-text-muted mt-0.5 block">Total claim limit</span>
            </div>
            <div>
              <label className="block text-[11px] font-mono text-text-muted mb-1">
                VALIDITY (DAYS)
              </label>
              <input
                type="number"
                required
                placeholder="30"
                value={form.expiresInDays}
                onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })}
                className="w-full rounded-[5px] border border-border bg-surface-2 px-3 py-1.5 font-mono text-xs text-text-main focus:border-brand-500 focus:outline-none"
              />
              <span className="text-[10px] text-text-muted mt-0.5 block">0 = Never expires</span>
            </div>
          </div>

          {/* MODEL SELECTOR (AUTO DETECT - TINGGAL PILIH) */}
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-mono font-semibold text-text-main uppercase tracking-wider">
                ALLOWED MODELS ({selectedModels.includes("*") ? "All Models (*)" : `${selectedModels.length} Selected`})
              </label>
              <button
                type="button"
                onClick={() => toggleModelSelection("*")}
                className={cn(
                  "px-2 py-0.5 rounded text-[10px] font-mono font-semibold transition-colors cursor-pointer",
                  selectedModels.includes("*")
                    ? "bg-primary text-white"
                    : "bg-surface-2 text-text-muted hover:text-text-main"
                )}
              >
                Allow All Models (*)
              </button>
            </div>

            <div className="relative">
              <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-text-muted">
                search
              </span>
              <input
                type="text"
                placeholder="Filter models (e.g. claude, gpt, qwen, deepseek)..."
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                className="w-full rounded-[5px] border border-border bg-surface-2 pl-8 pr-3 py-1.5 text-xs text-text-main focus:border-brand-500 focus:outline-none"
              />
            </div>

            <div className="max-h-40 overflow-y-auto rounded-[5px] border border-border bg-surface-2/60 p-2 custom-scrollbar">
              {loadingModels ? (
                <div className="text-center py-4 text-text-muted text-xs font-mono">Scanning installed models...</div>
              ) : catalogModels.length === 0 ? (
                <div className="text-center py-4 space-y-1">
                  <p className="text-xs font-mono text-text-muted">No installed provider connections found in X Router.</p>
                  <p className="text-[11px] text-[#777]">Connect an upstream provider in the Providers page to populate models here, or select Allow All Models (*).</p>
                </div>
              ) : filteredModels.length === 0 ? (
                <div className="text-center py-4 text-text-muted text-xs font-mono">No matching installed models found.</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {filteredModels.map((m) => {
                    const isSelected = selectedModels.includes(m.id) || selectedModels.includes("*");
                    const isExplicitSelected = selectedModels.includes(m.id);

                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleModelSelection(m.id)}
                        className={cn(
                          "inline-flex items-center gap-1 px-2 py-1 rounded-[4px] text-[10.5px] font-mono border transition-all cursor-pointer",
                          isExplicitSelected
                            ? "bg-primary text-white border-primary shadow-xs"
                            : isSelected
                            ? "bg-surface text-text-main border-primary/40 opacity-80"
                            : "bg-surface text-text-muted border-border hover:border-text-muted hover:text-text-main"
                        )}
                      >
                        <span>{m.id}</span>
                        {isExplicitSelected && (
                          <span className="material-symbols-outlined text-[11px]">check</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowModal(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submitting}
            >
              {submitting ? "Saving..." : "Save Voucher"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
