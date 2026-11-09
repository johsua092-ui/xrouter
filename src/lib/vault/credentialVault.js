import crypto from "node:crypto";
import { machineIdSync } from "node-machine-id";

const ENCRYPT_ALGO = "aes-256-gcm";
const VAULT_SALT = "xrouter-credential-vault-salt-2026";

let customMasterKey = null;

export function setVaultMasterKey(key) {
  if (typeof key === "string" && key.trim()) {
    customMasterKey = crypto.createHash("sha256").update(key.trim()).digest();
  }
}

function deriveKey() {
  if (customMasterKey) return customMasterKey;
  try {
    const mid = machineIdSync();
    return crypto.createHash("sha256").update(mid + VAULT_SALT).digest();
  } catch {
    return crypto.createHash("sha256").update(VAULT_SALT).digest();
  }
}

/**
 * Encrypt plaintext credential string using AES-256-GCM.
 * Output format: "enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>"
 */
export function sealCredential(plaintext) {
  if (typeof plaintext !== "string" || !plaintext) return plaintext;
  if (plaintext.startsWith("enc:v1:")) return plaintext; // Already sealed

  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPT_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `enc:v1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt credential sealed with sealCredential.
 * Backward compatible with plaintext legacy values.
 */
export function unsealCredential(stored) {
  if (typeof stored !== "string" || !stored) return stored;
  if (!stored.startsWith("enc:v1:")) return stored; // Plaintext legacy, return as-is

  const parts = stored.split(":");
  if (parts.length !== 5) return stored;
  const [, , ivHex, tagHex, dataHex] = parts;

  try {
    const key = deriveKey();
    const decipher = crypto.createDecipheriv(ENCRYPT_ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(dataHex, "hex")) + decipher.final("utf8");
  } catch (err) {
    console.error("[CredentialVault] Failed to unseal credential:", err.message);
    return stored;
  }
}

/**
 * Check if a credential value is currently sealed with AES-256-GCM.
 */
export function isSealed(value) {
  return typeof value === "string" && value.startsWith("enc:v1:");
}
