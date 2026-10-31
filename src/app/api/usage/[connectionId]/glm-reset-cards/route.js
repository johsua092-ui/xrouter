import "open-sse/index.js";
import { getProviderConnectionById } from "@/lib/db/index.js";
import { getGlmResetCards, redeemGlmResetCard } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "../route.js";

const inFlight = new Set();
const credential = (connection) => connection.apiKey || connection.accessToken || "";
const validId = (value) => Number.isSafeInteger(value) || (typeof value === "string" && value.trim().length > 0 && value.length <= 512);
const failure = (code, message, status = 400, uncertain = false) => Response.json({ reset: false, alreadyUsed: false, uncertain, error: message, code, message }, { status });
const safeText = (value, fallback) => typeof value === "string" && value.trim() ? value.trim().slice(0, 400) : fallback;

function mutationGuard(request) {
  const origin = request.headers.get("origin");
  if (origin) {
    let sameOrigin = false;
    try {
      const source = new URL(origin);
      const target = new URL(request.url);
      let host = (request.headers.get("host") || target.host).trim().toLowerCase();
      if ((source.protocol === "http:" && host.endsWith(":80")) || (source.protocol === "https:" && host.endsWith(":443"))) host = host.slice(0, host.lastIndexOf(":"));
      // TLS termination is accepted only with matching authority and browser-set same-origin metadata.
      const protocolMatches = source.protocol === target.protocol || (source.protocol === "https:" && target.protocol === "http:" && request.headers.get("sec-fetch-site") === "same-origin");
      sameOrigin = protocolMatches && source.host === host && !source.username && !source.password && source.pathname === "/" && !source.search && !source.hash;
    } catch {}
    if (!sameOrigin) return failure("cross_origin", "Cross-origin request rejected.", 403);
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return failure("invalid_content_type", "Content-Type must be application/json.");
  return null;
}

async function resolveConnection(connectionId) {
  const connection = await getProviderConnectionById(connectionId);
  if (!connection) return { response: failure("not_found", "Connection not found.", 404) };
  if (connection.provider !== "glm") return { response: failure("unsupported_provider", "GLM reset cards are only available for GLM connections.") };
  if (!["oauth", "apikey", "api_key"].includes(connection.authType)) return { response: failure("unsupported_auth", "GLM reset cards require an OAuth or API-key connection.") };
  if (!credential(connection)) return { response: failure("missing_credential", "GLM connection has no stored credential.") };
  return { connection, proxyOptions: { ...(await resolveConnectionProxyConfig(connection.providerSpecificData)), strictProxy: false } };
}

async function refresh(connection, force, proxyOptions) {
  try {
    return (await refreshAndUpdateCredentials(connection, force, proxyOptions))?.connection || connection;
  } catch {
    return connection;
  }
}

export async function GET(request, { params }) {
  const { connectionId } = params;
  const resolved = await resolveConnection(connectionId);
  if (resolved.response) return resolved.response;

  let connection = resolved.connection;
  let attempts = 0;
  while (attempts < 2) {
    attempts++;
    try {
      const data = await getGlmResetCards(credential(connection), resolved.proxyOptions, connection.providerSpecificData);
      return Response.json(data);
    } catch (err) {
      if (err.status === 401 && attempts === 1) {
        connection = await refresh(connection, true, resolved.proxyOptions);
        continue;
      }
      return failure("fetch_failed", err.message || "Failed to fetch GLM reset cards.", err.status || 502);
    }
  }
  return failure("fetch_failed", "Failed to fetch GLM reset cards after token refresh.", 502);
}

export async function POST(request, { params }) {
  let lockKey;
  try {
    const guard = mutationGuard(request);
    if (guard) return guard;
    let body;
    try { body = await request.json(); } catch { return failure("invalid_body", "Invalid JSON body."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return failure("invalid_body", "Request body must be a JSON object.");
    if (!validId(body.recordId)) return failure("invalid_record_id", "recordId must be a safe integer or non-blank string.");
    if (!["FIVE_HOUR", "WEEK"].includes(body.type)) return failure("invalid_type", "type must be FIVE_HOUR or WEEK.");

    const { connectionId } = params;
    lockKey = `${connectionId}:${body.type}:${body.recordId}`;
    if (inFlight.has(lockKey)) return failure("concurrent_request", "A reset card redemption is already in progress for this card.", 409);
    inFlight.add(lockKey);

    const resolved = await resolveConnection(connectionId);
    if (resolved.response) return resolved.response;

    const card = { recordId: body.recordId, type: body.type };
    let connection = resolved.connection;
    let result;
    try {
      result = await redeemGlmResetCard(credential(connection), card, resolved.proxyOptions, connection.providerSpecificData);
    } catch (err) {
      return failure("redemption_failed", err.message || "Failed to redeem GLM reset card.", 502, true);
    }

    if (result?.ok) {
      return Response.json(result);
    }
    return failure(result?.code || "redemption_failed", result?.message || "Failed to redeem GLM reset card.", result?.status || 502, result?.uncertain);
  } finally {
    if (lockKey) inFlight.delete(lockKey);
  }
}
