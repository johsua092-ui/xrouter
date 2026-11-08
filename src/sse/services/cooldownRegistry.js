/**
 * Dynamic Cooldown Registry & Intelligent Rate-Limit Backoff
 * Inspired by voidmind-io/voidllm (internal/cooldown/registry.go)
 *
 * Distinguishes temporary rate-limiting (HTTP 429) from hard circuit-breaker failures:
 * - Opportunistic eviction of expired cooldowns (no memory leak)
 * - Exact Retry-After header parsing (seconds or HTTP date)
 * - Multi-deployment / connection scoped tracking
 * - High-speed in-memory check with nil/empty safety
 */

class CooldownRegistry {
  constructor() {
    this.until = new Map();
    this.reasons = new Map();
  }

  /**
   * Mark a connection or deployment key in cooldown for a duration in milliseconds.
   * Opportunistically evicts expired entries on write.
   */
  mark(key, durationMs, reason = "Rate limited (429)") {
    if (!key) return;
    const now = Date.now();
    const expiry = now + Math.max(1000, durationMs || 30000);

    // Opportunistic eviction of expired keys to prevent memory growth
    for (const [k, exp] of this.until.entries()) {
      if (exp <= now) {
        this.until.delete(k);
        this.reasons.delete(k);
      }
    }

    this.until.set(key, expiry);
    this.reasons.set(key, typeof reason === "string" ? reason.slice(0, 150) : "Cooldown");
  }

  /**
   * Mark cooldown using a Retry-After header value (seconds or date)
   * Falls back to defaultDurationMs if missing or unparseable.
   */
  markFromRetryAfter(key, retryAfterHeader, defaultDurationMs = 30000, reason = "HTTP 429") {
    if (!key) return;
    let ms = defaultDurationMs;

    if (retryAfterHeader) {
      const parsedSeconds = parseInt(retryAfterHeader, 10);
      if (!isNaN(parsedSeconds) && parsedSeconds > 0) {
        ms = parsedSeconds * 1000;
      } else {
        const parsedDate = new Date(retryAfterHeader).getTime();
        if (!isNaN(parsedDate) && parsedDate > Date.now()) {
          ms = parsedDate - Date.now();
        }
      }
    }

    // Clamp cooldown duration between 3s and 10 minutes
    ms = Math.min(Math.max(ms, 3000), 10 * 60 * 1000);
    this.mark(key, ms, reason);
  }

  /**
   * Check if the key is currently cooling down.
   * Returns true if cooling, false if available.
   */
  isCooling(key) {
    if (!key) return false;
    const expiry = this.until.get(key);
    if (!expiry) return false;

    if (Date.now() >= expiry) {
      this.until.delete(key);
      this.reasons.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Get remaining cooldown time in milliseconds, or 0 if not cooling.
   */
  getRemainingMs(key) {
    if (!key) return 0;
    const expiry = this.until.get(key);
    if (!expiry) return 0;

    const remaining = expiry - Date.now();
    if (remaining <= 0) {
      this.until.delete(key);
      this.reasons.delete(key);
      return 0;
    }

    return remaining;
  }

  /**
   * Clear cooldown for a specific key (manual reset / healing).
   */
  clear(key) {
    if (!key) return;
    this.until.delete(key);
    this.reasons.delete(key);
  }

  /**
   * Get active metrics for telemetry / dashboard.
   */
  getMetrics() {
    const now = Date.now();
    const active = [];
    for (const [k, exp] of this.until.entries()) {
      if (exp > now) {
        active.push({
          key: k,
          remainingSeconds: Math.ceil((exp - now) / 1000),
          reason: this.reasons.get(k) || "Cooldown",
        });
      }
    }
    return {
      coolingCount: active.length,
      activeCooldowns: active,
    };
  }
}

export const cooldownRegistry = new CooldownRegistry();
