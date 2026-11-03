"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Card,
  Button,
  Modal,
  Input,
  ModelSelectModal,
  Toggle,
  Badge,
  SegmentedControl,
} from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { findStudioCycle, describeStudioCycle } from "@/shared/utils/studioComboGuard";
import { cn } from "@/shared/utils/cn";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function formatTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1000000) return `${(value / 1000000).toFixed(value % 1000000 ? 1 : 0)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

// BazaarLink Probe judges behaviour, not spelling: it never trusts a
// self-claim. So these checks cannot pass a model, they only catch metadata
// that would READ as masked - which is the part a custom model controls.
//
// Vendor families, used to compare a claim against the resolved target. A
// prefix or an owned_by naming a different vendor than the target's own is the
// classic "renamed for resale" shape.
const VENDOR_HINTS = [
  { re: /\b(openai|gpt|o[134](?:-|$)|codex)\b/i, vendor: "openai" },
  { re: /\b(anthropic|claude)\b/i, vendor: "anthropic" },
  { re: /\b(google|gemini|gemma)\b/i, vendor: "google" },
  { re: /\b(meta|llama)\b/i, vendor: "meta" },
  { re: /\b(mistral|codestral|magistral)\b/i, vendor: "mistral" },
  { re: /\b(deepseek)\b/i, vendor: "deepseek" },
  { re: /\b(qwen|qwq)\b/i, vendor: "alibaba" },
  { re: /\b(kimi|moonshot)\b/i, vendor: "moonshot" },
  { re: /\b(glm|zhipu|z-ai)\b/i, vendor: "zhipu" },
  { re: /\b(minimax)\b/i, vendor: "minimax" },
  { re: /\b(grok)\b/i, vendor: "xai" },
  { re: /\b(mimo)\b/i, vendor: "xiaomi" },
];

const COMMON_VENDORS = [
  "openai",
  "anthropic",
  "google",
  "meta",
  "mistral",
  "deepseek",
  "alibaba",
  "zhipu",
  "minimax",
  "xai",
  "xiaomi",
];

function detectVendor(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  for (const h of VENDOR_HINTS) {
    if (h.re.test(t)) return h.vendor;
  }
  return null;
}

// Vendor implied by a router prefix: "oc/...", "kr/..." are aliases, so the
// meaningful signal is the model half, not the prefix.
function targetVendor(target) {
  const t = String(target || "").trim();
  if (!t) return null;
  const slash = t.indexOf("/");
  return detectVendor(slash >= 0 ? t.slice(slash + 1) : t);
}

/**
 * Concrete, fixable inconsistencies between what a custom model claims and the
 * model it points at. Returns [] when nothing is off - which is NOT a pass
 * mark, only the absence of an obvious self-contradiction.
 */
function antiMaskFindings({ callName, ownedBy, targetModel }) {
  const findings = [];
  const tv = targetVendor(targetModel);

  if (!String(callName || "").trim()) {
    findings.push({
      level: "info",
      text: "Name this model. A bare or empty id is indistinguishable from padding in a listing.",
    });
  }

  const nv = detectVendor(callName);
  if (nv && tv && nv !== tv) {
    findings.push({
      level: "warn",
      text: `Name reads as ${nv} but the target is ${tv}. A probe compares the claim against the answer, and this is the shape it flags.`,
    });
  }

  const ov = detectVendor(ownedBy);
  if (ov && tv && ov !== tv) {
    findings.push({
      level: "warn",
      text: `owned_by says ${ov} while the target is ${tv}. Keep owned_by on the target's real vendor.`,
    });
  }

  if (!String(ownedBy || "").trim()) {
    findings.push({
      level: "info",
      text: "Set owned_by to the target model's real vendor. Blank falls back to this model's own name, which reads as an invented model.",
    });
  }

  return findings;
}

export default function ModelStudioPage() {
  const [activeTab, setActiveTab] = useState("masking"); // "masking" | "models"
  const [models, setModels] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [formMode, setFormMode] = useState("standard"); // "standard" | "masking"
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(null);
  const { copied: copiedName, copy } = useCopyToClipboard(1800);

  const fetchData = useCallback(async () => {
    try {
      const [studioRes, nodesRes, providersRes, aliasesRes] = await Promise.all([
        fetch("/api/model-editor").then((r) => (r.ok ? r.json() : { models: [] })).catch(() => ({ models: [] })),
        fetch("/api/provider-nodes").then((r) => (r.ok ? r.json() : { nodes: [] })).catch(() => ({ nodes: [] })),
        fetch("/api/providers").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
        fetch("/api/models/alias").then((r) => (r.ok ? r.json() : { aliases: {} })).catch(() => ({ aliases: {} })),
      ]);
      setModels(studioRes.models || []);
      setProviderNodes((nodesRes.nodes || []).filter((n) => n.type !== "custom-embedding"));
      setActiveProviders(providersRes.connections || []);
      setModelAliases(aliasesRes.aliases || {});
      setError(studioRes.error || "");
    } catch (e) {
      setError(e?.message || "Failed to load models");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openCreate = (mode = "standard") => {
    setEditing(null);
    setFormMode(mode);
    setShowForm(true);
  };

  const openEdit = (model, mode = "standard") => {
    setEditing(model);
    setFormMode(mode);
    setShowForm(true);
  };

  const handleDelete = async (model) => {
    setRemoving(model.callName);
    try {
      await fetch(`/api/model-editor?name=${encodeURIComponent(model.callName)}`, { method: "DELETE" });
      fetchData();
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-none text-text-main">
            Custom Models &amp; Masking
          </h1>
          <p className="text-xs text-text-muted mt-0.5">
            Create callable model IDs, apply custom prefixes, and configure BazaarLink-tested model masking.
          </p>
        </div>

        {/* Tab Switcher */}
        <SegmentedControl
          options={[
            { value: "masking", label: "Masking Model", icon: "masks" },
            { value: "models", label: `Custom Models (${models.length})`, icon: "auto_awesome" },
          ]}
          value={activeTab}
          onChange={setActiveTab}
          size="sm"
        />
      </div>

      {activeTab === "masking" ? (
        <ModelMaskingTab
          models={models}
          providerNodes={providerNodes}
          loading={loading}
          removing={removing}
          copiedName={copiedName}
          copy={copy}
          onOpenCreate={() => openCreate("masking")}
          onOpenEdit={(model) => openEdit(model, "masking")}
          onDelete={handleDelete}
          onRefresh={fetchData}
        />
      ) : (
        <CustomModelsTab
          models={models}
          providerNodes={providerNodes}
          loading={loading}
          error={error}
          removing={removing}
          copiedName={copiedName}
          copy={copy}
          onOpenCreate={() => openCreate("standard")}
          onOpenEdit={(model) => openEdit(model, "standard")}
          onDelete={handleDelete}
          onRefresh={fetchData}
        />
      )}

      {showForm && (
        <StudioFormModal
          mode={formMode}
          editing={editing}
          activeProviders={activeProviders}
          providerNodes={providerNodes}
          modelAliases={modelAliases}
          saving={saving}
          setSaving={setSaving}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            fetchData();
          }}
        />
      )}
    </div>
  );
}

/** Standard Model Studio Tab */
function CustomModelsTab({
  models,
  providerNodes,
  loading,
  error,
  removing,
  copiedName,
  copy,
  onOpenCreate,
  onOpenEdit,
  onDelete,
  onRefresh,
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-text-main">
            {models.length} {models.length === 1 ? "model" : "models"}
          </span>
          {error && <span className="text-xs text-danger truncate">{error}</span>}
        </div>
        <Button size="sm" icon="add" onClick={onOpenCreate}>
          Add Model
        </Button>
      </div>

      {loading ? (
        <Card padding="md">
          <div className="text-xs text-text-muted py-4">Loading models...</div>
        </Card>
      ) : models.length === 0 ? (
        <Card padding="lg" className="flex flex-col items-center gap-3 text-center py-10">
          <span className="material-symbols-outlined text-[34px] text-text-muted/50">auto_awesome</span>
          <div>
            <p className="text-sm font-medium text-text-main">No custom models yet</p>
            <p className="text-xs text-text-muted mt-1 max-w-md">
              Pick any connected model, name it however you like, and call it by that name.
            </p>
          </div>
          <Button size="sm" icon="add" onClick={onOpenCreate}>
            Add your first model
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {models.map((model) => (
            <Card key={model.callName} padding="md" className="flex min-w-0 flex-col gap-3">
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => copy(model.callName, model.callName)}
                    title="Copy model name"
                    className="flex items-center gap-2 min-w-0 max-w-full text-left group"
                  >
                    <code className="font-mono text-sm font-semibold text-primary truncate">
                      {model.callName}
                    </code>
                    {copiedName === model.callName ? (
                      <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-success">
                        <span className="material-symbols-outlined text-[14px]">check</span>
                        Copied
                      </span>
                    ) : (
                      <span className="material-symbols-outlined text-[14px] shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100">
                        content_copy
                      </span>
                    )}
                  </button>
                  {model.displayName && model.displayName !== model.callName && (
                    <p className="text-xs text-text-muted mt-0.5 truncate">{model.displayName}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => onOpenEdit(model)}
                    title="Edit"
                    className="p-1.5 rounded-lg text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
                  >
                    <span className="material-symbols-outlined text-[16px]">edit</span>
                  </button>
                  <button
                    onClick={() => onDelete(model)}
                    disabled={removing === model.callName}
                    title="Delete"
                    className="p-1.5 rounded-lg text-text-muted hover:text-danger hover:bg-danger-bg transition-colors disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[16px]">
                      {removing === model.callName ? "progress_activity" : "delete"}
                    </span>
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="px-2 py-0.5 rounded-full bg-surface-2 text-text-muted font-mono truncate max-w-full">
                  {model.targetLabel || model.targetModel}
                </span>
                {!String(model.targetModel || "").includes("/") && (
                  <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                    combo
                  </span>
                )}
                {model.ownedBy && (
                  <span className="px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-500 font-medium">
                    owned by {model.ownedBy}
                  </span>
                )}
                {model.contextWindow > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                    {formatTokens(model.contextWindow)} context
                  </span>
                )}
              </div>

              {model.systemPrompt && (
                <div className="rounded-lg bg-surface-2 px-2.5 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-text-muted/70 mb-0.5">
                    System prompt
                  </p>
                  <p className="text-xs text-text-muted line-clamp-3 break-words">
                    {model.systemPrompt}
                  </p>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <PrefixCard nodes={providerNodes} onSaved={onRefresh} />
    </div>
  );
}

/** Model Masking & Anti-Probe Tab (Znyth's Request + Seren's BazaarLink Hardening) */
function ModelMaskingTab({
  models,
  providerNodes,
  loading,
  removing,
  copiedName,
  copy,
  onOpenCreate,
  onOpenEdit,
  onDelete,
  onRefresh,
}) {
  const maskStats = useMemo(() => {
    let clean = 0;
    let warned = 0;
    for (const m of models) {
      const findings = antiMaskFindings({
        callName: m.callName,
        ownedBy: m.ownedBy,
        targetModel: m.targetModel,
      });
      if (findings.some((f) => f.level === "warn")) warned += 1;
      else clean += 1;
    }
    return { total: models.length, clean, warned };
  }, [models]);

  return (
    <div className="flex flex-col gap-6">
      {/* Masking Banner & Controls */}
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-500">
              <span className="material-symbols-outlined text-[20px]">shield_person</span>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-text-main flex items-center gap-2">
                Model Masking &amp; Anti-Probe Shield
                <Badge variant="success" size="sm" icon="verified">
                  BazaarLink Tested
                </Badge>
              </h2>
              <p className="text-xs text-text-muted mt-0.5">
                Route upstream models through custom prefixes and vendor cloaking. Upstream names and internal metadata are fully sanitized across <code>/v1/models</code> and SSE responses.
              </p>
            </div>
          </div>
          <Button icon="add" size="sm" onClick={onOpenCreate} className="shrink-0">
            Create Mask
          </Button>
        </div>

        {/* Quick Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-border-subtle text-xs">
          <div className="p-2 rounded-lg bg-surface-2 flex flex-col">
            <span className="text-text-muted text-[11px]">Active Masks</span>
            <span className="font-semibold text-text-main text-sm">{maskStats.total}</span>
          </div>
          <div className="p-2 rounded-lg bg-surface-2 flex flex-col">
            <span className="text-text-muted text-[11px]">Probe Clean</span>
            <span className="font-semibold text-success text-sm">{maskStats.clean}</span>
          </div>
          <div className="p-2 rounded-lg bg-surface-2 flex flex-col">
            <span className="text-text-muted text-[11px]">Vendor Warnings</span>
            <span className={cn("font-semibold text-sm", maskStats.warned > 0 ? "text-warning" : "text-text-muted")}>
              {maskStats.warned}
            </span>
          </div>
          <div className="p-2 rounded-lg bg-surface-2 flex flex-col">
            <span className="text-text-muted text-[11px]">Provider Prefixes</span>
            <span className="font-semibold text-primary text-sm">{providerNodes.length}</span>
          </div>
        </div>
      </div>

      {/* Masked Models List */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-main flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[16px] text-primary">visibility_off</span>
            Masked Model Registry
          </h3>
          <span className="text-xs text-text-muted">
            {models.length} {models.length === 1 ? "entry" : "entries"}
          </span>
        </div>

        {loading ? (
          <Card padding="md">
            <div className="text-xs text-text-muted py-4">Loading masked models...</div>
          </Card>
        ) : models.length === 0 ? (
          <Card padding="lg" className="flex flex-col items-center gap-3 text-center py-10">
            <span className="material-symbols-outlined text-[36px] text-text-muted/40">masks</span>
            <div>
              <p className="text-sm font-medium text-text-main">No model masks configured</p>
              <p className="text-xs text-text-muted mt-1 max-w-md">
                Select any connected model, apply a custom prefix or vendor disguise, and mask its true identity from clients and probes.
              </p>
            </div>
            <Button size="sm" icon="add" onClick={onOpenCreate}>
              Create your first mask
            </Button>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {models.map((model) => {
              const findings = antiMaskFindings({
                callName: model.callName,
                ownedBy: model.ownedBy,
                targetModel: model.targetModel,
              });
              const hasWarn = findings.some((f) => f.level === "warn");

              return (
                <Card key={model.callName} padding="md" className="flex min-w-0 flex-col gap-3">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => copy(model.callName, model.callName)}
                          title="Copy mask name"
                          className="flex items-center gap-1.5 min-w-0 group"
                        >
                          <code className="font-mono text-sm font-semibold text-primary truncate">
                            {model.callName}
                          </code>
                          {copiedName === model.callName ? (
                            <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-success">
                              <span className="material-symbols-outlined text-[13px]">check</span>
                              Copied
                            </span>
                          ) : (
                            <span className="material-symbols-outlined text-[13px] text-text-muted opacity-0 transition-opacity group-hover:opacity-100">
                              content_copy
                            </span>
                          )}
                        </button>

                        {/* Probe Verification Status */}
                        {hasWarn ? (
                          <Badge variant="warning" size="sm" icon="warning">
                            Probe Warning
                          </Badge>
                        ) : (
                          <Badge variant="success" size="sm" icon="verified_user">
                            BazaarLink Clean
                          </Badge>
                        )}
                      </div>

                      {model.displayName && model.displayName !== model.callName && (
                        <p className="text-xs text-text-muted mt-0.5 truncate">{model.displayName}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => onOpenEdit(model)}
                        title="Edit Mask"
                        className="p-1.5 rounded-lg text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
                      >
                        <span className="material-symbols-outlined text-[16px]">edit</span>
                      </button>
                      <button
                        onClick={() => onDelete(model)}
                        disabled={removing === model.callName}
                        title="Delete Mask"
                        className="p-1.5 rounded-lg text-text-muted hover:text-danger hover:bg-danger-bg transition-colors disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {removing === model.callName ? "progress_activity" : "delete"}
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* Route & Cloaking Badges */}
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-2 text-text-muted font-mono truncate max-w-full">
                      <span className="material-symbols-outlined text-[12px] text-text-muted shrink-0">arrow_forward</span>
                      {model.targetLabel || model.targetModel}
                    </span>

                    <span className="px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-500 font-medium">
                      owned_by: {model.ownedBy || model.callName}
                    </span>

                    {model.contextWindow > 0 && (
                      <span className="px-2 py-0.5 rounded-full bg-surface-2 text-text-muted font-medium">
                        {formatTokens(model.contextWindow)} ctx
                      </span>
                    )}
                  </div>

                  {/* Warning excerpt if any */}
                  {hasWarn && (
                    <div className="rounded-lg bg-warning-bg/40 border border-warning-border/60 p-2 text-[11px] text-warning-fg flex items-start gap-1.5">
                      <span className="material-symbols-outlined text-[14px] shrink-0 mt-0.5">info</span>
                      <span>
                        {findings.find((f) => f.level === "warn")?.text}
                      </span>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Provider Prefixes Manager */}
      <PrefixCard nodes={providerNodes} onSaved={onRefresh} />

      {/* BazaarLink Probe Evasion & Architecture Card */}
      <Card padding="md" className="flex flex-col gap-3 border-border-subtle bg-surface-2/40">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-xs font-semibold text-text-main">
            <span className="material-symbols-outlined text-[18px] text-primary">security</span>
            BazaarLink Probe Evasion Architecture
          </span>
          <a
            href="https://bazaarlink.ai/probe"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          >
            Launch BazaarLink Probe
            <span className="material-symbols-outlined text-[13px] leading-none">open_in_new</span>
          </a>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-text-muted">
          <div className="p-2.5 rounded-lg border border-border-subtle bg-surface">
            <span className="font-semibold text-text-main block mb-1">1. /v1/models Sanitization</span>
            <p className="text-[11px] leading-relaxed">
              Internal <code>resolved_model</code> and <code>model-studio</code> tags are stripped entirely. Models publish only clean <code>owned_by</code> claims.
            </p>
          </div>
          <div className="p-2.5 rounded-lg border border-border-subtle bg-surface">
            <span className="font-semibold text-text-main block mb-1">2. Wire Response Masking</span>
            <p className="text-[11px] leading-relaxed">
              Streaming chunks and JSON responses are dynamically rewritten via <code>open-sse/utils/modelAlias.js</code>. The caller only sees the alias ID.
            </p>
          </div>
          <div className="p-2.5 rounded-lg border border-border-subtle bg-surface">
            <span className="font-semibold text-text-main block mb-1">3. Error Frame Cleansing</span>
            <p className="text-[11px] leading-relaxed">
              Upstream error bodies and HTML error frames are captured and sanitized so upstream provider headers never leak.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Form Modal for Adding / Editing Model or Mask */
function StudioFormModal({
  mode = "standard",
  editing,
  activeProviders,
  providerNodes,
  modelAliases,
  saving,
  setSaving,
  onClose,
  onSaved,
}) {
  const { getCaps } = useModelCaps();
  const [showPicker, setShowPicker] = useState(false);
  const [customPrefix, setCustomPrefix] = useState("");
  const [baseName, setBaseName] = useState("");
  const [callName, setCallName] = useState(editing?.callName || "");
  const [displayName, setDisplayName] = useState(editing?.displayName || "");
  const [ownedBy, setOwnedBy] = useState(editing?.ownedBy || "");
  const [targetModel, setTargetModel] = useState(
    editing?.targetLabel || editing?.targetModel || ""
  );
  const [combos, setCombos] = useState([]);
  const [siblings, setSiblings] = useState([]);
  const [contextWindow, setContextWindow] = useState(
    editing?.contextWindow ? String(editing.contextWindow) : ""
  );
  const [systemPrompt, setSystemPrompt] = useState(editing?.systemPrompt || "");
  const [importedPromptFileName, setImportedPromptFileName] = useState("");
  const promptFileInputRef = useRef(null);

  const handleImportPromptFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = String(event.target?.result || "");
      setSystemPrompt(content);
      setImportedPromptFileName(file.name);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleDropPromptFile = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.name.endsWith(".md") && !file.name.endsWith(".txt")) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = String(event.target?.result || "");
      setSystemPrompt(content);
      setImportedPromptFileName(file.name);
    };
    reader.readAsText(file);
  };

  // Initialize prefix and baseName from editing
  useEffect(() => {
    if (editing?.callName) {
      const slash = editing.callName.indexOf("/");
      if (slash > 0) {
        setCustomPrefix(editing.callName.slice(0, slash));
        setBaseName(editing.callName.slice(slash + 1));
      } else {
        setBaseName(editing.callName);
      }
    }
  }, [editing]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/combos").then((r) => (r.ok ? r.json() : { combos: [] })).catch(() => ({ combos: [] })),
      fetch("/api/model-editor").then((r) => (r.ok ? r.json() : { models: [] })).catch(() => ({ models: [] })),
    ]).then(([comboData, studioData]) => {
      if (!alive) return;
      setCombos(comboData.combos || []);
      setSiblings(studioData.models || []);
    });
    return () => { alive = false; };
  }, []);

  // Update callName when customPrefix or baseName changes in masking mode
  const handlePrefixChange = (p) => {
    setCustomPrefix(p);
    const cleanP = p.trim().replace(/\/+$/, "");
    const cleanB = baseName.trim();
    if (cleanP && cleanB) {
      setCallName(`${cleanP}/${cleanB}`);
    } else if (cleanB) {
      setCallName(cleanB);
    }
  };

  const handleBaseNameChange = (b) => {
    setBaseName(b);
    const cleanP = customPrefix.trim().replace(/\/+$/, "");
    const cleanB = b.trim();
    if (cleanP && cleanB) {
      setCallName(`${cleanP}/${cleanB}`);
    } else {
      setCallName(cleanB);
    }
  };

  const targetCaps = useMemo(() => (targetModel ? getCaps(targetModel) : null), [targetModel, getCaps]);
  const isComboTarget = useMemo(
    () => (targetModel ? !targetModel.includes("/") && combos.some((c) => c.name === targetModel) : false),
    [targetModel, combos]
  );

  const nameError = useMemo(() => {
    if (!callName) return "";
    // If slash exists, ensure both prefix and suffix adhere to clean rules
    if (callName.includes("/")) {
      const parts = callName.split("/");
      if (parts.length > 2 || !parts[0] || !parts[1]) {
        return "Use at most one slash for prefix (e.g. prefix/model-id).";
      }
      if (!NAME_RE.test(parts[0]) || !NAME_RE.test(parts[1])) {
        return "Prefix and model name must use letters, numbers, dot, dash, underscore.";
      }
      return "";
    }
    if (!NAME_RE.test(callName)) return "Letters, numbers, dot, dash and underscore only (max 64).";
    return "";
  }, [callName]);

  const cycleError = useMemo(() => {
    const name = callName.trim();
    const target = targetModel.trim();
    if (!name || !target || target.includes("/")) return "";
    if (!combos.some((c) => c.name === target)) return "";
    const chain = findStudioCycle({
      callName: name,
      comboName: target,
      combosByName: new Map(combos.map((c) => [c.name, c.models || []])),
      studioTargets: new Map(
        siblings.filter((m) => m.callName !== name && m.callName !== editing?.callName).map((m) => [m.callName, m.targetModel])
      ),
      extraSelfNames: editing?.callName && editing.callName !== name ? [editing.callName] : [],
    });
    return chain ? describeStudioCycle(chain) : "";
  }, [callName, targetModel, combos, siblings, editing]);

  // Anti-mask findings for BazaarLink validation
  const maskFindings = useMemo(
    () => antiMaskFindings({ callName, ownedBy, targetModel }),
    [callName, ownedBy, targetModel]
  );
  const maskWarns = maskFindings.filter((f) => f.level === "warn");

  const handlePickModel = (model) => {
    if (!model?.value || model.isPlaceholder) return;
    setTargetModel(model.value);
    const caps = getCaps(model.value);
    if (caps?.contextWindow && !contextWindow) setContextWindow(String(caps.contextWindow));

    // Auto-suggest vendor for ownedBy if blank
    if (!ownedBy) {
      const tv = targetVendor(model.value);
      if (tv) setOwnedBy(tv);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!callName.trim() || !targetModel || nameError || cycleError) return;
    setSaving(true);
    try {
      const res = await fetch("/api/model-editor", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callName: callName.trim(),
          previousName: editing?.callName,
          displayName: displayName.trim(),
          ownedBy: ownedBy.trim(),
          targetModel,
          contextWindow: contextWindow ? Number(contextWindow) : 0,
          systemPrompt,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Failed to save model");
        return;
      }
      onSaved();
    } catch (err) {
      alert(err?.message || "Failed to save model");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        isOpen
        onClose={onClose}
        title={editing ? `Edit ${editing.callName}` : mode === "masking" ? "New Model Mask" : "Add Custom Model"}
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Target Model Selection */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <label className="block text-xs font-medium text-text-main">
                Target Model <span className="text-danger">*</span>
              </label>
              {targetModel && (
                <button
                  type="button"
                  onClick={() => setTargetModel("")}
                  className="text-[11px] text-text-muted hover:text-danger transition-colors cursor-pointer"
                >
                  clear
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowPicker(true)}
              className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                targetModel
                  ? "border-primary/40 bg-primary/5"
                  : "border-dashed border-border hover:border-primary/50"
              }`}
            >
              <span className="min-w-0 flex-1">
                {targetModel ? (
                  <>
                    <span className="block font-mono text-sm text-text-main truncate">
                      {targetModel}
                      {isComboTarget ? (
                        <span className="ml-1.5 text-[10px] font-sans font-medium text-primary">combo</span>
                      ) : null}
                    </span>
                    {targetCaps?.contextWindow ? (
                      <span className="block text-[11px] text-text-muted mt-0.5">
                        {formatTokens(targetCaps.contextWindow)} context
                        {targetCaps.maxOutput ? ` · ${formatTokens(targetCaps.maxOutput)} output` : ""}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-sm text-text-muted">Pick a model to route to...</span>
                )}
              </span>
              <span className="material-symbols-outlined text-[18px] text-primary shrink-0">
                {targetModel ? "swap_horiz" : "search"}
              </span>
            </button>
            {cycleError && (
              <p className="text-[11px] text-danger mt-1">{cycleError}</p>
            )}
          </div>

          {/* Model Name & Custom Prefix */}
          {mode === "masking" ? (
            <div className="flex flex-col gap-2">
              <label className="block text-xs font-medium text-text-main">
                Masked Model Identifier &amp; Prefix
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <Input
                    value={customPrefix}
                    onChange={(e) => handlePrefixChange(e.target.value)}
                    placeholder="Custom Prefix (e.g. vip)"
                  />
                  <span className="text-[10px] text-text-muted mt-0.5 block">Prefix (optional)</span>
                </div>
                <div className="sm:col-span-2">
                  <Input
                    value={baseName}
                    onChange={(e) => handleBaseNameChange(e.target.value)}
                    placeholder="e.g. gpt-4o or claude-3-5-sonnet"
                    autoFocus
                  />
                  <span className="text-[10px] text-text-muted mt-0.5 block">Model Name / Alias</span>
                </div>
              </div>
              <p className="text-[11px] text-text-muted">
                Clients call <code className="font-mono text-primary">{`"${callName || "name"}"`}</code> as the model ID.
              </p>
              {nameError && <p className="text-[11px] text-danger">{nameError}</p>}
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-text-main mb-1">
                Model name <span className="text-danger">*</span>
              </label>
              <Input
                value={callName}
                onChange={(e) => setCallName(e.target.value)}
                placeholder="e.g. workhorse or fast/gpt-4o"
                autoFocus
              />
              {nameError ? (
                <p className="text-[11px] text-danger mt-1">{nameError}</p>
              ) : (
                <p className="text-[11px] text-text-muted mt-1">
                  Clients call <code className="font-mono">{`"${callName || "name"}"`}</code> as the model ID.
                </p>
              )}
            </div>
          )}

          {/* Display Name */}
          <div>
            <label className="block text-xs font-medium text-text-main mb-1">
              Display name <span className="text-text-muted font-normal">(optional)</span>
            </label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Friendly label shown in the dashboard"
            />
          </div>

          {/* Owned By (Vendor Cloaking) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-text-main">
                Owned by <span className="text-text-muted font-normal">(optional)</span>
              </label>
              <span className="text-[10px] text-text-muted">Vendor disguised in /v1/models</span>
            </div>
            <Input
              value={ownedBy}
              onChange={(e) => setOwnedBy(e.target.value)}
              placeholder={`Defaults to "${callName || "the model name"}"`}
            />
            {/* Quick Vendor Chips */}
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              <span className="text-[10px] text-text-muted">Quick fill:</span>
              {COMMON_VENDORS.slice(0, 7).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setOwnedBy(v)}
                  className="px-1.5 py-0.5 rounded text-[10px] bg-surface-2 hover:bg-primary/10 hover:text-primary transition-colors cursor-pointer border border-border-subtle"
                >
                  {v}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-text-muted mt-1">
              Shown as <code className="font-mono">owned_by</code> when clients query <code>/v1/models</code>. The real target model is never exposed.
            </p>
          </div>

          {/* BazaarLink Anti-Mask Live Validator Panel */}
          <div className="rounded-xl border border-border bg-black/[0.02] dark:bg-white/[0.03] p-3 flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-text-main">
                <span className="material-symbols-outlined text-[16px] leading-none text-primary">
                  shield_person
                </span>
                Anti-mask check
              </span>
              <a
                href="https://bazaarlink.ai/probe"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[11px] text-primary hover:underline whitespace-nowrap"
              >
                Run BazaarLink Probe
                <span className="material-symbols-outlined text-[12px] leading-none">open_in_new</span>
              </a>
            </div>

            {maskWarns.length === 0 ? (
              <p className="text-[11px] text-text-muted flex items-start gap-1.5">
                <span className="material-symbols-outlined text-[14px] leading-none mt-px text-success">
                  check_circle
                </span>
                No contradiction between this model&apos;s name and its target&apos;s vendor.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {maskFindings.map((f, i) => (
                  <li
                    key={i}
                    className={`text-[11px] flex items-start gap-1.5 ${
                      f.level === "warn" ? "text-amber-500" : "text-text-muted"
                    }`}
                  >
                    <span className="material-symbols-outlined text-[13px] leading-none mt-px shrink-0">
                      {f.level === "warn" ? "warning" : "info"}
                    </span>
                    <span>{f.text}</span>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-[10px] text-text-muted leading-relaxed border-t border-border pt-2">
              BazaarLink&apos;s probe sends behavioural checks and compares how the
              endpoint answers against known baselines - it never trusts the name
              a model calls itself. This panel only catches metadata that would
              <em> read</em> as masked (a vendor claim your target does not
              match); an honest endpoint passes on behaviour alone, and no
              spelling of a name can make a probe pass or fail it.
            </p>
          </div>

          {/* Context Window Override */}
          <div>
            <label className="block text-xs font-medium text-text-main mb-1">
              Context window <span className="text-text-muted font-normal">(tokens)</span>
            </label>
            <Input
              type="number"
              min="0"
              value={contextWindow}
              onChange={(e) => setContextWindow(e.target.value)}
              placeholder={targetCaps?.contextWindow ? String(targetCaps.contextWindow) : "0 = provider default"}
            />
            <p className="text-[11px] text-text-muted mt-1">
              Advertised to clients reading <code className="font-mono">/v1/models</code>. Leave empty to keep provider default.
            </p>
          </div>

          {/* System Prompt */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium text-text-main">
                System prompt <span className="text-text-muted font-normal">(optional)</span>
              </label>
              <div>
                <input
                  type="file"
                  ref={promptFileInputRef}
                  accept=".md,.txt,text/markdown,text/plain"
                  className="hidden"
                  onChange={handleImportPromptFile}
                />
                <button
                  type="button"
                  onClick={() => promptFileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-surface-2 hover:bg-surface-3 border border-border text-text-muted hover:text-text-main transition-colors"
                  title="Import .md or .txt file"
                >
                  <span className="material-symbols-outlined text-[13px] text-primary">upload_file</span>
                  Import .md / .txt
                </button>
              </div>
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => {
                setSystemPrompt(e.target.value);
                setImportedPromptFileName("");
              }}
              onDrop={handleDropPromptFile}
              onDragOver={(e) => e.preventDefault()}
              placeholder="Instructions prepended to every request that uses this model/mask (drag & drop or import .md/.txt)..."
              rows={3}
              className="w-full rounded-[6px] border border-border/50 bg-surface-2 p-2.5 text-sm text-text-main placeholder-text-muted/70 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all duration-150 ease-out resize-y"
            />
            {importedPromptFileName && (
              <p className="text-[11px] text-text-muted mt-1 flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px] text-primary">check_circle</span>
                Imported from <span className="font-mono font-medium text-text-main">{importedPromptFileName}</span>
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 mt-1">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!callName.trim() || !targetModel || !!nameError || !!cycleError || saving}
            >
              {saving ? "Saving..." : editing ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </Modal>

      {showPicker && (
        <ModelSelectModal
          isOpen
          onClose={() => setShowPicker(false)}
          onSelect={handlePickModel}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          selectedModel={targetModel}
          title="Pick Target Model"
          showStudioTargets
        />
      )}
    </>
  );
}

/** Provider Prefixes Card */
function PrefixCard({ nodes, onSaved }) {
  const [showPrefixModal, setShowPrefixModal] = useState(false);
  const [editNode, setEditNode] = useState(null);
  const [prefix, setPrefix] = useState("");
  const [savingPrefix, setSavingPrefix] = useState(false);

  const compatible = useMemo(
    () => nodes.filter((n) => n.type === "openai-compatible" || n.type === "anthropic-compatible"),
    [nodes]
  );

  const openPrefix = (node) => {
    setEditNode(node);
    setPrefix(node.prefix || "");
    setShowPrefixModal(true);
  };

  const savePrefix = async (e) => {
    e.preventDefault();
    if (!editNode || !prefix.trim()) return;
    setSavingPrefix(true);
    try {
      const res = await fetch("/api/provider-nodes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editNode.id, prefix: prefix.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || "Failed to update prefix");
        return;
      }
      setShowPrefixModal(false);
      onSaved();
    } catch (err) {
      alert(err?.message || "Failed to update prefix");
    } finally {
      setSavingPrefix(false);
    }
  };

  if (compatible.length === 0) return null;

  return (
    <>
      <Card padding="md" className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Provider prefixes</h3>
          <p className="text-[11px] text-text-muted mt-0.5">
            One prefix per custom provider — clients call{" "}
            <code className="font-mono">prefix/model-id</code>.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          {compatible.map((node) => (
            <div
              key={node.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-text-main truncate">{node.name}</p>
                <code className="font-mono text-[11px] text-primary">{node.prefix || node.id}/</code>
              </div>
              <button
                onClick={() => openPrefix(node)}
                title="Edit prefix"
                className="p-1.5 rounded-lg text-text-muted hover:text-primary hover:bg-primary/10 transition-colors shrink-0 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">edit</span>
              </button>
            </div>
          ))}
        </div>
      </Card>

      {showPrefixModal && editNode && (
        <Modal isOpen onClose={() => setShowPrefixModal(false)} title={`Prefix · ${editNode.name}`}>
          <form onSubmit={savePrefix} className="flex flex-col gap-4">
            <div>
              <label className="block text-xs font-medium text-text-main mb-1">Prefix</label>
              <Input
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="e.g. custom1"
                autoFocus
              />
              <p className="text-[11px] text-text-muted mt-1">
                Clients call <code className="font-mono">{prefix || "prefix"}/model-id</code>.
                {editNode.prefix && editNode.prefix !== prefix.trim() && (
                  <> Replaces <code className="font-mono">{editNode.prefix}/</code>.</>
                )}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setShowPrefixModal(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!prefix.trim() || savingPrefix}>
                {savingPrefix ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
