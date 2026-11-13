// Who is asking, and what may they see.
//
// Four surfaces present the same catalogue to an API caller: /v1/models,
// /v1/models/{kind}, /v1/models/info and the Gemini-shaped /v1beta/models. They
// all have to agree, or a restricted key ends up reading the full catalogue
// through whichever one forgot to filter.

import { getAllowedModelsOfKey } from "@/lib/db/repos/apiKeysRepo";

/**
 * The caller's API key, from any of the headers the compatible APIs use.
 * Returns null when the request carries none.
 */
export function readCallerApiKey(request) {
  const auth = String(request?.headers?.get("authorization") || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  const raw =
    bearer?.[1] ||
    request?.headers?.get("x-api-key") ||
    request?.headers?.get("x-goog-api-key") ||
    "";
  return raw.trim() || null;
}

/**
 * The caller's allowed-model patterns, or null when the key may use everything
 * (or when no key was presented and the instance is running open).
 *
 * Resolves both kinds of credential: a per-key allowlist, and the team-wide key
 * that inherits the team's list.
 */
export async function callerAllowedModels(request) {
  return getAllowedModelsOfKey(readCallerApiKey(request));
}
