"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// Providers using the dynamic-port local callback proxy.
// Browser OAuth: popup → auto callback → auto exchange → poll-status.
// NOTE: xiaomi-mimo is deliberately NOT here. It authenticates through its own
// account-session login (server-side cluster picker → passToken capture →
// /api/oauth/xiaomi-mimo/login/*), surfaced by XiaomiMimoAuthModal. Adding it
// here routed the flow through /register-session, which only implements
// trae/windsurf/zed and rejected the request outright.
// aws-quick: two-hop loopback flow (discovery → OIDC authorize); the proxy
// handles both hops, plus a paste-back fallback for browsers that can't reach
// this machine's 127.0.0.1 callback (see submitAwsQuickPaste below).
const PROXY_OAUTH_PROVIDERS = new Set(["trae", "windsurf", "zed", "aws-quick"]);

// Providers offering a paste-token fallback (import-token flow).
// UX warns if the IDE (which issues the token) is not installed.
const PASTE_TOKEN_PROVIDERS = {
  trae: {
    label: "Cloud-IDE-JWT",
    instructions:
      "Sign in at trae.ai (or solo.trae.ai), open DevTools → Network, copy the Cloud-IDE-JWT token from any request's Authorization header (~14-day lifetime).",
    placeholder: "Paste Cloud-IDE-JWT here...",
    ideName: "Trae",
    ideOptional: true, // token can be grabbed from DevTools without the IDE
  },
  windsurf: {
    label: "Windsurf API key",
    instructions:
      "In the Windsurf/VS Code IDE, run the \"Windsurf: Provide Auth Token\" command, then copy the displayed sk-ws-... key.",
    placeholder: "Paste sk-ws-... key here...",
    ideName: "Windsurf",
    ideOptional: false,
  },
};

/**
 * OAuth Modal Component
 * - Localhost: Auto callback via popup message
 * - Remote: Manual paste callback URL
 */
export default function OAuthModal({ isOpen, provider, providerInfo, onSuccess, onClose, oauthMeta, idcConfig }) {
  const [step, setStep] = useState("waiting"); // waiting | input | success | error
  const [authData, setAuthData] = useState(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState(null);
  const [isDeviceCode, setIsDeviceCode] = useState(false);
  const [deviceData, setDeviceData] = useState(null);
  const [polling, setPolling] = useState(false);
  // trae/windsurf: choose between browser OAuth (proxy) and paste-token (import)
  const [authMode, setAuthMode] = useState("browser"); // "browser" | "paste-token"
  const [pasteToken, setPasteToken] = useState("");
  const [ideStatus, setIdeStatus] = useState(null);
  // aws-quick paste-back fallback: the browser's final address (hop-1
  // discovery URL, or the final /?code&state URL) from a browser that can't
  // reach this machine's 127.0.0.1 callback.
  const [awsQuickPasteUrl, setAwsQuickPasteUrl] = useState("");
  // aws-quick paste-back wizard: "discovery" (hop-1 /callback?nonce=…) → "code"
  // (final /?code=…). AWS OIDC requires a loopback redirect for public clients,
  // so a remote browser always produces two address-bar URLs to paste.
  const [awsQuickPasteStep, setAwsQuickPasteStep] = useState("discovery");
  // In-flight guard: /paste may take seconds (OIDC token exchange), so both
  // Continue/Connect and the clipboard read are disabled while one runs.
  const [awsQuickBusy, setAwsQuickBusy] = useState(false);
  const popupRef = useRef(null);
  const pollingAbortRef = useRef(false);
  const openedRef = useRef(false);
  // Proxy-flow session ledger: which provider's proxy THIS modal session
  // started, and whether its stop was already sent. Every stop-proxy call is
  // gated on this — parent re-renders can never spam it, and a close stops
  // the owned proxy exactly once.
  const flowRef = useRef({ proxyStarted: false, proxyProvider: null, stopSent: false });
  // Parent callbacks are stored in refs so effect/callback identities stay
  // stable across parent re-renders (the page passes fresh inline closures).
  // Synced by the ref-sync effect below (placed after all callbacks are
  // defined); the open effect then depends only on stable primitives.
  const onSuccessRef = useRef(onSuccess);
  const onCloseRef = useRef(onClose);
  const isOpenRef = useRef(isOpen);
  const startOAuthFlowRef = useRef(null);
  // aws-quick poll → /exchange: the poll effect must call the latest
  // completeAwsQuickExchange without taking it as a dep (identity churn).
  const completeAwsQuickExchangeRef = useRef(null);
  const { copied, copy } = useCopyToClipboard();

  // State for client-only values to avoid hydration mismatch
  const [isLocalhost] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  });
  const [placeholderUrl] = useState(() => {
    if (typeof window === "undefined") return "/callback?code=...";
    return `${window.location.origin}/callback?code=...`;
  });
  const callbackProcessedRef = useRef(false);

  // Define all useCallback hooks BEFORE the useEffects that reference them

  // Exchange tokens
  const exchangeTokens = useCallback(async (code, state) => {
    if (!authData) return;
    try {
      const res = await fetch(`/api/oauth/${provider}/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          redirectUri: authData.redirectUri,
          codeVerifier: authData.codeVerifier,
          state,
          // Zed: thread the login attempt's system_id so the stored
          // connection keeps the id sent to zed.dev (see register-session).
          ...(authData.systemId ? { systemId: authData.systemId } : {}),
          ...(oauthMeta ? { meta: oauthMeta } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setStep("success");
      onSuccessRef.current?.();
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  }, [authData, provider, oauthMeta]);

  const completeXaiManualCode = useCallback(async (code) => {
    if (!authData?.state) return;
    try {
      const res = await fetch("/api/oauth/xai/manual-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, state: authData.state }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setStep("success");
      onSuccessRef.current?.();
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  }, [authData]);

  // Poll for device code token
  const startPolling = useCallback(async (deviceCode, codeVerifier, interval, extraData, deadlineMs) => {
    pollingAbortRef.current = false;
    setPolling(true);
    // Honor the upstream's expires_in when supplied (qoder sets 300s) so we
    // don't time out earlier than the device code itself. Default 120s
    // matches the prior behavior for providers that don't surface a value.
    const startedAt = Date.now();
    const deadline = startedAt + (Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 120_000);

    while (Date.now() < deadline) {
      // Check if polling should be aborted
      if (pollingAbortRef.current) {
        console.log("[OAuthModal] Polling aborted");
        setPolling(false);
        return;
      }

      await new Promise((r) => setTimeout(r, interval * 1000));

      // Check again after sleep
      if (pollingAbortRef.current) {
        console.log("[OAuthModal] Polling aborted after sleep");
        setPolling(false);
        return;
      }

      try {
        const res = await fetch(`/api/oauth/${provider}/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode, codeVerifier, extraData }),
        });

        const data = await res.json().catch(() => ({}));

        if (data.success) {
          pollingAbortRef.current = true; // Stop polling immediately
          setStep("success");
          setPolling(false);
          onSuccessRef.current?.();
          return;
        }

        if (!res.ok) {
          throw new Error(data.errorDescription || data.error || data.message || `Poll failed (HTTP ${res.status})`);
        }

        if (data.error && data.error !== "authorization_pending" && data.error !== "slow_down") {
          throw new Error(data.errorDescription || data.error);
        }

        if (data.error === "slow_down") {
          interval = Math.min(interval + 5, 30);
        }

        // Server-requested back-off (freepi sends retry_after instead of
        // slow_down). Ignoring it is what earns a hard upstream rate limit.
        if (Number.isFinite(data.retryAfter) && data.retryAfter > interval) {
          interval = Math.min(data.retryAfter, 30);
        }
      } catch (err) {
        setError(err.message);
        setStep("error");
        setPolling(false);
        return;
      }
    }

    setError("Authorization timeout");
    setStep("error");
    setPolling(false);
  }, [provider]);

  // Stop the proxy owned by THIS modal session, at most once. Re-renders,
  // repeated closes, and post-completion calls are all no-ops by construction.
  const stopOwnedProxy = useCallback(() => {
    const flow = flowRef.current;
    if (flow.proxyStarted && !flow.stopSent && flow.proxyProvider) {
      flow.stopSent = true;
      fetch(`/api/oauth/${flow.proxyProvider}/stop-proxy`).catch(() => {});
    }
  }, []);

  // Trae/Windsurf/Zed proxy OAuth flow: dynamic-port local callback → auto exchange.
  const startProxyFlow = useCallback(async (providerId) => {
    // aws-quick: a new attempt (Try Again / retry) starts from a clean paste
    // wizard — the previous attempt's step, pasted URL and error are stale.
    if (providerId === "aws-quick") {
      setAwsQuickPasteStep("discovery");
      setAwsQuickPasteUrl("");
      setError(null);
      setAwsQuickBusy(false);
    }
    // 1. Start the local callback server (returns a dynamic port + callback URL).
    const startRes = await fetch(`/api/oauth/${providerId}/start-proxy`);
    const startData = await startRes.json();
    if (!startRes.ok || !startData.success || !startData.callbackUrl) {
      throw new Error(startData.reason || startData.error || `Failed to start ${providerId} callback server`);
    }
    // Take ownership immediately so a close during the remaining flight still
    // cleans this proxy up (via the close effect or the abort below).
    flowRef.current.proxyStarted = true;
    flowRef.current.proxyProvider = providerId;
    flowRef.current.stopSent = false;
    if (!isOpenRef.current) {
      stopOwnedProxy();
      return;
    }
    // 2. Build the authorize URL with redirect_uri = proxy callback URL.
    const authorizeUrl = new URL(`/api/oauth/${providerId}/authorize`, window.location.origin);
    authorizeUrl.searchParams.set("redirect_uri", startData.callbackUrl);
    const authRes = await fetch(authorizeUrl);
    const authData = await authRes.json();
    if (!authRes.ok) {
      stopOwnedProxy();
      throw new Error(authData.error);
    }
    if (!isOpenRef.current) {
      stopOwnedProxy();
      return;
    }
    // 3. Register the session so the proxy can match the incoming callback.
    //    Zed also passes code_verifier (encodes the RSA private key for decrypt)
    //    + systemId; sent via POST body so secrets never land in URL/query logs.
    const regBody = { state: authData.state };
    if (authData.codeVerifier) regBody.codeVerifier = authData.codeVerifier;
    if (authData.systemId) regBody.systemId = authData.systemId;
    const regRes = await fetch(`/api/oauth/${providerId}/register-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(regBody),
    });
    let regData = null;
    try {
      regData = await regRes.json();
    } catch {
      regData = null;
    }
    if (!regRes.ok || regData?.success === false) {
      stopOwnedProxy();
      throw new Error(regData?.error || "Failed to register login session; please retry");
    }
    if (!isOpenRef.current) return; // closed mid-flight: close effect owns cleanup now
    // 4. Open popup; proxy auto-exchanges on callback, modal polls poll-status.
    setAuthData({ ...authData, proxyProvider: providerId });
    setStep("waiting");
    const openUrl = authData.authUrl || authData.authorizeUrl;
    popupRef.current = openUrl ? window.open(openUrl, "oauth_popup", "width=600,height=700") : null;
    if (!popupRef.current) setStep("input"); // popup blocked → fall back to manual paste
  }, [stopOwnedProxy]);

  // aws-quick: finish from the settled session (POST /exchange reads the
  // server-side result and creates the connection).
  const completeAwsQuickExchange = useCallback(async (state) => {
    try {
      const res = await fetch("/api/oauth/aws-quick/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStep("success");
      setAwsQuickBusy(false);
      onSuccessRef.current?.();
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  }, []);

  // aws-quick paste-back (two attempts, magpie semantics): the pasted address is
  // either the hop-1 /callback?... discovery URL — the server saves the
  // discovery fields and we re-authorize straight to the OIDC authorize URL —
  // or the final /?code&state URL, which completes the exchange.
  const submitAwsQuickPaste = useCallback(async (pasted) => {
    setAwsQuickBusy(true);
    try {
      setError(null);
      const res = await fetch("/api/oauth/aws-quick/paste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: pasted }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.status === "discovery-saved") {
        setAwsQuickPasteStep("code");
        // Step 1 is consumed: clear the pasted URL (the field now expects the
        // final /?code=… address) and any stale message.
        setAwsQuickPasteUrl("");
        setError(null);
        // Attempt 2: reuse the session (state) — /authorize now skips the
        // discovery hop and returns the OIDC authorize URL.
        if (!authData?.redirectUri) throw new Error("Login session expired; restart the login flow");
        const authUrl = new URL("/api/oauth/aws-quick/authorize", window.location.origin);
        authUrl.searchParams.set("redirect_uri", authData.redirectUri);
        authUrl.searchParams.set("state", data.state);
        const authRes = await fetch(authUrl.toString());
        const newAuth = await authRes.json();
        if (!authRes.ok) throw new Error(newAuth.error);
        setAuthData((prev) => ({ ...(prev || {}), ...newAuth, proxyProvider: "aws-quick" }));
        callbackProcessedRef.current = false;
        setError(null);
        setStep("waiting");
        popupRef.current = window.open(newAuth.authorizeUrl || newAuth.authUrl, "oauth_popup", "width=600,height=700");
        if (!popupRef.current) setStep("input"); // popup blocked → paste the final URL next
        return;
      }
      if (data.status === "done") {
        await completeAwsQuickExchange(data.state);
        return;
      }
      throw new Error(data.error || "Unexpected paste-back result");
    } catch (err) {
      const message = err?.message || "Paste-back failed";
      setError(message);
      // Only a vanished session is unrecoverable in place — that one keeps the
      // dedicated error step (with Try Again). Every other failure keeps the
      // paste wizard mounted so the message renders inline and the user can
      // correct the pasted URL.
      setStep(String(message).includes("Login session not found") ? "error" : "input");
    } finally {
      setAwsQuickBusy(false);
    }
  }, [authData, completeAwsQuickExchange]);

  const pasteAwsQuickFromClipboard = useCallback(async () => {
    setAwsQuickBusy(true);
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return;
      setAwsQuickPasteUrl(text);
      await submitAwsQuickPaste(text);
    } catch {
      setError("Clipboard access was blocked — click the field and paste with Ctrl/Cmd+V.");
    } finally {
      setAwsQuickBusy(false);
    }
  }, [submitAwsQuickPaste]);

  // Start OAuth flow (plain function by design: it is only invoked from the
  // open effect via ref and from user actions, so memoization would only add
  // an identity that re-triggers effects on every parent re-render).
  const startOAuthFlow = async () => {
    if (!provider) return;
    try {
      setError(null);

      // Trae/Windsurf: proxy OAuth (browser mode) — handled by dedicated flow.
      // Paste-token mode is handled by handleManualSubmit (no /authorize call).
      if (PROXY_OAUTH_PROVIDERS.has(provider) && authMode === "browser") {
        await startProxyFlow(provider);
        return;
      }

      // Device code flow providers (must match oauth providers with flowType: "device_code")
      const deviceCodeProviders = [
        "github",
        "kiro",
        "kimi",
        "kimi-coding",
        "kilocode",
        "codebuddy-cn",
        "codebuddy-intl",
        "qoder",
        "qoder-cn",
        "grok-cli",
        "muse",
        "glm",
        "zcode",
        "minimax-code",
        "minimax-code-global",
        "nous",
        "freepi",
      ];
      if (deviceCodeProviders.includes(provider)) {
        setIsDeviceCode(true);
        setStep("waiting");

        const deviceCodeUrl = new URL(`/api/oauth/${provider}/device-code`, window.location.origin);
        if (provider === "kiro" && idcConfig?.startUrl) {
          deviceCodeUrl.searchParams.set("start_url", idcConfig.startUrl);
          if (idcConfig.region) {
            deviceCodeUrl.searchParams.set("region", idcConfig.region);
          }
          deviceCodeUrl.searchParams.set("auth_method", "idc");
        }
        const res = await fetch(deviceCodeUrl.toString());
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        setDeviceData(data);

        // Auto-open verification URL in new tab
        const verifyUrl = data.verification_uri_complete || data.verification_uri;
        if (verifyUrl) window.open(verifyUrl, "_blank", "noopener,noreferrer");

        // Pass extraData for Kiro (contains _clientId, _clientSecret) and
        // Qoder (contains _qoderMachineId / _qoderNonce — needed so mapTokens
        // can persist the machine id alongside the token).
        const extraData = provider === "kiro"
          ? {
              _clientId: data._clientId,
              _clientSecret: data._clientSecret,
              _region: data._region,
              _authMethod: data._authMethod,
              _startUrl: data._startUrl,
            }
          : (provider === "qoder" || provider === "qoder-cn")
          ? {
              _qoderNonce: data._qoderNonce,
              _qoderMachineId: data._qoderMachineId,
              _qoderVerifier: data.codeVerifier,
            }
          : (provider === "kimi" || provider === "kimi-coding")
          ? { _kimiDeviceId: data._kimiDeviceId }
          : (provider === "minimax-code" || provider === "minimax-code-global")
          ? {
              // MiniMax's user-code variant polls the token endpoint with the
              // user_code instead of a device_code; the server must see this
              // flag or it sends device_code: undefined and every poll fails.
              _minimaxPollByUser: data._minimaxPollByUser,
            }
          : provider === "zcode"
          ? { _zcodePollToken: data._zcodePollToken, _zcodeFamily: data._zcodeFamily }
          : provider === "glm"
          ? { _zcodePollToken: data._zcodePollToken }
          : null;
        startPolling(
          data.device_code,
          data.codeVerifier,
          data.interval || 5,
          extraData,
          // Use the upstream's expires_in if present so we don't time out
          // before the device code itself (qoder gives 300s).
          Number.isFinite(data.expires_in) && data.expires_in > 0
            ? data.expires_in * 1000
            : undefined,
        );
        return;
      }

      // Authorization code flow - build redirect URI (some providers require fixed ports)
      const appPort = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
      let redirectUri;
      if (provider === "codex") {
        redirectUri = "http://localhost:1455/auth/callback";
      } else if (provider === "xai") {
        redirectUri = "http://127.0.0.1:56121/callback";
      } else if (provider === "antigravity" || provider === "gemini-cli") {
        // Google Client ID is registered only with localhost redirect_uri (Decolua original)
        redirectUri = `http://localhost:${appPort}/callback`;
      } else {
        redirectUri = `${window.location.origin}/callback`;
      }

      // Build authorize URL first to get codeVerifier/state for codex server-side mode
      const authorizeUrl = new URL(`/api/oauth/${provider}/authorize`, window.location.origin);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      if (oauthMeta) {
        Object.entries(oauthMeta).forEach(([k, v]) => { if (v) authorizeUrl.searchParams.set(k, v); });
      }
      const res = await fetch(authorizeUrl.toString());
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Codex: start proxy with server-side session (auto-exchange) + fallback to channels
      let codexProxyActive = false;
      let codexServerSide = false;
      if (provider === "codex") {
        try {
          const proxyUrl = new URL(`/api/oauth/codex/start-proxy`, window.location.origin);
          proxyUrl.searchParams.set("app_port", appPort);
          proxyUrl.searchParams.set("state", data.state);
          proxyUrl.searchParams.set("code_verifier", data.codeVerifier);
          proxyUrl.searchParams.set("redirect_uri", redirectUri);
          const proxyRes = await fetch(proxyUrl.toString());
          const proxyData = await proxyRes.json();
          codexProxyActive = proxyData.success;
          codexServerSide = !!proxyData.serverSide;
        } catch {
          codexProxyActive = false;
        }
      }

      // xAI: same fixed-port server-side proxy pattern as codex (port 56121)
      let xaiProxyActive = false;
      let xaiServerSide = false;
      if (provider === "xai") {
        try {
          const proxyUrl = new URL(`/api/oauth/xai/start-proxy`, window.location.origin);
          proxyUrl.searchParams.set("app_port", appPort);
          proxyUrl.searchParams.set("state", data.state);
          proxyUrl.searchParams.set("code_verifier", data.codeVerifier);
          proxyUrl.searchParams.set("redirect_uri", redirectUri);
          const proxyRes = await fetch(proxyUrl.toString());
          const proxyData = await proxyRes.json();
          xaiProxyActive = proxyData.success;
          xaiServerSide = !!proxyData.serverSide;
          if (!xaiProxyActive && proxyData.reason === "port_busy") {
            throw new Error("Port 56121 in use; close the conflicting process and retry");
          }
        } catch (e) {
          if (e?.message) throw e;
          xaiProxyActive = false;
        }
      }

      setAuthData({ ...data, redirectUri, codexServerSide, xaiServerSide });

      // Take ownership of server-side proxies so close stops them exactly once
      // (replaces the per-provider stop branches; same behavior, one ledger).
      if ((provider === "codex" && codexProxyActive) || (provider === "xai" && xaiProxyActive)) {
        flowRef.current.proxyStarted = true;
        flowRef.current.proxyProvider = provider;
        flowRef.current.stopSent = false;
      }

      // Guard: device_code providers return authUrl:null from /authorize. Never window.open(null)
      // (browsers coerce it to the relative path ".../null").
      if (!data.authUrl) {
        if (data.flowType === "device_code") {
          throw new Error(
            `Provider ${provider} uses device-code login but is not wired in the OAuth modal device-code list`
          );
        }
        throw new Error("No authorization URL returned from OAuth provider");
      }

      if (provider === "codex" && codexProxyActive) {
        // Proxy active: callback will be handled server-side (auto-exchange) or via channels (fallback)
        setStep("waiting");
        popupRef.current = window.open(data.authUrl, "oauth_popup", "width=600,height=700");
        if (!popupRef.current) {
          setStep("input");
        }
      } else if (provider === "xai" && xaiProxyActive) {
        setStep("waiting");
        popupRef.current = window.open(data.authUrl, "oauth_popup", "width=600,height=700");
        if (!popupRef.current) {
          setStep("input");
        }
      } else if (!isLocalhost && (provider === "antigravity" || provider === "gemini-cli")) {
        // Remote host with Google OAuth (Antigravity/Gemini): show manual copy-paste instructions
        setStep("input");
        window.open(data.authUrl, "_blank");
      } else {
        // Localhost (or standard providers): Open popup and wait for message
        setStep("waiting");
        popupRef.current = window.open(data.authUrl, "oauth_popup", "width=600,height=700");
        if (!popupRef.current) {
          setStep("input");
        }
      }
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  };

  // Sync latest props/flow into refs after every render (no dep array).
  // The open effect below then depends only on stable primitives.
  useEffect(() => {
    onSuccessRef.current = onSuccess;
    onCloseRef.current = onClose;
    isOpenRef.current = isOpen;
    startOAuthFlowRef.current = startOAuthFlow;
    completeAwsQuickExchangeRef.current = completeAwsQuickExchange;
  });

  // Reset state and start OAuth when modal opens — exactly once per open.
  // Guarded by openedRef so StrictMode/effect re-runs never open extra tabs.
  useEffect(() => {
    if (!isOpen || !provider) return;
    if (openedRef.current) return;
    openedRef.current = true;
    setAuthData(null);
    setCallbackUrl("");
    setError(null);
    setIsDeviceCode(false);
    setDeviceData(null);
    setPolling(false);
    setAuthMode("browser");
    setPasteToken("");
    setAwsQuickPasteUrl("");
    setAwsQuickPasteStep("discovery");
    setAwsQuickBusy(false);
    setIdeStatus(null);
    pollingAbortRef.current = false;
    flowRef.current = { proxyStarted: false, proxyProvider: null, stopSent: false };
    // Best-effort IDE detection for paste-token providers (Trae/Windsurf)
    if (PASTE_TOKEN_PROVIDERS[provider]) {
      fetch(`/api/oauth/${provider}/ide-status`)
        .then((r) => r.json())
        .then((data) => setIdeStatus(data))
        .catch(() => setIdeStatus({ installed: false, path: null }));
    }
    startOAuthFlowRef.current();
  }, [isOpen, provider]);

  // Cleanup when the modal closes: abort polling and stop the proxy THIS
  // session started, exactly once. Deps are stable primitives, so unrelated
  // parent re-renders cannot reach the stop call (previously every parent
  // render re-fired stop-proxy while the modal was closed).
  useEffect(() => {
    if (isOpen) return;
    pollingAbortRef.current = true;
    openedRef.current = false;
    stopOwnedProxy();
    flowRef.current = { proxyStarted: false, proxyProvider: null, stopSent: false };
  }, [isOpen, provider, stopOwnedProxy]);

  // Server-side proxy mode (codex/xai fixed-port + trae/windsurf dynamic-port):
  // poll status until the proxy auto-exchanges and saves the connection.
  useEffect(() => {
    const pollProvider = authData?.codexServerSide
      ? "codex"
      : authData?.xaiServerSide
        ? "xai"
        : authData?.proxyProvider
          ? authData.proxyProvider
          : null;
    if (!pollProvider || !authData?.state) return;
    if (callbackProcessedRef.current) return;
    let cancelled = false;
    const POLL_INTERVAL_MS = 1500;
    const MAX_ATTEMPTS = 200; // ~5 minutes
    let attempts = 0;

    const tick = async () => {
      // A closed modal (or a stopped flow) must never resolve into a success
      // step or fire onSuccess after the user dismissed the dialog.
      if (!isOpenRef.current || pollingAbortRef.current) return;
      if (cancelled || callbackProcessedRef.current) return;
      attempts += 1;
      try {
          const res = await fetch(`/api/oauth/${pollProvider}/poll-status?state=${encodeURIComponent(authData.state)}`);
        const data = await res.json();
        if (cancelled || callbackProcessedRef.current) return;
        if (data.status === "done") {
          callbackProcessedRef.current = true;
          if (pollProvider === "aws-quick") {
            // Quick settles tokens in memory only — POST /exchange is what
            // creates the connection. The generic success path would leave the
            // provider unconnected. completeAwsQuickExchange sets step/onSuccess.
            await completeAwsQuickExchangeRef.current?.(authData.state);
            return;
          }
          setStep("success");
          onSuccessRef.current?.();
          return;
        }
        if (data.status === "error") {
          callbackProcessedRef.current = true;
          setError(data.error || "Authentication failed");
          setStep("error");
          return;
        }
      } catch {
        // Network error, keep polling
      }
      if (attempts >= MAX_ATTEMPTS) {
        callbackProcessedRef.current = true;
        setError("Authentication timeout");
        setStep("error");
        return;
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    setTimeout(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; };
    // isOpen is a dep so closing the modal tears the loop down (tick also
    // guards on isOpenRef for a tick already in flight).
  }, [authData, isOpen]);

  // Listen for OAuth callback via multiple methods
  useEffect(() => {
    if (!authData) return;
    callbackProcessedRef.current = false; // Reset when authData changes

    // Handler for callback data - only process once
    const handleCallback = async (data) => {
      if (callbackProcessedRef.current) return; // Already processed

      const { code, token, state, error: callbackError, errorDescription } = data;

      if (callbackError) {
        callbackProcessedRef.current = true;
        setError(errorDescription || callbackError);
        setStep("error");
        return;
      }

      if (token || code) {
        callbackProcessedRef.current = true;
        await exchangeTokens(token || code, state);
      }
    };

    // Method 1: postMessage from popup
    const handleMessage = (event) => {
      // Allow messages from same origin or localhost (any port)
      const isLocalhost = event.origin.includes("localhost") || event.origin.includes("127.0.0.1");
      const isSameOrigin = event.origin === window.location.origin;
      if (!isLocalhost && !isSameOrigin) return;
      
      if (event.data?.type === "oauth_callback") {
        handleCallback(event.data.data);
      }
    };
    window.addEventListener("message", handleMessage);

    // Method 2: BroadcastChannel
    let channel;
    try {
      channel = new BroadcastChannel("oauth_callback");
      channel.onmessage = (event) => handleCallback(event.data);
    } catch (e) {
      console.log("BroadcastChannel not supported");
    }

    // Method 3: localStorage event
    const handleStorage = (event) => {
      if (event.key === "oauth_callback" && event.newValue) {
        try {
          const data = JSON.parse(event.newValue);
          handleCallback(data);
          localStorage.removeItem("oauth_callback");
        } catch (e) {
          console.log("Failed to parse localStorage data");
        }
      }
    };
    window.addEventListener("storage", handleStorage);

    // Also check localStorage on mount (in case callback already happened)
    try {
      const stored = localStorage.getItem("oauth_callback");
      if (stored) {
        const data = JSON.parse(stored);
        if (data.timestamp && Date.now() - data.timestamp < 30000) {
          handleCallback(data);
        }
        localStorage.removeItem("oauth_callback");
      }
    } catch {
      // localStorage may be unavailable or data may be malformed - ignore silently
    }

    return () => {
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("storage", handleStorage);
      if (channel) channel.close();
    };
  }, [authData, exchangeTokens]);

  // Handle manual URL input
  const handleManualSubmit = async () => {
    try {
      setError(null);

      // Paste-token mode (Trae/Windsurf): token goes straight to /exchange
      if (authMode === "paste-token" && PASTE_TOKEN_PROVIDERS[provider]) {
        const token = pasteToken.trim();
        if (!token) throw new Error("Missing token");
        const res = await fetch(`/api/oauth/${provider}/exchange`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: token }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setStep("success");
        onSuccessRef.current?.();
        return;
      }

      const input = callbackUrl.trim();

      // aws-quick paste-back: the input is the browser's final address (either
      // the hop-1 /callback?... discovery URL or the final /?code&state URL) —
      // handled by /paste, not the generic callback-URL exchange.
      if (provider === "aws-quick" && input) {
        await submitAwsQuickPaste(input);
        return;
      }

      // Trae/Windsurf/Zed proxy flow fallback (popup blocked): paste the full callback URL
      if (PROXY_OAUTH_PROVIDERS.has(provider) && input) {
        const res = await fetch(`/api/oauth/${provider}/exchange`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: input,
            state: authData?.state,
            // Zed manual fallback needs the same attempt material as the
            // automatic path (redirectUri + RSA verifier + system_id).
            ...(authData?.redirectUri ? { redirectUri: authData.redirectUri } : {}),
            ...(authData?.codeVerifier ? { codeVerifier: authData.codeVerifier } : {}),
            ...(authData?.systemId ? { systemId: authData.systemId } : {}),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setStep("success");
        onSuccessRef.current?.();
        return;
      }

      // Detect raw JWT access token (starts with eyJ) — skip URL parsing
      if (input.startsWith("eyJ") && input.includes(".")) {
        await exchangeTokens(input, null);
        return;
      }

      if (provider === "xai" && input && !input.includes("://") && !input.includes("?") && !input.includes("code=")) {
        await completeXaiManualCode(input);
        return;
      }

      if (provider === "kimchi" && input && !input.includes("://") && !input.includes("?")) {
        await exchangeTokens(input, null);
        return;
      }

      const url = new URL(input);
      const code = url.searchParams.get("code");
      const token = url.searchParams.get("token");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");

      if (errorParam) {
        throw new Error(url.searchParams.get("error_description") || errorParam);
      }

      if (!code && !token) {
        throw new Error(
          provider === "xai"
            ? "Paste the callback URL or copied xAI code"
            : provider === "kimchi"
              ? "No Kimchi token found in URL"
              : "No authorization code found in URL"
        );
      }

      await exchangeTokens(token || code, state);
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  };

  // Clear session on modal close + cleanup proxy (idempotent: the owned
  // proxy is stopped at most once across effect-close, button-close, and
  // Escape/backdrop-close — all funnel through here or the close effect).
  const handleClose = useCallback(() => {
    stopOwnedProxy();
    onCloseRef.current();
  }, [stopOwnedProxy]);

  if (!provider || !providerInfo) return null;
  const isXaiProvider = provider === "xai";
  const isKimchiProvider = provider === "kimchi";
  const deviceLoginUrl = deviceData?.verification_uri_complete || deviceData?.verification_uri || "";
  const modalTitle = isXaiProvider ? "Connect Grok Build OAuth" : `Connect ${providerInfo.name}`;
  const manualPlaceholder = isXaiProvider
    ? "http://127.0.0.1:56121/callback?code=... or copied code"
    : isKimchiProvider
      ? `${placeholderUrl.replace("code=...", "token=...")} or copied token`
      : placeholderUrl;

  return (
    <Modal isOpen={isOpen} title={modalTitle} onClose={handleClose} size="lg">
      <div className="flex flex-col gap-4">
        {/* Proxy OAuth (trae/windsurf/zed): browser flow; paste-token only when configured */}
        {PROXY_OAUTH_PROVIDERS.has(provider) && (step === "waiting" || step === "input" || step === "error") && (
          <>
            {PASTE_TOKEN_PROVIDERS[provider] && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setAuthMode("browser"); setError(null); setStep("waiting"); startOAuthFlow(); }}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${authMode === "browser" ? "border-primary bg-primary/10 text-primary" : "border-border text-text-muted hover:text-primary"}`}
                >
                  <span className="material-symbols-outlined text-[16px] align-[-3px] mr-1.5" aria-hidden="true">public</span>Sign in with browser
                </button>
                <button
                  type="button"
                  onClick={() => { setAuthMode("paste-token"); setError(null); setStep("input"); }}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${authMode === "paste-token" ? "border-primary bg-primary/10 text-primary" : "border-border text-text-muted hover:text-primary"}`}
                >
                  <span className="material-symbols-outlined text-[16px] align-[-3px] mr-1.5" aria-hidden="true">key</span>Paste token
                </button>
              </div>
            )}

            {authMode === "browser" && (
              <>
                {step === "waiting" && (
                  <div className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg bg-sidebar/50">
                    <span className="material-symbols-outlined text-base text-primary animate-spin">progress_activity</span>
                    <span className="text-sm">Waiting for browser authorization…</span>
                  </div>
                )}
                {/* Rendered for both states: the popup can come back blank on
                    "input" too, and that state has no visible sign-in link. */}
                {provider === "aws-quick" && (step === "waiting" || step === "input") && (
                  <button
                    type="button"
                    onClick={() => {
                      const u = authData?.authUrl || authData?.authorizeUrl;
                      if (u) window.open(u, "_blank", "noopener,noreferrer");
                    }}
                    className="w-full text-xs text-text-muted hover:text-primary underline"
                  >
                    Popup blank or blocked? Open the sign-in page manually
                  </button>
                )}
                {step === "input" && (
                  <div className="space-y-3">
                    <p className="text-sm text-text-muted">
                      The popup was blocked, so authorize in your browser and paste the full callback URL here:
                    </p>
                    <Input
                      value={callbackUrl}
                      onChange={(e) => setCallbackUrl(e.target.value)}
                      placeholder="http://127.0.0.1:.../callback?..."
                      className="font-mono text-xs"
                    />
                    <div className="flex gap-2">
                      <Button onClick={handleManualSubmit} fullWidth disabled={!callbackUrl}>Connect</Button>
                      <Button onClick={handleClose} variant="ghost" fullWidth>Cancel</Button>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* aws-quick paste-back wizard. AWS OIDC public clients must use a
                LOOPBACK redirect, so a browser on another machine can never hit
                this server's 127.0.0.1 listener. Two address-bar URLs are
                produced: hop-1 (/callback?nonce=…) teaches the server the
                tenant/issuer, hop-2 (/?code=…) finishes the exchange. */}
            {provider === "aws-quick" && authMode === "browser" && (step === "waiting" || step === "input") && (
              <div className="space-y-3">
                <div className="flex items-center gap-3 my-1">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-xs text-text-muted uppercase tracking-wider">
                    Browser on another machine? Paste both URLs
                  </span>
                  <div className="flex-1 h-px bg-border" />
                </div>

                <div className="flex items-center gap-2 text-[11px]">
                  <span className={`rounded-full px-2 py-0.5 border ${awsQuickPasteStep === "discovery" ? "border-primary text-primary" : "border-border text-text-muted"}`}>
                    Step 1 · sign-in
                  </span>
                  <span className="text-text-muted">→</span>
                  <span className={`rounded-full px-2 py-0.5 border ${awsQuickPasteStep === "code" ? "border-primary text-primary" : "border-border text-text-muted"}`}>
                    Step 2 · authorize
                  </span>
                </div>

                <p className="text-xs text-text-muted">
                  {awsQuickPasteStep === "discovery"
                    ? "Finish the AWS sign-in until the browser shows a connection error at 127.0.0.1. Copy that whole address bar URL (it contains nonce=…) and paste it below. The authorize page opens next."
                    : "Approve access on the authorize page. The browser then fails again at 127.0.0.1 — copy that whole address bar URL (it contains code=…) and paste it below to finish."}
                </p>

                <Input
                  value={awsQuickPasteUrl}
                  onChange={(e) => setAwsQuickPasteUrl(e.target.value)}
                  placeholder={awsQuickPasteStep === "discovery"
                    ? "http://127.0.0.1:<port>/callback?nonce=…&issuerUrl=…"
                    : "http://127.0.0.1:<port>/?code=…&state=…"}
                  className="font-mono text-xs"
                />

                {/* Paste failures keep the wizard mounted and surface here —
                    the error step would destroy the entered URL. */}
                {error && <p className="text-xs text-danger">{error}</p>}

                {awsQuickPasteUrl && /[?&]code=/.test(awsQuickPasteUrl) && awsQuickPasteStep === "discovery" && (
                  <p className="text-[11px] text-amber-500">
                    This looks like the final URL (code=…). If the sign-in page was reached on this machine the server may
                    already have the tenant — Connect will tell you.
                  </p>
                )}

                <div className="flex gap-2">
                  <Button onClick={pasteAwsQuickFromClipboard} variant="ghost" fullWidth disabled={awsQuickBusy}>
                    Paste from clipboard
                  </Button>
                  <Button
                    onClick={() => submitAwsQuickPaste(awsQuickPasteUrl)}
                    fullWidth
                    disabled={awsQuickBusy || !awsQuickPasteUrl}
                  >
                    {awsQuickPasteStep === "discovery" ? "Continue" : "Connect"}
                  </Button>
                </div>
                <button
                  type="button"
                  onClick={handleClose}
                  className="w-full text-[11px] text-text-muted hover:text-primary underline"
                >
                  Cancel
                </button>

                <p className="text-[11px] text-text-muted">
                  Want zero pastes? Run the dashboard on this machine, or open an SSH tunnel so the loopback callback
                  reaches the server: <span className="font-mono">ssh -L &lt;port&gt;:127.0.0.1:&lt;port&gt; &lt;this-host&gt;</span>
                  {" "}(the port is in the sign-in URL).
                </p>
              </div>
            )}

            {authMode === "paste-token" && PASTE_TOKEN_PROVIDERS[provider] && (
              <div className="space-y-3">
                {ideStatus && !ideStatus.installed && (
                  <div className={`px-3 py-2 rounded-lg text-sm ${PASTE_TOKEN_PROVIDERS[provider].ideOptional ? "bg-info-bg text-info" : "bg-warning-bg text-warning"}`}>
                    {PASTE_TOKEN_PROVIDERS[provider].ideName} IDE not detected.
                    {PASTE_TOKEN_PROVIDERS[provider].ideOptional
                      ? " You can still grab the token from DevTools."
                      : ` Install ${PASTE_TOKEN_PROVIDERS[provider].ideName} IDE to get the token, or use "Sign in with browser".`}
                  </div>
                )}
                <p className="text-sm text-text-muted">{PASTE_TOKEN_PROVIDERS[provider].instructions}</p>
                <Input
                  value={pasteToken}
                  onChange={(e) => setPasteToken(e.target.value)}
                  placeholder={PASTE_TOKEN_PROVIDERS[provider].placeholder}
                  className="font-mono text-xs"
                />
                <div className="flex gap-2">
                  <Button onClick={handleManualSubmit} fullWidth disabled={!pasteToken}>Connect</Button>
                  <Button onClick={handleClose} variant="ghost" fullWidth>Cancel</Button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Waiting + Manual Input combined (non-device-code, non-proxy) */}
        {(step === "waiting" || step === "input") && !isDeviceCode && !PROXY_OAUTH_PROVIDERS.has(provider) && (
          <>
            {/* Option A: Auto via popup */}
            <div className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg bg-sidebar/50">
              <span className="material-symbols-outlined text-base text-primary animate-spin">
                progress_activity
              </span>
              <span className="text-sm">
                {isXaiProvider ? "Waiting for Grok Build OAuth…" : "Waiting for popup authorization…"}
              </span>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3 my-1">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-text-muted uppercase tracking-wider">Or paste callback URL manually</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* Option B: Manual paste */}
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium mb-2">
                  Step 1: Open this {isXaiProvider ? "Grok Build OAuth URL" : "URL"} in your browser
                </p>
                <div className="flex gap-2">
                  <Input value={authData?.authUrl || ""} readOnly className="flex-1 font-mono text-xs" />
                  <Button variant="secondary" icon={copied === "auth_url" ? "check" : "content_copy"} onClick={() => copy(authData?.authUrl, "auth_url")} disabled={!authData?.authUrl}>
                    Copy
                  </Button>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium mb-2">
                  Step 2: Paste the {provider === "xai" ? "callback URL or copied code" : isKimchiProvider ? "callback URL or copied token" : "callback URL"} here
                </p>
                <p className="text-xs text-text-muted mb-2">
                  {provider === "xai"
                    ? "If xAI shows a code instead of redirecting, paste that code here."
                    : isKimchiProvider
                      ? "After authorization, copy the full callback URL or token from your browser."
                    : "After authorization, copy the full URL from your browser."}
                </p>
                <Input
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                  placeholder={manualPlaceholder}
                  className="font-mono text-xs"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={handleManualSubmit} fullWidth disabled={!callbackUrl}>
                Connect
              </Button>
              <Button onClick={handleClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </>
        )}

        {/* Device Code Flow - Waiting */}
        {step === "waiting" && isDeviceCode && deviceData && (
          <>
            <div className="text-center py-4">
              <p className="text-sm text-text-muted mb-4">
                Visit the login URL below and authorize:
              </p>
              <div className="bg-sidebar p-4 rounded-lg mb-4">
                <p className="text-xs text-text-muted mb-1">Login URL</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-sm break-all">{deviceLoginUrl}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={copied === "login_url" ? "check" : "content_copy"}
                    onClick={() => copy(deviceLoginUrl, "login_url")}
                    disabled={!deviceLoginUrl}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="open_in_new"
                    onClick={() => window.open(deviceLoginUrl, "_blank", "noopener,noreferrer")}
                    disabled={!deviceLoginUrl}
                  >
                    Open
                  </Button>
                </div>
              </div>
              {deviceData.user_code && (
                <div className="bg-primary/10 p-4 rounded-lg">
                  <p className="text-xs text-text-muted mb-1">Your Code</p>
                  <div className="flex items-center justify-center gap-2">
                    <p className="text-2xl font-mono font-bold text-primary">{deviceData.user_code}</p>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={copied === "user_code" ? "check" : "content_copy"}
                      onClick={() => copy(deviceData.user_code, "user_code")}
                    />
                  </div>
                </div>
              )}
            </div>
            {polling && (
              <div className="flex items-center justify-center gap-2 text-sm text-text-muted">
                <span className="material-symbols-outlined animate-spin">progress_activity</span>
                Waiting for authorization...
              </div>
            )}
          </>
        )}

        {/* Success Step */}
        {step === "success" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-success-bg flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-success">check_circle</span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Connected Successfully!</h3>
            <p className="text-sm text-text-muted mb-4">
              Your {providerInfo.name} account has been connected.
            </p>
            <Button onClick={handleClose} fullWidth>
              Done
            </Button>
          </div>
        )}

        {/* Error Step */}
        {step === "error" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-danger-bg flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-danger">error</span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Connection Failed</h3>
            <p className="text-sm text-danger mb-4">{error}</p>
            <div className="flex gap-2">
              <Button onClick={startOAuthFlow} variant="secondary" fullWidth>
                Try Again
              </Button>
              <Button onClick={handleClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

OAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string,
  providerInfo: PropTypes.shape({ name: PropTypes.string }),
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
  /** Extra metadata passed to /authorize and /exchange (e.g. gitlab clientId/baseUrl) */
  oauthMeta: PropTypes.object,
  /** Optional Kiro IDC config for AWS IAM Identity Center device flow */
  idcConfig: PropTypes.shape({
    startUrl: PropTypes.string,
    region: PropTypes.string,
  }),
};
