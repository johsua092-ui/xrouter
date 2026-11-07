"use client";

import { useEffect, useState, useMemo } from "react";
import {
  Card,
  Button,
  Badge,
  Input,
  Modal,
  CardSkeleton,
  Toggle,
  ConfirmModal
} from "@/shared/components";

export default function TeamsPage() {
  const [teams, setTeams] = useState([]);
  const [allModels, setAllModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const [modelSearch, setModelSearch] = useState("");

  // Form State
  const [formData, setFormData] = useState({
    id: null,
    name: "",
    apiKey: "",
    description: "",
    allowedModels: [],
    allowedProviders: [],
    rpmLimit: "",
    dailyLimit: "",
    monthlyLimit: "",
    dailySpendLimitUsd: "",
    monthlySpendLimitUsd: "",
  });

  const loadData = async () => {
    try {
      setLoading(true);
      const [teamsRes, modelsRes] = await Promise.all([
        fetch("/api/teams", { cache: "no-store" }),
        fetch("/api/models", { cache: "no-store" }).catch(() => ({ ok: false }))
      ]);

      const teamsData = await teamsRes.json();
      if (teamsRes.ok) {
        setTeams(teamsData.teams || []);
      } else {
        setError(teamsData.error || "Failed to load teams");
      }

      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const list = Array.isArray(modelsData) ? modelsData : (modelsData.models || modelsData.data || []);
        setAllModels(list.map(m => typeof m === "string" ? { id: m, name: m } : { id: m.id, name: m.name || m.id }));
      }
    } catch (err) {
      setError(err.message || "Failed to load teams");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleOpenCreate = () => {
    // Generate dynamic preview key
    const previewHex = Math.random().toString(16).substring(2, 10) + Math.random().toString(16).substring(2, 10);
    setFormData({
      id: null,
      name: "",
      apiKey: `xteam-${previewHex}`,
      description: "",
      allowedModels: [],
      allowedProviders: [],
      rpmLimit: "",
      dailyLimit: "",
      monthlyLimit: "",
      dailySpendLimitUsd: "",
      monthlySpendLimitUsd: "",
    });
    setModelSearch("");
    setShowModal(true);
  };

  const handleOpenEdit = (team) => {
    setFormData({
      id: team.id,
      name: team.name || "",
      apiKey: team.apiKey || "",
      description: team.description || "",
      allowedModels: Array.isArray(team.allowedModels) ? team.allowedModels : [],
      allowedProviders: Array.isArray(team.allowedProviders) ? team.allowedProviders : [],
      rpmLimit: team.rpmLimit ? String(team.rpmLimit) : "",
      dailyLimit: team.dailyLimit ? String(team.dailyLimit) : "",
      monthlyLimit: team.monthlyLimit ? String(team.monthlyLimit) : "",
      dailySpendLimitUsd: team.dailySpendLimitUsd ? String(team.dailySpendLimitUsd) : "",
      monthlySpendLimitUsd: team.monthlySpendLimitUsd ? String(team.monthlySpendLimitUsd) : "",
    });
    setModelSearch("");
    setShowModal(true);
  };

  const handleToggleEnable = async (team) => {
    try {
      const res = await fetch(`/api/teams/${team.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !team.enabled }),
      });
      if (res.ok) {
        setTeams((prev) =>
          prev.map((t) => (t.id === team.id ? { ...t, enabled: !t.enabled } : t))
        );
      }
    } catch (err) {
      console.error("Toggle team error:", err);
    }
  };

  const handleCopyKey = (key) => {
    navigator.clipboard.writeText(key);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleToggleModelSelection = (modelId) => {
    setFormData((prev) => {
      const exists = prev.allowedModels.includes(modelId);
      const next = exists
        ? prev.allowedModels.filter((id) => id !== modelId)
        : [...prev.allowedModels, modelId];
      return { ...prev, allowedModels: next };
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name.trim()) return;
    setBusy(true);
    try {
      const payload = {
        name: formData.name.trim(),
        apiKey: formData.apiKey.trim(),
        description: formData.description.trim(),
        allowedModels: formData.allowedModels,
        allowedProviders: formData.allowedProviders,
        rpmLimit: formData.rpmLimit ? parseInt(formData.rpmLimit, 10) : 0,
        dailyLimit: formData.dailyLimit ? parseInt(formData.dailyLimit, 10) : 0,
        monthlyLimit: formData.monthlyLimit ? parseInt(formData.monthlyLimit, 10) : 0,
        dailySpendLimitUsd: formData.dailySpendLimitUsd ? parseFloat(formData.dailySpendLimitUsd) : 0,
        monthlySpendLimitUsd: formData.monthlySpendLimitUsd ? parseFloat(formData.monthlySpendLimitUsd) : 0,
      };

      const url = formData.id ? `/api/teams/${formData.id}` : "/api/teams";
      const method = formData.id ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setShowModal(false);
        loadData();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to save team");
      }
    } catch (err) {
      alert(err.message || "Failed to save team");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      const res = await fetch(`/api/teams/${pendingDelete.id}`, { method: "DELETE" });
      if (res.ok) {
        setTeams((prev) => prev.filter((t) => t.id !== pendingDelete.id));
      }
    } catch (err) {
      console.error("Delete team error:", err);
    } finally {
      setPendingDelete(null);
    }
  };

  const filteredCatalogModels = useMemo(() => {
    if (!modelSearch.trim()) return allModels;
    const q = modelSearch.toLowerCase();
    return allModels.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q))
    );
  }, [allModels, modelSearch]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Teams & Quota Governance</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Create multi-tenant teams with auto-generated <span className="font-mono text-primary font-semibold">xteam-*</span> API keys, granular model pickers, and spending caps.
          </p>
        </div>
        <Button onClick={handleOpenCreate} icon="add">
          Create Team
        </Button>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
          {error}
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <CardSkeleton count={3} />
        </div>
      ) : teams.length === 0 ? (
        <Card className="text-center py-12">
          <span className="material-symbols-outlined text-4xl text-muted-foreground mb-2">groups</span>
          <h3 className="text-lg font-semibold">No teams configured yet</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
            Organize users into dedicated teams with custom <span className="font-mono text-primary">xteam-*</span> keys and model permissions.
          </p>
          <Button onClick={handleOpenCreate} icon="add" className="mt-4">
            Create First Team
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((team) => (
            <Card
              key={team.id}
              className={`flex flex-col justify-between transition-all duration-200 hover:border-primary/50 relative overflow-hidden ${
                !team.enabled ? "opacity-60" : ""
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-bold">
                      <span className="material-symbols-outlined text-xl">groups</span>
                    </div>
                    <div>
                      <h3 className="font-semibold text-base leading-tight">{team.name}</h3>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">{team.id}</p>
                    </div>
                  </div>
                  <Toggle
                    checked={team.enabled}
                    onChange={() => handleToggleEnable(team)}
                    title={team.enabled ? "Team active" : "Team disabled"}
                  />
                </div>

                {/* Team API Key Badge Box */}
                {team.apiKey && (
                  <div className="mt-3.5 p-2.5 rounded-lg bg-muted/50 border border-border/60 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block">
                        Team API Key
                      </span>
                      <code className="text-xs font-mono font-medium text-primary truncate block mt-0.5">
                        {team.apiKey}
                      </code>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 shrink-0"
                      onClick={() => handleCopyKey(team.apiKey)}
                      title="Copy Key"
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        {copiedKey === team.apiKey ? "check" : "content_copy"}
                      </span>
                    </Button>
                  </div>
                )}

                {team.description && (
                  <p className="text-xs text-muted-foreground mt-3 line-clamp-2">
                    {team.description}
                  </p>
                )}

                {/* Quota & Limits Badges */}
                <div className="flex flex-wrap gap-1.5 mt-3.5">
                  {team.rpmLimit > 0 && (
                    <Badge variant="outline" className="text-[11px] font-mono">
                      {team.rpmLimit} RPM
                    </Badge>
                  )}
                  {team.dailyLimit > 0 && (
                    <Badge variant="outline" className="text-[11px] font-mono">
                      {team.dailyLimit}/day
                    </Badge>
                  )}
                  {team.monthlyLimit > 0 && (
                    <Badge variant="outline" className="text-[11px] font-mono">
                      {team.monthlyLimit}/mo
                    </Badge>
                  )}
                  {team.dailySpendLimitUsd > 0 && (
                    <Badge variant="secondary" className="text-[11px] font-mono text-emerald-500 bg-emerald-500/10 border-emerald-500/20">
                      ${team.dailySpendLimitUsd}/day
                    </Badge>
                  )}
                  {team.monthlySpendLimitUsd > 0 && (
                    <Badge variant="secondary" className="text-[11px] font-mono text-emerald-500 bg-emerald-500/10 border-emerald-500/20">
                      ${team.monthlySpendLimitUsd}/mo
                    </Badge>
                  )}
                  {(!team.rpmLimit && !team.dailyLimit && !team.dailySpendLimitUsd) && (
                    <Badge variant="outline" className="text-[11px] text-muted-foreground">
                      Unlimited Quota
                    </Badge>
                  )}
                </div>

                {/* Selected Models Summary */}
                <div className="mt-4 pt-3 border-t border-border/50 text-xs">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-muted-foreground">Permitted Models:</span>
                    <span className="font-semibold text-primary">
                      {Array.isArray(team.allowedModels) && team.allowedModels.length > 0
                        ? `${team.allowedModels.length} models selected`
                        : "All Models (*)"}
                    </span>
                  </div>
                  {Array.isArray(team.allowedModels) && team.allowedModels.length > 0 ? (
                    <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto pr-1">
                      {team.allowedModels.map((m) => (
                        <span
                          key={m}
                          className="px-1.5 py-0.5 rounded bg-background border border-border/70 text-[10px] font-mono text-muted-foreground"
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-[11px] text-muted-foreground italic">
                      Full access to all catalog models
                    </span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 mt-5 pt-3 border-t border-border/50">
                <Button
                  size="sm"
                  variant="ghost"
                  icon="edit"
                  onClick={() => handleOpenEdit(team)}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10"
                  icon="delete"
                  onClick={() => setPendingDelete(team)}
                >
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit Modal */}
      {showModal && (
        <Modal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          title={formData.id ? "Edit Team" : "Create New Team"}
        >
          <form onSubmit={handleSubmit} className="space-y-4 max-h-[80vh] overflow-y-auto px-1 pr-2">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Team Name <span className="text-destructive">*</span>
              </label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. VIP Agents, Frontend Team"
                required
                className="mt-1.5"
              />
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Team API Key (Prefix: xteam-*)
              </label>
              <Input
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="xteam-..."
                className="mt-1.5 font-mono text-xs text-primary"
              />
              <span className="text-[11px] text-muted-foreground mt-1 block">
                Auto-assigned with high-entropy token. Clients can authenticate with this key directly.
              </span>
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Description
              </label>
              <Input
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Team purpose or members"
                className="mt-1.5"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  RPM Limit
                </label>
                <Input
                  type="number"
                  value={formData.rpmLimit}
                  onChange={(e) => setFormData({ ...formData, rpmLimit: e.target.value })}
                  placeholder="0 (Unlimited)"
                  className="mt-1.5"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Daily Requests
                </label>
                <Input
                  type="number"
                  value={formData.dailyLimit}
                  onChange={(e) => setFormData({ ...formData, dailyLimit: e.target.value })}
                  placeholder="0 (Unlimited)"
                  className="mt-1.5"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Daily Spend ($ USD)
                </label>
                <Input
                  type="number"
                  step="0.01"
                  value={formData.dailySpendLimitUsd}
                  onChange={(e) => setFormData({ ...formData, dailySpendLimitUsd: e.target.value })}
                  placeholder="0.00"
                  className="mt-1.5"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Monthly Spend ($ USD)
                </label>
                <Input
                  type="number"
                  step="0.01"
                  value={formData.monthlySpendLimitUsd}
                  onChange={(e) => setFormData({ ...formData, monthlySpendLimitUsd: e.target.value })}
                  placeholder="0.00"
                  className="mt-1.5"
                />
              </div>
            </div>

            {/* Granular Model Picker */}
            <div className="pt-2">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Allowed Models ({formData.allowedModels.length ? `${formData.allowedModels.length} selected` : "All models (*)"})
                </label>
                {formData.allowedModels.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setFormData((prev) => ({ ...prev, allowedModels: [] }))}
                    className="text-[11px] text-primary hover:underline"
                  >
                    Reset to All
                  </button>
                )}
              </div>

              <Input
                placeholder="Search models to filter..."
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                className="mb-2 text-xs"
              />

              <div className="max-h-48 overflow-y-auto border border-border rounded-xl p-2 bg-muted/20 space-y-1">
                {filteredCatalogModels.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">No models found</p>
                ) : (
                  filteredCatalogModels.map((m) => {
                    const isSelected = formData.allowedModels.includes(m.id);
                    return (
                      <div
                        key={m.id}
                        onClick={() => handleToggleModelSelection(m.id)}
                        className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors text-xs ${
                          isSelected
                            ? "bg-primary/10 border border-primary/30 text-primary font-medium"
                            : "hover:bg-muted/50 border border-transparent text-muted-foreground"
                        }`}
                      >
                        <div className="min-w-0 pr-2">
                          <span className="font-mono block truncate">{m.id}</span>
                          {m.name && m.name !== m.id && (
                            <span className="text-[10px] text-muted-foreground block truncate">{m.name}</span>
                          )}
                        </div>
                        <span className="material-symbols-outlined text-base">
                          {isSelected ? "check_box" : "check_box_outline_blank"}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-border">
              <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !formData.name.trim()}>
                {formData.id ? "Update Team" : "Create Team"}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Delete Confirm */}
      {pendingDelete && (
        <ConfirmModal
          isOpen={!!pendingDelete}
          onClose={() => setPendingDelete(null)}
          onConfirm={handleDelete}
          title="Delete Team"
          message={`Are you sure you want to delete team "${pendingDelete.name}"? This action cannot be undone.`}
          confirmLabel="Delete Team"
          variant="destructive"
        />
      )}
    </div>
  );
}
