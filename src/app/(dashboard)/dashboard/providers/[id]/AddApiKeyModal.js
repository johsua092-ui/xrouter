"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Badge, Input, Modal, Select, ProgressCard } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { planBulkAdd } from "@/shared/utils/bulkAdd";

const BULK_PLACEHOLDER = `name1|sk-key1\nname2|sk-key2\nsk-key-only-auto-named`;

export default function AddApiKeyModal({ isOpen, provider, providerName, isCompatible, isAnthropic, authType, authHint, website, proxyPools, error, existingNames, onSave, onBulkDone, onClose }) {
  const NONE_PROXY_POOL_VALUE = "__none__";
  const isOllamaLocal = provider === "ollama-local";
  const isCookie = authType === "cookie";
  const isXaiApiKey = provider === "xai" && !isCookie;
  const isArenaAi = provider === "arena-ai" || provider === "arena";
  const credentialLabel = isArenaAi
    ? "userToken (Session Token)"
    : isCookie
      ? "Cookie Value"
      : provider === "qoder" || provider === "qoder-cn"
        ? "Personal Access Token (PAT)"
        : "API Key";
  const credentialPlaceholder = isArenaAi
    ? "userToken / evaluation_session token value"
    : isCookie
      ? (provider === "deepseek-web" ? "userToken value" : provider === "gemini-web" ? "__Secure-1PSID value" : provider === "kimi-web" ? "access_token value" : "eyJhbGciOi...")
      : (isXaiApiKey ? "xai-..." : provider === "qoder" || provider === "qoder-cn" ? "pt-..." : "");

  const isAzure = provider === "azure";
  const isCloudflareAi = provider === "cloudflare-ai";
  const providerRegions = AI_PROVIDERS?.[provider]?.regions || null;
  const defaultRegion = AI_PROVIDERS?.[provider]?.defaultRegion || providerRegions?.[0]?.id || "";

  const [formData, setFormData] = useState({
    name: "",
    apiKey: "",
    defaultModel: "",
    priority: 1,
    proxyPoolId: NONE_PROXY_POOL_VALUE,
    ollamaHostUrl: "",
  });
  const [azureData, setAzureData] = useState({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState({ accountId: "" });
  const [region, setRegion] = useState(defaultRegion);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [validateError, setValidateError] = useState("");
  const [saving, setSaving] = useState(false);

  // Dual-column states for multi-cookie providers
  const isGeminiWeb = provider === "gemini-web";
  const isGrokWeb = provider === "grok-web";
  const [geminiPsid, setGeminiPsid] = useState("");
  const [geminiPsidts, setGeminiPsidts] = useState("");
  const [grokSso, setGrokSso] = useState("");
  const [grokSsoRw, setGrokSsoRw] = useState("");

  const updateGeminiCookie = (newPsid, newPsidts) => {
    let p1 = String(newPsid || "").trim();
    let p2 = String(newPsidts || "").trim();

    if (p1.includes("__Secure-1PSID=") || p1.includes("__Secure-1PSIDTS=")) {
      const m1 = p1.match(/(?:^|[;\s])__Secure-1PSID=([^;\s]+)/);
      const m2 = p1.match(/(?:^|[;\s])__Secure-1PSIDTS=([^;\s]+)/);
      if (m1) p1 = m1[1];
      if (m2 && !p2) p2 = m2[1];
    }
    if (p2.includes("__Secure-1PSID=") || p2.includes("__Secure-1PSIDTS=")) {
      const m2 = p2.match(/(?:^|[;\s])__Secure-1PSIDTS=([^;\s]+)/);
      const m1 = p2.match(/(?:^|[;\s])__Secure-1PSID=([^;\s]+)/);
      if (m2) p2 = m2[1];
      if (m1 && !p1) p1 = m1[1];
    }

    setGeminiPsid(p1);
    setGeminiPsidts(p2);

    const parts = [];
    if (p1) parts.push(p1.startsWith("__Secure-1PSID=") ? p1 : `__Secure-1PSID=${p1}`);
    if (p2) parts.push(p2.startsWith("__Secure-1PSIDTS=") ? p2 : `__Secure-1PSIDTS=${p2}`);
    setFormData((prev) => ({ ...prev, apiKey: parts.join("; ") }));
  };

  const updateGrokCookie = (newSso, newSsoRw) => {
    let s1 = String(newSso || "").trim();
    let s2 = String(newSsoRw || "").trim();

    if (s1.includes("sso=") || s1.includes("sso-rw=")) {
      const m1 = s1.match(/(?:^|[;\s])sso=([^;\s]+)/);
      const m2 = s1.match(/(?:^|[;\s])sso-rw=([^;\s]+)/);
      if (m1) s1 = m1[1];
      if (m2 && !s2) s2 = m2[1];
    }
    if (s2.includes("sso=") || s2.includes("sso-rw=")) {
      const m2 = s2.match(/(?:^|[;\s])sso-rw=([^;\s]+)/);
      const m1 = s2.match(/(?:^|[;\s])sso=([^;\s]+)/);
      if (m2) s2 = m2[1];
      if (m1 && !s1) s1 = m1[1];
    }

    setGrokSso(s1);
    setGrokSsoRw(s2);

    const parts = [];
    if (s1) parts.push(s1.startsWith("sso=") ? s1 : `sso=${s1}`);
    if (s2) parts.push(s2.startsWith("sso-rw=") ? s2 : `sso-rw=${s2}`);
    setFormData((prev) => ({ ...prev, apiKey: parts.join("; ") }));
  };
  const bulkPlaceholder = isCloudflareAi
    ? `name1|sk-key1|acc123456\nname2|sk-key2|def789012\nsk-key-only-auto-named`
    : provider === "qoder" || provider === "qoder-cn"
      ? `name1|pt-xxxxx\nname2|pt-yyyyy\npt-only-auto-named`
      : BULK_PLACEHOLDER;

  const [mode, setMode] = useState("single"); // "single" | "bulk"
  const [bulkText, setBulkText] = useState("");
  const [bulkResult, setBulkResult] = useState(null); // { success, failed }
  const [bulkProgress, setBulkProgress] = useState(null); // { done, total } while bulk import runs

  const buildProviderSpecificData = () => {
    const data = {};
    if (formData.proxyPoolId && formData.proxyPoolId !== NONE_PROXY_POOL_VALUE) {
      data.connectionProxyPoolId = formData.proxyPoolId;
      data.proxyPoolId = formData.proxyPoolId;
    }
    if (isOllamaLocal && formData.ollamaHostUrl.trim()) {
      data.baseUrl = formData.ollamaHostUrl.trim();
    }
    if (isAzure) {
      Object.assign(data, {
        azureEndpoint: azureData.azureEndpoint,
        apiVersion: azureData.apiVersion,
        deployment: azureData.deployment,
        organization: azureData.organization,
      });
    }
    if (isCloudflareAi) {
      data.accountId = cloudflareData.accountId;
    }
    if (providerRegions && region) {
      data.region = region;
    }
    return Object.keys(data).length > 0 ? data : undefined;
  };

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: formData.apiKey, providerSpecificData: buildProviderSpecificData() }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
      if (!data.valid && data.error) {
        setValidateError(data.error);
      } else {
        setValidateError("");
      }
    } catch {
      setValidationResult("failed");
      setValidateError("Network error while validating credential");
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async () => {
    if (!provider) return;
    if (!isOllamaLocal && !formData.apiKey) return;
    if (!isOllamaLocal) {
      // Non-ollama providers require a name
      if (!formData.name) return;
    }
    if (isCompatible && !formData.defaultModel.trim()) return;

    setSaving(true);
    const timeoutCtrl = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutCtrl.abort(), 12000);
    let isValid = false;
    try {
      if (isGeminiWeb) {
        isValid = true;
      } else {
        try {
          setValidating(true);
          setValidationResult(null);
          const res = await fetch("/api/providers/validate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider, apiKey: formData.apiKey, providerSpecificData: buildProviderSpecificData() }),
            signal: timeoutCtrl.signal,
          });
          const data = await res.json().catch(() => ({}));
          isValid = !!data.valid;
          setValidationResult(isValid ? "success" : "failed");
        } catch {
          setValidationResult("failed");
        } finally {
          setValidating(false);
        }
      }

      await onSave({
        name: formData.name || (isOllamaLocal ? "Ollama Local" : ""),
        apiKey: formData.apiKey,
        defaultModel: isCompatible ? formData.defaultModel.trim() : undefined,
        priority: formData.priority,
        proxyPoolId: formData.proxyPoolId === NONE_PROXY_POOL_VALUE ? null : formData.proxyPoolId,
        testStatus: isValid ? "active" : "unknown",
        providerSpecificData: buildProviderSpecificData()
      });
    } finally {
      clearTimeout(timeoutTimer);
      setSaving(false);
    }
  };

  const handleBulkSubmit = async () => {
    const lines = bulkText.split("\n");
    if (!lines.length) return;
    // Plan collision-free names against existing connections so a generated
    // "Key N" never matches a saved name (which the backend would upsert /
    // overwrite instead of inserting). See bulkAdd.js for the full rationale.
    const plan = planBulkAdd(lines, existingNames, { isCloudflareAi });
    if (!plan.length) return;
    setSaving(true);
    setBulkResult(null);
    setBulkProgress({ done: 0, total: plan.length });
    let success = 0;
    let failed = 0;
    for (const entry of plan) {
      try {
        // Validate each key before saving so bulk-added connections get a
        // real status (active/unknown) like single adds, instead of a
        // hardcoded "unknown" that never flips until a manual test.
        let isValid = false;
        try {
          const vres = await fetch("/api/providers/validate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider, apiKey: entry.apiKey }),
          });
          const vdata = await vres.json().catch(() => ({}));
          isValid = !!vdata.valid;
        } catch {
          isValid = false;
        }
        const res = await fetch("/api/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            apiKey: entry.apiKey,
            name: entry.name,
            priority: 1,
            testStatus: isValid ? "active" : "unknown",
            ...(entry.providerSpecificData ? { providerSpecificData: entry.providerSpecificData } : {}),
          }),
        });
        if (res.ok) success++;
        else failed++;
      } catch {
        failed++;
      }
      setBulkProgress((prev) => (prev ? { done: Math.min(prev.total, prev.done + 1), total: prev.total } : prev));
    }
    setSaving(false);
    setBulkProgress(null);
    setBulkResult({ success, failed });
    if (success > 0 && onBulkDone) onBulkDone();
  };

  if (!provider) return null;

  const bulkPct = bulkProgress && bulkProgress.total > 0
    ? Math.round((bulkProgress.done / bulkProgress.total) * 100)
    : null;

  const handleClose = () => {
    // Block closing while a bulk import loop is running so a partial batch
    // is never left behind an unmounted modal.
    if (saving && bulkProgress) return;
    setGeminiPsid("");
    setGeminiPsidts("");
    setGrokSso("");
    setGrokSsoRw("");
    onClose();
  };

  return (
    <Modal isOpen={isOpen} title={`Add ${providerName || provider} ${credentialLabel}`} onClose={handleClose}>
      <div className="flex flex-col gap-4">
        {/* Mode switcher */}
        <div className="flex gap-2">
          <Button size="sm" variant={mode === "single" ? "primary" : "ghost"} onClick={() => { setMode("single"); setBulkResult(null); }}>Single</Button>
          <Button size="sm" variant={mode === "bulk" ? "primary" : "ghost"} onClick={() => { setMode("bulk"); setBulkResult(null); }}>Bulk Add</Button>
        </div>

        {mode === "bulk" && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-text-muted">
              {isCloudflareAi
                ? <>One key per line. Format: <code>name|apiKey|accountId</code> or just <code>apiKey</code> (auto-named by index).</>
                : provider === "qoder" || provider === "qoder-cn"
                  ? <>One PAT per line. Format: <code>name|pt-...</code> or just <code>pt-...</code> (auto-named by index).</>
                  : <>One key per line. Format: <code>name|apiKey</code> or just <code>apiKey</code> (auto-named by index).</>
              }
            </p>
            <textarea
              className="w-full rounded border border-accent/30 bg-sidebar p-2 text-sm font-mono resize-y min-h-[140px] focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder={bulkPlaceholder}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
            />
            {bulkResult && (
              <div className={`text-sm font-medium ${bulkResult.failed > 0 ? "text-warning" : "text-success"}`}>
                <span className="material-symbols-outlined text-[13px] align-[-2px] mr-1 text-success" aria-hidden="true">check_circle</span>{bulkResult.success} added{bulkResult.failed > 0 ? `, ${bulkResult.failed} failed` : ""}
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={handleBulkSubmit} fullWidth disabled={saving || !bulkText.trim()}>
                Add All Keys
              </Button>
              <Button onClick={handleClose} variant="ghost" fullWidth disabled={!!bulkProgress}>Cancel</Button>
            </div>
          </div>
        )}

        {mode === "single" && (<>
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOllamaLocal ? "Ollama Local" : "Production Key"}
        />
        {isOllamaLocal && (
          <div className="flex gap-2">
            <Input
              label="Ollama Host URL"
              value={formData.ollamaHostUrl}
              onChange={(e) => setFormData({ ...formData, ollamaHostUrl: e.target.value })}
              placeholder="http://localhost:11434"
              className="flex-1"
            />
            <div className="pt-6">
              <Button onClick={handleValidate} disabled={validating || saving} variant="secondary">
                {validating ? "Checking..." : "Check"}
              </Button>
            </div>
          </div>
        )}
        {!isOllamaLocal && (
          isGeminiWeb ? (
            <div className="flex flex-col gap-3 p-3.5 rounded-lg bg-surface-2 border border-border">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-text-main flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-primary" />
                  Google Gemini Web Cookies
                </span>
                <span className="text-[11px] text-text-muted">Format 2 Kolom (Anti-Ribet)</span>
              </div>
              
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-text-muted font-mono flex items-center justify-between">
                  <span>1. __Secure-1PSID (Session Token) <span className="text-primary">*</span></span>
                  <span className="text-[10px] text-text-muted">Mulai dengan g.a000...</span>
                </label>
                <Input
                  type="text"
                  value={geminiPsid}
                  onChange={(e) => updateGeminiCookie(e.target.value, geminiPsidts)}
                  placeholder="g.a000... (Paste nilai __Secure-1PSID saja)"
                  className="w-full font-mono text-xs"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-text-muted font-mono flex items-center justify-between">
                  <span>2. __Secure-1PSIDTS (Timestamp Token) <span className="text-primary">*</span></span>
                  <span className="text-[10px] text-text-muted">Mulai dengan sidts-...</span>
                </label>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={geminiPsidts}
                    onChange={(e) => updateGeminiCookie(geminiPsid, e.target.value)}
                    placeholder="sidts-... (Paste nilai __Secure-1PSIDTS saja)"
                    className="flex-1 font-mono text-xs"
                  />
                  <Button onClick={handleValidate} disabled={(!geminiPsid && !formData.apiKey) || validating || saving} variant="secondary">
                    {validating ? "Checking..." : "Check"}
                  </Button>
                </div>
              </div>

              <p className="text-[11px] text-text-muted leading-relaxed">
                💡 <b>Fitur Auto-Split:</b> Kalau Anda meng-copy seluruh baris cookie dari DevTools (atau teks gabungan), cukup paste ke kolom nomor 1 — sistem otomatis memecahnya ke masing-masing kolom!
              </p>
            </div>
          ) : isGrokWeb ? (
            <div className="flex flex-col gap-3 p-3.5 rounded-lg bg-surface-2 border border-border">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-text-main flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-primary" />
                  Grok Web Session Cookies
                </span>
                <span className="text-[11px] text-text-muted">Format 2 Kolom</span>
              </div>
              
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-text-muted font-mono">
                  1. sso (Session Token) <span className="text-primary">*</span>
                </label>
                <Input
                  type="text"
                  value={grokSso}
                  onChange={(e) => updateGrokCookie(e.target.value, grokSsoRw)}
                  placeholder="Paste nilai cookie sso di sini"
                  className="w-full font-mono text-xs"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-text-muted font-mono">
                  2. sso-rw (Read/Write Token - Opsional)
                </label>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={grokSsoRw}
                    onChange={(e) => updateGrokCookie(grokSso, e.target.value)}
                    placeholder="Paste nilai cookie sso-rw di sini"
                    className="flex-1 font-mono text-xs"
                  />
                  <Button onClick={handleValidate} disabled={(!grokSso && !formData.apiKey) || validating || saving} variant="secondary">
                    {validating ? "Checking..." : "Check"}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                label={credentialLabel}
                type={isCookie ? "text" : "password"}
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder={credentialPlaceholder}
                className="flex-1"
              />
              <div className="pt-6">
                <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
          )
        )}
        {isXaiApiKey && (
          <p className="text-xs text-text-muted">
            Use a direct xAI API key from console.x.ai instead of Grok Build OAuth.
          </p>
        )}
        {isCookie && authHint && (
          <p className="text-xs text-text-muted">
            {authHint}
            {website && (
              <>
                {" "}
                <a href={website} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                  Open {website.replace(/^https?:\/\//, "")}
                </a>
              </>
            )}
          </p>
        )}
        {providerRegions && (
          <Select
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            options={providerRegions.map((r) => ({ value: r.id, label: r.label }))}
          />
        )}
        {isCompatible && (
          <Input
            label="Default Model"
            value={formData.defaultModel}
            onChange={(e) => setFormData({ ...formData, defaultModel: e.target.value })}
            placeholder={isAnthropic ? "claude-3-5-sonnet-latest" : "gpt-4o-mini"}
          />
        )}
        {isOllamaLocal && (
          <p className="text-xs text-text-muted">
            Leave blank to use <code>http://localhost:11434</code>. For remote Ollama, enter the full host URL (e.g. <code>http://192.168.1.10:11434</code>).
          </p>
        )}
        {validationResult && (
          <div className="flex items-center gap-2">
            <Badge variant={validationResult === "success" ? "success" : "error"}>
              {validationResult === "success" ? "Valid" : "Invalid"}
            </Badge>
            {validationResult !== "success" && validateError && (
              <span className="text-xs text-danger">{validateError}</span>
            )}
          </div>
        )}
        {error && (
          <p className="text-xs text-danger break-words">{error}</p>
        )}
        {isCompatible && (
          <p className="text-xs text-text-muted">
            Enter the model ID exactly as your endpoint expects it and it becomes the connection default.
          </p>
        )}
        {isCloudflareAi && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Cloudflare Workers AI</h3>
            <Input
              label="Account ID"
              value={cloudflareData.accountId}
              onChange={(e) => setCloudflareData({ ...cloudflareData, accountId: e.target.value })}
              placeholder="abc123def456..."
            />
            <p className="text-xs text-text-muted mt-2">
              Find your Account ID in the right sidebar of <a href="https://dash.cloudflare.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">dash.cloudflare.com</a>
            </p>
          </div>
        )}
        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
              />
            </div>
          </div>
        )}

        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value) || 1 })}
        />

        <Select
          label="Proxy Pool"
          value={formData.proxyPoolId}
          onChange={(e) => setFormData({ ...formData, proxyPoolId: e.target.value })}
          options={[
            { value: NONE_PROXY_POOL_VALUE, label: "None" },
            ...(proxyPools || []).map((pool) => ({ value: pool.id, label: pool.name })),
          ]}
          placeholder="None"
        />

        {(proxyPools || []).length === 0 && (
          <p className="text-xs text-text-muted">
            Create an active proxy pool in the Proxy Pools page first.
          </p>
        )}

        <p className="text-xs text-text-muted">
          Legacy manual proxy fields are still accepted by API for backward compatibility.
        </p>

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving || (!isOllamaLocal && (!formData.name || !formData.apiKey)) || (isCompatible && !formData.defaultModel.trim()) || (isAzure && (!azureData.azureEndpoint || !azureData.deployment || !azureData.organization)) || (isCloudflareAi && !cloudflareData.accountId)}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button onClick={handleClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
        </>)}
      </div>
      {bulkProgress && (
        <ProgressCard
          fixed={false}
          title="Adding keys"
          message={bulkPct !== null ? `${bulkProgress.done}/${bulkProgress.total} keys` : null}
          progress={bulkPct}
        />
      )}
    </Modal>
  );
}

AddApiKeyModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string,
  providerName: PropTypes.string,
  isCompatible: PropTypes.bool,
  isAnthropic: PropTypes.bool,
  authType: PropTypes.string,
  authHint: PropTypes.string,
  website: PropTypes.string,
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  })),
  error: PropTypes.string,
  existingNames: PropTypes.arrayOf(PropTypes.string),
  onSave: PropTypes.func.isRequired,
  onBulkDone: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
