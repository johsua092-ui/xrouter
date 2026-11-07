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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [busy, setBusy] = useState(false);

  // Form State
  const [formData, setFormData] = useState({
    id: null,
    name: "",
    description: "",
    allowedModels: "",
    allowedProviders: "",
    rpmLimit: "",
    dailyLimit: "",
    monthlyLimit: "",
    dailySpendLimitUsd: "",
    monthlySpendLimitUsd: "",
  });

  const loadTeams = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/teams", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setTeams(data.teams || []);
      } else {
        setError(data.error || "Failed to load teams");
      }
    } catch (err) {
      setError(err.message || "Failed to load teams");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTeams();
  }, []);

  const handleOpenCreate = () => {
    setFormData({
      id: null,
      name: "",
      description: "",
      allowedModels: "",
      allowedProviders: "",
      rpmLimit: "",
      dailyLimit: "",
      monthlyLimit: "",
      dailySpendLimitUsd: "",
      monthlySpendLimitUsd: "",
    });
    setShowModal(true);
  };

  const handleOpenEdit = (team) => {
    setFormData({
      id: team.id,
      name: team.name || "",
      description: team.description || "",
      allowedModels: Array.isArray(team.allowedModels) ? team.allowedModels.join(", ") : "",
      allowedProviders: Array.isArray(team.allowedProviders) ? team.allowedProviders.join(", ") : "",
      rpmLimit: team.rpmLimit ? String(team.rpmLimit) : "",
      dailyLimit: team.dailyLimit ? String(team.dailyLimit) : "",
      monthlyLimit: team.monthlyLimit ? String(team.monthlyLimit) : "",
      dailySpendLimitUsd: team.dailySpendLimitUsd ? String(team.dailySpendLimitUsd) : "",
      monthlySpendLimitUsd: team.monthlySpendLimitUsd ? String(team.monthlySpendLimitUsd) : "",
    });
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name.trim()) return;
    setBusy(true);
    try {
      const payload = {
        name: formData.name.trim(),
        description: formData.description.trim(),
        allowedModels: formData.allowedModels.trim()
          ? formData.allowedModels.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        allowedProviders: formData.allowedProviders.trim()
          ? formData.allowedProviders.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
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
        loadTeams();
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Teams & Quota Governance</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Group access control, rate limits, spending caps (USD), and model permissions per team.
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
            Organize users and API keys into dedicated teams with custom rate limits and budget controls.
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
              className={`flex flex-col justify-between transition-all duration-200 hover:border-primary/50 ${
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

                {team.description && (
                  <p className="text-xs text-muted-foreground mt-3 line-clamp-2">
                    {team.description}
                  </p>
                )}

                {/* Quota & Limits Badges */}
                <div className="flex flex-wrap gap-1.5 mt-4">
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

                {/* Models Policy */}
                <div className="mt-4 pt-3 border-t border-border/50 text-xs">
                  <span className="text-muted-foreground">Allowed Models: </span>
                  <span className="font-medium text-foreground">
                    {Array.isArray(team.allowedModels) && team.allowedModels.length
                      ? team.allowedModels.join(", ")
                      : "All models (*)"}
                  </span>
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
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Team Name <span className="text-destructive">*</span>
              </label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. Core Engineering, VIP Agents"
                required
                className="mt-1.5"
              />
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

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Allowed Models (comma separated)
              </label>
              <Input
                value={formData.allowedModels}
                onChange={(e) => setFormData({ ...formData, allowedModels: e.target.value })}
                placeholder="Leave blank for all models (*)"
                className="mt-1.5 font-mono text-xs"
              />
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
