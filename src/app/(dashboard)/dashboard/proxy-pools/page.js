"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Badge, Button, Card, CardSkeleton, Input, Modal, Pagination, ProgressCard, Toggle, ConfirmModal } from "@/shared/components";
import { cn } from "@/shared/utils/cn";
import { useNotificationStore } from "@/store/notificationStore";
import { useTaskStore } from "@/store/taskStore";
import {
  startProxyImportJob,
  pollProxyImportJob,
  cancelProxyImportJob,
  readStoredJob,
  writeStoredJob,
} from "@/shared/utils/proxyImportClient";
import {
  startDashboardJob,
  pollDashboardJob,
  cancelDashboardJob,
  fetchDashboardJob,
  readStoredDashboardJob,
  clearStoredDashboardJob,
} from "@/shared/utils/dashboardJobsClient";

// One task id for the batch import
const PROXY_IMPORT_TASK = "proxy-pools-import";

// One task id per operation kind
const dashboardTaskId = (kind) => `dashboard-job-${kind}`;

const followDashboardJob = async (kind, jobId, { title, pollMs = 1000, onFinal }) => {
  const taskId = dashboardTaskId(kind);
  useTaskStore.getState().start({
    id: taskId,
    title,
    message: "Starting",
    progress: 0,
    onCancel: () => cancelDashboardJob(jobId),
  });
  try {
    const final = await pollDashboardJob(
      jobId,
      (job) => {
        useTaskStore.getState().update(taskId, {
          message: job.message || "",
          progress: typeof job.progress === "number" ? job.progress : 0,
        });
      },
      { pollMs }
    );
    if (final) onFinal?.(final);
  } finally {
    useTaskStore.getState().finish(taskId);
  }
};

function getStatusVariant(status) {
  if (status === "active") return "success";
  if (status === "error") return "error";
  return "default";
}

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

function normalizeFormData(data = {}) {
  return {
    name: data.name || "",
    proxyUrl: data.proxyUrl || "",
    noProxy: data.noProxy || "",
    isActive: data.isActive !== false,
    strictProxy: data.strictProxy === true,
  };
}

export default function ProxyPoolsPage() {
  const [proxyPools, setProxyPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showFormModal, setShowFormModal] = useState(false);
  const [showBatchImportModal, setShowBatchImportModal] = useState(false);
  const [showVercelModal, setShowVercelModal] = useState(false);
  const [showCloudflareModal, setShowCloudflareModal] = useState(false);
  const [showDenoModal, setShowDenoModal] = useState(false);
  const [showNetlifyModal, setShowNetlifyModal] = useState(false);
  const [showRelayMenu, setShowRelayMenu] = useState(false);
  const [editingProxyPool, setEditingProxyPool] = useState(null);
  const [formData, setFormData] = useState(normalizeFormData());
  const [batchImportText, setBatchImportText] = useState("");
  const [importProgress, setImportProgress] = useState(null);
  const [vercelForm, setVercelForm] = useState({ vercelToken: "", projectName: "vercel-relay" });
  const [cloudflareForm, setCloudflareForm] = useState({ accountId: "", apiToken: "", projectName: "cloudflare-relay" });
  const [denoForm, setDenoForm] = useState({ denoToken: "", orgDomain: "", projectName: "" });
  const [netlifyForm, setNetlifyForm] = useState({ netlifyToken: "", projectName: "netlify-relay" });
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(() =>
    useTaskStore.getState().tasks.some((t) => t.id === PROXY_IMPORT_TASK)
  );
  const importAbortRef = useRef(null);
  const [deploying, setDeploying] = useState(false);
  const [deployLabel, setDeployLabel] = useState(null);
  const [testingId, setTestingId] = useState(null);
  const [harvesting, setHarvesting] = useState(false);
  const [harvestTarget, setHarvestTarget] = useState(5);
  const [harvestLoopMinutes, setHarvestLoopMinutes] = useState(15);
  const [harvestStatus, setHarvestStatus] = useState(null);
  const [autoScanActive, setAutoScanActive] = useState(false);
  const [autoScanInterval, setAutoScanInterval] = useState(1);
  const [autoScanStatus, setAutoScanStatus] = useState(null);
  const [pruningDead, setPruningDead] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  // Search/filter/pagination
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState("all");
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthProgress, setHealthProgress] = useState({ current: 0, total: 0 });
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmState, setConfirmState] = useState(null);
  const relayMenuRef = useRef(null);
  const notify = useNotificationStore();

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (relayMenuRef.current && !relayMenuRef.current.contains(e.target)) {
        setShowRelayMenu(false);
      }
    };
    if (showRelayMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showRelayMenu]);

  const fetchProxyPools = useCallback(async () => {
    try {
      const res = await fetch("/api/proxy-pools?includeUsage=true", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setProxyPools(data.proxyPools || []);
      }
    } catch (error) {
      console.log("Error fetching proxy pools:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProxyPools();
  }, [fetchProxyPools]);

  const resetForm = () => {
    setEditingProxyPool(null);
    setFormData(normalizeFormData());
  };

  const openCreateModal = () => {
    resetForm();
    setShowFormModal(true);
  };

  const openEditModal = (proxyPool) => {
    setEditingProxyPool(proxyPool);
    setFormData(normalizeFormData(proxyPool));
    setShowFormModal(true);
  };

  const closeFormModal = () => {
    setShowFormModal(false);
    resetForm();
  };

  const handleSave = async () => {
    const payload = {
      name: formData.name.trim(),
      proxyUrl: formData.proxyUrl.trim(),
      noProxy: formData.noProxy.trim(),
      isActive: formData.isActive === true,
      strictProxy: formData.strictProxy === true,
    };

    if (!payload.name || !payload.proxyUrl) return;

    setSaving(true);
    try {
      const isEdit = !!editingProxyPool;
      const res = await fetch(isEdit ? `/api/proxy-pools/${editingProxyPool.id}` : "/api/proxy-pools", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        await fetchProxyPools();
        closeFormModal();
        notify.success(editingProxyPool ? "Proxy pool updated" : "Proxy pool created");
      } else {
        const data = await res.json();
        notify.error(data.error || "Failed to save proxy pool");
      }
    } catch (error) {
      console.log("Error saving proxy pool:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (proxyPool) => {
    setConfirmState({
      title: "Delete Proxy Pool",
      message: `Delete proxy pool "${proxyPool.name}"?`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/proxy-pools/${proxyPool.id}`, { method: "DELETE" });
          if (res.ok) {
            setProxyPools((prev) => prev.filter((item) => item.id !== proxyPool.id));
            notify.success("Proxy pool deleted");
            return;
          }

          const data = await res.json();
          if (res.status === 409) {
            notify.warning(`Cannot delete: ${data.boundConnectionCount || 0} connection(s) are still using this pool.`);
          } else {
            notify.error(data.error || "Failed to delete proxy pool");
          }
        } catch (error) {
          console.log("Error deleting proxy pool:", error);
          notify.error("Failed to delete proxy pool");
        }
      }
    });
  };

  // Poll harvester & auto-scan daemon states
  useEffect(() => {
    let active = true;
    const checkDaemonStatuses = async () => {
      try {
        const [hRes, sRes] = await Promise.all([
          fetch("/api/proxy-pools/harvest"),
          fetch("/api/proxy-pools/auto-scan"),
        ]);
        if (hRes.ok) {
          const hData = await hRes.json();
          if (active) {
            setHarvestStatus(hData);
            setHarvesting(hData.running);
            if (hData.running) {
              if (hData.targetCount) setHarvestTarget(hData.targetCount);
              if (hData.loopIntervalMinutes !== undefined) setHarvestLoopMinutes(hData.loopIntervalMinutes);
            }
          }
        }
        if (sRes.ok) {
          const sData = await sRes.json();
          if (active) {
            setAutoScanStatus(sData);
            setAutoScanActive(sData.running);
            if (sData.running && sData.intervalMinutes) {
              setAutoScanInterval(sData.intervalMinutes);
            }
          }
        }
      } catch {}
    };

    checkDaemonStatuses();
    const interval = setInterval(checkDaemonStatuses, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const handleToggleAutoScan = async () => {
    try {
      if (autoScanActive) {
        const res = await fetch("/api/proxy-pools/auto-scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" }),
        });
        const data = await res.json();
        setAutoScanActive(false);
        setAutoScanStatus(data);
        notify.success("Auto-Scan Pruner stopped");
      } else {
        const res = await fetch("/api/proxy-pools/auto-scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interval: Number(autoScanInterval) || 1 }),
        });
        const data = await res.json();
        if (!res.ok) {
          notify.error(data.error || "Failed to start auto scanner");
          return;
        }
        setAutoScanActive(true);
        setAutoScanStatus(data);
        notify.success(data.message || "Auto-Scan Pruner active in background");
      }
      setTimeout(() => fetchProxyPools(), 2500);
    } catch (err) {
      console.error("Auto scan toggle error:", err);
      notify.error(err?.message || "Error toggling auto-scanner");
    }
  };

  const handleToggleHarvest = async () => {
    try {
      if (harvesting) {
        // Stop harvester
        const res = await fetch("/api/proxy-pools/harvest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" }),
        });
        const data = await res.json();
        setHarvesting(false);
        setHarvestStatus(data);
        notify.success("Auto Harvester stopped");
      } else {
        // Start harvester with configured target & loop interval
        const res = await fetch("/api/proxy-pools/harvest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            target: Number(harvestTarget) || 5,
            loopMinutes: Number(harvestLoopMinutes) || 0,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          notify.error(data.error || "Failed to start harvester");
          return;
        }
        setHarvesting(true);
        setHarvestStatus(data);
        notify.success(data.message || "Harvester started in background");
      }
      setTimeout(() => fetchProxyPools(), 2500);
    } catch (err) {
      notify.error("Error toggling harvester");
    }
  };

  const handlePruneDeadProxies = async () => {
    setPruningDead(true);
    try {
      const res = await fetch("/api/proxy-pools/prune-dead", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        notify.error(data.error || "Failed to prune dead proxies");
        return;
      }
      await fetchProxyPools();
      notify.success(data.message || `Pruned ${data.deletedCount || 0} dead proxies`);
    } catch (err) {
      notify.error("Error pruning dead proxies");
    } finally {
      setPruningDead(false);
    }
  };

  const handleTest = async (proxyPoolId) => {
    setTestingId(proxyPoolId);
    try {
      const res = await fetch(`/api/proxy-pools/${proxyPoolId}/test`, { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        notify.error(data.error || "Failed to test proxy");
        return;
      }

      await fetchProxyPools();
      notify.success(data.ok ? "Proxy test passed" : "Proxy test failed");
    } catch (error) {
      console.log("Error testing proxy pool:", error);
      notify.error("Failed to test proxy");
    } finally {
      setTestingId(null);
    }
  };

  const handleToggleActive = async (pool) => {
    const next = !pool.isActive;
    setProxyPools((prev) => prev.map((p) => p.id === pool.id ? { ...p, isActive: next } : p));
    try {
      const res = await fetch(`/api/proxy-pools/${pool.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      });
      if (!res.ok) {
        setProxyPools((prev) => prev.map((p) => p.id === pool.id ? { ...p, isActive: pool.isActive } : p));
        notify.error("Failed to update active state");
      }
    } catch (error) {
      console.log("Error toggling active:", error);
      setProxyPools((prev) => prev.map((p) => p.id === pool.id ? { ...p, isActive: pool.isActive } : p));
    }
  };

  const toggleSelect = (id) => setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  const filteredPools = useMemo(() => {
    const q = search.trim().toLowerCase();
    return proxyPools.filter((pool) => {
      if (statusFilter === "active" && pool.isActive !== true) return false;
      if (statusFilter === "inactive" && pool.isActive === true) return false;
      if (statusFilter === "unbound" && (pool.boundConnectionCount || 0) > 0) return false;
      if (!q) return true;
      return (
        String(pool.name || "").toLowerCase().includes(q) ||
        String(pool.proxyUrl || "").toLowerCase().includes(q)
      );
    });
  }, [proxyPools, search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredPools.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visiblePools = useMemo(
    () => filteredPools.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredPools, safePage, pageSize]
  );

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, pageSize]);

  const allSelected =
    filteredPools.length > 0 && filteredPools.every((p) => selectedIds.includes(p.id));

  const toggleSelectAll = () => setSelectedIds(allSelected ? [] : filteredPools.map((p) => p.id));
  const clearSelection = () => setSelectedIds([]);

  const bulkSetActive = async (isActive) => {
    const targets = selectedIds.length > 0 ? selectedIds : proxyPools.map((p) => p.id);
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await fetch("/api/proxy-pools/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: targets, isActive }),
      });
      if (res.ok) {
        setProxyPools((prev) =>
          prev.map((p) => (targets.includes(p.id) ? { ...p, isActive } : p))
        );
        notify.success(`${isActive ? "Activated" : "Deactivated"} ${targets.length} proxy pool(s)`);
      } else {
        notify.error("Failed to update proxy pools");
      }
    } catch {
      notify.error("Failed to update proxy pools");
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setConfirmState({
      title: "Delete Proxy Pools",
      message: `Delete ${selectedIds.length} proxy pool(s)?`,
      onConfirm: async () => {
        setConfirmState(null);
        setBulkBusy(true);
        try {
          const res = await fetch("/api/proxy-pools/bulk", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: selectedIds }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            const deletedSet = new Set(data.deleted || selectedIds);
            setProxyPools((prev) => prev.filter((p) => !deletedSet.has(p.id)));
            clearSelection();
            notify.success(`Deleted ${data.deletedCount ?? selectedIds.length} proxy pool(s)`);
          } else if (res.status === 409) {
            notify.warning(`Cannot delete: ${data.boundConnectionCount || "some"} proxy pool(s) are in use by provider connections.`);
          } else {
            notify.error(data.error || "Failed to delete proxy pools");
          }
        } catch {
          notify.error("Failed to delete proxy pools");
        } finally {
          setBulkBusy(false);
        }
      }
    });
  };

  const handleHealthCheck = async () => {
    const targets = selectedIds.length > 0
      ? proxyPools.filter((p) => selectedIds.includes(p.id))
      : proxyPools;
    if (targets.length === 0) return;

    setHealthChecking(true);
    setHealthProgress({ current: 0, total: targets.length });

    try {
      const { jobId, pollMs } = await startDashboardJob(
        "health-check",
        { poolIds: targets.map((p) => p.id) },
        "Health check"
      );
      await followDashboardJob("health-check", jobId, {
        title: "Health check",
        pollMs,
        onFinal: (job) => {
          if (job.status === "cancelled") {
            notify.info(job.message || "Health check stopped");
            return;
          }
          if (job.status !== "done") {
            notify.error(job.error || job.message || "Health check failed");
            return;
          }
          const deadIds = job.result?.deadIds || [];
          if (deadIds.length > 0) {
            setConfirmState({
              title: "Disable Dead Proxies",
              message: `Alive: ${job.result.alive}, Dead: ${deadIds.length}.\n\nDisable ${deadIds.length} dead proxies?`,
              onConfirm: async () => {
                setConfirmState(null);
                setBulkBusy(true);
                try {
                  for (const id of deadIds) {
                    try {
                      await fetch(`/api/proxy-pools/${id}`, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ isActive: false }),
                      });
                    } catch {}
                  }
                  await fetchProxyPools();
                  notify.success(`Disabled ${deadIds.length} dead proxies`);
                } finally {
                  setBulkBusy(false);
                }
              },
            });
          } else {
            notify.success(job.message || "Health check done");
          }
        },
      });
    } catch (error) {
      notify.error(error?.message || "Could not start the health check");
    } finally {
      await fetchProxyPools();
      setHealthChecking(false);
      setHealthProgress({ current: 0, total: 0 });
    }
  };

  // Cleanup selectedIds when pools change
  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => proxyPools.some((p) => p.id === id)));
  }, [proxyPools]);

  const openBatchImportModal = () => {
    setBatchImportText("");
    setShowBatchImportModal(true);
  };

  const closeBatchImportModal = () => {
    setShowBatchImportModal(false);
  };

  const openVercelModal = () => {
    setVercelForm({ vercelToken: "", projectName: "vercel-relay" });
    setShowVercelModal(true);
  };

  const closeVercelModal = () => {
    setShowVercelModal(false);
  };

  const openCloudflareModal = () => {
    setCloudflareForm({ accountId: "", apiToken: "", projectName: "cloudflare-relay" });
    setShowCloudflareModal(true);
  };

  const closeCloudflareModal = () => {
    setShowCloudflareModal(false);
  };

  const openDenoModal = () => {
    setDenoForm({ denoToken: "", orgDomain: "", projectName: "" });
    setShowDenoModal(true);
  };

  const closeDenoModal = () => {
    setShowDenoModal(false);
  };

  const handleVercelDeploy = async () => {
    if (!vercelForm.vercelToken.trim()) return;
    setDeployLabel("Deploying Vercel Relay");
    setDeploying(true);
    try {
      const res = await fetch("/api/proxy-pools/vercel-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vercelForm),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchProxyPools();
        closeVercelModal();
        notify.success(`Deployed: ${data.deployUrl}`);
      } else {
        notify.error(data.error || "Deploy failed");
      }
    } catch (error) {
      console.log("Error deploying Vercel relay:", error);
      notify.error("Deploy failed");
    } finally {
      setDeploying(false);
      setDeployLabel(null);
    }
  };

  const handleCloudflareDeploy = async () => {
    if (!cloudflareForm.accountId.trim() || !cloudflareForm.apiToken.trim()) return;
    setDeployLabel("Deploying Cloudflare Worker");
    setDeploying(true);
    try {
      const res = await fetch("/api/proxy-pools/cloudflare-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cloudflareForm),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchProxyPools();
        closeCloudflareModal();
        notify.success(`Deployed: ${data.deployUrl}`);
      } else {
        notify.error(data.error || "Deploy failed");
      }
    } catch (error) {
      console.log("Error deploying Cloudflare relay:", error);
      notify.error("Deploy failed");
    } finally {
      setDeploying(false);
      setDeployLabel(null);
    }
  };

  const handleDenoDeploy = async () => {
    if (!denoForm.denoToken.trim()) return;
    setDeployLabel("Deploying Deno Relay");
    setDeploying(true);
    try {
      const res = await fetch("/api/proxy-pools/deno-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(denoForm),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchProxyPools();
        closeDenoModal();
        notify.success(`Deployed: ${data.deployUrl}`);
      } else {
        notify.error(data.error || "Deploy failed");
      }
    } catch (error) {
      console.log("Error deploying Deno relay:", error);
      notify.error("Deploy failed");
    } finally {
      setDeploying(false);
      setDeployLabel(null);
    }
  };

  const openNetlifyModal = () => {
    setNetlifyForm({ netlifyToken: "", projectName: "netlify-relay" });
    setShowNetlifyModal(true);
  };

  const closeNetlifyModal = () => {
    setShowNetlifyModal(false);
  };

  const handleNetlifyDeploy = async () => {
    if (!netlifyForm.netlifyToken.trim()) return;
    setDeployLabel("Deploying Netlify Relay");
    setDeploying(true);
    try {
      const res = await fetch("/api/proxy-pools/netlify-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(netlifyForm),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchProxyPools();
        closeNetlifyModal();
        notify.success(`Deployed: ${data.deployUrl}`);
      } else {
        notify.error(data.error || "Deploy failed");
      }
    } catch (error) {
      console.log("Error deploying Netlify relay:", error);
      notify.error("Deploy failed");
    } finally {
      setDeploying(false);
      setDeployLabel(null);
    }
  };

  const parseProxyLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return null;

    if (trimmed.includes("://")) {
      const parsed = new URL(trimmed);
      const hostLabel = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      return {
        proxyUrl: parsed.toString(),
        name: `Imported ${hostLabel}`,
      };
    }

    const parts = trimmed.split(":");
    if (parts.length === 4) {
      const [host, port, username, password] = parts;
      if (!host || !port || !username || !password) {
        throw new Error("Invalid host:port:user:pass format");
      }

      const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
      const parsed = new URL(proxyUrl);
      return {
        proxyUrl: parsed.toString(),
        name: `Imported ${host}:${port}`,
      };
    }

    throw new Error("Unsupported format");
  };

  const handleBatchImport = async () => {
    const lines = batchImportText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      notify.warning("Please paste at least one proxy line.");
      return;
    }

    const parsedEntries = [];
    const invalidLines = [];

    lines.forEach((line, index) => {
      try {
        const parsed = parseProxyLine(line);
        if (parsed) {
          parsedEntries.push({
            ...parsed,
            lineNumber: index + 1,
          });
        }
      } catch (error) {
        invalidLines.push(`Line ${index + 1}: ${error.message}`);
      }
    });

    if (invalidLines.length > 0) {
      notify.error(`Invalid proxy format:\n${invalidLines.join("\n")}`);
      return;
    }

    setImporting(true);
    setImportProgress({ done: 0, total: parsedEntries.length });
    setShowBatchImportModal(false);

    const total = parsedEntries.length;
    try {
      const { jobId, pollMs } = await startProxyImportJob(parsedEntries);
      writeStoredJob(jobId, total);
      importAbortRef.current = jobId;
      useTaskStore.getState().start({
        id: PROXY_IMPORT_TASK,
        title: "Importing proxies",
        message: `0/${total} proxies`,
        progress: 0,
        onCancel: () => cancelProxyImportJob(jobId),
      });

      const final = await pollProxyImportJob(
        jobId,
        (job) => {
          setImportProgress({
            done: job.counts?.processed ?? 0,
            total,
          });
          useTaskStore.getState().update(PROXY_IMPORT_TASK, {
            message: job.message || `${job.counts?.processed ?? 0}/${total} proxies`,
            progress: Number(job.progress) || 0,
          });
        },
        { pollMs }
      );

      if (final?.status === "done") {
        await fetchProxyPools();
        notify.success(final.message || "Batch import completed");
      } else if (final?.status === "cancelled") {
        await fetchProxyPools();
        notify.info(final.message || "Batch import stopped");
      } else if (final?.status === "error") {
        notify.error(final.error || final.message || "Batch import failed");
      }
    } catch (error) {
      console.log("Error starting proxy import:", error);
      notify.error(error?.message || "Batch import failed");
    } finally {
      useTaskStore.getState().finish(PROXY_IMPORT_TASK);
      importAbortRef.current = null;
      setImporting(false);
      setImportProgress(null);
    }
  };

  const activeCount = useMemo(
    () => proxyPools.filter((pool) => pool.isActive === true).length,
    [proxyPools]
  );

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
      {/* Header bar: Title & Primary Action */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold sm:text-2xl">Proxy Pools</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative" ref={relayMenuRef}>
            <Button
              size="sm"
              variant="secondary"
              icon="rocket_launch"
              onClick={() => setShowRelayMenu(!showRelayMenu)}
            >
              Deploy Relay
              <span className="material-symbols-outlined ml-1 text-[18px]">
                {showRelayMenu ? "expand_less" : "expand_more"}
              </span>
            </Button>

            {showRelayMenu && (
              <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-[6px] border border-border bg-surface p-1 shadow-[var(--shadow-elev)] dark:border-border dark:bg-surface-2 sm:left-auto sm:right-0">
                <button
                  onClick={() => {
                    openCloudflareModal();
                    setShowRelayMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-2 dark:hover:bg-surface-2"
                >
                  <span className="material-symbols-outlined text-[20px] text-warning">cloud</span>
                  Cloudflare Relay
                </button>
                <button
                  onClick={() => {
                    openVercelModal();
                    setShowRelayMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-2 dark:hover:bg-surface-2"
                >
                  <span className="material-symbols-outlined text-[20px] text-info">cloud_upload</span>
                  Vercel Relay
                </button>
                <button
                  onClick={() => {
                    openDenoModal();
                    setShowRelayMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-2 dark:hover:bg-surface-2"
                >
                  <span className="material-symbols-outlined text-[20px] text-success">terminal</span>
                  Deno Relay
                </button>
                <button
                  onClick={() => {
                    openNetlifyModal();
                    setShowRelayMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-surface-2 dark:hover:bg-surface-2"
                >
                  <span className="material-symbols-outlined text-[20px] text-teal-500">deployed_code</span>
                  Netlify Relay
                </button>
              </div>
            )}
          </div>

          <Button
            size="sm"
            variant="secondary"
            icon="mop"
            loading={pruningDead}
            onClick={handlePruneDeadProxies}
            title="Prune dead or failed proxies that are not in use"
          >
            {pruningDead ? "Cleaning..." : "Clean Dead"}
          </Button>

          <Button size="sm" variant="secondary" icon="upload" onClick={openBatchImportModal}>
            Batch Import
          </Button>

          <Button size="sm" icon="add" onClick={openCreateModal}>
            Add Proxy Pool
          </Button>
        </div>
      </div>

      {/* Dedicated Harvester Tier (Bertingkat: Rapih & Lega) */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2/60 p-3 sm:flex-row sm:items-center sm:justify-between shadow-xs">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-[6px] border border-primary/30 bg-primary/10 text-primary">
            <span className="material-symbols-outlined text-[19px]">sensors</span>
          </div>
          <div className="min-w-0 flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-text-main tracking-tight">Auto-Harvester Engine</span>
              <span className={cn(
                "inline-flex items-center gap-1 rounded-full px-1.5 py-0.2 text-[10px] font-mono font-medium",
                harvesting ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" : "bg-surface-3 text-text-muted"
              )}>
                <span className={cn("size-1.5 rounded-full shrink-0", harvesting ? "bg-emerald-400 animate-pulse" : "bg-text-subtle")} />
                {harvesting ? "ACTIVE" : "IDLE"}
              </span>
            </div>
            <span className="text-[11px] text-text-muted truncate">
              {harvestStatus?.lastMessage || "Scrapes fast pre-verified HTTP/HTTPS proxies from upstream feeds"}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0 pt-2 sm:pt-0 border-t border-border/50 sm:border-t-0">
          <div className="flex items-center gap-1.5 rounded-[6px] border border-border bg-surface px-2 py-1 text-xs">
            <label className="text-text-muted font-mono text-[11px]">Target:</label>
            <input
              type="number"
              min="1"
              max="200"
              value={harvestTarget}
              onChange={(e) => setHarvestTarget(e.target.value)}
              disabled={harvesting}
              className="w-12 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-center font-mono text-xs text-text-main focus:border-primary focus:outline-none"
              title="Target number of live proxies to collect"
            />
          </div>

          <div className="flex items-center gap-1.5 rounded-[6px] border border-border bg-surface px-2 py-1 text-xs">
            <label className="text-text-muted font-mono text-[11px]">Loop:</label>
            <select
              value={harvestLoopMinutes}
              onChange={(e) => setHarvestLoopMinutes(Number(e.target.value))}
              disabled={harvesting}
              className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text-main focus:border-primary focus:outline-none cursor-pointer"
              title="Background repeating harvest cycle"
            >
              <option value={0}>Off (Once)</option>
              <option value={2}>Every 2m (Aggressive)</option>
              <option value={5}>Every 5m (Fast)</option>
              <option value={15}>Every 15m</option>
              <option value={30}>Every 30m</option>
              <option value={60}>Every 1h</option>
            </select>
          </div>

          <Button
            size="sm"
            variant={harvesting ? "danger" : "primary"}
            icon={harvesting ? "stop_circle" : "play_arrow"}
            onClick={handleToggleHarvest}
            className={harvesting ? "bg-red-500/20 text-red-400 border-red-500/40 hover:bg-red-500/30" : ""}
            title={harvesting ? "Stop background harvester" : "Start background harvest"}
          >
            {harvesting ? "Stop" : "Harvest"}
          </Button>
        </div>
      </div>

      {/* Dedicated Auto-Scan Pruner Tier (Auto-delete dead proxies in background) */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2/60 p-3 sm:flex-row sm:items-center sm:justify-between shadow-xs">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-[6px] border border-warning/30 bg-warning/10 text-warning">
            <span className="material-symbols-outlined text-[19px]">mop</span>
          </div>
          <div className="min-w-0 flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-text-main tracking-tight">Auto-Scan Dead Pruner</span>
              <span className={cn(
                "inline-flex items-center gap-1 rounded-full px-1.5 py-0.2 text-[10px] font-mono font-medium",
                autoScanActive ? "bg-amber-500/15 text-amber-400 border border-amber-500/30" : "bg-surface-3 text-text-muted"
              )}>
                <span className={cn("size-1.5 rounded-full shrink-0", autoScanActive ? "bg-amber-400 animate-pulse" : "bg-text-subtle")} />
                {autoScanActive ? "WATCHING" : "IDLE"}
              </span>
            </div>
            <span className="text-[11px] text-text-muted truncate">
              {autoScanStatus?.lastMessage || "Background worker probes health and auto-deletes dead proxies"}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0 pt-2 sm:pt-0 border-t border-border/50 sm:border-t-0">
          <div className="flex items-center gap-1.5 rounded-[6px] border border-border bg-surface px-2 py-1 text-xs">
            <label className="text-text-muted font-mono text-[11px]">Interval:</label>
            <select
              value={autoScanInterval}
              onChange={(e) => setAutoScanInterval(Number(e.target.value))}
              disabled={autoScanActive}
              className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text-main focus:border-primary focus:outline-none cursor-pointer"
              title="Auto-scan repeat interval"
            >
              <option value={1}>Every 1 min</option>
              <option value={2}>Every 2 min</option>
              <option value={5}>Every 5 min</option>
              <option value={15}>Every 15 min</option>
              <option value={30}>Every 30 min</option>
            </select>
          </div>

          <Button
            size="sm"
            variant={autoScanActive ? "danger" : "secondary"}
            icon={autoScanActive ? "stop_circle" : "sync"}
            onClick={handleToggleAutoScan}
            className={autoScanActive ? "bg-red-500/20 text-red-400 border-red-500/40 hover:bg-red-500/30" : ""}
            title={autoScanActive ? "Stop background auto-scan" : "Start background auto-scan"}
          >
            {autoScanActive ? "Stop Scan" : "Start Auto-Scan"}
          </Button>
        </div>
      </div>

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {proxyPools.length > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="size-4 rounded border-border"
              />
              {allSelected ? "Unselect all" : "Select all"}
            </label>
          )}
          <Badge variant="default">Total: {proxyPools.length}</Badge>
          <Badge variant="success">Active: {activeCount}</Badge>
        </div>

        {(selectedIds.length > 0 || healthChecking) && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
            <span className="material-symbols-outlined text-[18px] text-primary">checklist</span>
            <span className="text-xs font-medium text-primary">
              {selectedIds.length > 0 ? `${selectedIds.length} selected` : "All pools"}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                icon={healthChecking ? "progress_activity" : "health_and_safety"}
                onClick={handleHealthCheck}
                disabled={healthChecking || bulkBusy || proxyPools.length === 0}
              >
                {healthChecking ? `Checking ${healthProgress.current}/${healthProgress.total}` : "Health Check"}
              </Button>
              {selectedIds.length > 0 && (
                <>
                  <Button size="sm" variant="secondary" icon="toggle_on" onClick={() => bulkSetActive(true)} disabled={bulkBusy || healthChecking}>
                    Activate
                  </Button>
                  <Button size="sm" variant="secondary" icon="toggle_off" onClick={() => bulkSetActive(false)} disabled={bulkBusy || healthChecking}>
                    Deactivate
                  </Button>
                  <Button size="sm" variant="secondary" icon="delete" onClick={bulkDelete} disabled={bulkBusy || healthChecking}>
                    Delete
                  </Button>
                  <Button size="sm" variant="ghost" onClick={clearSelection} disabled={bulkBusy || healthChecking}>
                    Clear
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {proxyPools.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-text-main font-medium mb-1">No proxy pool entries yet</p>
            <p className="text-sm text-text-muted mb-4">
              Create a proxy pool entry, then assign it to connections.
            </p>
            <Button icon="add" onClick={openCreateModal}>Add Proxy Pool</Button>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-black/[0.04] dark:divide-white/[0.05]">
            {proxyPools.map((pool) => (
              <div key={pool.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(pool.id)}
                    onChange={() => toggleSelect(pool.id)}
                    className="mt-1 size-4 shrink-0 rounded border-border"
                  />
                  <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="min-w-0 max-w-full truncate text-sm font-medium sm:max-w-[18rem]">{pool.name}</p>
                    <Badge variant={getStatusVariant(pool.testStatus)} size="sm" dot>
                      {pool.testStatus || "unknown"}
                    </Badge>
                    <Badge variant={pool.isActive ? "success" : "default"} size="sm">
                      {pool.isActive ? "active" : "inactive"}
                    </Badge>
                    {pool.type === "vercel" && (
                      <Badge variant="default" size="sm">vercel relay</Badge>
                    )}
                    {pool.type === "cloudflare" && (
                      <Badge variant="default" size="sm">cloudflare relay</Badge>
                    )}
                    {pool.type === "deno" && (
                      <Badge variant="default" size="sm">deno relay</Badge>
                    )}
                    {pool.type === "netlify" && (
                      <Badge variant="default" size="sm">netlify relay</Badge>
                    )}
                    <Badge variant="default" size="sm">
                      {pool.boundConnectionCount || 0} bound
                    </Badge>
                  </div>
                  <p className="text-xs text-text-muted truncate mt-1">{pool.proxyUrl}</p>
                  {pool.noProxy ? (
                    <p className="text-xs text-text-muted truncate">No proxy: {pool.noProxy}</p>
                  ) : null}
                  <p className="text-[11px] text-text-muted mt-1">
                    Last tested: {formatDateTime(pool.lastTestedAt)}
                    {pool.lastError ? ` · ${pool.lastError}` : ""}
                  </p>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-1">
                  <Toggle
                    size="sm"
                    checked={pool.isActive === true}
                    onChange={() => handleToggleActive(pool)}
                    title={pool.isActive ? "Disable" : "Enable"}
                  />
                  <button
                    onClick={() => handleTest(pool.id)}
                    className="p-2 rounded hover:bg-surface-2 dark:hover:bg-surface-2 text-text-muted hover:text-primary"
                    title="Test proxy"
                    disabled={testingId === pool.id}
                  >
                    <span
                      className="material-symbols-outlined text-[18px]"
                      style={testingId === pool.id ? { animation: "spin 1s linear infinite" } : undefined}
                    >
                      {testingId === pool.id ? "progress_activity" : "science"}
                    </span>
                  </button>
                  <button
                    onClick={() => openEditModal(pool)}
                    className="p-2 rounded hover:bg-surface-2 dark:hover:bg-surface-2 text-text-muted hover:text-primary"
                    title="Edit"
                  >
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                  <button
                    onClick={() => handleDelete(pool)}
                    className="p-2 rounded hover:bg-danger-bg text-danger"
                    title="Delete"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {deploying && (
        <ProgressCard
          title={deployLabel || "Deploying relay"}
          message="Pushing worker build to the edge, this can take about a minute"
          section="Do not close this tab"
        />
      )}

      <Modal
        isOpen={showBatchImportModal}
        title="Batch Import Proxies"
        onClose={closeBatchImportModal}
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="text-sm font-medium text-text-main mb-1 block">Paste Proxy List (One per line)</label>
            <textarea
              value={batchImportText}
              onChange={(e) => setBatchImportText(e.target.value)}
              placeholder={"http://user:pass@127.0.0.1:7897\n127.0.0.1:7897:user:pass"}
              className="w-full min-h-[180px] py-2 px-3 text-sm text-text-main bg-surface dark:bg-surface-2 border border-border rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
            />
            <p className="text-xs text-text-muted mt-1">
              Supported formats: protocol://user:pass@host:port, host:port:user:pass
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button fullWidth onClick={handleBatchImport} disabled={!batchImportText.trim() || importing}>
              Import
            </Button>
            <Button fullWidth variant="ghost" onClick={closeBatchImportModal} disabled={importing}>
              Cancel
            </Button>
          </div>
        </div>

        {importing && (
          <ProgressCard
            fixed={false}
            title="Importing proxies"
            message={
              importProgress
                ? `${importProgress.done}/${importProgress.total} proxies`
                : "Validating proxy list"
            }
            progress={
              importProgress && importProgress.total > 0
                ? Math.round((importProgress.done / importProgress.total) * 100)
                : null
            }
          />
        )}
      </Modal>

      <Modal
        isOpen={showVercelModal}
        title="Deploy Vercel Relay"
        onClose={closeVercelModal}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-info-bg border border-info-border p-3 flex flex-col gap-1.5">
            <p className="text-sm text-text-main font-medium">What is Vercel Relay?</p>
            <p className="text-xs text-text-muted">
              Forwards all AI provider requests through Vercel&apos;s edge network so your real IP stays hidden.
            </p>
            <ul className="text-xs text-text-muted list-disc pl-4 space-y-0.5">
              <li>Your IP is replaced by Vercel&apos;s dynamic edge IPs (hundreds of IPs across 20+ global regions)</li>
              <li>Vercel serves millions of apps — providers can&apos;t block Vercel IPs without affecting legitimate traffic</li>
              <li>Free tier: 100GB bandwidth/month, 500K edge invocations</li>
              <li>Deploy multiple relays on different accounts for more IP diversity</li>
            </ul>
          </div>
          <Input
            label="Vercel API Token"
            value={vercelForm.vercelToken}
            onChange={(e) => setVercelForm((prev) => ({ ...prev, vercelToken: e.target.value }))}
            placeholder="your-vercel-api-token"
            hint={<>Token is used once for deployment and not stored. <a href="https://vercel.com/account/tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Get token →</a></>}
            type="password"
          />
          <Input
            label="Project Name"
            value={vercelForm.projectName}
            onChange={(e) => setVercelForm((prev) => ({ ...prev, projectName: e.target.value }))}
            placeholder="my-relay"
            hint="Name for your Vercel project (leave empty to auto-generate)"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleVercelDeploy}
              disabled={!vercelForm.vercelToken.trim() || deploying}
            >
              Deploy
            </Button>
            <Button fullWidth variant="ghost" onClick={closeVercelModal} disabled={deploying}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showCloudflareModal}
        title="Deploy Cloudflare Relay"
        onClose={closeCloudflareModal}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-warning-bg border border-warning-border p-3 flex flex-col gap-1.5">
            <p className="text-sm text-text-main font-medium">What is Cloudflare Relay?</p>
            <p className="text-xs text-text-muted">
              Forwards all AI provider requests through Cloudflare&apos;s global edge network.
            </p>
            <ul className="text-xs text-text-muted list-disc pl-4 space-y-0.5">
              <li>High performance global routing and IP masking via Cloudflare Workers</li>
              <li>Free tier: 100,000 requests per day</li>
              <li>Requires Cloudflare Account ID and a Workers API Token (Edit Workers permission)</li>
            </ul>
            <div className="mt-2 pt-2 border-t border-warning-border text-xs text-text-muted">
              <p className="font-medium text-text-main mb-1">How to generate your API Token:</p>
              <ol className="list-decimal pl-4 space-y-0.5">
                <li>Go to <b>My Profile</b> → <b>API Tokens</b> → <b>Create Token</b></li>
                <li>Scroll down to <b>Custom Token</b> and click <b>Get started</b></li>
                <li>Under <b>Permissions</b>: Account | Workers Scripts | Edit</li>
                <li>Under <b>Account Resources</b>: Include | Account | <i>Your Account Name</i></li>
                <li>Click <b>Continue to summary</b> → <b>Create Token</b></li>
              </ol>
            </div>
          </div>
          <Input
            label="Account ID"
            value={cloudflareForm.accountId}
            onChange={(e) => setCloudflareForm((prev) => ({ ...prev, accountId: e.target.value }))}
            placeholder="your-cloudflare-account-id"
            hint={<>Found on the right side of the Cloudflare dashboard overview page.</>}
          />
          <Input
            label="API Token"
            value={cloudflareForm.apiToken}
            onChange={(e) => setCloudflareForm((prev) => ({ ...prev, apiToken: e.target.value }))}
            placeholder="your-cloudflare-api-token"
            hint={<>Requires "Workers Scripts: Edit" permission. <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Get token →</a></>}
            type="password"
          />
          <Input
            label="Worker Name"
            value={cloudflareForm.projectName}
            onChange={(e) => setCloudflareForm((prev) => ({ ...prev, projectName: e.target.value }))}
            placeholder="my-relay"
            hint="Name for your Cloudflare Worker (leave empty to auto-generate)"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleCloudflareDeploy}
              disabled={!cloudflareForm.accountId.trim() || !cloudflareForm.apiToken.trim() || deploying}
            >
              Deploy Worker
            </Button>
            <Button fullWidth variant="ghost" onClick={closeCloudflareModal} disabled={deploying}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showDenoModal}
        title="Deploy Deno Relay"
        onClose={closeDenoModal}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-surface-2 border border-border p-3 flex flex-col gap-1.5">
            <p className="text-sm text-text-main font-medium">What is Deno Relay?</p>
            <p className="text-xs text-text-muted">
              Forwards all AI provider requests through Deno&apos;s global edge network to mask your real IP.
            </p>
            <ul className="text-xs text-text-muted list-disc pl-4 space-y-0.5">
              <li>Deno Deploy v2 runs on a high-performance global edge network</li>
              <li>Free tier: 1M requests & 100GiB outbound traffic per month</li>
              <li>No per-request CPU time limits (unlike Vercel/Cloudflare)</li>
              <li>Support up to 20 active apps & 50 custom domains</li>
              <li>Deploy multiple relays for maximum IP diversity</li>
            </ul>
            <div className="mt-2 pt-2 border-t border-border text-xs text-text-muted">
              <p className="font-medium text-text-main mb-1">How to generate API token:</p>
              <ol className="list-decimal pl-4 space-y-0.5">
                <li>Go to <b>console.deno.com</b></li>
                <li>Select your <b>Organization</b> → <b>Settings</b> → <b>Organization Tokens</b></li>
                <li>Create a <b>Organization Token</b> (prefix <b>ddo_</b>)</li>
              </ol>
            </div>
          </div>
          <Input
            label="Deno Deploy API Token"
            value={denoForm.denoToken}
            onChange={(e) => setDenoForm((prev) => ({ ...prev, denoToken: e.target.value }))}
            placeholder="ddo_xxxxxxxxxxxxxxxx"
            hint={<>Used once for deployment and never stored (found in Organization Settings)</>}
            type="password"
          />
          <Input
            label="Organization Domain"
            value={denoForm.orgDomain}
            onChange={(e) => setDenoForm((prev) => ({ ...prev, orgDomain: e.target.value }))}
            placeholder="your-org.deno.net"
            hint="Organization's default domain. Your relay URL will be in the format: https://my-relay.your-org.deno.net"
          />
          <Input
            label="App Name"
            value={denoForm.projectName}
            onChange={(e) => setDenoForm((prev) => ({ ...prev, projectName: e.target.value }))}
            placeholder="deno-relay"
            hint="App name (leave empty to auto-generate)"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleDenoDeploy}
              disabled={!denoForm.denoToken.trim() || !denoForm.orgDomain.trim() || deploying}
            >
              Deploy Relay
            </Button>
            <Button fullWidth variant="ghost" onClick={closeDenoModal} disabled={deploying}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showNetlifyModal}
        title="Deploy Netlify Relay"
        onClose={closeNetlifyModal}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-surface-2 border border-border p-3 flex flex-col gap-1.5">
            <p className="text-sm text-text-main font-medium">What is Netlify Relay?</p>
            <p className="text-xs text-text-muted">
              Deploys a serverless relay function to Netlify&apos;s global edge network. All AI provider requests are forwarded through Netlify&apos;s edge, masking your real IP.
            </p>
            <ul className="text-xs text-text-muted list-disc pl-4 space-y-0.5">
              <li>Runs on Netlify Functions with a 60-second execution limit and streaming support</li>
              <li>Free tier: 125,000 function invocations and 100GB bandwidth per month</li>
              <li>Relay URL format: https://your-site.netlify.app/.netlify/functions/relay</li>
              <li>Deploy multiple relays on different accounts for more IP diversity</li>
            </ul>
            <div className="mt-2 pt-2 border-t border-border text-xs text-text-muted">
              <p className="font-medium text-text-main mb-1">How to generate API token:</p>
              <ol className="list-decimal pl-4 space-y-0.5">
                <li>Go to <b>User Settings</b> → <b>Applications</b> → <b>Personal access tokens</b></li>
                <li>Select <b>New access token</b> and generate a token</li>
                <li>Copy the token — you won&apos;t see it again after leaving the page</li>
              </ol>
            </div>
          </div>
          <Input
            label="Netlify API Token"
            value={netlifyForm.netlifyToken}
            onChange={(e) => setNetlifyForm((prev) => ({ ...prev, netlifyToken: e.target.value }))}
            placeholder="nfp_xxxxxxxxxxxxxxxx"
            hint={<>Token is used once for deployment and not stored. <a href="https://app.netlify.com/user/applications#personal-access-tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Get token →</a></>}
            type="password"
          />
          <Input
            label="Site Name"
            value={netlifyForm.projectName}
            onChange={(e) => setNetlifyForm((prev) => ({ ...prev, projectName: e.target.value }))}
            placeholder="netlify-relay"
            hint="Unique site name (lowercase letters, numbers, hyphens). Your relay URL will be https://site-name.netlify.app/.netlify/functions/relay"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleNetlifyDeploy}
              disabled={!netlifyForm.netlifyToken.trim() || deploying}
            >
              {deploying ? "Deploying... (may take ~1 min)" : "Deploy"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeNetlifyModal} disabled={deploying}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showFormModal}
        title={editingProxyPool ? "Edit Proxy Pool" : "Add Proxy Pool"}
        onClose={closeFormModal}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            value={formData.name}
            onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="Office Proxy"
          />
          <Input
            label="Proxy URL"
            value={formData.proxyUrl}
            onChange={(e) => setFormData((prev) => ({ ...prev, proxyUrl: e.target.value }))}
            placeholder="http://127.0.0.1:7897"
          />
          <Input
            label="No Proxy"
            value={formData.noProxy}
            onChange={(e) => setFormData((prev) => ({ ...prev, noProxy: e.target.value }))}
            placeholder="localhost,127.0.0.1,.internal"
            hint="Comma-separated hosts/domains to bypass proxy"
          />

          <div className="flex flex-col gap-3 rounded-lg border border-border/50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-sm">Active</p>
              <p className="text-xs text-text-muted">Inactive pools are ignored by runtime resolution.</p>
            </div>
            <Toggle
              checked={formData.isActive === true}
              onChange={() => setFormData((prev) => ({ ...prev, isActive: !prev.isActive }))}
              disabled={saving}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border/50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-sm">Strict Proxy</p>
              <p className="text-xs text-text-muted">Fail request if proxy is unreachable instead of falling back to direct.</p>
            </div>
            <Toggle
              checked={formData.strictProxy === true}
              onChange={() => setFormData((prev) => ({ ...prev, strictProxy: !prev.strictProxy }))}
              disabled={saving}
            />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleSave}
              disabled={!formData.name.trim() || !formData.proxyUrl.trim() || saving}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeFormModal} disabled={saving}>
              Cancel
            </Button>
          </div>
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
    </div>
  );
}
