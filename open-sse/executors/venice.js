import { BaseExecutor } from "./base.js";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let wreq = null;
try {
  wreq = require("wreq-js");
} catch (e) {
  // Graceful fallback if wreq-js not available
}

const VENICE_OUTERFACE_URL = "https://outerface.venice.ai";
const INFERENCE_URL = `${VENICE_OUTERFACE_URL}/api/inference/chat`;
const MINT_URL = `${VENICE_OUTERFACE_URL}/api/app/user/client_attestation/mint`;
const MIDDLEFACE_VERSION = "0.1.1267";
const DEFAULT_MODEL = "deepseek-v4-1-flash-uncensored";

function errorResponse(status, message) {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "venice_error",
        code: status,
      },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  );
}

export class VeniceExecutor extends BaseExecutor {
  constructor() {
    super("venice");
    this.noAuth = true;
    this.tokenCache = new Map(); // proxyUrl -> array of tokens
    this.proxyIndex = 0;
    this.localProxies = this.loadLocalProxies();
  }

  loadLocalProxies() {
    const defaultPath = process.env.VENICE_PROXY_FILE || "d:/app/file txt/proxyscrape_premium_http_proxies (5).txt";
    try {
      if (fs.existsSync(defaultPath)) {
        const raw = fs.readFileSync(defaultPath, "utf8");
        return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      }
    } catch {}
    return [];
  }

  resolveProxy(proxyOptions) {
    if (proxyOptions?.connectionProxyUrl && proxyOptions.connectionProxyEnabled !== false) {
      return proxyOptions.connectionProxyUrl;
    }
    if (this.localProxies.length > 0) {
      const p = this.localProxies[this.proxyIndex % this.localProxies.length];
      this.proxyIndex++;
      return p.startsWith("http://") || p.startsWith("https://") ? p : `http://${p}`;
    }
    return null;
  }

  async getAttestationToken(session, proxyKey) {
    const tokens = this.tokenCache.get(proxyKey) || [];
    if (tokens.length > 0) {
      return tokens.shift();
    }

    const mintRes = await session.fetch(MINT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://venice.ai",
        Referer: "https://venice.ai/chat/v2",
        "x-venice-middleface-version": MIDDLEFACE_VERSION,
        "x-venice-request-timestamp-ms": String(Date.now()),
        "Sec-CH-UA": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
      },
      body: JSON.stringify({
        count: 5,
        env: {
          nativeIntegrityOk: true,
          webdriver: false,
          unexpectedGlobalsCount: 0,
        },
      }),
    });

    if (mintRes.status !== 200) {
      throw new Error(`Attestation mint failed with HTTP ${mintRes.status}: ${await mintRes.text()}`);
    }

    const data = await mintRes.json();
    const minted = data.tokens ? data.tokens.map((t) => t.token) : [data.token];
    if (!minted || !minted.length) {
      throw new Error("No tokens returned from Venice attestation mint");
    }

    this.tokenCache.set(proxyKey, minted);
    return minted.shift();
  }

  formatPayload(model, bodyObj) {
    const rawModel = String(model || "").replace(/^(venice\/|venice-ai\/|veniceai\/)/, "") || DEFAULT_MODEL;
    const messages = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];

    let systemPrompt = "";
    const prompt = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemPrompt += (systemPrompt ? "\n" : "") + (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      } else {
        prompt.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        });
      }
    }

    if (!prompt.some((m) => m.role === "user")) {
      prompt.push({ role: "user", content: "Hello" });
    }

    return {
      requestId: crypto.randomUUID(),
      modelId: rawModel,
      prompt,
      systemPrompt: systemPrompt || undefined,
      temperature: bodyObj.temperature ?? 0.7,
      topP: bodyObj.top_p ?? 0.9,
      simpleMode: false,
    };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    if (!wreq) {
      return {
        response: errorResponse(500, "wreq-js is required for Venice executor TLS impersonation"),
        url: INFERENCE_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const bodyObj = body || {};
    const proxyUrl = this.resolveProxy(proxyOptions);
    const proxyKey = proxyUrl || "direct";

    let session;
    try {
      session = await wreq.createSession({
        profile: "chrome_133",
        proxy: proxyUrl || undefined,
        timeout: 45000,
      });
    } catch (err) {
      return {
        response: errorResponse(502, `Failed to initialize session via proxy ${proxyKey}: ${err.message}`),
        url: INFERENCE_URL,
        headers: {},
        transformedBody: body,
      };
    }

    let attestationToken;
    try {
      attestationToken = await this.getAttestationToken(session, proxyKey);
    } catch (err) {
      this.tokenCache.delete(proxyKey);
      return {
        response: errorResponse(502, `Venice Attestation error: ${err.message}`),
        url: MINT_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const payload = this.formatPayload(model, bodyObj);

    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json, */*",
      Origin: "https://venice.ai",
      Referer: "https://venice.ai/chat/v2",
      "x-venice-middleface-version": MIDDLEFACE_VERSION,
      "x-venice-request-timestamp-ms": String(Date.now()),
      "x-venice-client-attestation": attestationToken,
      "Sec-CH-UA": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
    };

    let upstreamRes;
    try {
      upstreamRes = await session.fetch(INFERENCE_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      return {
        response: errorResponse(502, `Failed to connect to Venice AI: ${err.message}`),
        url: INFERENCE_URL,
        headers,
        transformedBody: payload,
      };
    }

    if (!upstreamRes.ok) {
      this.tokenCache.delete(proxyKey);
      const errText = await upstreamRes.text().catch(() => "");
      return {
        response: errorResponse(upstreamRes.status, `Venice AI Error (${upstreamRes.status}): ${errText}`),
        url: INFERENCE_URL,
        headers,
        transformedBody: payload,
      };
    }

    const id = `chatcmpl-vnc-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const resolvedModel = payload.modelId;

    if (stream) {
      const encoder = new TextEncoder();
      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder("utf-8");

      const readable = new ReadableStream({
        async start(controller) {
          let buffer = "";

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                let contentChunk = "";
                try {
                  const parsed = JSON.parse(trimmed);
                  if (parsed.kind === "content" && parsed.content) {
                    contentChunk = parsed.content;
                  }
                } catch {
                  // Ignore metadata or parse failures
                }

                if (contentChunk) {
                  const sseChunk = {
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: resolvedModel,
                    choices: [
                      {
                        index: 0,
                        delta: { content: contentChunk },
                        finish_reason: null,
                      },
                    ],
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(sseChunk)}\n\n`));
                }
              }
            }

            // Emit final chunk
            const finalChunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model: resolvedModel,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
      });

      return {
        response: new Response(readable, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
        url: INFERENCE_URL,
        headers,
        transformedBody: payload,
      };
    }

    // Non-streaming response handling
    const rawBody = await upstreamRes.text().catch(() => "");
    let fullText = "";
    for (const line of rawBody.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.kind === "content" && parsed.content) {
          fullText += parsed.content;
        }
      } catch {}
    }

    const nonStreamBody = {
      id,
      object: "chat.completion",
      created,
      model: resolvedModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: fullText,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: Math.ceil(fullText.length / 4),
        total_tokens: 15 + Math.ceil(fullText.length / 4),
      },
    };

    return {
      response: new Response(JSON.stringify(nonStreamBody), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }),
      url: INFERENCE_URL,
      headers,
      transformedBody: payload,
    };
  }
}
