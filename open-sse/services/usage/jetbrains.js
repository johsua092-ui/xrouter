/**
 * JetBrains AI (Grazie) usage & quota.
 * Access is granted via Grazie Lite license (grazie.individual.lite) with
 * free unlimited access to GPT-6 Luna (1.05M Context).
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { getAdapter } from "@/lib/db/driver.js";

const JETBRAINS_MODELS_URL = "https://api.jetbrains.ai/user/v5/llm/openai/v1/models";

function getTodayDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function getLocalUsageForConnection(connectionId) {
  if (!connectionId) return { requests: 0, tokens: 0 };
  try {
    const db = await getAdapter();
    const dateKey = getTodayDateKey();

    // 1. Check usageDaily (fast memory/indexed read)
    const row = await db.get("SELECT data FROM usageDaily WHERE dateKey = ?", [dateKey]);
    if (row?.data) {
      const day = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
      const accountData = day?.byAccount?.[connectionId];
      if (accountData) {
        const requests = accountData.requests || 0;
        const tokens = (accountData.promptTokens || 0) + (accountData.completionTokens || 0);
        return { requests, tokens };
      }
    }

    // 2. Fallback: Query usageHistory for this connection today
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const historyRow = await db.get(
      "SELECT COUNT(*) as requests, COALESCE(SUM(promptTokens + completionTokens), 0) as totalTokens FROM usageHistory WHERE connectionId = ? AND timestamp >= ?",
      [connectionId, startOfDay.toISOString()]
    );
    if (historyRow) {
      return {
        requests: historyRow.requests || 0,
        tokens: historyRow.totalTokens || 0,
      };
    }
  } catch {}
  return { requests: 0, tokens: 0 };
}

export async function getJetBrainsUsage(connection, proxyOptions = null) {
  const psd = connection?.providerSpecificData || {};
  const licenseId = psd.licenseId || "Active";
  const jwt = psd.grazieJwt || connection?.accessToken || "";

  // Decode expiration from grazieJwt payload
  let resetAt = null;
  if (jwt && typeof jwt === "string" && jwt.includes(".")) {
    try {
      const parts = jwt.split(".");
      if (parts.length > 1) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
        if (payload.exp && Number.isFinite(payload.exp)) {
          resetAt = new Date(payload.exp * 1000).toISOString();
        }
      }
    } catch {}
  }

  // Quick connectivity / license verification against models endpoint
  let upstreamActive = true;
  if (jwt) {
    try {
      const res = await proxyAwareFetch(
        JETBRAINS_MODELS_URL,
        {
          method: "GET",
          headers: {
            "Grazie-Authenticate-JWT": jwt,
            "Grazie-Agent": JSON.stringify({ name: "Pulse", version: "1" }),
          },
          signal: AbortSignal.timeout(6000),
        },
        proxyOptions
      );
      if (res && (res.ok || res.status === 200)) {
        upstreamActive = true;
      } else if (res && (res.status === 401 || res.status === 403)) {
        upstreamActive = false;
      }
    } catch {
      // Network hiccup - keep active
    }
  }

  if (!upstreamActive) {
    return {
      plan: "JetBrains AI (Grazie Lite)",
      message: "Token expired or revoked. Please test connection or reconnect.",
    };
  }

  // Query local usage recorded today for this connection
  const localUsage = await getLocalUsageForConnection(connection?.id);

  const quotas = {
    "gpt-6-luna": {
      used: localUsage.requests,
      total: 0,
      remainingPercentage: 100,
      resetAt,
      unlimited: true,
      description: `License: ${licenseId} · Free unlimited access to GPT-6 Luna (1.05M Context)`,
    },
  };

  if (localUsage.tokens > 0) {
    quotas["Tokens Today"] = {
      used: localUsage.tokens,
      total: 0,
      remainingPercentage: 100,
      resetAt,
      unlimited: true,
      unit: "tokens",
    };
  }

  return {
    plan: "JetBrains AI (Grazie Lite)",
    quotas,
  };
}
