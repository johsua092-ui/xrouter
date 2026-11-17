// JSON cache for mitmAlias — read by standalone MITM server (no SQLite native binding).
// Source of truth = SQLite kv['mitmAlias']. JSON is a read-replica synced on app start
// and after every UI write.
import fs from "fs";
import path from "path";
import { DATA_DIR } from "./dataDir.js";

// DATA_DIR comes from src/lib/dataDir.js so this cache resolves the SAME
// directory as the rest of the app. It used to read the env var directly,
// which on Windows honoured a Unix-style .env value like /var/lib/xrouter — the
// same split that made the MITM server and the dashboard disagree about where
// the certs live. One resolver, one path. This module is ESM (see package.json
// "type": "module") and is imported from Next.js routes, so the alias matches.
const CACHE_FILE = path.join(DATA_DIR, "mitm", "aliases.json");

function writeAtomic(data) {
  const dir = path.dirname(CACHE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, CACHE_FILE);
}

// Sync entire mitmAlias map from DB → JSON file
export async function syncToJson() {
  try {
    const { getMitmAlias } = await import("@/lib/db/repos/aliasRepo.js");
    const all = await getMitmAlias();
    writeAtomic(all || {});
  } catch (e) {
    console.log("[mitmAliasCache] sync failed:", e.message);
  }
}

// Update cache for a single tool after UI saves to DB
export function writeAliasForTool(tool, mappings) {
  try {
    let current = {};
    if (fs.existsSync(CACHE_FILE)) {
      try { current = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { /* corrupted → reset */ }
    }
    current[tool] = mappings || {};
    writeAtomic(current);
  } catch (e) {
    console.log("[mitmAliasCache] write failed:", e.message);
  }
}
