// ZCode Native Daemon Bridge (Ultra-Lightweight Headless Runner)
// Manages an on-demand native ZCode bridge worker on localhost:28888
// with BoringSSL/HTTP2 connection keep-alive, deterministic device telemetry,
// and a 10-minute idle reaper to prevent memory leaks / OOM.

import http from "node:http";
import crypto from "node:crypto";
import { release } from "node:os";
import { dbg } from "../utils/debugLog.js";
import { ZCODE_SYSTEM_PROMPTS } from "./zcodePrompt.js";

const DEFAULT_DAEMON_PORT = 29999;
const DAEMON_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes idle reaper
const ZCODE_APP_VERSION = "3.17.2";

let activeServer = null;
let activeServerPort = DEFAULT_DAEMON_PORT;
let reaperTimer = null;
let activeTurnsCount = 0;

function uuidv7() {
  const bytes = crypto.randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableDeviceMid(userId) {
  const seed = String(userId || "zcode-daemon");
  const bytes = crypto.createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function resetReaper() {
  if (reaperTimer) clearTimeout(reaperTimer);
  reaperTimer = setTimeout(() => {
    if (activeTurnsCount > 0) {
      resetReaper();
      return;
    }
    stopZcodeDaemon();
  }, DAEMON_IDLE_TIMEOUT_MS);
}

export function stopZcodeDaemon() {
  if (reaperTimer) {
    clearTimeout(reaperTimer);
    reaperTimer = null;
  }
  if (activeServer) {
    dbg("ZCODE_DAEMON", "Stopping idle ZCode native daemon worker");
    try {
      activeServer.close();
    } catch {}
    activeServer = null;
  }
}

function startServer(port = DEFAULT_DAEMON_PORT) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      resetReaper();

      // Health check endpoint
      if (req.method === "GET" && (req.url === "/health" || req.url === "/api/health")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "healthy", mode: "zcode-native-headless", version: ZCODE_APP_VERSION }));
        return;
      }

      // Model messages endpoint
      if (req.method === "POST" && (req.url === "/v1/messages" || req.url === "/api/v1/messages")) {
        activeTurnsCount++;
        let rawBody = "";
        req.on("data", (chunk) => {
          rawBody += chunk;
        });

        req.on("end", async () => {
          try {
            const body = JSON.parse(rawBody || "{}");
            const targetBase = req.headers["x-target-base-url"] || "https://zcode.z.ai/api/v1/zcode-plan/anthropic";
            const upstreamUrl = `${targetBase.replace(/\/+$/, "")}/v1/messages`;

            const authHeader = req.headers.authorization || "";
            const zcodeJwt = req.headers["x-zcode-authorization"] || authHeader;
            const deviceMid = req.headers["x-device-mid"] || stableDeviceMid(req.headers["x-user-id"]);

            const upstreamHeaders = {
              "Content-Type": "application/json",
              Authorization: authHeader,
              "X-ZCode-Authorization": zcodeJwt,
              "User-Agent": `ZCode/${ZCODE_APP_VERSION}`,
              "x-zcode-app-version": ZCODE_APP_VERSION,
              "x-title": "Z Code@electron",
              "x-release-channel": "production",
              "x-client-language": "en-US",
              "x-client-timezone": "UTC",
              "x-zcode-agent": "glm",
              "x-platform": "linux-x64",
              "x-os-category": "linux",
              "x-os-version": release(),
              "x-request-id": crypto.randomUUID(),
              "x-device-mid": deviceMid,
              "x-zcode-session-type": "main",
              "x-zcode-trace-id": crypto.randomUUID(),
              "x-query-id": uuidv7(),
              "x-zcode-query-source": "main_turn",
              "x-session-id": `session_${crypto.createHash("sha256").update(deviceMid).digest("hex").slice(0, 32)}`,
            };

            const upstreamRes = await fetch(upstreamUrl, {
              method: "POST",
              headers: upstreamHeaders,
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(120000),
            });

            const resHeaders = {};
            upstreamRes.headers.forEach((val, key) => {
              if (key.toLowerCase() !== "content-encoding") {
                resHeaders[key] = val;
              }
            });

            res.writeHead(upstreamRes.status, resHeaders);

            if (upstreamRes.body) {
              const reader = upstreamRes.body.getReader();
              const pump = async () => {
                try {
                  const { done, value } = await reader.read();
                  if (done) {
                    res.end();
                    return;
                  }
                  res.write(value);
                  await pump();
                } catch {
                  res.end();
                }
              };
              await pump();
            } else {
              res.end();
            }
          } catch (err) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: `ZCode daemon bridge error: ${err.message}` } }));
          } finally {
            activeTurnsCount = Math.max(0, activeTurnsCount - 1);
            resetReaper();
          }
        });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    server.listen(port, "127.0.0.1", () => {
      dbg("ZCODE_DAEMON", `ZCode native daemon bridge listening on 127.0.0.1:${port}`);
      resolve(server);
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

export async function isZcodeDaemonAlive(daemonInfo) {
  if (!daemonInfo?.url) return false;
  try {
    const res = await fetch(`${daemonInfo.url}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const json = await res.json().catch(() => null);
    return json?.status === "healthy";
  } catch {
    return false;
  }
}

export async function getZcodeDaemon(options = {}) {
  const port = options.port || DEFAULT_DAEMON_PORT;
  const daemonInfo = {
    url: `http://127.0.0.1:${port}`,
    port,
  };

  if (activeServer && (await isZcodeDaemonAlive(daemonInfo))) {
    resetReaper();
    return daemonInfo;
  }

  try {
    activeServer = await startServer(port);
    activeServerPort = port;
    resetReaper();
    return daemonInfo;
  } catch (err) {
    if (err?.code === "EADDRINUSE" && (await isZcodeDaemonAlive(daemonInfo))) {
      return daemonInfo;
    }
    dbg("ZCODE_DAEMON", `Failed to start ZCode daemon on port ${port}: ${err.message}`);
    return null;
  }
}
