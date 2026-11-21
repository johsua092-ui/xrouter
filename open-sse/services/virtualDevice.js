import crypto from "crypto";

/**
 * Virtual Device Profile Isolation (Antigravity-Shield parity)
 *
 * Each authenticated connection receives an isolated, deterministic
 * hardware profile (machineId) and RFC 4122 v4 device UUID.
 * This prevents Google's upstream telemetry from correlating multiple
 * accounts to a single physical device footprint or flagging account rotations.
 */
export function getVirtualDeviceProfile(connectionIdOrSeed) {
  const seed = String(connectionIdOrSeed || "antigravity:default:seed");
  const machineId = crypto.createHash("sha256").update(`machine:${seed}`).digest("hex");

  // Deterministic RFC 4122 UUID v4
  const bytes = crypto.createHash("sha256").update(`device-uuid:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC 4122 version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  const deviceUuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

  return {
    machineId,
    deviceUuid,
  };
}

/**
 * Sanitizes access tokens, client secrets, and sensitive bearer headers
 * from logs and telemetry payloads to prevent credential leakage.
 */
export function sanitizeLogOutput(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/ya29\.[a-zA-Z0-9_\-]+/g, "ya29.***REDACTED***")
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer ***REDACTED***")
    .replace(/GOCSPX-[a-zA-Z0-9_\-]+/g, "GOCSPX-***REDACTED***");
}
