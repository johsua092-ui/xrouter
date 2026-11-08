/**
 * V2Ray / Xray Process & LifeCycle Manager
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getDataDir } from "@/lib/dataDir.js";
import { parseV2RayLink, buildXrayConfig } from "./parser.js";
import { getProxyPools, createProxyPool, updateProxyPool, deleteProxyPools } from "@/lib/db/repos/proxyPoolsRepo.js";

const DEFAULT_SOCKS_PORT = 10855;
const DEFAULT_HTTP_PORT = 10856;
const V2RAY_POOL_ID = "v2ray-builtin-tunnel";

let xrayChild = null;
let currentMetadata = null;

function getXrayBinaryPath() {
  const candidates = [
    "/opt/xray/xray",
    "/usr/local/bin/xray",
    "/usr/bin/xray",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "xray";
}

function ensureV2RayDir() {
  const dir = path.join(getDataDir(), "v2ray");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getV2RayStatus() {
  const bin = getXrayBinaryPath();
  const installed = fs.existsSync(bin) || Boolean(bin === "xray");
  const running = xrayChild !== null && !xrayChild.killed && xrayChild.exitCode === null;

  return {
    installed,
    running,
    binaryPath: bin,
    socksPort: DEFAULT_SOCKS_PORT,
    httpPort: DEFAULT_HTTP_PORT,
    currentMetadata,
  };
}

export async function stopV2Ray() {
  if (xrayChild) {
    try {
      xrayChild.kill("SIGTERM");
    } catch {}
    xrayChild = null;
  }
  currentMetadata = null;

  // Mark in proxy pools as inactive
  try {
    const pools = await getProxyPools();
    const existing = pools.find((p) => p.id === V2RAY_POOL_ID);
    if (existing) {
      await updateProxyPool(V2RAY_POOL_ID, { isActive: false, testStatus: "offline" });
    }
  } catch {}

  return { success: true };
}

export async function startV2RayFromLink(link, customName = "") {
  const parsed = parseV2RayLink(link);
  if (!parsed) {
    throw new Error("Invalid V2Ray link. Supports vmess://, vless://, trojan://, or ss://");
  }

  const v2rayDir = ensureV2RayDir();
  const configFile = path.join(v2rayDir, "config.json");
  const config = buildXrayConfig({
    outbound: parsed.outbound,
    socksPort: DEFAULT_SOCKS_PORT,
    httpPort: DEFAULT_HTTP_PORT,
  });

  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf-8");

  // Kill previous process if any
  if (xrayChild) {
    try {
      xrayChild.kill("SIGTERM");
    } catch {}
    xrayChild = null;
  }

  const bin = getXrayBinaryPath();
  const child = spawn(bin, ["run", "-c", configFile], {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (data) => {
    // Optional debug log
  });

  child.stderr.on("data", (data) => {
    // Optional debug log
  });

  child.on("exit", (code, signal) => {
    if (xrayChild === child) {
      xrayChild = null;
    }
  });

  xrayChild = child;
  currentMetadata = {
    protocol: parsed.protocol,
    server: parsed.server,
    port: parsed.port,
    name: customName?.trim() || parsed.name,
    startedAt: new Date().toISOString(),
  };

  // Give it 500ms to bind sockets
  await new Promise((r) => setTimeout(r, 500));

  // Upsert into Proxy Pools so OpenCode and other providers can select it immediately
  const poolName = `[V2Ray] ${currentMetadata.name}`;
  const proxyUrl = `http://127.0.0.1:${DEFAULT_HTTP_PORT}`;

  const pools = await getProxyPools();
  const existing = pools.find((p) => p.id === V2RAY_POOL_ID);

  let poolResult;
  if (existing) {
    poolResult = await updateProxyPool(V2RAY_POOL_ID, {
      name: poolName,
      proxyUrl,
      type: "http",
      isActive: true,
      testStatus: "active",
      updatedAt: new Date().toISOString(),
    });
  } else {
    poolResult = await createProxyPool({
      id: V2RAY_POOL_ID,
      name: poolName,
      proxyUrl,
      type: "http",
      isActive: true,
      strictProxy: false,
      testStatus: "active",
    });
  }

  return {
    success: true,
    metadata: currentMetadata,
    proxyPool: poolResult,
    socksPort: DEFAULT_SOCKS_PORT,
    httpPort: DEFAULT_HTTP_PORT,
    proxyUrl,
  };
}
