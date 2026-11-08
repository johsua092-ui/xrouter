import * as log from "../utils/logger.js";
import { updateProviderConnection, getProviderConnectionById } from "@/lib/localDb";
import { cooldownRegistry } from "./cooldownRegistry.js";

/**
 * Smart Circuit Breaker & Auto-Cooldown Recovery
 *
 * Implements a state machine for upstream provider connections:
 *   [HEALTHY] ──(429/5xx/Timeout)──> [COOLDOWN (30s-120s)] ──(Canary Success)──> [HEALTHY]
 *                                         │
 *                                  (Canary Failure / Max Tries)
 *                                         ▼
 *                                    [EXHAUSTED]
 *
 * Key benefits:
 * 1. Cooled-down connections are skipped in round-robin / fill-first rotation instantly without delay.
 * 2. When cooldown timer expires, a lightweight canary probe tests health.
 * 3. Successful probe auto-recovers testStatus to "active" and clears error state.
 */

// In-memory circuit breaker table: connectionId -> { state, cooldownUntil, failures, timer }
const circuitBreakerState = new Map();

const CIRCUIT_STATES = {
  HEALTHY: "healthy",
  COOLDOWN: "cooldown",
  EXHAUSTED: "exhausted",
};

const DEFAULT_COOLDOWN_MS = 45000; // 45 seconds initial quarantine
const MAX_FAILURES_BEFORE_EXHAUSTED = 5;

/**
 * Report a transient or rate-limit failure to the circuit breaker.
 */
export function tripCircuitBreaker(connectionId, { status = 429, error = "", provider = "", model = "" } = {}) {
  if (!connectionId || connectionId === "noauth") return;

  const now = Date.now();
  const existing = circuitBreakerState.get(connectionId) || {
    failures: 0,
    cooldownUntil: 0,
    state: CIRCUIT_STATES.HEALTHY,
  };

  const newFailures = existing.failures + 1;
  const backoffFactor = Math.min(newFailures, 4);
  const cooldownDuration = DEFAULT_COOLDOWN_MS * backoffFactor;
  const cooldownUntil = now + cooldownDuration;

  const nextState = newFailures >= MAX_FAILURES_BEFORE_EXHAUSTED
    ? CIRCUIT_STATES.EXHAUSTED
    : CIRCUIT_STATES.COOLDOWN;

  circuitBreakerState.set(connectionId, {
    state: nextState,
    failures: newFailures,
    cooldownUntil,
    provider,
    model,
    lastError: typeof error === "string" ? error.slice(0, 150) : `HTTP ${status}`,
  });

  log.warn("CIRCUIT", `🔌 Tripped circuit breaker for ${connectionId.slice(0, 8)} [${nextState.toUpperCase()}] cooldown=${Math.round(cooldownDuration / 1000)}s failures=${newFailures}`);
}

/**
 * Check if a connection is currently blocked by circuit breaker.
 * If cooldown expired, returns false (eligible for canary probe / rotation).
 */
export function isCircuitBreakerOpen(connectionId) {
  if (!connectionId) return false;
  const entry = circuitBreakerState.get(connectionId);
  if (!entry) return false;

  if (entry.state === CIRCUIT_STATES.EXHAUSTED) {
    // Auto-recovery canary after 10 minutes so transient errors do not quarantine indefinitely
    if (Date.now() - entry.cooldownUntil > 10 * 60 * 1000) {
      return false;
    }
    return true;
  }

  if (entry.state === CIRCUIT_STATES.COOLDOWN) {
    if (Date.now() < entry.cooldownUntil) {
      return true; // Still quarantined
    }
    // Cooldown elapsed: tentatively allow one request through as a canary probe
    return false;
  }

  return false;
}

/**
 * Record a successful request through this connection: resets circuit breaker to healthy.
 */
export function recordCircuitSuccess(connectionId) {
  if (!connectionId) return;
  cooldownRegistry.clear(connectionId);
  const entry = circuitBreakerState.get(connectionId);
  if (entry && (entry.failures > 0 || entry.state !== CIRCUIT_STATES.HEALTHY)) {
    circuitBreakerState.set(connectionId, {
      state: CIRCUIT_STATES.HEALTHY,
      failures: 0,
      cooldownUntil: 0,
    });
    log.info("CIRCUIT", `✅ Circuit breaker healed connection ${connectionId.slice(0, 8)} -> HEALTHY`);

    // Auto-heal DB status if it was marked unavailable
    updateProviderConnection(connectionId, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
    }).catch(() => {});
  }
}

/**
 * Periodic auto-recovery scanner: checks connections whose cooldown expired and marks them eligible.
 */
export function getCircuitBreakerMetrics() {
  const summary = { healthy: 0, cooldown: 0, exhausted: 0, totalTracked: circuitBreakerState.size };
  const now = Date.now();
  for (const [, val] of circuitBreakerState.entries()) {
    if (val.state === CIRCUIT_STATES.COOLDOWN && now >= val.cooldownUntil) {
      summary.healthy++;
    } else {
      summary[val.state] = (summary[val.state] || 0) + 1;
    }
  }
  return summary;
}
