import { handleChat } from "@/sse/handlers/chat.js";
import { parseJsonBody } from "@/shared/utils/parseJsonBody.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;
async function ensureInitialized() {
  if (!initialized) {
    initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    },
  });
}

/**
 * POST /v1/responses/compact
 * OpenAI Responses API endpoint for compact output format
 */
export async function POST(request) {
  await ensureInitialized();
  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return Response.json({ error: { message: "Invalid JSON body", type: "invalid_request_error", code: "bad_request" } }, { status: 400 });
  }
  body._compact = true;
  const headers = new Headers(request.headers);
  // The rebuilt body is plain JSON, not the original compressed representation.
  headers.delete("content-encoding");
  headers.delete("content-length");
  const newRequest = new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: request.signal
  });
  return await handleChat(newRequest);
}
