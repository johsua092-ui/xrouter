// Single source: build PROVIDERS + PROVIDER_MODELS from registry/{id}.js (transport + models co-located).
import REGISTRY from "./registry/index.js";
import { PROVIDER_DEFAULTS } from "./schema.js";
import { normalizeModel } from "./models/schema.js";
import { buildTtsProviderModels } from "../config/ttsModels.js";

// oauth block is canonical for these fields; inject into transport so executors reading
// this.config.{clientId,clientSecret,tokenUrl} keep working without duplicating in transport
const OAUTH_INJECT_FIELDS = ["clientId", "clientSecret", "tokenUrl"];

// transport: re-apply shared default (format:"openai") + inject oauth-canonical fields
function buildTransport(transport, oauth, entry = {}) {
  const t = { ...transport };
  if (!t.format) t.format = PROVIDER_DEFAULTS.format;
  if (entry.authType) t.authType = entry.authType;
  if (entry.noAuth !== undefined) t.noAuth = entry.noAuth;
  if (oauth) {
    for (const f of OAUTH_INJECT_FIELDS) {
      if (t[f] === undefined && oauth[f] !== undefined) t[f] = oauth[f];
    }
  }
  return t;
}

const MEDIA_KEYS = new Set([
  "serviceKinds", "ttsConfig", "sttConfig", "embeddingConfig",
  "imageConfig", "imageToTextConfig", "videoConfig", "musicConfig",
  "searchViaChat", "searchConfig", "fetchConfig", "systemoneConfig",
  "modelsFetcher", "mediaPriority", "hiddenKinds",
]);

export const PROVIDERS = {};
export const PROVIDER_MODELS = {};
export const PROVIDER_OAUTH = {};
export const PROVIDER_MEDIA = {};
for (const entry of REGISTRY) {
  if (entry.transport) {
    PROVIDERS[entry.id] = buildTransport(entry.transport, entry.oauth, entry);
    if (entry.transports) PROVIDERS[entry.id].transports = entry.transports;
  }
  if (entry.models !== undefined) PROVIDER_MODELS[entry.alias || entry.id] = entry.models.map(normalizeModel);
  if (entry.oauth) PROVIDER_OAUTH[entry.id] = entry.oauth;
  // Build PROVIDER_MEDIA from top-level fields (post-migration) + legacy entry.media
  const mediaFields = {};
  for (const k of MEDIA_KEYS) {
    if (entry[k] !== undefined) mediaFields[k] = entry[k];
  }
  if (entry.media) Object.assign(mediaFields, entry.media);
  if (Object.keys(mediaFields).length) PROVIDER_MEDIA[entry.id] = mediaFields;
}

// TTS model/voice tables keyed by special names (openai-tts-models, ...), not provider ids
Object.assign(PROVIDER_MODELS, buildTtsProviderModels());
