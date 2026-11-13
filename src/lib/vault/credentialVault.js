import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { machineIdSync } from "node-machine-id";
import { DATA_DIR } from "@/lib/dataDir";

const ENCRYPT_ALGO = "aes-256-gcm";
const VAULT_SALT = "xrouter-credential-vault-salt-2026";

// Same persisted identity the server, the CLI and middleware read (see
// src/shared/utils/machineId.js). Deriving from this file instead of calling
// node-machine-id directly keeps every runtime — and every row sealed by another
// build or on a box that shares this DATA_DIR — on one key.
const MACHINE_ID_FILE = path.join(DATA_DIR, "machine-id");

let customMasterKey = null;
let cachedDerivedKey = null;
const warnedReasons = new Set();

export function setVaultMasterKey(key) {
  if (typeof key === "string" && key.trim()) {
    customMasterKey = crypto.createHash("sha256").update(key.trim()).digest();
    cachedDerivedKey = null;
  }
}

// A deployment whose DATA_DIR moved between hosts can pin the key explicitly
// instead of inheriting the new host's identity.
function envMasterKey() {
  const raw = process.env.VAULT_MASTER_KEY || process.env.CREDENTIAL_VAULT_KEY;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? crypto.createHash("sha256").update(trimmed).digest() : null;
}

function loadMachineIdentity() {
  try {
    const persisted = fs.readFileSync(MACHINE_ID_FILE, "utf8").trim();
    if (persisted) return persisted;
  } catch {}
  try {
    return machineIdSync();
  } catch {
    return null;
  }
}

function deriveKey() {
  if (customMasterKey) return customMasterKey;
  if (cachedDerivedKey) return cachedDerivedKey;

  const pinned = envMasterKey();
  if (pinned) {
    cachedDerivedKey = pinned;
    return cachedDerivedKey;
  }

  const mid = loadMachineIdentity();
  cachedDerivedKey = crypto
    .createHash("sha256")
    .update(mid ? mid + VAULT_SALT : VAULT_SALT)
    .digest();
  return cachedDerivedKey;
}

// One line per distinct failure instead of a stack trace per row: a vault the
// current host cannot open used to flood the console on every dashboard load and
// on every background refresh tick.
function warnUnsealOnce(reason, err) {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  console.warn(
    `[CredentialVault] Failed to unseal credential (${reason}): ${err?.message || err}. ` +
    `The value was sealed with a different vault key — set VAULT_MASTER_KEY to the sealing host's key to recover it.`
  );
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
 *
 * Returns null when the payload cannot be authenticated. It used to return the
 * raw ciphertext, which then travelled into upstream `Authorization: Bearer
 * enc:v1:...` headers and read as a valid-looking credential in the UI.
 */
export function unsealCredential(stored) {
  if (typeof stored !== "string" || !stored) return stored;
  if (!stored.startsWith("enc:v1:")) return stored; // Plaintext legacy, return as-is

  const parts = stored.split(":");
  if (parts.length !== 5) {
    warnUnsealOnce("malformed payload", new Error(`expected 5 segments, got ${parts.length}`));
    return null;
  }
  const [, , ivHex, tagHex, dataHex] = parts;

  try {
    const key = deriveKey();
    const decipher = crypto.createDecipheriv(ENCRYPT_ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(dataHex, "hex")) + decipher.final("utf8");
  } catch (err) {
    warnUnsealOnce("wrong key or corrupt payload", err);
    return null;
  }
}

/**
 * Check if a credential value is currently sealed with AES-256-GCM.
 */
export function isSealed(value) {
  return typeof value === "string" && value.startsWith("enc:v1:");
}
