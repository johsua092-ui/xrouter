import { BaseExecutor } from "./base.js";

const JETBRAINS_INFERENCE_URL = "https://api.jetbrains.ai/user/v5/llm/openai/v1/chat/completions";
const MAX_INPUT_CHARS = 5_200_000; // ~922K tokens hard ceiling

export class JetBrainsExecutor extends BaseExecutor {
  constructor(provider = "jetbrains", config = { baseUrl: JETBRAINS_INFERENCE_URL }) {
    super(provider, config || { baseUrl: JETBRAINS_INFERENCE_URL });
  }

  async execute(params) {
    const { body } = params || {};
    if (Array.isArray(body?.messages)) {
      let totalChars = 0;
      for (const m of body.messages) {
        if (typeof m?.content === "string") {
          totalChars += m.content.length;
        } else if (Array.isArray(m?.content)) {
          for (const part of m.content) {
            if (part?.type === "text" && typeof part.text === "string") {
              totalChars += part.text.length;
            }
          }
        }
      }

      if (totalChars > MAX_INPUT_CHARS) {
        return {
          response: new Response(
            JSON.stringify({
              error: {
                message: "Input tokens exceed the configured limit of 922000 tokens. Please reduce the length of the messages.",
                type: "invalid_request_error",
                code: "context_length_exceeded",
              },
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          ),
          url: JETBRAINS_INFERENCE_URL,
          headers: {},
          transformedBody: body,
          responseFormat: "openai",
        };
      }
    }

    return await super.execute(params);
  }

  getBaseUrls() {
    return [JETBRAINS_INFERENCE_URL];
  }

  getFallbackCount() {
    return 1;
  }

  buildUrl(_model, _stream, _urlIndex, _credentials) {
    return JETBRAINS_INFERENCE_URL;
  }

  buildHeaders(credentials, _stream, _url, _model, _body) {
    const headers = {
      "Content-Type": "application/json",
      "Grazie-Agent": JSON.stringify({ name: "Pulse", version: "1" }),
      "X-Forced-License-Free": "2",
      "X-Accept-EAP-License": "false",
      "X-Accept-Release-License": "false",
    };

    const jwt = credentials?.providerSpecificData?.grazieJwt || credentials?.accessToken || credentials?.apiKey || "";
    if (jwt) {
      headers["Grazie-Authenticate-JWT"] = jwt;
    }

    if (_stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  transformRequest(_model, body, stream, _credentials) {
    const payload = { ...body };

    // JetBrains Free model is gpt-6-luna
    payload.model = "gpt-6-luna";

    // OpenAI endpoint on JetBrains rejects max_tokens; requires max_completion_tokens
    if (payload.max_tokens !== undefined) {
      payload.max_completion_tokens = payload.max_tokens;
      delete payload.max_tokens;
    }

    // Default to at least 4096 (or minimum 500) so reasoning tokens don't exhaust output budget
    if (!payload.max_completion_tokens || payload.max_completion_tokens < 500) {
      payload.max_completion_tokens = 4096;
    }

    // Upstream requires stream_options.include_usage: true when stream is true
    if (stream || payload.stream) {
      payload.stream = true;
      payload.stream_options = {
        ...(payload.stream_options || {}),
        include_usage: true,
      };
    }

    // Upstream rejects function tools when reasoning_effort is not 'none' in /v1/chat/completions.
    // Strip empty tools array to avoid triggering unnecessary upstream validations.
    if (Array.isArray(payload.tools) && payload.tools.length === 0) {
      delete payload.tools;
    }
    if (Array.isArray(payload.functions) && payload.functions.length === 0) {
      delete payload.functions;
    }

    const hasTools = (Array.isArray(payload.tools) && payload.tools.length > 0) ||
      (Array.isArray(payload.functions) && payload.functions.length > 0);
    if (hasTools) {
      payload.reasoning_effort = "none";
    }

    return payload;
  }

  parseError(response, bodyText) {
    let message = bodyText;
    let code = "upstream_error";
    let type = "invalid_request_error";

    try {
      const json = JSON.parse(bodyText);
      if (json.error) {
        message = json.error.message || message;
        code = json.error.code || code;
        type = json.error.type || type;
      } else if (json.message) {
        message = json.message;
      }
    } catch {}

    return {
      status: response.status,
      message,
      code,
      type,
    };
  }
}
