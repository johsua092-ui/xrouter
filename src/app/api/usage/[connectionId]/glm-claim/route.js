import "open-sse/index.js";
import { getProviderConnectionById } from "@/lib/db/index.js";
import { getGlmClaimablePlans, claimGlmPlan, getGlmBalance } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "../route.js";

const inFlight = new Set();
const resolveToken = (connection, request) => {
  const headerToken = request?.headers?.get?.("x-zcode-token")?.trim();
  if (headerToken) return headerToken;

  if (request?.url) {
    try {
      const url = new URL(request.url);
      const queryToken = url.searchParams.get("token")?.trim();
      if (queryToken) return queryToken;
    } catch {}
  }

  return (
    connection?.providerSpecificData?.zcodeJwtToken ||
    connection?.providerSpecificData?.zaiBusinessToken ||
    connection?.accessToken ||
    connection?.apiKey ||
    ""
  );
};

const failure = (code, message, status = 400, extra = {}) =>
  Response.json({ ok: false, error: message, code, message, ...extra }, { status });

function mutationGuard(request) {
  const origin = request.headers.get("origin");
  if (origin) {
    let sameOrigin = false;
    try {
      const source = new URL(origin);
      const target = new URL(request.url);
      let host = (request.headers.get("host") || target.host).trim().toLowerCase();
      if (
        (source.protocol === "http:" && host.endsWith(":80")) ||
        (source.protocol === "https:" && host.endsWith(":443"))
      ) {
        host = host.slice(0, host.lastIndexOf(":"));
      }
      const protocolMatches =
        source.protocol === target.protocol ||
        (source.protocol === "https:" &&
          target.protocol === "http:" &&
          request.headers.get("sec-fetch-site") === "same-origin");
      sameOrigin =
        protocolMatches &&
        source.host === host &&
        !source.username &&
        !source.password &&
        source.pathname === "/" &&
        !source.search &&
        !source.hash;
    } catch {}
    if (!sameOrigin) return failure("cross_origin", "Cross-origin request rejected.", 403);
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return failure("invalid_content_type", "Content-Type must be application/json.");
  }
  return null;
}

async function resolveConnection(connectionId, request) {
  const connection = await getProviderConnectionById(connectionId);
  if (!connection) return { response: failure("not_found", "Connection not found.", 404) };
  if (connection.provider !== "glm") {
    return { response: failure("unsupported_provider", "GLM claim is only available for GLM connections.") };
  }
  const token = resolveToken(connection, request);
  if (!token) {
    return {
      response: failure(
        "missing_credential",
        "GLM connection has no stored ZCode session token or API key.",
      ),
    };
  }
  return {
    connection,
    token,
    proxyOptions: {
      ...(await resolveConnectionProxyConfig(connection.providerSpecificData)),
      strictProxy: false,
    },
  };
}

async function refresh(connection, force, proxyOptions) {
  try {
    return (await refreshAndUpdateCredentials(connection, force, proxyOptions))?.connection || connection;
  } catch {
    return connection;
  }
}

/**
 * GET: Preview claimable plans / gift cards for this connection
 */
export async function GET(request, { params }) {
  const { connectionId } = params;
  const resolved = await resolveConnection(connectionId, request);
  if (resolved.response) return resolved.response;

  let connection = resolved.connection;
  let attempts = 0;
  while (attempts < 2) {
    attempts++;
    try {
      const [plansData, balanceData] = await Promise.all([
        getGlmClaimablePlans(resolved.token, resolved.proxyOptions).catch((e) => ({ plans: [], error: e.message })),
        getGlmBalance(resolved.token, resolved.proxyOptions).catch(() => null),
      ]);
      return Response.json({
        ok: true,
        plans: plansData?.plans || [],
        count: plansData?.plans?.length || 0,
        activeBalances: balanceData?.balances || [],
        activePlans: balanceData?.plans || [],
        serverTime: plansData?.serverTime || balanceData?.server_time,
      });
    } catch (err) {
      if (err.status === 401 && attempts === 1) {
        connection = await refresh(connection, true, resolved.proxyOptions);
        resolved.token = resolveToken(connection, request);
        continue;
      }
      return failure("preview_failed", err.message || "Failed to preview GLM claimable plans.", err.status || 502);
    }
  }
  return failure("preview_failed", "Failed to fetch claimable plans after token refresh.", 502);
}

/**
 * POST: Claim a specific plan by planId
 */
export async function POST(request, { params }) {
  let lockKey;
  try {
    const guard = mutationGuard(request);
    if (guard) return guard;

    let body;
    try {
      body = await request.json();
    } catch {
      return failure("invalid_body", "Invalid JSON body.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return failure("invalid_body", "Request body must be a JSON object.");
    }

    const planId = typeof body.planId === "string" ? body.planId.trim() : "";
    if (!planId) {
      return failure("missing_plan_id", "planId is required.");
    }

    const { connectionId } = params;
    lockKey = `${connectionId}:claim:${planId}`;
    if (inFlight.has(lockKey)) {
      return failure("concurrent_request", "A claim request is already in progress for this plan.", 409);
    }
    inFlight.add(lockKey);

    const resolved = await resolveConnection(connectionId, request);
    if (resolved.response) return resolved.response;

    const captcha = body.captcha || {
      captchaVerifyParam: body.captchaVerifyParam,
      captchaRegion: body.captchaRegion,
    };

    let result = await claimGlmPlan(resolved.token, planId, resolved.proxyOptions, captcha);

    // If unauthorized on first attempt, try refreshing once
    if (!result?.ok && result?.status === 401) {
      const refreshedConn = await refresh(resolved.connection, true, resolved.proxyOptions);
      const refreshedToken = resolveToken(refreshedConn, request);
      if (refreshedToken && refreshedToken !== resolved.token) {
        result = await claimGlmPlan(refreshedToken, planId, resolved.proxyOptions, captcha);
      }
    }

    if (result?.ok) {
      return Response.json(result);
    }
    return failure(result?.code || "claim_failed", result?.message || "Failed to claim GLM plan.", result?.status || 502, result);
  } finally {
    if (lockKey) inFlight.delete(lockKey);
  }
}
