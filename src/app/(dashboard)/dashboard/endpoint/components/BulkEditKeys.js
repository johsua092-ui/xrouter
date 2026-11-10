"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal, Input } from "@/shared/components";

/**
 * Bulk edit keys: write one field to every selected key in one call.
 * Each field is opt-in (checkbox): fields left off are not touched, so the
 * form never rewrites what the user did not mean to change.
 */
export default function BulkEditKeys({ selectedCount, onApply, onClose }) {
  const [fields, setFields] = useState({
    tokenLimit: { on: false, value: "" },
    resetInterval: { on: false, value: "never" },
    rpmLimit: { on: false, value: "" },
    tpmLimit: { on: false, value: "" },
    allowedModels: { on: false, value: "" },
    deniedModels: { on: false, value: "" },
    allowedProviders: { on: false, value: "" },
    ipWhitelist: { on: false, value: "" },
    expiresAt: { on: false, value: "" },
    isActive: { on: false, value: "true" },
  });
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");

  const toggle = (name) =>
    setFields((prev) => ({ ...prev, [name]: { ...prev[name], on: !prev[name].on } }));
  const setValue = (name, value) =>
    setFields((prev) => ({ ...prev, [name]: { ...prev[name], value } }));

  const handleApply = async () => {
    const patch = {};
    // Deny-list and provider allowlist live in their own table (apiKeyAcls), so they
    // travel as a nested `acl` and are written once per selected key by the caller.
    const acl = {};
    for (const [name, { on, value }] of Object.entries(fields)) {
      if (!on) continue;
      if (name === "isActive") {
        patch.isActive = value === "true";
      } else if (name === "tokenLimit" || name === "rpmLimit" || name === "tpmLimit") {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
          setError(`${labelFor(name)} must be a number of 0 or more (0 = unlimited)`);
          return;
        }
        patch[name] = n;
      } else if (name === "allowedModels") {
        if (!String(value).trim()) {
          setError("Allowed models pattern cannot be empty when enabled");
          return;
        }
        patch.allowedModels = String(value).trim();
      } else if (name === "deniedModels" || name === "allowedProviders") {
        if (!String(value).trim()) {
          setError(`${labelFor(name)} cannot be empty when enabled (turn the checkbox off to leave it alone)`);
          return;
        }
        acl[name] = String(value).trim();
      } else {
        patch[name] = value;
      }
    }
    if (!Object.keys(patch).length && !Object.keys(acl).length) {
      setError("Enable at least one field to change");
      return;
    }
    if (Object.keys(acl).length) patch.acl = acl;
    setError("");
    setApplying(true);
    try {
      await onApply(patch);
      onClose();
    } catch (err) {
      setError(err.message || "Failed to apply bulk changes");
    } finally {
      setApplying(false);
    }
  };

  const rows = ["tokenLimit", "resetInterval", "rpmLimit", "tpmLimit", "allowedModels", "deniedModels", "allowedProviders", "ipWhitelist", "expiresAt", "isActive"];

  return (
    <Modal isOpen onClose={onClose} title={`Bulk edit ${selectedCount} key${selectedCount === 1 ? "" : "s"}`}>
      <div className="flex flex-col gap-3">
        {rows.map((name) => (
          <div key={name} className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={fields[name].on}
              onChange={() => toggle(name)}
              className="mt-1.5 size-4 accent-brand-500"
              aria-label={`Change ${labelFor(name)}`}
            />
            <div className="flex-1 min-w-0">
              <label className="text-sm font-medium text-text-main block mb-1">{labelFor(name)}</label>
              {name === "resetInterval" ? (
                <select
                  value={fields[name].value}
                  onChange={(e) => setValue(name, e.target.value)}
                  disabled={!fields[name].on}
                  className="w-full h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface text-sm text-text-main disabled:opacity-40"
                >
                  <option value="never">No reset</option>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              ) : name === "isActive" ? (
                <select
                  value={fields[name].value}
                  onChange={(e) => setValue(name, e.target.value)}
                  disabled={!fields[name].on}
                  className="w-full h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface text-sm text-text-main disabled:opacity-40"
                >
                  <option value="true">Active</option>
                  <option value="false">Disabled</option>
                </select>
              ) : (
                <Input
                  value={fields[name].value}
                  onChange={(e) => setValue(name, e.target.value)}
                  disabled={!fields[name].on}
                  placeholder={placeholderFor(name)}
                  type={name === "expiresAt" ? "date" : "text"}
                />
              )}
            </div>
          </div>
        ))}

        {error && (
          <p className="text-xs text-red-500" role="alert">{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          <Button onClick={handleApply} loading={applying}>
            Apply to {selectedCount} key{selectedCount === 1 ? "" : "s"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function labelFor(name) {
  return {
    tokenLimit: "Token limit (0 = unlimited)",
    resetInterval: "Reset interval",
    rpmLimit: "Requests per minute (0 = unlimited)",
    tpmLimit: "Tokens per minute (0 = unlimited)",
    allowedModels: "Allowed models pattern",
    deniedModels: "Denied models pattern",
    allowedProviders: "Allowed providers",
    ipWhitelist: "IP whitelist",
    expiresAt: "Expiry date",
    isActive: "Status",
  }[name] || name;
}

function placeholderFor(name) {
  return {
    tokenLimit: "e.g. 1000000",
    rpmLimit: "e.g. 60",
    tpmLimit: "e.g. 100000",
    allowedModels: "e.g. anthropic/*, openai/gpt-4o",
    deniedModels: "e.g. gpt-4*, *opus  (same pattern rules as allowed)",
    allowedProviders: "e.g. opencode, anthropic, glm",
    ipWhitelist: "e.g. 203.0.113.5, 198.51.100.0/24",
    expiresAt: "leave blank for no expiry",
  }[name] || "";
}

BulkEditKeys.propTypes = {
  selectedCount: PropTypes.number.isRequired,
  onApply: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};