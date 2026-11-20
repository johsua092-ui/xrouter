/**
 * antigravity429Engine.js — 429 classification and cooldown decisions for Antigravity.
 *
 * Distinguishes spent-quota 429s (long cooldown) from transient rate-limit /
 * capacity 429s (short account switch), matching OmniRoute's antigravity429Engine
 * surface used by agyCliExecutor.
 */

export const SHORT_COOLDOWN_MS = 15 * 1000;
export const FULL_QUOTA_COOLDOWN_MS = 5 * 60 * 60 * 1000;
export const CAPACITY_COOLDOWN_MS = 30 * 1000;
export const TRANSIENT_429_COOLDOWN_MS = 60 * 1000;

function parseResetAfterMs(message) {
  if (!message || typeof message !== "string") return null;
  const match = message.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
  if (!match) return null;
  let totalMs = 0;
  if (match[1]) totalMs += parseInt(match[1], 10) * 3600 * 1000;
  if (match[2]) totalMs += parseInt(match[2], 10) * 60 * 1000;
  if (match[3]) totalMs += parseInt(match[3], 10) * 1000;
  return totalMs > 0 ? totalMs : null;
}

/**
 * Classify an Antigravity 429 error text into a structured kind.
 * Distinguishes explicit account-level quota exhaustion (long cooldown)
 * from detail-free generic rate-limit / capacity throttles (transient 60s cooldown).
 * @param {string} message
 */
export function classify429(message) {
  const text = String(message || "");
  const resetAfterMs = parseResetAfterMs(text);
  if (
    /\bQUOTA_EXHAUSTED\b/i.test(text) ||
    /(?:daily|monthly|account|subscription|billing)[\s\S]{0,80}(?:quota|limit|credits?)[\s\S]{0,40}(?:exceeded|exhausted|reached|depleted)\b/i.test(text) ||
    /\b(insufficient[\s_-]+credits?|credits?[\s_-]+balance[\s_-]+is[\s_-]+too[\s_-]+low|quota[\s_-]+depleted)\b/i.test(text) ||
    /quota\s+will\s+reset/i.test(text)
  ) {
    return { kind: "quota_exhausted", resetAfterMs };
  }
  if (
    /\bMODEL_CAPACITY_EXHAUSTED\b/i.test(text) ||
    /high\s+traffic/i.test(text) ||
    /\bcapacity\b/i.test(text) ||
    /overloaded/i.test(text)
  ) {
    return { kind: "capacity", resetAfterMs };
  }
  if (
    /\bRESOURCE_EXHAUSTED\b/i.test(text) ||
    /resource has been exhausted/i.test(text) ||
    /too many requests|rate[_ -]?limit/i.test(text)
  ) {
    return { kind: "rate_limit", resetAfterMs };
  }
  return { kind: "unknown", resetAfterMs };
}

/**
 * Decide cooldown duration from a classified 429 and optional header retry ms.
 * @param {{ kind: string, resetAfterMs?: number | null }} classified
 * @param {number | null | undefined} headerRetryMs
 */
export function decide429(classified, headerRetryMs = null) {
  if (typeof headerRetryMs === "number" && headerRetryMs > 0) {
    return { retryAfterMs: headerRetryMs };
  }
  if (typeof classified?.resetAfterMs === "number" && classified.resetAfterMs > 0) {
    return { retryAfterMs: classified.resetAfterMs };
  }
  if (classified?.kind === "quota_exhausted") {
    return { retryAfterMs: FULL_QUOTA_COOLDOWN_MS };
  }
  if (classified?.kind === "capacity") {
    return { retryAfterMs: CAPACITY_COOLDOWN_MS };
  }
  if (classified?.kind === "rate_limit") {
    return { retryAfterMs: TRANSIENT_429_COOLDOWN_MS };
  }
  return { retryAfterMs: SHORT_COOLDOWN_MS };
}
