import { describe, it, expect } from "vitest";
import { sealCredential, unsealCredential, isSealed } from "../../src/lib/vault/credentialVault.js";

describe("credential vault (AES-256-GCM)", () => {
  it("seals plaintext credentials into enc:v1 format", () => {
    const secret = "sk-test-secret-key-12345";
    const sealed = sealCredential(secret);

    expect(sealed).not.toBe(secret);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
  });

  it("unseals ciphertext back to original plaintext", () => {
    const secret = "gho_sampleGithubOAuthToken123456789";
    const sealed = sealCredential(secret);
    const unsealed = unsealCredential(sealed);

    expect(unsealed).toBe(secret);
  });

  it("leaves unsealed legacy plaintext untouched (backward compatibility)", () => {
    const legacy = "plaintext-api-key-from-old-db";
    expect(unsealCredential(legacy)).toBe(legacy);
  });
});
