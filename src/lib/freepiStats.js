import { getProviderConnections } from "@/lib/localDb";
import { getFreePiMetrics, getFreePiQueuePressure } from "../../open-sse/executors/freepi.js";

// A single account deeper than this means requests are waiting on a slot, which
// for a pool of two should never happen for long.
const QUEUE_ALERT_DEPTH = 8;

/**
 * Pool snapshot for the dashboard panel and for scraping.
 *
 * The executor keeps per-token state keyed by a hash, so account identity has to
 * come from the DB: for each active FreePI connection we read its queue pressure
 * with its own token. Counters are process-lifetime (rate() material), the map
 * sizes are gauges.
 */
export async function collectFreePiStats() {
  let connections = [];
  try {
    connections = await getProviderConnections({ provider: "freepi", isActive: true });
  } catch {
    connections = [];
  }

  const accounts = connections.map((connection) => {
    const pressure = getFreePiQueuePressure(connection.accessToken || connection.apiKey || "");
    const lastError = connection.lastError || null;
    const needsReauth =
      connection.errorCode === "unauthorized" || /invalid or expired token/i.test(lastError || "");
    const rateLimited =
      connection.rateLimitedUntil && new Date(connection.rateLimitedUntil).getTime() > Date.now();

    return {
      id: connection.id,
      name: connection.displayName || connection.name || connection.email || String(connection.id).slice(0, 8),
      status: needsReauth ? "needs_reauth" : rateLimited ? "rate_limited" : pressure.total > 0 ? "busy" : "idle",
      running: pressure.running,
      waiting: pressure.waiting,
      reserved: pressure.reserved,
      queueDepth: pressure.total,
      testStatus: connection.testStatus || null,
      lastError,
      rateLimitedUntil: connection.rateLimitedUntil || null,
      priority: connection.priority ?? null,
    };
  });

  const metrics = getFreePiMetrics();
  const alerts = [];

  if (accounts.length === 0) {
    alerts.push("no active FreePI account");
  } else {
    if (accounts.every((a) => a.status === "needs_reauth")) {
      alerts.push("every FreePI account needs re-authentication");
    }
    const deepest = accounts.reduce((max, a) => Math.max(max, a.queueDepth), 0);
    if (deepest >= QUEUE_ALERT_DEPTH) alerts.push(`queue depth ${deepest} on one account`);
  }
  if (metrics.authFailures > 0 && accounts.length > 0 && accounts.every((a) => a.status !== "needs_reauth")) {
    alerts.push(`${metrics.authFailures} upstream 401(s) since start`);
  }

  return {
    provider: "freepi",
    accounts,
    totals: {
      accounts: accounts.length,
      idle: accounts.filter((a) => a.status === "idle").length,
      busy: accounts.filter((a) => a.status === "busy").length,
      needsReauth: accounts.filter((a) => a.status === "needs_reauth").length,
      // inFlight counts the streams holding a slot; waiting is what is queued
      // behind them. Summing both under one label reads as "4 queued" when four
      // streams are simply running, one per account.
      inFlight: accounts.reduce((sum, a) => sum + a.running, 0),
      waiting: accounts.reduce((sum, a) => sum + a.waiting, 0),
    },
    metrics,
    alerts,
    generatedAt: new Date().toISOString(),
  };
}
