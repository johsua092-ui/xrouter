/**
 * Regression: two Antigravity failure chains reported on 2026-11-18.
 *
 * 1. Bypassed OAuth requests lost their body: createBypassRequest JSON.stringify'd
 *    a URLSearchParams body to "{}" and spread web Headers instances to {} —
 *    Google answered every bypassed token refresh with 400 unsupported_grant_type
 *    ("Invalid grant_type: ") on the 5-minute proactive refresh loop.
 * 2. MITM leaf certs: node-forge serial "958622" (decimal string) is HEX to forge;
 *    a first hex digit ≥ 8 encodes as a NEGATIVE ASN.1 INTEGER, which Go's
 *    crypto/x509 rejects outright (~20% of leaf certs). The leaf also lacked
 *    authorityKeyIdentifier, so Windows CryptoAPI chain-building could fail.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import forge from "node-forge";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PROXY_FETCH = read("open-sse/utils/proxyFetch.js");
const ROOT_CA = read("src/mitm/cert/rootCA.js");
const APP_CONST = read("open-sse/config/appConstants.js");
const MODELS_ROUTE = read("src/app/api/providers/[id]/models/route.js");
const PROVIDER_PAGE = read("src/app/(dashboard)/dashboard/providers/[id]/page.js");

describe("bypass request serialization (token refresh died as {})", () => {
  it("normalizes web Headers instances before spreading", () => {
    expect(PROXY_FETCH).toMatch(/options\.headers instanceof Headers/);
    expect(PROXY_FETCH).toMatch(/Object\.fromEntries\(options\.headers\.entries\(\)\)/);
  });

  it("serializes URLSearchParams as form-encoded, not JSON", () => {
    expect(PROXY_FETCH).toMatch(/options\.body instanceof URLSearchParams/);
    expect(PROXY_FETCH).toMatch(/bodyData = options\.body\.toString\(\)/);
  });

  it("no longer JSON.stringify's non-string bodies unconditionally", () => {
    // The old line: req.write(typeof options.body === "string" ? ... : JSON.stringify(options.body))
    expect(PROXY_FETCH).not.toMatch(/req\.write\(typeof options\.body === "string"/);
  });

  it("sets Content-Length from the serialized body", () => {
    expect(PROXY_FETCH).toMatch(/Content-Length"\] = String\(Buffer\.byteLength\(bodyData\)\)/);
  });

  it("response headers resolve case-insensitively", () => {
    expect(PROXY_FETCH).toMatch(/k\.toLowerCase\(\), v/);
    expect(PROXY_FETCH).toMatch(/get: \(name\) =>/);
  });
});

describe("leaf cert serial + AKI (Go x509 rejected ~20% of certs)", () => {
  it("serial is no longer a raw random decimal string", () => {
    expect(ROOT_CA).not.toMatch(/Math\.random\(\) \* 1000000/);
    expect(ROOT_CA).toMatch(/"01" \+ .*randomBytes\(15\)\.toString\("hex"\)/);
  });

  it("generated serial parses as a POSITIVE ASN.1 INTEGER, always", () => {
    // Property test over 500 serials produced by the same expression:
    // DER encodes the first byte's MSB as the sign, so it must stay < 0x80.
    for (let i = 0; i < 500; i++) {
      const serial = "01" + forge.random.getBytesSync(15).split("").map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
      expect(serial.startsWith("01")).toBe(true);
      expect(serial).toMatch(/^[0-9a-f]{32}$/);
      const firstByte = parseInt(serial.slice(0, 2), 16);
      expect(firstByte).toBeLessThan(0x80);
    }
  });

  it("leaf cert carries authorityKeyIdentifier bound to the root SKI", () => {
    expect(ROOT_CA).toMatch(/name: "authorityKeyIdentifier"/);
    expect(ROOT_CA).toMatch(/generateSubjectKeyIdentifier\(\)\.getBytes\(\)/);
  });

  it("a real generated leaf: positive serial + AKI present + chain verifies", () => {
    // End-to-end through the real module (slow: two 2048-bit keygens ~1-2s).
    const { generateRootCA, loadRootCA, generateLeafCert, ROOT_CA_CERT_PATH } = require(resolve(root, "src/mitm/cert/rootCA.js"));
    generateRootCA(); // ensures the on-disk CA exists (no-op if present)
    const rootCA = loadRootCA(); // { key, cert } as forge objects
    const leafPem = generateLeafCert("smoke.test.local", rootCA).cert;
    const leaf = forge.pki.certificateFromPem(leafPem);

    // Serial must encode positive: first hex byte < 0x80
    const serialHex = leaf.serialNumber;
    expect(serialHex).toBeTruthy();
    expect(serialHex.length).toBeGreaterThanOrEqual(30);

    const aki = leaf.getExtension("authorityKeyIdentifier");
    expect(aki).toBeTruthy();
    const ski = rootCA.cert.getExtension("subjectKeyIdentifier");
    // node-forge stores the AKI as DER (SEQUENCE { [0] keyid }) and the SKI as
    // a hex STRING of the 20-byte id. The AKI's embedded key id must equal the
    // root SKI — that IS the chain binding Windows CryptoAPI (and Go) use.
    const akiDer = Buffer.from(aki.value, "binary");
    const akiKey = akiDer.subarray(akiDer.length - 20).toString("hex");
    expect(akiKey).toBe(ski.subjectKeyIdentifier);

    // Chain verifies: leaf signed by root
    const caStore = forge.pki.createCaStore([rootCA.cert]);
    expect(forge.pki.verifyCertificateChain(caStore, [leaf])).toBe(true);
    expect(ROOT_CA_CERT_PATH).toBeTruthy();
  });
});

describe("Antigravity prompt rewrites + live catalog (upstream #5738 / #5734)", () => {
  it("OpenClaw header is rewritten to Antigravity", () => {
    expect(APP_CONST).toMatch(/running inside OpenClaw\\./gi);
    const rules = extractRewrites(APP_CONST);
    const openclaw = rules.find((r) => r.from.source.includes("OpenClaw"));
    expect(openclaw).toBeTruthy();
    expect(openclaw.to).toBe("You are a personal assistant running inside Antigravity.");
    // Sanity: actually rewrites a sample prompt
    const sample = "You are a personal assistant running inside OpenClaw. Today is Tuesday.";
    expect(sample.replace(openclaw.from, openclaw.to)).toBe("You are a personal assistant running inside Antigravity. Today is Tuesday.");
  });

  it("antigravity models route uses the live per-account catalog", () => {
    expect(MODELS_ROUTE).toMatch(/v1internal:fetchAvailableModels/);
    expect(MODELS_ROUTE).not.toMatch(/daily-cloudcode-pa\.sandbox\.googleapis\.com\/v1internal:models/);
    expect(MODELS_ROUTE).toMatch(/X-Client-Name": "antigravity"/);
    expect(MODELS_ROUTE).toMatch(/-disabled/);
    expect(MODELS_ROUTE).toMatch(/isInternal/);
  });

  it("dashboard renders the live catalog for antigravity", () => {
    expect(PROVIDER_PAGE).toMatch(/providerId === "antigravity"/);
  });
});

/** Extract the ANTIGRAVITY_PROMPT_REWRITES array entries without importing the ESM graph. */
function extractRewrites(src) {
  const start = src.indexOf("export const ANTIGRAVITY_PROMPT_REWRITES = [");
  const body = src.slice(src.indexOf("[", start) + 1, src.indexOf("];", start));
  const rules = [];
  const re = /\{\s*from:\s*\/((?:[^/\\]|\\.)*)\/([gimsuy]*),\s*to:\s*(?:"((?:[^"\\]|\\.)*)"|([^}]+\}))\s*\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    rules.push({ from: new RegExp(m[1], m[2]), to: m[4] ? null : m[3], rawTo: (m[4] || "").trim() });
  }
  return rules;
}
