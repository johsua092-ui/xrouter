import { PROVIDER_MODELS } from "@/shared/constants/models";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Returns models in Gemini API format
 */
import { getSettings } from "@/lib/localDb";
import { isValidApiKey, apiKeyGateFailure } from "@/sse/services/auth.js";
import { getClientIp } from "@/lib/auth/loginLimiter";

export async function GET(request) {
  try {
    const settings = await getSettings();
    const auth = String(request?.headers?.get("authorization") || "");
    const bearer = auth.match(/^Bearer\s+(.+)$/i);
    const apiKey = (bearer?.[1] || request?.headers?.get("x-goog-api-key") || request?.headers?.get("x-api-key") || "").trim() || null;
    if (settings?.requireApiKey && apiKey) {
      const failure = apiKeyGateFailure(await isValidApiKey(apiKey, null, getClientIp(request)), true);
      if (failure) {
        return Response.json({ error: { message: failure.message } }, { status: failure.status });
      }
    }
    const models = [];
    const seen = new Set();

    function addModel({ name, displayName, description, methods = ["generateContent"] }) {
      if (seen.has(name)) return;
      seen.add(name);
      models.push({
        name,
        displayName,
        description,
        supportedGenerationMethods: methods,
        inputTokenLimit: 128000,
        outputTokenLimit: 8192,
      });
    }
    
    for (const [provider, providerModels] of Object.entries(PROVIDER_MODELS)) {
      for (const model of providerModels) {
        addModel({
          name: `models/${provider}/${model.id}`,
          displayName: model.name || model.id,
          description: `${provider} model: ${model.name || model.id}`,
        });

        if (provider === "gemini") {
          addModel({
            name: `models/${model.id}`,
            displayName: model.name || model.id,
            description: `Gemini model: ${model.name || model.id}`,
            methods: ["generateContent", "streamGenerateContent"],
          });
        }
      }
    }

    return Response.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}
