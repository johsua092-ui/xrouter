import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToTeam(row) {
  if (!row) return null;
  let allowedModels = [];
  if (row.allowedModels && row.allowedModels !== "*") {
    try {
      allowedModels = typeof row.allowedModels === "string" ? JSON.parse(row.allowedModels) : row.allowedModels;
    } catch {
      allowedModels = String(row.allowedModels).split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  let allowedProviders = [];
  if (row.allowedProviders && row.allowedProviders !== "*") {
    try {
      allowedProviders = typeof row.allowedProviders === "string" ? JSON.parse(row.allowedProviders) : row.allowedProviders;
    } catch {
      allowedProviders = String(row.allowedProviders).split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  return {
    id: row.id,
    name: row.name,
    apiKey: row.apiKey || "",
    enabled: row.enabled === 1 || row.enabled === true,
    description: row.description || "",
    allowedModels,
    allowedProviders,
    rpmLimit: row.rpmLimit || 0,
    dailyLimit: row.dailyLimit || 0,
    monthlyLimit: row.monthlyLimit || 0,
    dailySpendLimitUsd: Number(row.dailySpendLimitUsd) || 0,
    monthlySpendLimitUsd: Number(row.monthlySpendLimitUsd) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

let schemaChecked = false;
async function ensureTeamsSchema(db) {
  if (schemaChecked) return;
  try {
    const cols = await db.all("PRAGMA table_info(teams)");
    const colNames = new Set((cols || []).map((c) => c.name));
    if (!colNames.has("apiKey")) {
      await db.run("ALTER TABLE teams ADD COLUMN apiKey TEXT UNIQUE");
    }
    schemaChecked = true;
  } catch (e) {
    // If table doesn't exist yet, it will be created by schema sync
  }
}

export async function getTeams() {
  const db = await getAdapter();
  await ensureTeamsSchema(db);
  const rows = await db.all("SELECT * FROM teams ORDER BY createdAt DESC");
  return (rows || []).map(rowToTeam);
}

export async function getTeamById(id) {
  if (!id) return null;
  const db = await getAdapter();
  await ensureTeamsSchema(db);
  const row = await db.get("SELECT * FROM teams WHERE id = ?", [id]);
  return rowToTeam(row);
}

export async function createTeam({
  name,
  apiKey = "",
  description = "",
  allowedModels = [],
  allowedProviders = [],
  rpmLimit = 0,
  dailyLimit = 0,
  monthlyLimit = 0,
  dailySpendLimitUsd = 0,
  monthlySpendLimitUsd = 0,
}) {
  const db = await getAdapter();
  await ensureTeamsSchema(db);
  const id = `team_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  // Auto-generate high-prestige team API key with prefix xteam- if not provided
  let finalKey = apiKey && apiKey.trim() ? apiKey.trim() : "";
  if (!finalKey) {
    const randomHex = uuidv4().replace(/-/g, "").slice(0, 24);
    finalKey = `xteam-${randomHex}`;
  }

  const modelsStr = Array.isArray(allowedModels) && allowedModels.length ? JSON.stringify(allowedModels) : "*";
  const providersStr = Array.isArray(allowedProviders) && allowedProviders.length ? JSON.stringify(allowedProviders) : "*";

  await db.run(
    `INSERT INTO teams (
      id, name, apiKey, enabled, description, allowedModels, allowedProviders,
      rpmLimit, dailyLimit, monthlyLimit, dailySpendLimitUsd, monthlySpendLimitUsd,
      createdAt, updatedAt
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      name.trim(),
      finalKey,
      description.trim(),
      modelsStr,
      providersStr,
      Number(rpmLimit) || 0,
      Number(dailyLimit) || 0,
      Number(monthlyLimit) || 0,
      Number(dailySpendLimitUsd) || 0,
      Number(monthlySpendLimitUsd) || 0,
      now,
      now,
    ]
  );

  return getTeamById(id);
}

export async function updateTeam(id, updates = {}) {
  const db = await getAdapter();
  await ensureTeamsSchema(db);
  const existing = await getTeamById(id);
  if (!existing) return null;

  const fields = [];
  const values = [];

  if (typeof updates.name === "string" && updates.name.trim()) {
    fields.push("name = ?");
    values.push(updates.name.trim());
  }
  if (typeof updates.apiKey === "string" && updates.apiKey.trim()) {
    fields.push("apiKey = ?");
    values.push(updates.apiKey.trim());
  }
  if (typeof updates.enabled === "boolean") {
    fields.push("enabled = ?");
    values.push(updates.enabled ? 1 : 0);
  }
  if (typeof updates.description === "string") {
    fields.push("description = ?");
    values.push(updates.description.trim());
  }
  if (updates.allowedModels !== undefined) {
    fields.push("allowedModels = ?");
    values.push(Array.isArray(updates.allowedModels) && updates.allowedModels.length ? JSON.stringify(updates.allowedModels) : "*");
  }
  if (updates.allowedProviders !== undefined) {
    fields.push("allowedProviders = ?");
    values.push(Array.isArray(updates.allowedProviders) && updates.allowedProviders.length ? JSON.stringify(updates.allowedProviders) : "*");
  }
  if (updates.rpmLimit !== undefined) {
    fields.push("rpmLimit = ?");
    values.push(Number(updates.rpmLimit) || 0);
  }
  if (updates.dailyLimit !== undefined) {
    fields.push("dailyLimit = ?");
    values.push(Number(updates.dailyLimit) || 0);
  }
  if (updates.monthlyLimit !== undefined) {
    fields.push("monthlyLimit = ?");
    values.push(Number(updates.monthlyLimit) || 0);
  }
  if (updates.dailySpendLimitUsd !== undefined) {
    fields.push("dailySpendLimitUsd = ?");
    values.push(Number(updates.dailySpendLimitUsd) || 0);
  }
  if (updates.monthlySpendLimitUsd !== undefined) {
    fields.push("monthlySpendLimitUsd = ?");
    values.push(Number(updates.monthlySpendLimitUsd) || 0);
  }

  fields.push("updatedAt = ?");
  values.push(new Date().toISOString());
  values.push(id);

  await db.run(`UPDATE teams SET ${fields.join(", ")} WHERE id = ?`, values);
  return getTeamById(id);
}

export async function deleteTeam(id) {
  const db = await getAdapter();
  await db.run("DELETE FROM teams WHERE id = ?", [id]);
  return true;
}
