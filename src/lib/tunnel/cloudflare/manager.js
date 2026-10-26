import { loadState, saveState, generateShortId } from "../shared/state.js";
import { spawnQuickTunnel, killCloudflared, isCloudflaredRunning, setUnexpectedExitHandler } from "./cloudflared.js";
import { clearPid } from "./pid.js";
import { waitForHealth, probeUrlAlive } from "./healthCheck.js";
import { WORKER_URL } from "./config.js";
import { getSettings, updateSettings } from "@/lib/localDb";

const svc = {
  cancelToken: { cancelled: false },
  spawnInProgress: false,
  lastRestartAt: 0,
  activeLocalPort: null,
  enablePromise: null, // serialize concurrent enableTunnel calls
};

export function getTunnelService() { return svc; }
export function isTunnelManuallyDisabled() { return svc.cancelToken.cancelled; }
export function isTunnelReconnecting() { return svc.spawnInProgress; }

let onUnexpectedExit = null;
export function setTunnelUnexpectedExitCallback(cb) { onUnexpectedExit = cb; }

async function registerTunnelUrl(shortId, tunnelUrl, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${WORKER_URL}/api/tunnel/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortId, tunnelUrl }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return true;
      console.warn(`[Tunnel] register attempt ${i + 1}/${retries} failed: HTTP ${res.status}`);
    } catch (e) {
      console.warn(`[Tunnel] register attempt ${i + 1}/${retries} failed: ${e.message}`);
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  console.error(`[Tunnel] register FAILED after ${retries} attempts — public URL will NOT work`);
  return false;
}

function throwIfCancelled(token) {
  if (token.cancelled) throw new Error("tunnel cancelled");
}

export async function enableTunnel(localPort = 20128) {
  // Serialize concurrent calls: if an enable is already in-flight, wait for it
  if (svc.enablePromise) {
    console.log("[Tunnel] enable already in progress, waiting...");
    return svc.enablePromise;
  }
  svc.enablePromise = _doEnableTunnel(localPort);
  try {
    return await svc.enablePromise;
  } finally {
    svc.enablePromise = null;
  }
}

async function _doEnableTunnel(localPort) {
  console.log(`[Tunnel] enable start (port=${localPort})`);
  svc.cancelToken = { cancelled: false };
  svc.activeLocalPort = localPort;
  svc.spawnInProgress = true;
  const token = svc.cancelToken;

  try {
    if (isCloudflaredRunning()) {
      const existing = loadState();
      if (existing?.tunnelUrl && existing?.shortId) {
        const publicUrl = `https://r${existing.shortId}.abc-tunnel.us`;
        // Reuse if cloudflared is running and either URL responds or process is healthy
        const [directOk, publicOk] = await Promise.all([
          probeUrlAlive(existing.tunnelUrl),
          probeUrlAlive(publicUrl),
        ]);
        if (directOk || publicOk || isCloudflaredRunning()) {
          console.log(`[Tunnel] already running, reuse: ${existing.tunnelUrl}`);
          return { success: true, tunnelUrl: existing.tunnelUrl, shortId: existing.shortId, publicUrl, alreadyRunning: true };
        }
        console.log(`[Tunnel] stale (direct=${directOk} public=${publicOk}), respawn`);
      }
    }

    killCloudflared(localPort);
    console.log("[Tunnel] killed existing cloudflared");
    throwIfCancelled(token);

    const existing = loadState();
    const shortId = existing?.shortId || generateShortId();

    const onUrlUpdate = async (url) => {
      if (token.cancelled) return;
      console.log(`[Tunnel] url updated: ${url}`);
      await registerTunnelUrl(shortId, url);
      saveState({ shortId, tunnelUrl: url });
      await updateSettings({ tunnelEnabled: true, tunnelUrl: url });
    };

    // Register exit handler BEFORE spawn so it fires even on early exit
    setUnexpectedExitHandler(() => {
      console.warn("[Tunnel] cloudflared exited unexpectedly, scheduling respawn");
      if (onUnexpectedExit) onUnexpectedExit();
    });

    const { tunnelUrl } = await spawnQuickTunnel(localPort, onUrlUpdate);
    console.log(`[Tunnel] spawned: ${tunnelUrl}`);
    throwIfCancelled(token);

    const publicUrl = `https://r${shortId}.abc-tunnel.us`;
    await registerTunnelUrl(shortId, tunnelUrl);
    saveState({ shortId, tunnelUrl });
    await updateSettings({ tunnelEnabled: true, tunnelUrl });
    console.log(`[Tunnel] registered shortId=${shortId} publicUrl=${publicUrl}`);

    // Verify tunnel health (check both direct trycloudflare and worker publicUrl)
    // Non-blocking fallback: if process is alive, don't fail even if DNS propagation lags
    let verified = false;
    let publicAlive = false;
    const probeStart = Date.now();
    while (Date.now() - probeStart < 15000) {
      if (token.cancelled) throw new Error("tunnel cancelled");
      const [directOk, publicOk] = await Promise.all([
        probeUrlAlive(tunnelUrl),
        probeUrlAlive(publicUrl),
      ]);
      publicAlive = publicOk;
      if (directOk || publicOk) {
        verified = true;
        console.log(`[Tunnel] verified alive (direct=${directOk}, public=${publicOk})`);
        // If direct works but public doesn't, re-register and retry public once
        if (directOk && !publicOk) {
          console.log("[Tunnel] public URL not responding, re-registering...");
          await registerTunnelUrl(shortId, tunnelUrl);
          await new Promise(r => setTimeout(r, 3000));
          publicAlive = await probeUrlAlive(publicUrl);
          console.log(`[Tunnel] public URL after re-register: ${publicAlive ? "OK" : "still down"}`);
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!verified) {
      console.warn("[Tunnel] health check pending propagation, continuing with active process");
    }

    if (!publicAlive) {
      console.warn(`[Tunnel] WARNING: public URL ${publicUrl} is NOT accessible. Use direct URL: ${tunnelUrl}`);
    }

    // If publicUrl fails but direct trycloudflare is alive, prefer direct tunnelUrl as primary
    const effectivePublicUrl = publicAlive ? publicUrl : tunnelUrl;
    console.log("[Tunnel] enable success");
    return { success: true, tunnelUrl, shortId, publicUrl: effectivePublicUrl };
  } catch (e) {
    // Suppress noise when spawn was deliberately killed (restart/disable superseded it)
    if (!/cloudflared killed|tunnel cancelled/.test(e.message)) {
      console.error(`[Tunnel] enable error: ${e.message}`);
    }
    throw e;
  } finally {
    svc.spawnInProgress = false;
  }
}

export async function disableTunnel() {
  console.log("[Tunnel] disable");
  // Abort any in-flight enable so it cannot resurrect state after we clear it
  svc.cancelToken.cancelled = true;
  setUnexpectedExitHandler(null);

  try { killCloudflared(svc.activeLocalPort); } catch (e) { console.warn(`[Tunnel] kill warn: ${e.message}`); }
  clearPid();

  const state = loadState();
  if (state) saveState({ shortId: state.shortId, tunnelUrl: null });

  await updateSettings({ tunnelEnabled: false, tunnelUrl: "" });
  // Force-clear flags so a subsequent enable is not blocked by a stuck spawnInProgress
  svc.spawnInProgress = false;
  svc.activeLocalPort = null;
  return { success: true };
}

export async function getTunnelStatus() {
  const settings = await getSettings();
  const settingsEnabled = settings.tunnelEnabled === true;
  const state = loadState();
  const shortId = state?.shortId;
  let publicUrl = shortId ? `https://r${shortId}.abc-tunnel.us` : "";
  const tunnelUrl = state?.tunnelUrl || "";
  // If shortlink worker is dead/unresponsive, fallback to direct trycloudflare tunnelUrl
  if (!publicUrl || !tunnelActive) {
    publicUrl = tunnelUrl;
  }

  // Lazy: skip PID probe entirely when user disabled tunnel
  const running = settingsEnabled ? isCloudflaredRunning() : false;

  return {
    enabled: settingsEnabled && running,
    settingsEnabled,
    tunnelUrl,
    shortId,
    publicUrl,
    running
  };
}
