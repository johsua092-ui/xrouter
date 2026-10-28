import { BaseExecutor } from "./base.js";
import crypto from "node:crypto";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  prepareToolMessages,
  parseToolCallReply,
  emitToolCallChunks,
  buildToolCallResponse,
} from "./deepseekWebToolBridge.js";

const GEMINI_URL = "https://gemini.google.com/app";
const STREAM_URL = "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const ROTATE_COOKIES_URL = "https://accounts.google.com/RotateCookies";
const ROTATE_SENTINEL_PAYLOAD = '[000,"-0000000000000000000"]';

/**
 * Auto-refresh short-lived __Secure-1PSIDTS cookie via Google's sentinel RPC (GSB standard)
 */
async function autoRotateGeminiCookies(cookieStr, proxyOptions) {
  if (!cookieStr || typeof cookieStr !== "string") return cookieStr;
  try {
    const res = await proxyAwareFetch(ROTATE_COOKIES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieStr,
        Origin: "https://gemini.google.com",
        Referer: "https://gemini.google.com/app",
        ...GEMINI_BROWSER_HEADERS,
      },
      body: ROTATE_SENTINEL_PAYLOAD,
    }, proxyOptions);

    if (res.ok) {
      const setCookies = res.headers.getSetCookie?.() || [];
      if (setCookies.length > 0) {
        let merged = cookieStr;
        for (const sc of setCookies) {
          const part = sc.split(";")[0].trim();
          if (part) {
            const [k] = part.split("=");
            if (merged.includes(`${k}=`)) {
              merged = merged.replace(new RegExp(`${k}=[^;]*`), part);
            } else {
              merged += `; ${part}`;
            }
          }
        }
        return merged;
      }
    }
  } catch {}
  return cookieStr;
}

const GEMINI_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

const GEMINI_BROWSER_HEADERS = {
  "User-Agent": GEMINI_USER_AGENT,
  "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "x-same-domain": "1",
  Origin: "https://gemini.google.com",
  Referer: "https://gemini.google.com/app",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

// Gemini Web model hashes and modes (from official web reverse contract)
const GEMINI_WEB_MODELS = {
  "gemini-4-argon": { hash: "95a4c0abcba24364", mode: 8, thinking: 1 },
  "gemini-4-argon-thinking": { hash: "95a4c0abcba24364", mode: 8, thinking: 2 },
  "gemini-3.8-flash": { hash: "56fdd199312815e2", mode: 1, thinking: 1 },
  "gemini-3.5-flash-lite": { hash: "cf41b0e0dd7d53e5", mode: 6, thinking: 1 },
  "gemini-3.1-pro": { hash: "e6fa609c3fa255c0", mode: 3, thinking: 1 },
  "gemini-3.1-pro-preview": { hash: "e6fa609c3fa255c0", mode: 3, thinking: 1 },
  "gemini-2.5-pro": { hash: "e6fa609c3fa255c0", mode: 3, thinking: 1 },
  "gemini-2.5-flash": { hash: "56fdd199312815e2", mode: 1, thinking: 1 },
  "gemini-2.5-flash-lite": { hash: "cf41b0e0dd7d53e5", mode: 6, thinking: 1 },
};

function getModelConfig(modelId) {
  const norm = String(modelId || "").toLowerCase();
  for (const [key, cfg] of Object.entries(GEMINI_WEB_MODELS)) {
    if (norm.includes(key)) return cfg;
  }
  return GEMINI_WEB_MODELS["gemini-3.8-flash"];
}
const SESSION_CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes validity

export function normalizeGeminiCookieInput(raw, cookieName = "__Secure-1PSID") {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const pairs = parsed
          .filter((c) => c && c.name && c.value)
          .map((c) => `${c.name}=${String(c.value).trim()}`);
        if (pairs.length > 0) return pairs.join("; ");
      }
      const cookies =
        parsed.cookies && typeof parsed.cookies === "object" && !Array.isArray(parsed.cookies)
          ? parsed.cookies
          : parsed;
      const pairs = Object.entries(cookies)
        .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
        .map(([k, v]) => `${k}=${String(v).trim()}`);
      if (pairs.length > 0) return pairs.join("; ");
    } catch {}
  }
  return trimmed.includes("=") ? trimmed : `${cookieName}=${trimmed}`;
}

export function buildGeminiPrompt(messages) {
  const historyLines = [];
  const systemParts = [];
  let lastUserContent = "";

  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === "system") {
      const txt = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      if (txt) systemParts.push(txt);
    } else if (m.role === "user") {
      const txt =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((c) => c.text || "").join("\n")
            : "";
      lastUserContent = txt;
      historyLines.push(`User: ${txt}`);
    } else if (m.role === "assistant") {
      const txt = typeof m.content === "string" ? m.content : "";
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          historyLines.push(
            `Assistant: <tool>${JSON.stringify({ name: tc.function?.name, arguments: tc.function?.arguments })}</tool>`
          );
        }
      } else if (txt) {
        historyLines.push(`Assistant: ${txt}`);
      }
    } else if (m.role === "tool") {
      historyLines.push(
        `[Tool Result (${m.name || m.tool_call_id || "tool"})]:\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`
      );
    }
  }

  const systemText = systemParts.join("\n\n");
  const previousConv = historyLines.slice(0, -1).join("\n\n");

  const parts = [];
  if (systemText) parts.push(`System:\n${systemText}`);
  if (previousConv) parts.push(`Previous conversation:\n${previousConv}`);
  parts.push(`Current user message:\n${lastUserContent}`);
  return parts.join("\n\n");
}

export function parseStreamResponse(raw) {
  const lines = String(raw || "").split("\n");
  let lastText = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === ")]}'" || /^\d+$/.test(line)) continue;
    try {
      const parsed = JSON.parse(line);
      const candidates = parsed?.[0]?.[2];
      if (typeof candidates === "string") {
        const nested = JSON.parse(candidates);
        const text = nested?.[4]?.[0]?.[1]?.[0];
        if (typeof text === "string" && text.length > 0) {
          lastText = text;
        }
      }
    } catch {}
  }
  return lastText;
}

export function parseCookies(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const idx = s.indexOf("=");
      if (idx === -1) return { name: s, value: "" };
      return { name: s.slice(0, idx).trim(), value: s.slice(idx + 1).trim() };
    });
}

export async function fetchSessionParams(cookie, proxyOptions = null) {
  const cached = sessionCache.get(cookie);
  if (cached && Date.now() < cached.expiresAt) {
    return { at: cached.at, bl: cached.bl };
  }

  const res = await proxyAwareFetch(GEMINI_URL, {
    headers: {
      Cookie: cookie,
      ...GEMINI_BROWSER_HEADERS,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
    },
    signal: AbortSignal.timeout(12000),
  }, proxyOptions);
  if (!res || !res.ok) return null;
  const html = await res.text();
  const atMatch = html.match(/"SNlM0e":"([^"]+)"/) || html.match(/\["SNlM0e","([^"]+)"\]/);
  const blMatch = html.match(/"cfb2h":"([^"]+)"/) || html.match(/\["cfb2h","([^"]+)"\]/);
  if (!atMatch || !blMatch) return null;
  
  const params = { at: atMatch[1], bl: blMatch[1] };
  sessionCache.set(cookie, { ...params, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
  return params;
}

function errorResponse(status, message) {
  return new Response(
    JSON.stringify({
      error: { message, type: "upstream_error", code: `HTTP_${status}` },
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", { baseUrl: GEMINI_URL });
  }

  async testConnection(credentials) {
    try {
      const raw = credentials?.apiKey || credentials?.cookie || "";
      const cookie = normalizeGeminiCookieInput(raw);
      if (!cookie) return false;
      return parseCookies(cookie).some((p) => p.value.length > 0);
    } catch {
      return false;
    }
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const bodyObj = body || {};
    const rawCreds = credentials || {};
    let cookie = normalizeGeminiCookieInput(rawCreds.apiKey || rawCreds.cookie || "");
    if (!cookie) {
      return {
        response: errorResponse(401, "Missing Gemini cookies (__Secure-1PSID)"),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const messages = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
    const hasTools = Array.isArray(bodyObj.tools) && bodyObj.tools.length > 0;

    // Bridge tools into prompt contract
    const { effectiveMessages } = prepareToolMessages(bodyObj, messages);
    const prompt = buildGeminiPrompt(effectiveMessages);

    const hasUser = messages.some(
      (m) =>
        (m.role === "user" || m.role === "tool") &&
        (typeof m.content === "string" ? m.content.trim().length > 0 : true)
    );
    if (!prompt || !hasUser) {
      return {
        response: errorResponse(400, "No user message found"),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const modelId = String(model || bodyObj.model || "gemini-2.5-pro");

    let session;
    try {
      // Check and auto-rotate cookies before executing query (GSB keepalive)
      cookie = await autoRotateGeminiCookies(cookie, proxyOptions);

      session = await fetchSessionParams(cookie, proxyOptions);
    } catch (err) {
      return {
        response: errorResponse(502, `Gemini session fetch failed: ${err instanceof Error ? err.message : "unknown"}`),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }
    if (!session) {
      return {
        response: errorResponse(401, "Gemini cookie expired or invalid, re-copy __Secure-1PSID and __Secure-1PSIDTS from gemini.google.com cookies"),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const reqId = Math.floor(Math.random() * 900000) + 100000;
    const rpcBody = `[null,"${prompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"]`;
    const params = new URLSearchParams({
      bl: session.bl,
      _reqid: String(reqId),
      rt: "c",
    });

    const mCfg = getModelConfig(modelId);
    const jspbHeader = JSON.stringify([
      1,
      null,
      null,
      null,
      mCfg.hash,
      null,
      null,
      1,
      [4, 5, 6, 8],
      null,
      null,
      2,
      null,
      null,
      mCfg.mode,
      mCfg.thinking,
      crypto.randomUUID ? crypto.randomUUID().toUpperCase() : "B49464E6-4170-4708-815E-C3C14E8D5E85",
    ]);

    let upstream;
    try {
      upstream = await proxyAwareFetch(
        `${STREAM_URL}?${params.toString()}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Cookie: cookie,
            ...GEMINI_BROWSER_HEADERS,
            "x-goog-ext-525001261-jspb": jspbHeader,
            "x-goog-ext-73010989-jspb": "[0]",
            "x-goog-ext-73010990-jspb": "[0,0,0]",
          },
          body: `f.req=${encodeURIComponent(`[[["SnzQ9e",${JSON.stringify(rpcBody)},null,"generic"]]]`)}&at=${encodeURIComponent(session.at)}&`,
          signal: signal ?? undefined,
        },
        proxyOptions
      );
    } catch (err) {
      return {
        response: errorResponse(502, `Gemini fetch failed: ${err instanceof Error ? err.message : "unknown"}`),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      log?.error?.("GEMINI-WEB", `Upstream HTTP ${upstream.status}`);
      return {
        response: errorResponse(upstream.status, `Gemini error: ${errText.slice(0, 300)}`),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const raw = await upstream.text().catch(() => "");
    const responseText = parseStreamResponse(raw);
    if (!responseText) {
      return {
        response: errorResponse(502, "No response from Gemini (cookie may be expired or the web endpoint changed)"),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    // Parse potential tool calls from model output
    let toolResult = { content: responseText, calls: [] };
    if (hasTools) {
      toolResult = parseToolCallReply(responseText, bodyObj.tools);
    }

    if (stream) {
      const encoder = new TextEncoder();
      const id = `chatcmpl-gwe-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const chunk = (delta, finish) => ({
        id,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });

      const readable = new ReadableStream({
        start(controller) {
          if (toolResult.calls.length > 0) {
            emitToolCallChunks(
              (delta, finish) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(delta, finish))}\n\n`));
              },
              () => {},
              toolResult.calls
            );
          } else {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: toolResult.content }, null))}\n\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return {
        response: new Response(readable, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    if (toolResult.calls.length > 0) {
      return {
        response: buildToolCallResponse({
          id: `chatcmpl-${Date.now()}`,
          model: modelId,
          messageText: toolResult.content,
          calls: toolResult.calls,
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    return {
      response: new Response(
        JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: toolResult.content },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      ),
      url: GEMINI_URL,
      headers: {},
      transformedBody: body,
    };
  }
}
