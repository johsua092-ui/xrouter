// Sesi upstream `x-opencode-session` harus STABIL sepanjang satu percakapan dan
// BERBEDA antar percakapan. Sebelumnya key diturunkan hanya dari identity credential,
// jadi provider noAuth (Bearer public) jatuh ke "opencode:default": semua percakapan
// berbagi satu sesi, sehingga isolasi percakapan hilang dan kuota per-sesi upstream
// tercampur. CLI resmi memakai satu sesi kanonik PER PERCAKAPAN.
import { describe, expect, it } from "vitest";
import { conversationScope, resolveOpencodeSession, stableSessionId } from "../../open-sse/executors/opencode.js";

const bodyA = {
  messages: [
    { role: "system", content: "You are Hermes." },
    { role: "user", content: "Halo, bantu audit egress stack" },
  ],
};
const bodyA_turn2 = {
  messages: [
    { role: "system", content: "You are Hermes." },
    { role: "user", content: "Halo, bantu audit egress stack" },
    { role: "assistant", content: "Siap." },
    { role: "user", content: "lanjut" },
  ],
};
const bodyB = {
  messages: [
    { role: "system", content: "You are Hermes." },
    { role: "user", content: "Topik lain sama sekali" },
  ],
};

describe("conversationScope", () => {
  it("stabil walau riwayat percakapan bertambah", () => {
    expect(conversationScope(bodyA_turn2)).toBe(conversationScope(bodyA));
  });

  it("berbeda untuk percakapan berbeda", () => {
    expect(conversationScope(bodyA)).not.toBe(conversationScope(bodyB));
  });

  it("membedakan percakapan yang hanya beda system prompt", () => {
    const other = { messages: [{ role: "system", content: "You are a poet." }, bodyA.messages[1]] };
    expect(conversationScope(other)).not.toBe(conversationScope(bodyA));
  });

  it("membedakan format Claude yang menaruh system prompt di root body.system", () => {
    const claude1 = { system: "You are an angel.", messages: [{ role: "user", content: "Hi" }] };
    const claude2 = { system: "You are a demon.", messages: [{ role: "user", content: "Hi" }] };
    expect(conversationScope(claude1)).not.toBe(conversationScope(claude2));
  });

  it("null bila tidak ada pesan yang bisa dipakai", () => {
    expect(conversationScope({ messages: [] })).toBe(null);
    expect(conversationScope(undefined)).toBe(null);
  });
});

describe("stableSessionId per percakapan", () => {
  const anon = { rawHeaders: {} };
  it("memberi sesi sama untuk percakapan yang sama", () => {
    expect(stableSessionId(anon, conversationScope(bodyA)))
      .toBe(stableSessionId(anon, conversationScope(bodyA_turn2)));
  });
  it("memberi sesi berbeda untuk percakapan berbeda", () => {
    expect(stableSessionId(anon, conversationScope(bodyA)))
      .not.toBe(stableSessionId(anon, conversationScope(bodyB)));
  });
  it("tetap memberi sesi valid saat scope null (perilaku lama dipertahankan)", () => {
    const sid = stableSessionId(anon, null);
    expect(sid).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(stableSessionId(anon, null)).toBe(sid);
  });
});

describe("resolveOpencodeSession pada koneksi bersama (jalur produksi nyata)", () => {
  // Jalur produksi: chatCore.js selalu menghitung providerSessionId dari
  // resolveSessionId() (sessionManager.js, deriveSessionId(connectionId)) lalu
  // meneruskannya SELALU. Pada koneksi "Public (Proxy)" yang dipakai bersama,
  // providerSessionId itu sama untuk SEMUA percakapan. Bug lama: `hinted =
  // incoming || normalizeSession(providerSessionId)` dipakai verbatim, jadi
  // semua percakapan di koneksi itu jatuh ke SATU sesi upstream -- cache/kuota
  // bercampur lintas percakapan (dibuktikan OBSERVED: req BRAVO menunjukkan
  // CACHE dari req ALFA meski topik sama sekali berbeda).
  const sharedProviderSessionId = "shared-pooled-connection-id-0001";
  const creds = { rawHeaders: {} };

  it("percakapan berbeda pada koneksi sama -> sesi upstream BEDA", () => {
    const sidA = resolveOpencodeSession(bodyA, creds, sharedProviderSessionId, "cli");
    const sidB = resolveOpencodeSession(bodyB, creds, sharedProviderSessionId, "cli");
    expect(sidA).not.toBe(sidB);
  });

  it("percakapan yang sama (riwayat bertambah) pada koneksi sama -> sesi TETAP", () => {
    const sid1 = resolveOpencodeSession(bodyA, creds, sharedProviderSessionId, "cli");
    const sid2 = resolveOpencodeSession(bodyA_turn2, creds, sharedProviderSessionId, "cli");
    expect(sid1).toBe(sid2);
  });

  it("header x-opencode-session asli klien tetap diprioritaskan verbatim", () => {
    const native = "ses_e20611112222aaaaaaaaaaaaaa";
    const credsHeader = { rawHeaders: { "x-opencode-session": native } };
    const sid = resolveOpencodeSession(bodyA, credsHeader, sharedProviderSessionId, "cli");
    expect(sid).toBe(native);
  });
});
