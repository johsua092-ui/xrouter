"use client";

import { useState, useEffect, useRef } from "react";
import LogoMark from "@/shared/components/LogoMark";

function formatTokenLimit(n) {
  const v = Number(n);
  if (!v || v <= 0) return "Unlimited";
  if (v >= 1_000_000_000) {
    const val = v / 1_000_000_000;
    return `${Number.isInteger(val) ? val : val.toFixed(1)}B tokens`;
  }
  if (v >= 1_000_000) {
    const val = v / 1_000_000;
    return `${Number.isInteger(val) ? val : val.toFixed(1)}M tokens`;
  }
  if (v >= 1_000) {
    const val = v / 1_000;
    return `${Number.isInteger(val) ? val : val.toFixed(1)}K tokens`;
  }
  return `${v.toLocaleString()} tokens`;
}

export default function ClaimPage() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState("");
  const [themeModalOpen, setThemeModalOpen] = useState(false);
  const [activeSnippetTab, setActiveSnippetTab] = useState("curl");

  // Public faucet / community allocation info
  const [faucetInfo, setFaucetInfo] = useState(null);
  const [loadingFaucet, setLoadingFaucet] = useState(true);

  // CAPTCHA & Security Challenge
  const [captchaInput, setCaptchaInput] = useState("");
  const [captchaImage, setCaptchaImage] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const challengeRef = useRef(null);

  // Cloudflare Turnstile
  const [turnstileToken, setTurnstileToken] = useState("");
  const turnstileContainerRef = useRef(null);
  const turnstileWidgetId = useRef(null);

  // Anti-Bot & Telemetry
  const pageLoadTime = useRef(Date.now());
  const [honeypot, setHoneypot] = useState("");
  const deviceFpRef = useRef("");
  const hardwareFpRef = useRef("");
  const hwMetricsRef = useRef(null);
  const audioHashRef = useRef("");
  const automationProbeRef = useRef({ isAutomated: false, indicators: [] });
  const trajectoryRef = useRef([]);
  const [userInteracted, setUserInteracted] = useState(false);

  // Biometric interaction & motion recording
  useEffect(() => {
    const recordMotion = (x, y) => {
      setUserInteracted(true);
      if (typeof x !== "number" || typeof y !== "number") return;
      const t = Date.now();
      const traj = trajectoryRef.current;
      if (traj.length === 0 || t - traj[traj.length - 1].t > 30) {
        if (traj.length < 50) {
          traj.push({ x: Math.round(x), y: Math.round(y), t });
        }
      }
    };

    const onPointerMove = (e) => recordMotion(e.clientX, e.clientY);
    const onTouchMove = (e) => {
      if (e.touches && e.touches[0]) recordMotion(e.touches[0].clientX, e.touches[0].clientY);
    };
    const onAction = () => setUserInteracted(true);

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("pointerdown", onAction);
    window.addEventListener("mousedown", onAction);
    window.addEventListener("touchstart", onAction);
    window.addEventListener("keydown", onAction);
    window.addEventListener("click", onAction);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("pointerdown", onAction);
      window.removeEventListener("mousedown", onAction);
      window.removeEventListener("touchstart", onAction);
      window.removeEventListener("keydown", onAction);
      window.removeEventListener("click", onAction);
    };
  }, []);

  // Generate deep hardware attestation (Canvas 2D + WebGL GPU + AudioContext)
  // This binds directly to physical GPU / sound chip, completely blocking Airplane Mode & VPN loops!
  useEffect(() => {
    try {
      const nav = window.navigator;
      const screen = window.screen;

      // 1. Basic Device Signature
      const rawEnv = [
        nav.userAgent,
        nav.language,
        screen.colorDepth,
        screen.width + "x" + screen.height,
        new Date().getTimezoneOffset(),
      ].join("###");

      let envHash = 0;
      for (let i = 0; i < rawEnv.length; i++) {
        envHash = (envHash << 5) - envHash + rawEnv.charCodeAt(i);
        envHash |= 0;
      }
      deviceFpRef.current = "dfp_" + Math.abs(envHash).toString(16);

      // 2. STABLE Hardware WebGL GPU & Silicon Parameters (Brave/Incognito/Airplane resistant)
      let gpuVendor = "";
      let gpuRenderer = "";
      let extCount = 0;
      let maxAnisotropy = 0;
      try {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
        if (gl) {
          const dbg = gl.getExtension("WEBGL_debug_renderer_info");
          gpuVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
          gpuRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
          extCount = (gl.getSupportedExtensions() || []).length;
          const aniso = gl.getExtension("EXT_texture_filter_anisotropic") || gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
          maxAnisotropy = aniso ? gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 0;
        }
      } catch {}

      // 3. AudioContext DSP Acoustic Attestation
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          const actx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
          const osc = actx.createOscillator();
          osc.type = "triangle";
          osc.frequency.setValueAtTime(10000, actx.currentTime);
          const comp = actx.createDynamicsCompressor();
          comp.threshold.setValueAtTime(-50, actx.currentTime);
          comp.knee.setValueAtTime(40, actx.currentTime);
          comp.ratio.setValueAtTime(12, actx.currentTime);
          comp.reduction.setValueAtTime(-20, actx.currentTime);
          comp.attack.setValueAtTime(0, actx.currentTime);
          comp.release.setValueAtTime(0.25, actx.currentTime);
          osc.connect(comp);
          comp.connect(actx.destination);
          osc.start(0);
          actx.startRendering().then((buf) => {
            const data = buf.getChannelData(0);
            let aHash = 0;
            for (let i = 4500; i < 5000; i++) aHash += Math.abs(data[i]);
            audioHashRef.current = Math.floor(aHash * 1000000).toString(16);
          }).catch(() => {});
        }
      } catch {}

      // 4. Automation & Headless Sandbox Probes
      const automationIndicators = [];
      if (Boolean(nav.webdriver)) automationIndicators.push("webdriver");
      if (window.document?.documentElement?.getAttribute("webdriver")) automationIndicators.push("dom_webdriver");
      if (window.callPhantom || window._phantom || window.__nightmare) automationIndicators.push("phantom");
      if (window.outerWidth === 0 && window.outerHeight === 0) automationIndicators.push("zero_dimensions");
      automationProbeRef.current = {
        isAutomated: automationIndicators.length > 0,
        indicators: automationIndicators,
      };

      // 5. Immutable Hardware Invariant Signature
      const hardwareRaw = [
        gpuVendor,
        gpuRenderer,
        extCount,
        maxAnisotropy,
        nav.hardwareConcurrency || 4,
        nav.deviceMemory || 4,
        nav.maxTouchPoints || 0,
        screen.width + "x" + screen.height + "x" + screen.colorDepth,
        screen.pixelDepth || 24,
      ].join("|||");

      let hwHash = 0;
      for (let i = 0; i < hardwareRaw.length; i++) {
        hwHash = (hwHash << 5) - hwHash + hardwareRaw.charCodeAt(i);
        hwHash |= 0;
      }
      hardwareFpRef.current = "hwp_" + Math.abs(hwHash).toString(16);

      hwMetricsRef.current = {
        gpuVendor,
        gpuRenderer,
        extCount,
        maxAnisotropy,
        cores: nav.hardwareConcurrency || 4,
        memory: nav.deviceMemory || 4,
        touchPoints: nav.maxTouchPoints || 0,
        screen: `${screen.width}x${screen.height}x${screen.colorDepth}`,
        pixelDepth: screen.pixelDepth || 24,
        pixelRatio: window.devicePixelRatio || 1,
        audioSig: audioHashRef.current || "",
      };
    } catch {}
  }, []);

  // Listen for real human interaction
  useEffect(() => {
    const onInteract = () => setUserInteracted(true);
    window.addEventListener("pointerdown", onInteract);
    window.addEventListener("mousedown", onInteract);
    window.addEventListener("touchstart", onInteract);
    window.addEventListener("keydown", onInteract);
    window.addEventListener("click", onInteract);
    return () => {
      window.removeEventListener("pointerdown", onInteract);
      window.removeEventListener("mousedown", onInteract);
      window.removeEventListener("touchstart", onInteract);
      window.removeEventListener("keydown", onInteract);
      window.removeEventListener("click", onInteract);
    };
  }, []);

  // Helper to read raw cookie by name
  const getCookie = (name) => {
    if (typeof document === "undefined") return null;
    const match = document.cookie.match(new RegExp("(^|;\\s*)(" + name + ")=([^;]*)"));
    return match ? decodeURIComponent(match[3]) : null;
  };

  // Helper to retrieve saved receipt from localStorage, sessionStorage, or document.cookie
  const getSavedReceipt = (targetKey) => {
    if (typeof window === "undefined") return null;
    const isSpecific = Boolean(targetKey && targetKey.toUpperCase() !== "BANSOS");
    const key = (targetKey || "BANSOS").toUpperCase();
    const keysToCheck = isSpecific
      ? ["xr_receipt_" + key, "xr_key_" + key]
      : ["xr_receipt_BANSOS", "xr_key_BANSOS", "xr_latest_receipt"];

    for (const k of keysToCheck) {
      try {
        const local = localStorage.getItem(k);
        if (local) {
          const parsed = JSON.parse(local);
          if (parsed && parsed.apiKey) {
            const parsedCode = (parsed.code || "BANSOS").toUpperCase();
            if (isSpecific && parsedCode !== key) continue;
            return parsed;
          }
        }
      } catch {}

      try {
        const sess = sessionStorage.getItem(k);
        if (sess) {
          const parsed = JSON.parse(sess);
          if (parsed && parsed.apiKey) {
            const parsedCode = (parsed.code || "BANSOS").toUpperCase();
            if (isSpecific && parsedCode !== key) continue;
            return parsed;
          }
        }
      } catch {}

      try {
        const cookieVal = getCookie(k);
        if (cookieVal) {
          const parsed = JSON.parse(cookieVal);
          if (parsed && parsed.apiKey) {
            const parsedCode = (parsed.code || "BANSOS").toUpperCase();
            if (isSpecific && parsedCode !== key) continue;
            return parsed;
          }
        }
      } catch {}
    }
    return null;
  };

  // Clear saved receipt cookies & storage
  const clearSavedReceipts = (targetKey) => {
    if (typeof window === "undefined") return;
    const key = targetKey ? targetKey.toUpperCase() : null;
    const toClear = [
      "xr_latest_receipt",
      "xr_receipt_BANSOS",
      "xr_key_BANSOS",
      ...(key ? ["xr_receipt_" + key, "xr_key_" + key] : [])
    ];
    if (typeof document !== "undefined") {
      const cookies = document.cookie.split(";");
      for (const c of cookies) {
        const name = c.split("=")[0].trim();
        if (name.startsWith("xr_")) {
          document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; SameSite=Lax`;
        }
      }
    }
    for (const k of toClear) {
      try { localStorage.removeItem(k); } catch {}
      try { sessionStorage.removeItem(k); } catch {}
    }
    setResult(null);
  };

  // Fetch Faucet status & Mint Security Challenge
  const loadSecurityChallenge = async (customCode, skipReceipt = false) => {
    // Bind the challenge to the voucher code in play: explicit param wins,
    // otherwise fall back to the live input state so re-mints after a failed
    // attempt stay bound to the same code.
    const bindCode = customCode !== undefined && customCode !== null
      ? String(customCode)
      : String(code || "");
    try {
      let q = bindCode ? `?code=${encodeURIComponent(bindCode)}` : "";
      if (skipReceipt) {
        q += (q ? "&" : "?") + "skipReceipt=1";
      }
      const res = await fetch(`/api/vouchers/claim${q}`);
      if (res.ok) {
        const data = await res.json();

        // 1. If backend detected an existing claim receipt for this device/session, restore it only if code matches!
        if (!skipReceipt && data.savedReceipt && data.savedReceipt.apiKey) {
          const expectedCode = (bindCode || "BANSOS").toUpperCase();
          const receiptCode = (data.savedReceipt.code || "BANSOS").toUpperCase();
          if (expectedCode === receiptCode) {
            saveClaimReceipt(data.savedReceipt);
            setResult(data.savedReceipt);
            setLoadingFaucet(false);
            return true;
          }
        }

        if (data.voucher) {
          const vCode = data.voucher.code;
          setCode(vCode);
          setFaucetInfo({
            name: data.voucher.name,
            description: data.voucher.description,
            tokenLimit: data.voucher.tokenLimit,
            allowedModels: data.voucher.allowedModels,
            expiresInDays: data.voucher.expiresInDays,
            remainingClaims: data.voucher.remainingClaims,
            isCustomCode: true,
            code: vCode,
          });
        } else if (data.hasActiveBansos && data.bansos) {
          setFaucetInfo(data.bansos);
        } else {
          setFaucetInfo(null);
        }
        if (data.challenge) {
          challengeRef.current = data.challenge;
          setCaptchaImage(data.challenge.captchaImage || "");
          setCaptchaToken(data.challenge.captchaToken || "");
        }
        return true;
      }
    } catch (err) {
      console.error(err);
      return false;
    } finally {
      setLoadingFaucet(false);
    }
  };

  const saveClaimReceipt = (data) => {
    try {
      if (!data || !data.apiKey) return;
      const receipt = JSON.stringify(data);
      if (typeof window !== "undefined") {
        const key = (data.code ? data.code.toUpperCase() : "BANSOS");
        try { localStorage.setItem("xr_receipt_" + key, receipt); } catch {}
        try { localStorage.setItem("xr_latest_receipt", receipt); } catch {}
        try { sessionStorage.setItem("xr_receipt_" + key, receipt); } catch {}
        try { sessionStorage.setItem("xr_latest_receipt", receipt); } catch {}

        // Save persistent cookies (1 year)
        const encoded = encodeURIComponent(receipt);
        document.cookie = `xr_receipt_${key}=${encoded}; path=/; max-age=31536000; SameSite=Lax`;
        document.cookie = `xr_latest_receipt=${encoded}; path=/; max-age=31536000; SameSite=Lax`;
      }
    } catch {}
  };

  useEffect(() => {
    pageLoadTime.current = Date.now();
    let queryCode = "";

    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const c = p.get("code");
      if (c) {
        queryCode = c.toUpperCase();
        setCode(queryCode);
      }
      const key = queryCode || "BANSOS";

      // 1. Immediately check persistent multi-store vault (LocalStorage + SessionStorage + Cookies)
      const existing = getSavedReceipt(key);
      if (existing) {
        setResult(existing);
        setLoadingFaucet(false);
        return;
      }
    }

    loadSecurityChallenge(queryCode);
  }, []);

  // Initialize Cloudflare Turnstile Widget (Only on claim form, NEVER on result view!)
  useEffect(() => {
    if (result) return;
    let timeoutId;
    const renderWidget = () => {
      if (result) return;
      if (typeof window !== "undefined" && window.turnstile && turnstileContainerRef.current && !turnstileWidgetId.current) {
        try {
          const id = window.turnstile.render(turnstileContainerRef.current, {
            sitekey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "1x00000000000000000000AA",
            theme: "dark",
            size: "flexible",
            callback: (token) => {
              setTurnstileToken(token);
              setUserInteracted(true);
            },
            "expired-callback": () => setTurnstileToken(""),
            "error-callback": () => setTurnstileToken(""),
          });
          turnstileWidgetId.current = id;
        } catch (e) {
          console.error("Turnstile render error:", e);
        }
      }
    };

    if (typeof window !== "undefined") {
      if (!window.turnstile) {
        const existing = document.getElementById("cf-turnstile-script");
        if (!existing) {
          const script = document.createElement("script");
          script.id = "cf-turnstile-script";
          script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
          script.async = true;
          script.defer = true;
          script.onload = () => {
            timeoutId = setTimeout(renderWidget, 100);
          };
          document.head.appendChild(script);
        }
      } else {
        timeoutId = setTimeout(renderWidget, 100);
      }
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [result]);

  // Clean up Turnstile widget when result view is active so it never overlaps code snippets!
  useEffect(() => {
    if (result && typeof window !== "undefined") {
      if (window.turnstile && turnstileWidgetId.current) {
        try {
          window.turnstile.remove(turnstileWidgetId.current);
        } catch {}
        turnstileWidgetId.current = null;
      }
      // Strip any orphaned iframes or containers left behind by Cloudflare script
      try {
        const orphaned = document.querySelectorAll('iframe[src*="cloudflare"], iframe[src*="turnstile"], div[id*="cf-chl"]');
        orphaned.forEach((el) => {
          try { el.remove(); } catch {}
        });
      } catch {}
    }
  }, [result]);

  // Client-Side Cryptographically Bound Proof-of-Work Solver (SHA-256)
  const solveProofOfWork = async (challenge) => {
    if (!challenge) return { token: null, nonce: 0 };
    const salt = challenge.salt;
    const difficulty = challenge.difficulty || 4;
    const targetPrefix = "0".repeat(difficulty);
    const token = challenge.challengeToken || "";
    const hfp = hardwareFpRef.current || "";

    const encoder = new TextEncoder();
    let nonce = 0;
    while (nonce < 600000) {
      const raw = `${salt}:${token}:${hfp}:${nonce}`;
      const data = encoder.encode(raw);
      const hashBuf = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuf));
      const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hashHex.startsWith(targetPrefix)) {
        return { token: challenge.challengeToken, nonce };
      }
      nonce++;
    }
    return { token: challenge.challengeToken, nonce: 0 };
  };

  // 1-Click Instant Faucet Provisioning
  const handleInstantProvision = async (e) => {
    if (e && !e.isTrusted) return; // Block synthetic click bots

    try {
      setLoading(true);
      setError("");
      setResult(null);

      // Solve Proof-of-Work challenge
      const pow = await solveProofOfWork(challengeRef.current);

      const res = await fetch("/api/vouchers/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: (faucetInfo?.code || code || "").trim(),
          isBansos: !(faucetInfo?.code || code),
          website: honeypot,
          captchaCode: captchaInput.trim(),
          captchaToken: captchaToken,
          _t: pageLoadTime.current,
          _dfp: deviceFpRef.current,
          _hfp: hardwareFpRef.current,
          hwMetrics: hwMetricsRef.current,
          _gpuRenderer: typeof window !== "undefined" ? window.navigator?.userAgent : "",
          _isWebdriver: typeof window !== "undefined" ? Boolean(window.navigator?.webdriver) : false,
          _automationDetected: Boolean(automationProbeRef.current?.isAutomated),
          _isTrusted: Boolean(!e || e.isTrusted),
          trajectory: trajectoryRef.current,
          _challengeToken: pow.token,
          _powNonce: pow.nonce,
          turnstileToken,
          interactiveProof: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to provision API key");
        // Reload challenge on failure
        loadSecurityChallenge();
        if (typeof window !== "undefined" && window.turnstile && turnstileWidgetId.current) {
          try { window.turnstile.reset(turnstileWidgetId.current); } catch {}
        }
      } else {
        saveClaimReceipt(data);
        setResult(data);
      }
    } catch (err) {
      setError(err.message || "Network connection failure");
      loadSecurityChallenge();
      if (typeof window !== "undefined" && window.turnstile && turnstileWidgetId.current) {
        try { window.turnstile.reset(turnstileWidgetId.current); } catch {}
      }
    } finally {
      setLoading(false);
    }
  };

  // Single Unified Form Claim Handler (1 Layer)
  const handleClaimByCode = async (e) => {
    e.preventDefault();
    if (!e.isTrusted) return; // Block synthetic click bots
    const targetCode = (code || faucetInfo?.code || "").trim();
    if (!targetCode && !faucetInfo) return;

    try {
      setLoading(true);
      setError("");
      setResult(null);

      // Solve Proof-of-Work challenge using current challengeRef
      const pow = await solveProofOfWork(challengeRef.current);

      const res = await fetch("/api/vouchers/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: targetCode,
          isBansos: !targetCode,
          website: honeypot,
          captchaCode: captchaInput.trim(),
          captchaToken: challengeRef.current?.captchaToken || captchaToken,
          _t: pageLoadTime.current,
          _dfp: deviceFpRef.current,
          _hfp: hardwareFpRef.current,
          hwMetrics: hwMetricsRef.current,
          _gpuRenderer: typeof window !== "undefined" ? window.navigator?.userAgent : "",
          _isWebdriver: typeof window !== "undefined" ? Boolean(window.navigator?.webdriver) : false,
          _automationDetected: Boolean(automationProbeRef.current?.isAutomated),
          _isTrusted: Boolean(!e || e.isTrusted),
          trajectory: trajectoryRef.current,
          _challengeToken: pow.token,
          _powNonce: pow.nonce,
          turnstileToken,
          interactiveProof: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Gagal mengklaim voucher pass.");
        loadSecurityChallenge(targetCode, true);
        if (typeof window !== "undefined" && window.turnstile && turnstileWidgetId.current) {
          try { window.turnstile.reset(turnstileWidgetId.current); } catch {}
        }
      } else {
        saveClaimReceipt(data);
        setResult(data);
      }
    } catch (err) {
      setError(err.message || "Network connection failure");
      loadSecurityChallenge(targetCode, true);
      if (typeof window !== "undefined" && window.turnstile && turnstileWidgetId.current) {
        try { window.turnstile.reset(turnstileWidgetId.current); } catch {}
      }
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text, type) => {
    navigator.clipboard.writeText(text);
    if (type === "key") {
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } else {
      setCopiedSnippet(type);
      setTimeout(() => setCopiedSnippet(""), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-bg text-text-main flex flex-col justify-between selection:bg-primary/25 selection:text-white font-sans antialiased">
      {/* Hairline grid background */}
      <div className="fixed inset-0 pointer-events-none bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px] opacity-40" />

      {/* Top Console Bar */}
      <header className="relative z-10 flex h-13 w-full items-center justify-between border-b border-border bg-surface px-4 sm:px-8">
        <div className="flex items-center gap-3">
          <div className="flex size-7 items-center justify-center rounded-[5px] border border-primary/40 bg-surface-2 shrink-0 shadow-xs overflow-hidden p-0.5">
            <LogoMark className="size-full" />
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-bold tracking-wider text-text-main">X ROUTER</span>
            <span className="text-border">/</span>
            <span className="font-mono text-[11px] text-text-muted uppercase tracking-wider">Developer Access Portal</span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[11px] font-mono text-text-muted">
          <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
          <span>GATEWAY ONLINE</span>
        </div>
      </header>

      {/* Main Terminal Frame */}
      <main className="relative z-10 flex-1 flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-xl">
          {!result ? (
            /* Intended Claim Container */
            <div className="rounded-[6px] border border-border bg-surface p-6 sm:p-7 shadow-[var(--shadow-elev)] space-y-5">
              
              <div className="border-b border-border pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="material-symbols-outlined text-primary text-[18px]">key</span>
                  <h1 className="text-base sm:text-lg font-bold tracking-tight text-text-main">
                    API Key Provisioning
                  </h1>
                </div>
                <p className="text-xs text-text-muted">
                  Generate an authenticated X Router API key to connect models directly into Cursor, Cline, or custom SDKs.
                </p>
              </div>

              {/* VOUCHER & FAUCET DETAILS (IF ACTIVE) */}
              {faucetInfo && (
                <div className="rounded-[6px] border border-border bg-surface-2 p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="rounded-[3px] bg-surface px-2 py-0.5 font-mono text-[10px] font-bold text-text-main border border-border">
                      {faucetInfo.isCustomCode ? `VOUCHER: ${faucetInfo.code}` : "PUBLIC FAUCET (BANSOS)"}
                    </span>
                    <span className="font-mono text-[11px] text-emerald-500 font-semibold">
                      {faucetInfo.remainingClaims} slots remaining
                    </span>
                  </div>

                  <div>
                    <h2 className="text-xs font-semibold text-text-main">{faucetInfo.name}</h2>
                    {faucetInfo.description && (
                      <p className="text-[11px] text-text-muted mt-0.5">
                        {faucetInfo.description}
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-2 font-mono text-[11px] py-0.5">
                    <div className="rounded-[4px] bg-surface p-2 border border-border">
                      <span className="text-text-muted block text-[9.5px]">ALLOCATION</span>
                      <span className="font-semibold text-text-main">
                        {faucetInfo.tokenLimit != null ? formatTokenLimit(faucetInfo.tokenLimit) : "—"}
                      </span>
                    </div>
                    <div className="rounded-[4px] bg-surface p-2 border border-border">
                      <span className="text-text-muted block text-[9.5px]">MODELS</span>
                      <span className="font-semibold text-text-main truncate block">
                        {faucetInfo.allowedModels ? (faucetInfo.allowedModels === "*" ? "All (*)" : faucetInfo.allowedModels) : "—"}
                      </span>
                    </div>
                    <div className="rounded-[4px] bg-surface p-2 border border-border">
                      <span className="text-text-muted block text-[9.5px]">LIFESPAN</span>
                      <span className="font-semibold text-text-main">{faucetInfo.expiresInDays != null ? `${faucetInfo.expiresInDays} Days` : "—"}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* SINGLE UNIFIED CLAIM FORM (1 LAYER) */}
              <form onSubmit={handleClaimByCode} className="space-y-3.5">
                {/* Honeypot field for bot traps */}
                <input
                  type="text"
                  name="website"
                  value={honeypot}
                  onChange={(e) => setHoneypot(e.target.value)}
                  tabIndex={-1}
                  autoComplete="off"
                  style={{ display: "none" }}
                  aria-hidden="true"
                />

                <div className="space-y-1">
                  <label className="text-[10px] font-mono text-text-muted uppercase block">
                    VOUCHER PASS CODE
                  </label>
                  <input
                    type="text"
                    placeholder="Enter voucher pass code (e.g. TEST)..."
                    value={code}
                    onChange={(e) => {
                      const val = e.target.value.toUpperCase();
                      setCode(val);
                      if (val.trim()) loadSecurityChallenge(val.trim(), true);
                    }}
                    className="w-full rounded-[5px] border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-xs tracking-wider text-text-main uppercase placeholder:text-text-muted focus:border-primary focus:outline-none"
                  />
                </div>

                {/* CLOUDFLARE TURNSTILE (Hanya jika ada site key resmi) */}
                {process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY && process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY !== "1x00000000000000000000AA" && (
                  <div className="flex flex-col items-center justify-center pt-1">
                    <div
                      ref={turnstileContainerRef}
                      className="w-full flex justify-center min-h-[65px]"
                    />
                  </div>
                )}

                {/* MATH CAPTCHA (LANGSUNG TAMPIL DARI AWAL) */}
                {captchaImage ? (
                  <div className="space-y-1 pt-1">
                    <label className="text-[10px] font-mono text-text-muted uppercase block">
                      SECURITY VERIFICATION
                    </label>
                    <div className="flex items-center gap-2">
                      <img
                        src={captchaImage}
                        alt="captcha"
                        className="h-[44px] rounded-[5px] border border-border bg-surface-2"
                      />
                      <input
                        type="text"
                        placeholder="Hitung jawaban..."
                        value={captchaInput}
                        onChange={(e) => setCaptchaInput(e.target.value)}
                        className="flex-1 rounded-[5px] border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-xs text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-2 text-xs text-text-muted font-mono">
                    Memuat verifikasi captcha...
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || (!code.trim() && !faucetInfo) || (captchaImage && !captchaInput.trim())}
                  className="w-full rounded-[5px] bg-primary py-2.5 text-xs font-semibold text-white shadow-xs hover:bg-primary/90 active:scale-[0.99] disabled:opacity-50 transition-all flex items-center justify-center gap-2 cursor-pointer mt-2"
                >
                  {loading ? (
                    <span className="font-mono">Memverifikasi & Menerbitkan Key...</span>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-[16px]">key_vertical</span>
                      <span>Klaim API Key Sekarang</span>
                    </>
                  )}
                </button>
              </form>

              {error && (
                <div className="rounded-[5px] border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-500 flex items-start gap-2">
                  <span className="material-symbols-outlined text-[15px] shrink-0 mt-0.5">error</span>
                  <span>{error}</span>
                </div>
              )}

              <div className="pt-1 text-center">
                <button
                  type="button"
                  onClick={() => {
                    clearSavedReceipts();
                    setError("");
                    loadSecurityChallenge(code, true);
                  }}
                  className="text-[11px] font-mono text-text-muted hover:text-primary transition-colors cursor-pointer"
                >
                  [Reset Cookie & Sesi]
                </button>
              </div>
            </div>
          ) : (
            /* Result Panel */
            <div className="rounded-[6px] border border-border bg-surface p-6 sm:p-7 shadow-[var(--shadow-elev)] space-y-5">
              <div className="border-b border-border pb-3 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-text-main">Credential Provisioned</h2>
                  <p className="text-xs text-text-muted mt-0.5">Copy this API key now. It is permanently active for your allocated quota.</p>
                </div>
                <span className="rounded-[3px] bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-mono text-emerald-500 font-bold">
                  ACTIVE
                </span>
              </div>

              {/* API Key Display */}
              <div className="space-y-1.5">
                <span className="text-[10px] font-mono text-text-muted uppercase">API KEY</span>
                <div className="flex items-center gap-2 rounded-[5px] border border-border bg-surface-2 p-2">
                  <input
                    type="text"
                    readOnly
                    value={result.apiKey}
                    className="flex-1 bg-transparent font-mono text-xs text-text-main select-all focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => copyToClipboard(result.apiKey, "key")}
                    className="rounded-[4px] bg-primary px-3 py-1 text-xs font-semibold text-white hover:bg-primary/90 transition-colors cursor-pointer"
                  >
                    {copiedKey ? "Copied" : "Copy Key"}
                  </button>
                </div>
              </div>

              {/* Metadata strip */}
              <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
                <div className="rounded-[4px] bg-surface-2 p-2 border border-border">
                  <span className="text-text-muted block text-[9.5px]">TOKEN LIMIT</span>
                  <span className="font-semibold text-text-main">
                    {formatTokenLimit(result.tokenLimit)}
                  </span>
                </div>
                <div className="rounded-[4px] bg-surface-2 p-2 border border-border">
                  <span className="text-text-muted block text-[9.5px]">MODELS</span>
                  <span className="font-semibold text-text-main truncate block" title={result.allowedModels}>
                    {result.allowedModels === "*" ? "All Models (*)" : result.allowedModels}
                  </span>
                </div>
                <div className="rounded-[4px] bg-surface-2 p-2 border border-border">
                  <span className="text-text-muted block text-[9.5px]">EXPIRES</span>
                  <span className="font-semibold text-text-main">
                    {result.expiresAt ? new Date(result.expiresAt).toLocaleDateString() : "Never"}
                  </span>
                </div>
              </div>

              {/* Base URL */}
              <div className="space-y-1.5">
                <span className="text-[10px] font-mono text-text-muted uppercase">BASE URL (OPENAI COMPATIBLE)</span>
                <div className="flex items-center gap-2 rounded-[5px] border border-border bg-surface-2 p-2 text-xs font-mono">
                  <span className="flex-1 text-text-main truncate">{result.baseUrl}</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(result.baseUrl, "baseUrl")}
                    className="text-text-muted hover:text-text-main transition-colors cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[15px]">
                      {copiedSnippet === "baseUrl" ? "check" : "content_copy"}
                    </span>
                  </button>
                </div>
              </div>

              {/* Quickstart Tabs */}
              <div className="space-y-2 border-t border-border pt-3">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-[10px] uppercase text-text-muted font-bold">CLIENT QUICKSTART</span>
                  <div className="flex items-center gap-1">
                    {["curl", "python", "cursor", "cline"].map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setActiveSnippetTab(tab)}
                        className={`px-2 py-0.5 rounded-[3px] uppercase text-[10px] transition-colors cursor-pointer ${
                          activeSnippetTab === tab
                            ? "bg-primary text-white font-bold"
                            : "text-text-muted hover:text-text-main"
                        }`}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                </div>

                {activeSnippetTab === "curl" && (() => {
                  const curlCode = result.configs?.curl || `curl ${result.baseUrl || "http://127.0.0.1:8080/v1"}/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ***" \\\n  -d '{"model": "${result.allowedModels === "*" ? "gpt-4o" : (result.allowedModels || "").split(",")[0].trim() || "gpt-4o"}", "messages": [{"role": "user", "content": "Hello!"}]}'`;
                  return (
                    <div className="relative rounded-[5px] border border-border bg-surface-2 p-3 text-[11px] font-mono">
                      <button
                        type="button"
                        onClick={() => copyToClipboard(curlCode, "curl")}
                        className="absolute right-2 top-2 rounded-[3px] bg-surface-3 px-2 py-0.5 text-[10px] text-text-muted hover:text-text-main cursor-pointer"
                      >
                        {copiedSnippet === "curl" ? "Copied" : "Copy"}
                      </button>
                      <pre className="overflow-x-auto text-text-main pr-12">{curlCode}</pre>
                    </div>
                  );
                })()}

                {activeSnippetTab === "python" && (() => {
                  const pythonCode = result.configs?.python || `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${result.baseUrl || "http://127.0.0.1:8080/v1"}",\n    api_key="${result.apiKey}"\n)\n\nresponse = client.chat.completions.create(\n    model="${result.allowedModels === "*" ? "gpt-4o" : (result.allowedModels || "").split(",")[0].trim() || "gpt-4o"}",\n    messages=[{"role": "user", "content": "Hello X Router!"}]\n)\nprint(response.choices[0].message.content)`;
                  return (
                    <div className="relative rounded-[5px] border border-border bg-surface-2 p-3 text-[11px] font-mono">
                      <button
                        type="button"
                        onClick={() => copyToClipboard(pythonCode, "python")}
                        className="absolute right-2 top-2 rounded-[3px] bg-surface-3 px-2 py-0.5 text-[10px] text-text-muted hover:text-text-main cursor-pointer"
                      >
                        {copiedSnippet === "python" ? "Copied" : "Copy"}
                      </button>
                      <pre className="overflow-x-auto text-text-main pr-12">{pythonCode}</pre>
                    </div>
                  );
                })()}

                {activeSnippetTab === "cursor" && (
                  <div className="rounded-[5px] border border-border bg-surface-2 p-3 space-y-2 text-xs font-mono">
                    <div className="flex justify-between bg-surface p-2 rounded border border-border">
                      <span className="text-text-muted">Base URL:</span>
                      <span className="text-text-main select-all">{result.baseUrl}</span>
                    </div>
                    <div className="flex justify-between bg-surface p-2 rounded border border-border">
                      <span className="text-text-muted">API Key:</span>
                      <span className="text-text-main select-all">{result.apiKey}</span>
                    </div>
                  </div>
                )}

                {activeSnippetTab === "cline" && (
                  <div className="rounded-[5px] border border-border bg-surface-2 p-3 space-y-2 text-xs font-mono">
                    <div className="flex justify-between bg-surface p-2 rounded border border-border">
                      <span className="text-text-muted">Base URL:</span>
                      <span className="text-text-main select-all">{result.baseUrl}</span>
                    </div>
                    <div className="flex justify-between bg-surface p-2 rounded border border-border">
                      <span className="text-text-muted">API Key:</span>
                      <span className="text-text-main select-all">{result.apiKey}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-2 text-center border-t border-border">
                <button
                  type="button"
                  onClick={() => {
                    clearSavedReceipts();
                    setResult(null);
                    setCode("");
                    setCaptchaInput("");
                    loadSecurityChallenge("", true);
                  }}
                  className="text-xs font-mono text-primary hover:underline transition-colors cursor-pointer font-semibold"
                >
                  Klaim Voucher Lain / Reset Kuki
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border bg-surface py-3 px-4 text-center text-[11px] text-text-muted font-mono">
        (c) 2026 X Router Infrastructure - High-Performance AI Gateway
      </footer>
    </div>
  );
}
