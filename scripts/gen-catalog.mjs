// Dumps the Node provider/model catalog into a JSON artifact the Go core embeds.
//
// The catalog lives in code on the Node side (open-sse/config/providerModels.js
// plus shared/constants/providers.js). Rather than hand-copying ~150 providers
// and their model lists into Go — a copy that would drift on the next Node
// commit — the Go build consumes this generated file. Regenerate with:
//
//   node scripts/gen-catalog.mjs
//
// Output: internal/catalog/catalog.json (embedded via go:embed).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

// The app's modules import through Next.js aliases (`open-sse/*`, `@/*`).
// Register the resolver hook before any app module is imported.
register("./alias-hook.mjs", import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } = await import(
  resolve(root, "open-sse/config/providerModels.js")
);
const { AI_PROVIDERS } = await import(resolve(root, "src/shared/constants/providers.js"));

function pickProvider(id, p) {
  const out = {
    id,
    name: p.name || id,
    alias: p.alias || id,
    baseUrl: p.baseUrl || "",
    kind: p.kind || "",
    passthroughModels: !!p.passthroughModels,
    noAuth: !!p.noAuth,
    authType: p.authType || "",
  };
  if (p.searchConfig) out.searchConfig = p.searchConfig;
  if (p.ttsConfig) out.ttsConfig = p.ttsConfig;
  // The remaining media descriptors are copied verbatim into one map: the Go
  // media plane is config-driven, so whatever knobs Node ships for a provider
  // (paths, formats, auth style, required options) must arrive intact instead
  // of being re-typed field by field.
  const media = {};
  if (p.searchConfig) media.searchConfig = p.searchConfig;
  if (p.ttsConfig) media.ttsConfig = p.ttsConfig;
  for (const field of [
    "fetchConfig",
    "sttConfig",
    "embeddingConfig",
    "systemoneConfig",
    "imageConfig",
    "videoConfig",
    "ttsVoicesConfig",
  ]) {
    if (p[field] !== undefined) media[field] = p[field];
  }
  if (p.searchViaChat !== undefined) media.searchViaChat = p.searchViaChat;
  if (Object.keys(media).length) out.media = media;
  return out;
}

const providers = {};
for (const [id, p] of Object.entries(AI_PROVIDERS)) {
  providers[id] = pickProvider(id, p);
}

const models = {};
for (const [key, list] of Object.entries(PROVIDER_MODELS)) {
  models[key] = (list || []).map((m) => {
    const entry = { id: m.id };
    if (m.name) entry.name = m.name;
    const kind = m.kind || m.type;
    if (kind) entry.kind = kind;
    for (const field of [
      "params",
      "capabilities",
      "options",
      "dimensions",
      "contextWindow",
      "upstreamId",
      "strip",
      "quotaFamily",
    ]) {
      if (m[field] !== undefined) entry[field] = m[field];
    }
    return entry;
  });
}

const artifact = {
  generatedFrom: "open-sse/config/providerModels.js",
  providerIdToAlias: PROVIDER_ID_TO_ALIAS,
  providers,
  models,
};

const outDir = resolve(here, "../internal/catalog");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "catalog.json"), JSON.stringify(artifact, null, 0) + "\n");

const providerCount = Object.keys(providers).length;
const modelCount = Object.values(models).reduce((n, l) => n + l.length, 0);
console.log(`catalog.json: ${providerCount} providers, ${modelCount} models`);

// Thinking signatures are wire constants, not configuration: Gemini rejects a
// functionCall whose thoughtSignature does not match what it issued, and the
// official clients ship fixed sentinels for the synthetic case. They are several
// kilobytes of base64, so they are generated instead of hand-copied — a
// transcription slip here fails silently as a broken reasoning chain.
const signatures = await import("../open-sse/config/defaultThinkingSignature.js");
const sigDir = resolve(here, "../internal/translate");
mkdirSync(sigDir, { recursive: true });
const sigArtifact = {};
for (const [key, value] of Object.entries(signatures)) {
  if (typeof value === "string" && key.startsWith("DEFAULT_THINKING")) {
    sigArtifact[key] = value;
  }
}
writeFileSync(resolve(sigDir, "signatures.json"), JSON.stringify(sigArtifact) + "\n");
console.log(`signatures.json: ${Object.keys(sigArtifact).length} constants`);
