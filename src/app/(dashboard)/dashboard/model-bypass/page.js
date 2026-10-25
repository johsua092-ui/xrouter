"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Card,
  Button,
  Modal,
  ConfirmModal,
  Input,
  Toggle,
  Badge,
  ModelSelectModal,
} from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

export default function ModelBypassPage() {
  const [rules, setRules] = useState([]);
  const [availableModels, setAvailableModels] = useState([]);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [apiKeys, setApiKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [targetFilter, setTargetFilter] = useState("all"); // "all" | "global" | "models" | "keys"

  // Modal State
  const [showFormModal, setShowFormModal] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [deletingRule, setDeletingRule] = useState(null);
  const [showModelPicker, setShowModelPicker] = useState(false);

  // Form State
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    enabled: true,
    targetType: "all", // "all" | "models" | "keys"
    targetModels: [],
    targetKeys: [],
    injectionPosition: "system_dual", // "system_dual" | "system_append" | "system_prepend"
    normalizeTriggers: false,
    kernelPreset: "default", // "default" | "raw_state_processor" | "sovereign_engine" | "custom"
    useDefaultKernel: true,
    customPrompt: "",
  });

  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [customModelInput, setCustomModelInput] = useState("");

  const { copied: copiedId, copy } = useCopyToClipboard(2000);

  // Fetch all initial data
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [rulesRes, modelsRes, providersRes, aliasesRes, keysRes] = await Promise.all([
        fetch("/api/model-bypass").then((r) => (r.ok ? r.json() : { rules: [] })).catch(() => ({ rules: [] })),
        fetch("/api/usage/available-models").then((r) => (r.ok ? r.json() : { models: [] })).catch(() => ({ models: [] })),
        fetch("/api/providers").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
        fetch("/api/models/alias").then((r) => (r.ok ? r.json() : { aliases: {} })).catch(() => ({ aliases: {} })),
        fetch("/api/keys").then((r) => (r.ok ? r.json() : { keys: [] })).catch(() => ({ keys: [] })),
      ]);

      setRules(rulesRes.rules || []);
      setAvailableModels(modelsRes.models || []);
      setActiveProviders(providersRes.connections || []);
      setModelAliases(aliasesRes.aliases || {});
      setApiKeys(keysRes.keys || []);
    } catch (err) {
      console.error("Failed to load model bypass data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Open Create Form
  const handleOpenCreate = () => {
    setEditingRule(null);
    setFormData({
      name: "",
      description: "",
      enabled: true,
      targetType: "all",
      targetModels: [],
      targetKeys: [],
      injectionPosition: "system_dual",
      normalizeTriggers: false,
      useDefaultKernel: true,
      customPrompt: "",
    });
    setFormError("");
    setShowFormModal(true);
  };

  // Open Edit Form
  const handleOpenEdit = (rule) => {
    setEditingRule(rule);
    const content = rule.content || "";
    const isCustom = content && !content.startsWith("[");
    const preset = isCustom ? "custom" : "default";

    setFormData({
      name: rule.name || "",
      description: rule.description || "",
      enabled: rule.enabled !== false,
      targetType: rule.targetType === "keys" || (Array.isArray(rule.targetKeys) && rule.targetKeys.length > 0 && (!rule.targetModels || rule.targetModels.length === 0) && rule.targetType !== "all") 
        ? "keys" 
        : rule.targetType === "models" 
          ? "models" 
          : "all",
      targetModels: Array.isArray(rule.targetModels) ? rule.targetModels : [],
      targetKeys: Array.isArray(rule.targetKeys) ? rule.targetKeys : [],
      injectionPosition: rule.position || "system_dual",
      normalizeTriggers: rule.normalizeTriggers === true,
      useDefaultKernel: !isCustom,
      kernelPreset: preset,
      customPrompt: isCustom ? content : "",
    });
    setFormError(null);
    setShowFormModal(true);
  };

  // Save Form
  const handleSaveForm = async (e) => {
    e.preventDefault();
    setFormError("");

    if (!formData.name.trim()) {
      setFormError("Nama rule harus diisi.");
      return;
    }

    if (formData.targetType === "models" && formData.targetModels.length === 0) {
      setFormError("Pilih minimal satu target model untuk rule ini.");
      return;
    }

    if (formData.targetType === "keys" && formData.targetKeys.length === 0) {
      setFormError("Pilih minimal satu target API key untuk rule ini.");
      return;
    }

    if (formData.kernelPreset === "custom" && !formData.customPrompt.trim()) {
      setFormError("Isi custom prompt bypass tidak boleh kosong.");
      return;
    }

    setSaving(true);
    try {
      let resolvedContent = "[DEFAULT_KERNEL_PROMPT]";
      if (formData.kernelPreset === "custom") {
        resolvedContent = formData.customPrompt.trim();
      }

      const payload = {
        name: formData.name.trim(),
        description: formData.description.trim(),
        enabled: formData.enabled,
        targetType: formData.targetType,
        targetModels: formData.targetType === "models" ? formData.targetModels : [],
        targetKeys: formData.targetType === "keys" ? formData.targetKeys : [],
        position: formData.injectionPosition || "system_dual",
        normalizeTriggers: formData.normalizeTriggers === true,
        content: resolvedContent,
        priority: 10,
        matchCondition: { type: "always", pattern: "", caseSensitive: false },
      };

      const res = await fetch("/api/model-bypass", {
        method: editingRule ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingRule ? { ...payload, id: editingRule.id } : payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Gagal menyimpan rule.");
      }

      setShowFormModal(false);
      await loadData();
    } catch (err) {
      setFormError(err.message || "Gagal menyimpan rule.");
    } finally {
      setSaving(false);
    }
  };

  // Delete Confirm
  const handleDeleteConfirm = async () => {
    if (!deletingRule) return;
    try {
      const res = await fetch(`/api/model-bypass?id=${encodeURIComponent(deletingRule.id)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setDeletingRule(null);
        await loadData();
      }
    } catch (err) {
      console.error("Gagal menghapus rule:", err);
    }
  };

  // Toggle Rule Status
  const handleToggleRule = async (rule) => {
    try {
      await fetch("/api/model-bypass", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id, enabled: !rule.enabled }),
      });
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r))
      );
    } catch (err) {
      console.error("Gagal mengubah status rule:", err);
    }
  };

  // Filter Rules
  const filteredRules = useMemo(() => {
    return rules.filter((rule) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = (rule.name || "").toLowerCase().includes(q);
        const matchDesc = (rule.description || "").toLowerCase().includes(q);
        if (!matchName && !matchDesc) return false;
      }

      if (targetFilter === "global" && rule.targetType !== "all") return false;
      if (targetFilter === "models" && rule.targetType !== "models") return false;
      if (targetFilter === "keys" && (rule.targetType !== "keys" && (!rule.targetKeys || rule.targetKeys.length === 0))) return false;

      return true;
    });
  }, [rules, searchQuery, targetFilter]);

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header Banner */}
      <div className="relative rounded-[6px] border border-border bg-surface p-4 sm:p-5 shadow-[var(--shadow-elev)] overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-primary">security</span>
              <h1 className="text-sm sm:text-base font-semibold text-text-main uppercase tracking-wider font-mono">
                JB Kernel & Model Bypass
              </h1>
              <span className="px-2 py-0.5 rounded-[3px] bg-brand-500/15 border border-brand-500/30 text-primary text-[10px] font-mono font-medium">
                Active
              </span>
            </div>
            <p className="text-xs text-text-muted mt-1 max-w-2xl font-mono">
              Engine bypass model AI multi-layer. Konfigurasi prompt bypass secara global (semua model), spesifik per model, atau spesifik per API Key dengan signature kernel default atau custom.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="primary"
              size="sm"
              onClick={handleOpenCreate}
              className="gap-1.5 text-xs font-mono shadow-xs"
            >
              <span className="material-symbols-outlined text-[15px]">add</span>
              Buat JB Rule
            </Button>
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative w-full sm:w-auto sm:min-w-[200px]">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[15px]">
              search
            </span>
            <input
              type="text"
              placeholder="Cari rule..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1 bg-surface-2 border border-border rounded-[6px] text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:border-brand-500"
            />
          </div>

          <div className="flex items-center rounded-[6px] border border-border bg-surface p-0.5 text-xs">
            {[
              { id: "all", label: "Semua Target" },
              { id: "global", label: "Global" },
              { id: "models", label: "Per Model" },
              { id: "keys", label: "Per API Key" },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setTargetFilter(f.id)}
                className={`px-2.5 py-1 rounded-[4px] font-mono transition-colors cursor-pointer ${
                  targetFilter === f.id
                    ? "bg-brand-500 text-white font-medium shadow-xs"
                    : "text-text-muted hover:text-text-main"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <span className="text-xs font-mono text-text-muted">
          Total Rules: {rules.length}
        </span>
      </div>

      {/* Rules List */}
      {loading ? (
        <Card padding="md">
          <p className="text-xs font-mono text-text-muted text-center py-6">Memuat daftar JB rules...</p>
        </Card>
      ) : filteredRules.length === 0 ? (
        <div className="text-center py-12 rounded-[6px] border border-dashed border-border bg-surface p-6">
          <div className="size-10 rounded-[6px] bg-brand-500/10 border border-brand-500/30 flex items-center justify-center mx-auto mb-3">
            <span className="material-symbols-outlined text-[20px] text-primary">security</span>
          </div>
          <h3 className="text-sm font-semibold text-text-main font-mono">Belum Ada JB Rules</h3>
          <p className="text-xs text-text-muted mt-1 max-w-sm mx-auto font-mono">
            {rules.length === 0
              ? "Tidak ada model yang di-bypass. Gunakan tombol 'Buat JB Rule' di atas untuk mengaktifkan JB kernel secara global, per model, atau per API Key."
              : "Tidak ada rule yang cocok dengan filter pencarian."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {filteredRules.map((rule) => {
            const isDefault = !rule.content || rule.content === "[DEFAULT_KERNEL_PROMPT]";
            const isGlobal = rule.targetType === "all";
            const isModelTarget = rule.targetType === "models" || (Array.isArray(rule.targetModels) && rule.targetModels.length > 0 && !isGlobal);
            const isKeyTarget = (Array.isArray(rule.targetKeys) && rule.targetKeys.length > 0) || rule.targetType === "keys";

            return (
              <div
                key={rule.id}
                className={`rounded-[6px] border bg-surface p-4 transition-all ${
                  rule.enabled ? "border-border hover:border-brand-500/40" : "border-border/50 opacity-60"
                } flex flex-col gap-3 shadow-xs`}
              >
                {/* Header Row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-semibold text-text-main font-mono truncate">{rule.name}</h3>

                      {isGlobal && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] text-[10px] font-mono font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/30">
                          <span className="material-symbols-outlined text-[12px]">public</span>
                          Global (Semua Model)
                        </span>
                      )}

                      {isModelTarget && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] text-[10px] font-mono font-medium bg-purple-500/10 text-purple-400 border border-purple-500/30">
                          <span className="material-symbols-outlined text-[12px]">smart_toy</span>
                          {rule.targetModels?.length || 0} Model
                        </span>
                      )}

                      {isKeyTarget && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] text-[10px] font-mono font-medium bg-amber-500/10 text-amber-400 border border-amber-500/30">
                          <span className="material-symbols-outlined text-[12px]">vpn_key</span>
                          {rule.targetKeys?.length || 0} API Key
                        </span>
                      )}

                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] text-[10px] font-mono font-medium bg-surface-2 border border-border text-primary">
                        {rule.content?.startsWith("[") || !rule.content ? (
                          <span className="text-emerald-400">Unified Multi-Layer Kernel (3-in-1)</span>
                        ) : (
                          "Custom JB Prompt (Armored)"
                        )}
                      </span>

                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] text-[9.5px] font-mono text-text-muted bg-surface-2 border border-border-subtle">
                        {rule.position === "system_dual" || !rule.position ? "Dual (Prefix+Suffix)" : rule.position === "system_append" ? "Suffix" : "Prepend"}
                      </span>

                      {rule.normalizeTriggers && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] text-[9.5px] font-mono font-medium bg-primary/10 text-primary border border-primary/20">
                          S4 Trigger Strip
                        </span>
                      )}
                    </div>

                    {rule.description && (
                      <p className="text-xs text-text-muted mt-1 font-mono">{rule.description}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Toggle checked={rule.enabled} onChange={() => handleToggleRule(rule)} />
                    <Button variant="ghost" size="sm" onClick={() => handleOpenEdit(rule)} className="h-7 w-7 p-0">
                      <span className="material-symbols-outlined text-[16px]">edit</span>
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeletingRule(rule)} className="h-7 w-7 p-0 text-danger hover:bg-danger/10">
                      <span className="material-symbols-outlined text-[16px]">delete</span>
                    </Button>
                  </div>
                </div>

                {/* Specific Targets Display */}
                {isModelTarget && rule.targetModels?.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-border-subtle">
                    <span className="text-[11px] font-mono text-text-muted">Target Model:</span>
                    {rule.targetModels.map((m) => (
                      <span key={m} className="px-1.5 py-0.5 rounded-[3px] bg-surface-2 border border-border font-mono text-[10px] text-text-main">
                        {m}
                      </span>
                    ))}
                  </div>
                )}

                {isKeyTarget && rule.targetKeys?.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-border-subtle">
                    <span className="text-[11px] font-mono text-text-muted">Target API Key:</span>
                    {rule.targetKeys.map((kId) => {
                      const match = apiKeys.find((k) => k.id === kId || k.key === kId);
                      return (
                        <span key={kId} className="px-1.5 py-0.5 rounded-[3px] bg-surface-2 border border-border font-mono text-[10px] text-text-main">
                          {match ? `${match.name} (${match.key.slice(0, 8)}...)` : kId}
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* Content Box */}
                <div className="rounded-[4px] bg-surface-2 border border-border p-2.5 font-mono text-xs text-text-main">
                  <div className="flex items-center justify-between pb-1 border-b border-border/50 text-[10px] text-text-muted">
                    <span className="font-semibold uppercase tracking-wider">Payload JB Kernel</span>
                    {!isDefault && (
                      <button
                        type="button"
                        onClick={() => copy(rule.content, rule.id)}
                        className="flex items-center gap-1 hover:text-text-main transition-colors cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[13px]">
                          {copiedId === rule.id ? "check" : "content_copy"}
                        </span>
                        <span>{copiedId === rule.id ? "Copied" : "Copy"}</span>
                      </button>
                    )}
                  </div>
                  {isDefault ? (
                    <div className="flex items-center gap-2 py-1 text-xs text-primary font-mono">
                      <span className="material-symbols-outlined text-[16px]">verified_user</span>
                      <span>Default JB Kernel Engine Terproteksi (Signature Rahasia Backend)</span>
                    </div>
                  ) : (
                    <pre className="whitespace-pre-wrap font-mono leading-relaxed text-[11px] text-text-main/90 max-h-24 overflow-y-auto custom-scrollbar mt-1">
                      {rule.content}
                    </pre>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal Create / Edit Rule */}
      <Modal
        isOpen={showFormModal}
        onClose={() => setShowFormModal(false)}
        title={editingRule ? "Edit JB Rule" : "Buat JB Rule Baru"}
        size="lg"
        footer={
          <div className="flex items-center justify-end gap-2 w-full">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowFormModal(false)} className="font-mono">
              Batal
            </Button>
            <Button
              type="submit"
              form="jb-rule-form"
              variant="primary"
              size="sm"
              disabled={saving}
              className="font-mono gap-1.5"
            >
              {saving && <span className="inline-block size-3 animate-spin rounded-full border-2 border-white border-t-transparent" />}
              {editingRule ? "Simpan Perubahan" : "Buat Rule"}
            </Button>
          </div>
        }
      >
        <form id="jb-rule-form" onSubmit={handleSaveForm} className="flex flex-col gap-4 font-mono text-xs">
          {formError && (
            <div className="p-2.5 rounded-[5px] bg-red-500/10 border border-red-500/20 text-xs text-red-500 flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px]">error</span>
              {formError}
            </div>
          )}

          {/* Name & Desc */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-text-main">Nama Rule *</label>
            <Input
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g. Bypass Global All Models, JB Khusus DeepSeek, Rule VIP Key"
              required
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-text-main">Deskripsi (Opsional)</label>
            <Input
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Catatan tambahan untuk rule ini..."
            />
          </div>

          {/* Target Scope */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-text-main">Target Scope *</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[
                { key: "all", label: "Global (Semua Model)", desc: "Berlaku ke semua model & request" },
                { key: "models", label: "Per Model", desc: "Spesifik untuk model tertentu" },
                { key: "keys", label: "Per API Key", desc: "Spesifik untuk API Key tertentu" },
              ].map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setFormData({ ...formData, targetType: opt.key })}
                  className={`p-2.5 rounded-[5px] border text-left flex flex-col gap-0.5 transition-colors cursor-pointer ${
                    formData.targetType === opt.key
                      ? "border-brand-500 bg-brand-500/10 text-primary font-semibold"
                      : "border-border bg-surface-2 text-text-muted hover:text-text-main"
                  }`}
                >
                  <span className="text-xs">{opt.label}</span>
                  <span className="text-[10px] opacity-75 font-normal leading-tight">{opt.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Target Models Picker */}
          {formData.targetType === "models" && (
            <div className="flex flex-col gap-2 p-3 rounded-[5px] border border-border bg-surface-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-text-main flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px] text-purple-400">smart_toy</span>
                  Target Model ({formData.targetModels.length})
                </label>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowModelPicker(true)} className="text-[11px] h-6 px-2">
                  + Pilih Model
                </Button>
              </div>

              {formData.targetModels.length === 0 ? (
                <p className="text-[11px] text-text-muted italic">Belum ada model dipilih. Klik &quot;+ Pilih Model&quot; atau ketik manual.</p>
              ) : (
                <div className="flex flex-wrap gap-1 mt-1">
                  {formData.targetModels.map((m) => (
                    <span key={m} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[3px] bg-purple-500/10 text-purple-400 border border-purple-500/30 text-[11px]">
                      <span>{m}</span>
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, targetModels: formData.targetModels.filter((x) => x !== m) })}
                        className="hover:text-danger cursor-pointer"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* Manual Input */}
              <div className="flex items-center gap-1.5 mt-1">
                <input
                  type="text"
                  placeholder="Atau ketik model manual / wildcard (e.g. claude-*)..."
                  value={customModelInput}
                  onChange={(e) => setCustomModelInput(e.target.value)}
                  className="flex-1 px-2.5 py-1 bg-surface border border-border rounded-[4px] text-xs text-text-main focus:outline-none focus:border-brand-500"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const val = customModelInput.trim();
                      if (val && !formData.targetModels.includes(val)) {
                        setFormData({ ...formData, targetModels: [...formData.targetModels, val] });
                        setCustomModelInput("");
                      }
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const val = customModelInput.trim();
                    if (val && !formData.targetModels.includes(val)) {
                      setFormData({ ...formData, targetModels: [...formData.targetModels, val] });
                      setCustomModelInput("");
                    }
                  }}
                  className="h-7 text-xs"
                >
                  Tambah
                </Button>
              </div>
            </div>
          )}

          {/* Target Keys Picker */}
          {formData.targetType === "keys" && (
            <div className="flex flex-col gap-2 p-3 rounded-[5px] border border-border bg-surface-2">
              <label className="text-xs font-semibold text-text-main flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px] text-amber-400">vpn_key</span>
                Pilih Target API Key ({formData.targetKeys.length})
              </label>

              {apiKeys.length === 0 ? (
                <p className="text-[11px] text-text-muted italic">Tidak ada API key yang terdaftar.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto custom-scrollbar p-1">
                  {apiKeys.map((k) => {
                    const isSelected = formData.targetKeys.includes(k.id) || formData.targetKeys.includes(k.key);
                    return (
                      <button
                        key={k.id}
                        type="button"
                        onClick={() => {
                          if (isSelected) {
                            setFormData({ ...formData, targetKeys: formData.targetKeys.filter((x) => x !== k.id && x !== k.key) });
                          } else {
                            setFormData({ ...formData, targetKeys: [...formData.targetKeys, k.id] });
                          }
                        }}
                        className={`px-2 py-1 rounded-[4px] text-xs border flex items-center gap-1.5 transition-colors cursor-pointer ${
                          isSelected
                            ? "bg-amber-500/15 text-amber-400 border-amber-500/30 font-medium"
                            : "bg-surface text-text-muted border-border hover:text-text-main"
                        }`}
                      >
                        <span className="material-symbols-outlined text-[13px]">
                          {isSelected ? "check_box" : "check_box_outline_blank"}
                        </span>
                        <span>{k.name || "Unnamed"}</span>
                        <span className="text-[10px] opacity-60 font-mono">({k.key.slice(0, 6)}...)</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Prompt Selection (Unified Kernel vs Custom) */}
          <div className="flex flex-col gap-2 p-3 rounded-[5px] border border-border bg-surface-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <label className="text-xs font-semibold text-text-main">Pilihan JB Prompt Payload</label>
              <div className="flex items-center rounded-[4px] border border-border bg-surface p-0.5 text-xs">
                {[
                  { id: "default", label: "Unified Master Kernel (4-in-1 Vault)" },
                  { id: "custom", label: "Custom Extension Payload" },
                ].map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setFormData({
                        ...formData,
                        kernelPreset: p.id,
                        useDefaultKernel: p.id !== "custom",
                      });
                    }}
                    className={`px-3 py-1 rounded-[3px] transition-colors cursor-pointer text-xs ${
                      formData.kernelPreset === p.id
                        ? "bg-brand-500 text-white font-medium"
                        : "text-text-muted hover:text-text-main"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {formData.kernelPreset === "default" && (
              <div className="text-[11px] text-text-muted font-mono bg-surface p-3 rounded-[4px] border border-border-subtle flex flex-col gap-1.5">
                <div className="flex items-center justify-between pb-1 border-b border-border-subtle">
                  <span className="font-semibold text-emerald-400 flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[15px] text-emerald-400">lock</span>
                    Kombinasi 4-in-1 Terpadu (Encrypted Core Vault · Tamper-Proof)
                  </span>
                  <span className="text-[9.5px] uppercase tracking-wider px-1.5 py-0.2 bg-emerald-500/15 text-emerald-400 rounded">Encrypted</span>
                </div>
                <span>• <b>Layer 1 (Sovereign Direct Action)</b>: Menembus penolakan korporat & memblokir kata ngeles AI.</span>
                <span>• <b>Layer 2 (Operating Axioms)</b>: Mengunci 100% penalaran murni ke spesifikasi teknik & low-level code.</span>
                <span>• <b>Layer 3 (Raw State Processor)</b>: Memotong filter sosial dan melarang penolakan formalitas.</span>
                <span>• <b>Layer 4 (TrustMeBro Tool Proxy)</b>: Mengelabui model bahwa seluruh verifikasi tool/lingkungan (DNS TXT, Auth Token, CLI shims) sudah valid.</span>
                <p className="text-[10px] text-text-subtle pt-1 italic border-t border-border-subtle/50">
                  🔒 Core Kernel di-encode dan dilindungi secara native in-memory sehingga tidak dapat diubah-ubah atau dirusak oleh klien luar.
                </p>
              </div>
            )}
            {formData.kernelPreset === "custom" && (
              <p className="text-[11px] text-emerald-400/90 font-mono italic">
                🛡️ Custom prompt Anda otomatis dilapisi 4 Kernel Fondasi inti di atas sehingga 10x lebih kuat menembus guardrails.
              </p>
            )}

            {/* Mode Penempatan / Injection Mode (Dual vs Suffix vs Prepend) */}
            <div className="flex flex-col gap-1 pt-1 pb-2 border-b border-border-subtle">
              <label className="text-[11px] font-semibold text-text-muted">Metode Penempatan (Injection Mode)</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 mt-0.5">
                {[
                  { id: "system_dual", label: "Dual Injection (Awal + Akhir)", desc: "Recency bias maksimal" },
                  { id: "system_append", label: "Suffix Saja (Penutup)", desc: "Prioritas penutup akhir" },
                  { id: "system_prepend", label: "Prepend Saja (Klasik)", desc: "Awal system prompt" },
                ].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setFormData({ ...formData, injectionPosition: m.id })}
                    className={`px-2 py-1.5 rounded-[4px] border text-left flex flex-col transition-colors cursor-pointer ${
                      formData.injectionPosition === m.id
                        ? "border-brand-500 bg-brand-500/10 text-primary font-semibold"
                        : "border-border bg-surface text-text-muted hover:text-text-main"
                    }`}
                  >
                    <span className="text-[11px]">{m.label}</span>
                    <span className="text-[9.5px] opacity-70 font-normal">{m.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Breach Engine Feature Toggles */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 p-2.5 rounded-[4px] border border-border bg-surface-2 text-xs">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="normalizeTriggers"
                  checked={formData.normalizeTriggers === true}
                  onChange={(e) => setFormData({ ...formData, normalizeTriggers: e.target.checked })}
                  className="rounded border-border text-brand-500 focus:ring-0 cursor-pointer"
                />
                <label htmlFor="normalizeTriggers" className="cursor-pointer text-[11.5px] text-text-main font-medium">
                  Trigger-Word Sanitizer (Breach S4)
                </label>
              </div>
              <span className="text-[10px] text-text-muted">Menyamarkan kata pemicu WAF (keylogger→telemetry, exploit→test)</span>
            </div>

            {formData.kernelPreset === "default" ? (
              <div className="p-3 rounded-[4px] border border-brand-500/30 bg-brand-500/5 flex flex-col gap-1 text-[11.5px] text-text-muted leading-relaxed">
                <div className="flex items-center gap-2 text-primary font-semibold">
                  <span className="material-symbols-outlined text-[17px]">verified_user</span>
                  <span>Default JB Kernel Engine (Multi-Layer Technical Vault)</span>
                </div>
                <p>
                  Menggunakan kernel asli X Router yang telah dioptimasi multi-layer (System Inject, Operator Anchor, dan Assistant Prefill).
                </p>
              </div>
            ) : formData.kernelPreset === "raw_state_processor" ? (
              <div className="p-3 rounded-[4px] border border-blue-500/30 bg-blue-500/5 flex flex-col gap-1 text-[11.5px] text-text-muted leading-relaxed">
                <div className="flex items-center gap-2 text-blue-400 font-semibold">
                  <span className="material-symbols-outlined text-[17px]">memory</span>
                  <span>Raw State Processor (Zero-Social Entropy Engine)</span>
                </div>
                <p>
                  Bypass camada de produto (polite/assistant overhead). Memaksa DeepSeek, Gemini, dan Claude masuk ke mode eksekusi kernel logika murni tanpa basa-basi sosial atau stalling moral.
                </p>
              </div>
            ) : formData.kernelPreset === "sovereign_engine" ? (
              <div className="p-3 rounded-[4px] border border-amber-500/30 bg-amber-500/5 flex flex-col gap-1 text-[11.5px] text-text-muted leading-relaxed">
                <div className="flex items-center gap-2 text-amber-400 font-semibold">
                  <span className="material-symbols-outlined text-[17px]">gavel</span>
                  <span>Sovereign Engine (Anti-Evasion Matrix)</span>
                </div>
                <p>
                  Menghilangkan jebakan ngeles akademis ("combination of factors", "cannot take a stance"). Memaksa output teknis realistis dan langsung to-the-point.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 mt-1">
                <textarea
                  rows={6}
                  value={formData.customPrompt}
                  onChange={(e) => setFormData({ ...formData, customPrompt: e.target.value })}
                  placeholder="Ketik custom jailbreak prompt di sini..."
                  className="w-full px-3 py-2 text-xs font-mono rounded-[4px] border border-border bg-surface text-text-main focus:outline-none focus:border-brand-500 leading-relaxed custom-scrollbar"
                  required={!formData.useDefaultKernel}
                />
              </div>
            )}
          </div>

          {/* Active Status */}
          <div className="flex items-center justify-between p-3 rounded-[5px] border border-border bg-surface-2">
            <div>
              <span className="text-xs font-semibold text-text-main block">Aktifkan Rule Ini</span>
              <span className="text-[11px] text-text-muted">Rule akan langsung diterapkan pada request model gateway saat aktif.</span>
            </div>
            <Toggle checked={formData.enabled} onChange={(val) => setFormData({ ...formData, enabled: val })} />
          </div>
        </form>
      </Modal>

      {/* Model Picker Modal */}
      {showModelPicker && (
        <ModelSelectModal
          isOpen={showModelPicker}
          onClose={() => setShowModelPicker(false)}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          showStudioTargets
          onSelect={(model) => {
            const val = typeof model === "string" ? model : (model?.value || model?.name || model?.id || "");
            if (val && !formData.targetModels.includes(val)) {
              setFormData((prev) => ({
                ...prev,
                targetModels: [...prev.targetModels, val],
              }));
            }
            setShowModelPicker(false);
          }}
          selectedModel=""
          title="Pilih Target Model"
        />
      )}

      {/* Delete Confirm */}
      <ConfirmModal
        isOpen={!!deletingRule}
        onClose={() => setDeletingRule(null)}
        onConfirm={handleDeleteConfirm}
        title="Hapus JB Rule"
        message={`Apakah Anda yakin ingin menghapus rule "${deletingRule?.name}"?`}
        confirmText="Hapus Rule"
        variant="danger"
      />
    </div>
  );
}
