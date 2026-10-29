"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS } from "@/shared/constants/providers";
import Select from "@/shared/components/Select";

export default function EditConnectionModal({ isOpen, connection, proxyPools, onSave, onClose }) {
  const NONE_PROXY_POOL_VALUE = "__none__";
  const [formData, setFormData] = useState({
    name: "",
    priority: 1,
    apiKey: "",
    proxyPoolId: NONE_PROXY_POOL_VALUE,
  });
  const [azureData, setAzureData] = useState({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState({ accountId: "" });
  const [region, setRegion] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);

  // Dual-column states for multi-cookie providers
  const isGeminiWeb = connection?.provider === "gemini-web";
  const isGrokWeb = connection?.provider === "grok-web";
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

  useEffect(() => {
    if (connection) {
      const poolId = connection.providerSpecificData?.connectionProxyPoolId || connection.providerSpecificData?.proxyPoolId || NONE_PROXY_POOL_VALUE;
      setFormData({
        name: connection.name || "",
        priority: connection.priority || 1,
        apiKey: "",
        proxyPoolId: poolId,
      });

      // Parse existing cookies if multi-cookie web provider
      const existingKey = connection.apiKey || connection.token || "";
      if (connection.provider === "gemini-web") {
        const m1 = existingKey.match(/(?:^|[;\s])__Secure-1PSID=([^;\s]+)/);
        const m2 = existingKey.match(/(?:^|[;\s])__Secure-1PSIDTS=([^;\s]+)/);
        setGeminiPsid(m1 ? m1[1] : "");
        setGeminiPsidts(m2 ? m2[1] : "");
      } else if (connection.provider === "grok-web") {
        const m1 = existingKey.match(/(?:^|[;\s])sso=([^;\s]+)/);
        const m2 = existingKey.match(/(?:^|[;\s])sso-rw=([^;\s]+)/);
        setGrokSso(m1 ? m1[1] : "");
        setGrokSsoRw(m2 ? m2[1] : "");
      }

      // Load Azure-specific data if present
      if (connection.provider === "azure" && connection.providerSpecificData) {
        setAzureData({
          azureEndpoint: connection.providerSpecificData.azureEndpoint || "",
          apiVersion: connection.providerSpecificData.apiVersion || "2024-10-01-preview",
          deployment: connection.providerSpecificData.deployment || "",
          organization: connection.providerSpecificData.organization || "",
        });
      }
      if (connection.provider === "cloudflare-ai" && connection.providerSpecificData) {
        setCloudflareData({ accountId: connection.providerSpecificData.accountId || "" });
      }
      // Load region for providers that support it (e.g. xiaomi-tokenplan)
      const providerCfg = AI_PROVIDERS?.[connection.provider];
      if (providerCfg?.regions) {
        const savedRegion = connection.providerSpecificData?.region || providerCfg.defaultRegion || providerCfg.regions[0]?.id || "";
        setRegion(savedRegion);
      }
      setTestResult(null);
      setValidationResult(null);
    }
  }, [connection]);

  const isOAuth = connection?.authType === "oauth";
  const isAzure = connection?.provider === "azure";
  const isCloudflareAi = connection?.provider === "cloudflare-ai";
  const isCompatible = connection
    ? (isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider))
    : false;
  const providerRegions = connection ? (AI_PROVIDERS?.[connection.provider]?.regions || null) : null;

  // Build providerSpecificData for region-aware providers
  const buildRegionSpecificData = () => {
    if (providerRegions && region) return { ...((connection?.providerSpecificData) || {}), region };
    return undefined;
  };

  const handleTest = async () => {
    if (!connection?.provider) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/providers/${connection.id}/test`, { method: "POST" });
      const data = await res.json();
      setTestResult(data.valid ? "success" : "failed");
    } catch {
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  const handleValidate = async () => {
    if (!connection?.provider || !formData.apiKey) return;
    setValidating(true);
    setValidationResult(null);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: connection.provider,
          apiKey: formData.apiKey,
          ...(isAzure ? { providerSpecificData: azureData } : {}),
          ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
          ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
        }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async () => {
    if (!connection) return;
    setSaving(true);
    try {
      const updates = {
        name: formData.name,
        priority: formData.priority,
      };
      if (!isOAuth && formData.apiKey) {
        updates.apiKey = formData.apiKey;
        let isValid = validationResult === "success";
        if (!isValid) {
          try {
            setValidating(true);
            setValidationResult(null);
            const res = await fetch("/api/providers/validate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                provider: connection.provider,
                apiKey: formData.apiKey,
                ...(isAzure ? { providerSpecificData: azureData } : {}),
                ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
                ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
              }),
            });
            const data = await res.json();
            isValid = !!data.valid;
            setValidationResult(isValid ? "success" : "failed");
          } catch {
            setValidationResult("failed");
          } finally {
            setValidating(false);
          }
        }
        if (isValid) {
          updates.testStatus = "active";
          updates.lastError = null;
          updates.lastErrorAt = null;
        }
      }
      
      // Add proxy pool data
      const currentPSD = connection.providerSpecificData || {};
      const nextPSD = { ...currentPSD };
      if (formData.proxyPoolId && formData.proxyPoolId !== NONE_PROXY_POOL_VALUE) {
        nextPSD.connectionProxyPoolId = formData.proxyPoolId;
        nextPSD.proxyPoolId = formData.proxyPoolId;
      } else {
        delete nextPSD.connectionProxyPoolId;
        delete nextPSD.proxyPoolId;
      }

      // Add Azure-specific data if this is an Azure connection
      if (isAzure) {
        Object.assign(nextPSD, {
          azureEndpoint: azureData.azureEndpoint,
          apiVersion: azureData.apiVersion,
          deployment: azureData.deployment,
          organization: azureData.organization,
        });
      }
      if (isCloudflareAi) {
        nextPSD.accountId = cloudflareData.accountId;
      }
      // Persist updated region for region-aware providers
      if (providerRegions && region) {
        nextPSD.region = region;
      }

      updates.providerSpecificData = nextPSD;

      // Fast-pass for gemini-web: save directly without blocking on validation
      if (isGeminiWeb && updates.apiKey) {
        updates.testStatus = "active";
        updates.lastError = null;
        updates.lastErrorAt = null;
      }
      
      await onSave(updates);
    } finally {
      setSaving(false);
    }
  };

  if (!connection) return null;

  return (
    <Modal isOpen={isOpen} title="Edit Connection" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOAuth ? "Account name" : "Production Key"}
        />
        {isOAuth && connection.email && (
          <div className="bg-sidebar/50 p-3 rounded-lg">
            <p className="text-sm text-text-muted mb-1">Email</p>
            <p className="font-medium">{connection.email}</p>
          </div>
        )}
        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })}
        />

        {!isOAuth && (
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
            <>
              <div className="flex gap-2">
                <Input
                  label="API Key"
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                  placeholder="Enter new API key"
                  hint="Leave blank to keep the current API key."
                  className="flex-1"
                />
                <div className="pt-6">
                  <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
                    {validating ? "Checking..." : "Check"}
                  </Button>
                </div>
              </div>
              {validationResult && (
                <Badge variant={validationResult === "success" ? "success" : "error"}>
                  {validationResult === "success" ? "Valid" : "Invalid"}
                </Badge>
              )}
            </>
          )
        )}

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

        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
                hint="Your Azure OpenAI resource endpoint URL"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
                hint="The deployment name in your Azure resource"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
                hint="Azure OpenAI API version to use"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
                hint="Required for billing"
              />
            </div>
          </div>
        )}

        {providerRegions && (
          <Select
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            options={providerRegions.map((r) => ({ value: r.id, label: r.label }))}
          />
        )}

        {!isCompatible && !isAzure && !isCloudflareAi && (
          <div className="flex items-center gap-3">
            <Button onClick={handleTest} variant="secondary" disabled={testing}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            {testResult && (
              <Badge variant={testResult === "success" ? "success" : "error"}>
                {testResult === "success" ? "Valid" : "Failed"}
              </Badge>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

EditConnectionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    priority: PropTypes.number,
    authType: PropTypes.string,
    provider: PropTypes.string,
    providerSpecificData: PropTypes.object,
  }),
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  })),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

