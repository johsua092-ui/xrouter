/**
 * V2Ray / Xray Link Parser
 * Converts vmess://, vless://, trojan://, and ss:// links into Xray client outbound configurations.
 */

function safeBase64Decode(str) {
  try {
    let clean = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (clean.length % 4 !== 0) {
      clean += "=";
    }
    return Buffer.from(clean, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

export function parseV2RayLink(rawLink) {
  if (!rawLink || typeof rawLink !== "string") return null;
  const link = rawLink.trim();

  if (link.startsWith("vmess://")) {
    return parseVmess(link);
  }
  if (link.startsWith("vless://")) {
    return parseVless(link);
  }
  if (link.startsWith("trojan://")) {
    return parseTrojan(link);
  }
  if (link.startsWith("ss://")) {
    return parseShadowsocks(link);
  }
  return null;
}

function parseVmess(link) {
  const b64 = link.slice(8);
  const jsonStr = safeBase64Decode(b64);
  if (!jsonStr) return null;

  try {
    const data = JSON.parse(jsonStr);
    const server = data.add || "";
    const port = parseInt(data.port, 10) || 443;
    const uuid = data.id || "";
    const alterId = parseInt(data.aid, 10) || 0;
    const security = data.scy || "auto";
    const net = data.net || "tcp";
    const type = data.type || "none";
    const host = data.host || "";
    const path = data.path || "/";
    const tls = data.tls || "none";
    const sni = data.sni || host || server;
    const name = data.ps || `vmess-${server}:${port}`;

    const outbound = {
      tag: "proxy",
      protocol: "vmess",
      settings: {
        vnext: [
          {
            address: server,
            port,
            users: [
              {
                id: uuid,
                alterId,
                security,
              },
            ],
          },
        ],
      },
      streamSettings: {
        network: net,
        security: tls === "tls" ? "tls" : "none",
      },
    };

    if (tls === "tls") {
      outbound.streamSettings.tlsSettings = {
        serverName: sni,
      };
    }

    if (net === "ws") {
      outbound.streamSettings.wsSettings = {
        path: path.startsWith("/") ? path : `/${path}`,
        headers: host ? { Host: host } : {},
      };
    } else if (net === "grpc") {
      outbound.streamSettings.grpcSettings = {
        serviceName: path || "",
      };
    }

    return {
      protocol: "vmess",
      name,
      server,
      port,
      outbound,
    };
  } catch {
    return null;
  }
}

function parseVless(link) {
  try {
    const parsed = new URL(link);
    const uuid = parsed.username;
    const server = parsed.hostname;
    const port = parseInt(parsed.port, 10) || 443;
    const params = Object.fromEntries(parsed.searchParams.entries());
    const name = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : `vless-${server}:${port}`;

    const security = params.security || "none";
    const net = params.type || "tcp";
    const sni = params.sni || params.host || server;
    const path = params.path || "/";
    const host = params.host || "";
    const pbk = params.pbk || "";
    const sid = params.sid || "";
    const fp = params.fp || "chrome";

    const outbound = {
      tag: "proxy",
      protocol: "vless",
      settings: {
        vnext: [
          {
            address: server,
            port,
            users: [
              {
                id: uuid,
                encryption: params.encryption || "none",
                flow: params.flow || undefined,
              },
            ],
          },
        ],
      },
      streamSettings: {
        network: net,
        security: security,
      },
    };

    if (security === "tls") {
      outbound.streamSettings.tlsSettings = {
        serverName: sni,
        fingerprint: fp,
      };
    } else if (security === "reality") {
      outbound.streamSettings.realitySettings = {
        serverName: sni,
        fingerprint: fp,
        publicKey: pbk,
        shortId: sid,
      };
    }

    if (net === "ws") {
      outbound.streamSettings.wsSettings = {
        path: path.startsWith("/") ? path : `/${path}`,
        headers: host ? { Host: host } : {},
      };
    } else if (net === "grpc") {
      outbound.streamSettings.grpcSettings = {
        serviceName: params.serviceName || path || "",
      };
    }

    return {
      protocol: "vless",
      name,
      server,
      port,
      outbound,
    };
  } catch {
    return null;
  }
}

function parseTrojan(link) {
  try {
    const parsed = new URL(link);
    const password = parsed.username;
    const server = parsed.hostname;
    const port = parseInt(parsed.port, 10) || 443;
    const params = Object.fromEntries(parsed.searchParams.entries());
    const name = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : `trojan-${server}:${port}`;

    const security = params.security || "tls";
    const net = params.type || "tcp";
    const sni = params.sni || params.host || server;
    const path = params.path || "/";
    const host = params.host || "";

    const outbound = {
      tag: "proxy",
      protocol: "trojan",
      settings: {
        servers: [
          {
            address: server,
            port,
            password,
          },
        ],
      },
      streamSettings: {
        network: net,
        security,
      },
    };

    if (security === "tls") {
      outbound.streamSettings.tlsSettings = {
        serverName: sni,
      };
    }

    if (net === "ws") {
      outbound.streamSettings.wsSettings = {
        path: path.startsWith("/") ? path : `/${path}`,
        headers: host ? { Host: host } : {},
      };
    }

    return {
      protocol: "trojan",
      name,
      server,
      port,
      outbound,
    };
  } catch {
    return null;
  }
}

function parseShadowsocks(link) {
  try {
    const raw = link.slice(5);
    const hashIdx = raw.indexOf("#");
    const mainPart = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    const name = hashIdx >= 0 ? decodeURIComponent(raw.slice(hashIdx + 1)) : "shadowsocks";

    let server = "";
    let port = 8388;
    let method = "aes-256-gcm";
    let password = "";

    if (mainPart.includes("@")) {
      const [authPart, serverPart] = mainPart.split("@");
      const [host, p] = serverPart.split(":");
      server = host;
      port = parseInt(p, 10) || 8388;
      const decodedAuth = safeBase64Decode(authPart) || authPart;
      const [m, pwd] = decodedAuth.split(":");
      method = m;
      password = pwd;
    } else {
      const decoded = safeBase64Decode(mainPart);
      if (!decoded) return null;
      const atIdx = decoded.indexOf("@");
      if (atIdx === -1) return null;
      const [m, pwd] = decoded.slice(0, atIdx).split(":");
      const [host, p] = decoded.slice(atIdx + 1).split(":");
      method = m;
      password = pwd;
      server = host;
      port = parseInt(p, 10) || 8388;
    }

    const outbound = {
      tag: "proxy",
      protocol: "shadowsocks",
      settings: {
        servers: [
          {
            address: server,
            port,
            method,
            password,
          },
        ],
      },
    };

    return {
      protocol: "shadowsocks",
      name,
      server,
      port,
      outbound,
    };
  } catch {
    return null;
  }
}

export function buildXrayConfig({ outbound, socksPort = 10855, httpPort = 10856 }) {
  return {
    log: {
      loglevel: "warning",
    },
    inbounds: [
      {
        tag: "socks-in",
        port: socksPort,
        listen: "127.0.0.1",
        protocol: "socks",
        settings: {
          auth: "noauth",
          udp: true,
        },
      },
      {
        tag: "http-in",
        port: httpPort,
        listen: "127.0.0.1",
        protocol: "http",
        settings: {
          timeout: 60,
        },
      },
    ],
    outbounds: [
      outbound,
      {
        tag: "direct",
        protocol: "freedom",
        settings: {},
      },
    ],
  };
}
