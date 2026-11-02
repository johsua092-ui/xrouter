import crypto from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const DEFAULT_URL = "https://koma.run/api/v1/koma-free/chat/completions";

export class KomaFreeExecutor extends BaseExecutor {
  constructor() {
    super("koma-free", PROVIDERS["koma-free"] || { baseUrl: DEFAULT_URL });
    this.noAuth = true;
  }

  buildUrl() {
    return this.config?.baseUrl || DEFAULT_URL;
  }

  buildHeaders() {
    // Generate fresh session and install UUID on each request to ensure truly unlimited usage without IP/session throttling
    return {
      "Content-Type": "application/json",
      "User-Agent": "koma/0.4.7",
      "HTTP-Referer": "https://koma.run",
      "X-Title": "koma",
      "X-Koma": crypto.randomUUID(),
      "X-Session": crypto.randomUUID(),
    };
  }

  transformRequest(model, body) {
    const cloned = { ...body };
    cloned.model = "koma/apple";
    return cloned;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl();
    const headers = this.buildHeaders();
    const transformed = this.transformRequest(model, body);
    const bodyStr = JSON.stringify(transformed);

    log?.debug?.("FETCH", `KOMA-FREE → ${url} | model=${transformed.model}`);

    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal,
    }, proxyOptions);

    return { response, url, headers, transformedBody: transformed };
  }
}

export default KomaFreeExecutor;
