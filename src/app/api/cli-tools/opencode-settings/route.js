"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { ALIAS_TO_ID } from "@/shared/constants/providers";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";

const execAsync = promisify(exec);

const getConfigDir = () => path.join(os.homedir(), ".config", "opencode");
const getConfigPath = () => path.join(getConfigDir(), "opencode.json");

const ALIAS_TO_PROVIDER_ID = {
  ...Object.fromEntries(Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])),
  ...ALIAS_TO_ID,
};

// opencode "variants" built from the levels this gateway offers for a model
// ("alias/model" → same set as the dashboard picker). Returns null when the
// model has no reasoning levels, so nothing is written for it.
const buildEffortVariants = (fullModelId) => {
  const slash = fullModelId.indexOf("/");
  if (slash <= 0) return null;
  const alias = fullModelId.slice(0, slash);
  const levels = getThinkingLevels(ALIAS_TO_PROVIDER_ID[alias] || alias, fullModelId.slice(slash + 1));
  if (!Array.isArray(levels) || levels.length === 0) return null;
  return Object.fromEntries(levels.map((level) => [level, { reasoningEffort: level }]));
};

// Check if opencode CLI is installed (via which/where or config file exists)
const checkOpenCodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where opencode" : "which opencode";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfig = async () => {
  try {
    const content = await fs.readFile(getConfigPath(), "utf-8");
    // opencode config files may use JSONC format (trailing commas, comments).
    // Strip trailing commas before parsing to avoid SyntaxError on valid JSONC.
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // If the config file exists but is unparseable (corrupted, exotic JSONC),
    // treat it as "no config" rather than throwing a 500 that the UI
    // misinterprets as "opencode not installed".
    return null;
  }
};

const hasXRouterConfig = (config) => {
  if (!config?.provider) return false;
  return !!config.provider["xrouter"];
};

// GET - Check opencode CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenCodeInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "OpenCode CLI is not installed",
      });
    }

    const config = await readConfig();
    const providerConfig = config?.provider?.["xrouter"];
    const modelMap = providerConfig?.models || {};

    return NextResponse.json({
      installed: true,
      config,
      hasXRouter: hasXRouterConfig(config),
      configPath: getConfigPath(),
        opencode: {
          models: Object.keys(modelMap),
          activeModel: config?.model?.startsWith("xrouter/") ? config.model.replace(/^xrouter\//, "") : null,
          baseURL: providerConfig?.options?.baseURL || null,
        },
    });
  } catch (error) {
    console.log("Error checking opencode settings:", error);
    return NextResponse.json({ error: "Failed to check opencode settings" }, { status: 500 });
  }
}

// POST - Apply X Router as openai-compatible provider (multi-model support)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, activeModel, subagentModel } = await request.json();

    // Accept either `model` (string, legacy) or `models` (array of strings)
    const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);

    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const configDir = getConfigDir();
    const configPath = getConfigPath();

    await fs.mkdir(configDir, { recursive: true });

    // Read existing config or start fresh
    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch { /* No existing config */ }

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const keyToUse = apiKey || "sk_xrouter";
    const effectiveSubagentModel = subagentModel || modelsArray[0];

    // Ensure provider object
    if (!config.provider) config.provider = {};

    // Preserve any existing xrouter provider entry and its models
    const existingProvider = config.provider["xrouter"] || { npm: "@ai-sdk/openai-compatible", options: {}, models: {} };

    // Merge options (overwrite baseURL/apiKey)
    existingProvider.options = {
      ...existingProvider.options,
      baseURL: normalizedBaseUrl,
      apiKey: keyToUse,
    };

    // Ensure models map exists
    existingProvider.models = existingProvider.models || {};

    // Add or update entries for all requested models
    for (const m of modelsArray) {
      if (!m || typeof m !== "string") continue;
      const entry = { name: m, modalities: { input: ["text", "image"], output: ["text"] } };
      // Keep variants the user already tuned; only generate them when absent.
      const variants = existingProvider.models[m]?.variants || buildEffortVariants(m);
      if (variants) entry.variants = variants;
      existingProvider.models[m] = entry;
    }

    // Save merged provider back
    config.provider["xrouter"] = existingProvider;

    // Set the active model: prefer explicit activeModel, else first of modelsArray
    // If activeModel is explicitly empty string, clear the model
    if (activeModel === "") {
      config.model = "";
    } else {
      const finalActive = activeModel || modelsArray[0];
      if (finalActive) {
        config.model = `xrouter/${finalActive}`;
      }
    }

    // Add subagent configuration
    if (!config.agent) config.agent = {};
    config.agent.explorer = {
      description: "Fast explorer subagent for codebase exploration",
      mode: "subagent",
      model: `xrouter/${effectiveSubagentModel}`,
    };

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "OpenCode settings applied successfully!",
      configPath,
    });
  } catch (error) {
    console.log("Error applying opencode settings:", error);
    return NextResponse.json({ error: "Failed to apply settings" }, { status: 500 });
  }
}

// PATCH - Update specific settings (e.g., clear active model)
export async function PATCH(request) {
  try {
    const { clearActiveModel } = await request.json();
    const configPath = getConfigPath();

    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file found" });
      }
      throw error;
    }

    if (clearActiveModel === true) {
      // Clear active model but keep models in the list
      if (config.model?.startsWith("xrouter/")) {
        config.model = "";
      }
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings updated",
    });
  } catch (error) {
    console.log("Error patching opencode settings:", error);
    return NextResponse.json({ error: "Failed to patch settings" }, { status: 500 });
  }
}

// DELETE - Remove X Router provider or specific models from config
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");
    const configPath = getConfigPath();

    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file to reset" });
      }
      throw error;
    }

    // If specific model provided, remove just that model
    if (modelToRemove && config.provider?.["xrouter"]?.models) {
      delete config.provider["xrouter"].models[modelToRemove];
      
      // If no models left, remove the provider
      if (Object.keys(config.provider["xrouter"].models).length === 0) {
        delete config.provider["xrouter"];
        if (config.model?.startsWith("xrouter/")) delete config.model;
      } else if (config.model === `xrouter/${modelToRemove}`) {
        // If removed model was active, switch to first remaining model
        const remainingModels = Object.keys(config.provider["xrouter"].models);
        config.model = `xrouter/${remainingModels[0]}`;
      }
    } else {
      // No specific model - remove entire xrouter provider
      if (config.provider) delete config.provider["xrouter"];
      if (config.model?.startsWith("xrouter/")) delete config.model;
    }

    // Remove subagent configuration
    if (config.agent?.explorer?.model?.startsWith("xrouter/")) {
      delete config.agent.explorer;
      // Clean up empty agent object
      if (Object.keys(config.agent).length === 0) delete config.agent;
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: modelToRemove ? `Model "${modelToRemove}" removed` : "X Router settings removed from OpenCode",
    });
  } catch (error) {
    console.log("Error resetting opencode settings:", error);
    return NextResponse.json({ error: "Failed to reset opencode settings" }, { status: 500 });
  }
}
