/**
 * Hermes Agent Persona Sync for XRouter
 * Inspired by OhMyRouter OmopV2 (src/persona/hermes-sync.ts)
 * 
 * Synchronizes persona / system prompts from XRouter Model Bypass (Prompt Injections)
 * into $HERMES_HOME/SOUL.md or $SYNAPSE_HOME/SOUL.md with automatic timestamped backup.
 */

import fs from "fs";
import path from "path";
import os from "os";

function resolveHermesSoulPath() {
  const custom = process.env.HERMES_HOME || process.env.SYNAPSE_HOME;
  if (custom && fs.existsSync(custom)) {
    return path.join(custom, "SOUL.md");
  }

  const homedir = os.homedir();
  const candidates = [
    path.join(homedir, ".hermes", "SOUL.md"),
    path.join(homedir, ".synapse", "SOUL.md"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c) || fs.existsSync(path.dirname(c))) {
      return c;
    }
  }

  return path.join(homedir, ".synapse", "SOUL.md");
}

export async function syncPersonaToHermes(personaContent) {
  if (typeof personaContent !== "string" || !personaContent.trim()) {
    return { success: false, reason: "empty_content" };
  }

  try {
    const soulPath = resolveHermesSoulPath();
    const soulDir = path.dirname(soulPath);
    if (!fs.existsSync(soulDir)) {
      fs.mkdirSync(soulDir, { recursive: true });
    }

    // Create timestamped backup if SOUL.md already exists
    if (fs.existsSync(soulPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const bakPath = `${soulPath}.bak.${stamp}`;
      fs.copyFileSync(soulPath, bakPath);
    }

    fs.writeFileSync(soulPath, personaContent.trim() + "\n", "utf8");
    return { success: true, path: soulPath };
  } catch (err) {
    console.error("[HermesSync] Failed to sync persona to Hermes:", err);
    return { success: false, error: err.message };
  }
}
