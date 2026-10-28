import dns from "node:dns";
import { isIP } from "node:net";

const LOCAL_DNS_TIMEOUT_MS = 5000;

function dnsModeError() {
  return Object.assign(new Error("Invalid proxy DNS mode: use dns=local or dns=remote on a SOCKS5 URL"), {
    code: "ERR_PROXY_DNS_MODE",
  });
}

async function lookupLocal(hostname) {
  let timer;
  try {
    return await Promise.race([
      dns.promises.lookup(hostname),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Local proxy DNS lookup timed out"), {
          code: "ETIMEDOUT",
        })), LOCAL_DNS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * dns=local is opt-in: it exposes target lookups to the system resolver.
 * Keep the original request origin for HTTP Host, TLS SNI and certificate checks.
 */
export async function createProxyDispatcher(options) {
  const url = new URL(options.uri);
  const modes = url.searchParams.getAll("dns");
  const socks5 = url.protocol === "socks5:";
  if (modes.length && (!socks5 || modes.length !== 1 || !["local", "remote"].includes(modes[0]))) {
    throw dnsModeError();
  }
  const { ProxyAgent, Socks5ProxyAgent } = await import("undici");
  // Fast fail for dead proxies: 3.5s connect timeout + 6s headers timeout
  // This allows aggressive pool rotation (trying 5-8 proxies) before Cloudflare 524 cuts the stream!
  const agentOptions = {
    ...options,
    connect: { timeout: 3500 },
    headersTimeout: 6000,
    maxHeaderSize: 64 * 1024,
  };
  if (modes[0] !== "local") return new ProxyAgent(agentOptions);

  // Override only the tunnel destination, not the origin used by Undici's pool/TLS.
  class LocalDnsSocksProxyAgent extends Socks5ProxyAgent {
    async createSocks5Connection(hostname, port) {
      const host = hostname.replace(/^\[|\]$/g, "");
      const target = isIP(host) ? host : (await lookupLocal(host)).address;
      return super.createSocks5Connection(target, port);
    }
  }
  url.searchParams.delete("dns");
  return new LocalDnsSocksProxyAgent(url, options);
}
