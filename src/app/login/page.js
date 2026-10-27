"use client";

import { useState, useEffect } from "react";
import { Card, Button, Input } from "@/shared/components";
import LogoMark from "@/shared/components/LogoMark";

// Password default instance ini. Ditampilkan sebagai petunjuk di bawah input
// supaya pemilik tidak terkunci di luar dashboard-nya sendiri.
const DEFAULT_PASSWORD = "xrouter123";

// Panel brand kiri: dipakai oleh semua state login (form, no-access, ganti password).
function BrandPanel() {
  return (
    <aside className="relative hidden lg:flex flex-col justify-center gap-14 overflow-hidden bg-surface-2 border-r border-border p-10 xl:p-14">
      {/* Identity motif: the ember veil, a warm glow anchored to the bottom edge. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3"
        style={{
          background:
            "radial-gradient(ellipse 90% 70% at 20% 110%, color-mix(in srgb, var(--color-primary) 30%, transparent), transparent 70%)",
        }}
      />
      <div className="relative">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-[6px] border border-border-subtle overflow-hidden">
            <LogoMark className="size-full" />
          </div>
          <div className="leading-tight">
            <p className="text-[15px] font-semibold text-text-main">
              X <span className="text-primary">Router</span>
            </p>
            <p className="text-xs text-text-muted">LLM Gateway</p>
          </div>
        </div>
      </div>

      <div className="relative max-w-md">
        {/* Identity motif: the ember line. Repeats as the brand's one gesture. */}
        <div className="h-px w-16 bg-gradient-to-r from-primary to-transparent mb-6" aria-hidden="true" />
        <h2 className="text-[28px] leading-tight font-semibold tracking-tight text-text-main">
          Satu endpoint untuk semua provider AI kamu.
        </h2>
        {/* Real facts about the product, no invented numbers (R-17, R-38). */}
        <ul className="mt-8 flex flex-col gap-3.5">
          {[
            "Kompatibel dengan OpenAI dan Anthropic",
            "Fallback multi-akun dan rotasi key",
            "Berjalan di server kamu sendiri",
          ].map((line) => (
            <li key={line} className="flex items-start gap-3 text-sm text-text-muted">
              <span className="mt-[7px] h-px w-4 shrink-0 bg-primary" aria-hidden="true" />
              {line}
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-xs text-text-muted">
        Dashboard dan gateway, satu proses.
      </p>
    </aside>
  );
}

// Wordmark ringkas untuk layar sempit (panel brand disembunyikan di bawah lg).
function CompactBrand() {
  return (
    <div className="lg:hidden flex flex-col items-center text-center mb-8">
      <div className="h-16 w-16 rounded-[6px] border border-border-subtle overflow-hidden mb-4">
        <LogoMark className="size-full" />
      </div>
      <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-text-main">
        X <span className="text-primary">Router</span>
      </h1>
    </div>
  );
}

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [resetHint, setResetHint] = useState("");
  const [retryAfter, setRetryAfter] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasPassword, setHasPassword] = useState(null);
  const [authMode, setAuthMode] = useState("password");
  const [ssoType, setSsoType] = useState("oidc");
  const [oidcConfigured, setOidcConfigured] = useState(false);
  const [oidcLoginLabel, setOidcLoginLabel] = useState("Sign in with OIDC");
  const [samlConfigured, setSamlConfigured] = useState(false);
  const [samlLoginLabel, setSamlLoginLabel] = useState("Sign in with SAML SSO");
  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [loginMethod, setLoginMethod] = useState("password");
  const [apiKey, setApiKey] = useState("");
  const [noAccess, setNoAccess] = useState(false);

  // A key that signed in but holds no permission would bounce between /login and
  // the dashboard, so it stays here and can sign out instead.
  const handleSignOut = async () => {
    setLoading(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // The cookie may already be gone; the reload below settles the state.
    }
    window.location.assign("/login");
  };

  // Countdown for rate-limit
  useEffect(() => {
    if (retryAfter <= 0) return;
    const id = setInterval(() => setRetryAfter((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [retryAfter]);

  useEffect(() => {
    async function checkAuth() {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

      try {
        const res = await fetch(`${baseUrl}/api/auth/status`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          if (data.authenticated === true || data.requireLogin === false) {
            if (data.role === "apikey" && !data.homePath) {
              setNoAccess(true);
              setHasPassword(!!data.hasPassword);
              return;
            }
            window.location.assign(data.homePath || "/dashboard");
            return;
          }
          setHasPassword(!!data.hasPassword);
          setAuthMode(data.authMode || "password");
          setSsoType(data.ssoType || "oidc");
          setOidcConfigured(data.oidcConfigured === true);
          setOidcLoginLabel(data.oidcLoginLabel || "Sign in with OIDC");
          setSamlConfigured(data.samlConfigured === true);
          setSamlLoginLabel(data.samlLoginLabel || "Sign in with SAML SSO");
        } else {
          // Safe fallback on non-OK response to avoid infinite loading state.
          setHasPassword(true);
        }
      } catch (err) {
        clearTimeout(timeoutId);
        setHasPassword(true);
      }
    }
    checkAuth();
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResetHint("");

    try {
      const payload = loginMethod === "apikey" ? { apiKey } : { password };
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.mustChangePassword) {
          setMustChange(true);
          return;
        }
        if (typeof window !== "undefined") {
          sessionStorage.setItem("xrouter:justLoggedIn", "true");
        }
        if (data.role === "apikey" && !data.homePath) {
          setNoAccess(true);
          setHasPassword(true);
          return;
        }
        window.location.assign(data.homePath || "/dashboard");
      } else {
        const data = await res.json();
        setError(data.error || (loginMethod === "apikey" ? "Invalid API Key" : "Invalid password"));
        if (data.resetHint) setResetHint(data.resetHint);
        if (data.retryAfter) setRetryAfter(Number(data.retryAfter));
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Force a new password before entering the dashboard (default + remote).
  const handleSetNewPassword = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      });
      if (res.ok) {
        if (typeof window !== "undefined") {
          sessionStorage.setItem("xrouter:justLoggedIn", "true");
        }
        window.location.assign("/dashboard");
      } else {
        const data = await res.json();
        setError(data.error || "Failed to set password");
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleOidcLogin = () => {
    window.location.href = "/api/auth/oidc/start";
  };

  const handleSamlLogin = () => {
    window.location.href = "/api/auth/saml/start";
  };

  const isSsoEnabled = ["sso", "oidc", "saml", "both"].includes(authMode);
  const activeSsoType = ssoType || (authMode === "saml" ? "saml" : "oidc");

  const samlAvailable = isSsoEnabled && activeSsoType === "saml" && samlConfigured;
  const oidcAvailable = isSsoEnabled && activeSsoType === "oidc" && oidcConfigured;
  const ssoAvailable = samlAvailable || oidcAvailable;

  const passwordAvailable = authMode === "password" || authMode === "both" || !ssoAvailable;

  // Show loading state while checking password
  if (hasPassword === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg p-4">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          <p className="text-text-muted mt-4">Loading...</p>
        </div>
      </div>
    );
  }

  if (noAccess) {
    return (
      <div className="min-h-screen grid lg:grid-cols-2 bg-bg">
        <BrandPanel />
        <div className="relative flex items-center justify-center p-6 sm:p-10">
          <div className="landing-grid absolute inset-0 pointer-events-none" aria-hidden="true" />
          <div className="relative z-10 w-full max-w-sm">
            <CompactBrand />
            <Card className="shadow-none">
              <div className="flex flex-col gap-4">
                <h1 className="text-lg font-semibold text-text-main">Kunci ini tidak punya akses dashboard</h1>
                <p className="text-sm text-text-muted">
                  Kunci API ini sudah masuk, tapi belum diberi izin dashboard. Minta pemilik instance memberi izin pada kunci tersebut, atau masuk pakai password dashboard.
                </p>
                <Button type="button" variant="primary" className="w-full" loading={loading} onClick={handleSignOut}>
                  Keluar
                </Button>
              </div>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-bg">
      <BrandPanel />

      <div className="relative flex items-center justify-center p-6 sm:p-10">
        <div className="landing-grid absolute inset-0 pointer-events-none" aria-hidden="true" />
        <div className="relative z-10 w-full max-w-sm">
          <CompactBrand />

          <Card className="shadow-none">
            {mustChange ? (
              <form onSubmit={handleSetNewPassword} className="flex flex-col gap-4">
                <div>
                  <h1 className="text-lg font-semibold text-text-main">Ganti password</h1>
                  <p className="text-sm text-text-muted mt-1">
                    Kamu masuk dengan password default. Set password baru sebelum lanjut ke dashboard.
                  </p>
                </div>
                <Input
                  label="Password baru"
                  type="password"
                  placeholder="Masukkan password baru"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  error={error}
                  required
                  autoFocus
                />
                <Button type="submit" variant="primary" className="w-full" loading={loading} disabled={!newPassword}>
                  Simpan password
                </Button>
              </form>
            ) : (
              <div className="flex flex-col gap-5">
                <div>
                  <h1 className="text-lg font-semibold text-text-main">
                    {samlAvailable
                      ? "Masuk dengan SAML"
                      : oidcAvailable
                      ? "Masuk dengan OIDC"
                      : "Masuk ke dashboard"}
                  </h1>
                  <p className="text-sm text-text-muted mt-1">
                    {samlAvailable || oidcAvailable
                      ? "Pakai provider identitas kamu, atau password."
                      : "Masukkan password untuk lanjut."}
                  </p>
                </div>

                {samlAvailable && (
                  <Button type="button" variant="primary" className="w-full" onClick={handleSamlLogin}>
                    {samlLoginLabel}
                  </Button>
                )}

                {oidcAvailable && (
                  <Button type="button" variant="primary" className="w-full" onClick={handleOidcLogin}>
                    {oidcLoginLabel}
                  </Button>
                )}

                {ssoAvailable && passwordAvailable && <div className="h-px bg-border/60" />}

                {passwordAvailable ? (
                  <form onSubmit={handleLogin} className="flex flex-col gap-4">
                    {isSsoEnabled && !ssoAvailable && (
                      <p className="text-xs text-warning">
                        Login {activeSsoType === "saml" ? "SAML" : "OIDC"} aktif tapi konfigurasinya belum lengkap. Password masih bisa dipakai untuk masuk.
                      </p>
                    )}

                    {authMode === "both" && ssoAvailable && (
                      <p className="text-xs text-text-muted">
                        Password dan {activeSsoType === "saml" ? "SAML" : "OIDC"} dua-duanya aktif.
                      </p>
                    )}

                    {/* Login method toggle: two real states, password or API key. */}
                    <div className="flex rounded-[6px] border border-border bg-surface-2 p-1">
                      {[
                        { id: "password", label: "Password" },
                        { id: "apikey", label: "API Key" },
                      ].map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          aria-pressed={loginMethod === m.id}
                          onClick={() => { setLoginMethod(m.id); setError(""); }}
                          className={`flex-1 py-1.5 text-xs font-medium rounded-[6px] transition-colors ${
                            loginMethod === m.id
                              ? "bg-primary text-white"
                              : "text-text-muted hover:text-text-main"
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>

                    {loginMethod === "password" ? (
                      <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1.5">
                          <label htmlFor="xrouter-password" className="text-sm font-medium text-text-main">
                            Password
                          </label>
                          <div className="relative">
                            <input
                              id="xrouter-password"
                              type={showPassword ? "text" : "password"}
                              placeholder="Masukkan password"
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              autoFocus={!oidcAvailable}
                              autoComplete="current-password"
                              className="w-full py-2.5 pl-3 pr-11 text-sm text-text-main bg-surface-2 rounded-[6px] border border-border/50 placeholder-text-muted/70 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/50 focus:bg-surface transition-all duration-150 ease-out text-[16px] sm:text-sm"
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword((v) => !v)}
                              aria-label={showPassword ? "Sembunyikan password" : "Tampilkan password"}
                              aria-pressed={showPassword}
                              className="absolute inset-y-0 right-0 flex items-center pr-3 text-text-muted hover:text-text-main transition-colors"
                            >
                              <span className="material-symbols-outlined text-[19px]">
                                {showPassword ? "visibility_off" : "visibility"}
                              </span>
                            </button>
                          </div>
                        </div>

                        {error && (
                          <p className="text-xs text-danger flex items-center gap-1">
                            <span className="material-symbols-outlined text-[14px]">error</span>
                            {error}
                          </p>
                        )}

                        {/* Petunjuk password default: klik chip untuk mengisi otomatis. */}
                        <div className="flex flex-col gap-1">
                          <p className="text-xs leading-5 text-text-muted">
                            Password default:{" "}
                            <button
                              type="button"
                              onClick={() => { setPassword(DEFAULT_PASSWORD); setError(""); }}
                              className="font-mono rounded-[6px] border border-border bg-surface-2 px-1.5 py-[1px] text-text-main hover:border-primary/50 hover:text-primary transition-colors"
                              title="Klik untuk mengisi"
                            >
                              {DEFAULT_PASSWORD}
                            </button>
                          </p>
                          <p className="text-[11px] leading-4 text-text-subtle">
                            Ganti setelah masuk pertama kali.
                          </p>
                        </div>

                        {retryAfter > 0 && (
                          <p className="text-xs text-warning">
                            Terkunci sementara. Coba lagi dalam <span className="font-mono">{retryAfter}s</span>.
                          </p>
                        )}
                        {resetHint && (
                          <p className="text-xs text-text-muted">
                            Lupa password? Jalankan CLI <code className="bg-surface-2 px-1 rounded">xrouter</code> di server, buka <b>Settings</b>, lalu <b>Reset Password to Default</b>.
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <Input
                          label="API Key"
                          type="password"
                          placeholder="sk-9r-..."
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          autoFocus
                        />
                        <p className="text-xs text-text-muted">
                          Masuk pakai API Key yang sudah diberi izin untuk membuka fitur tertentu.
                        </p>
                      </div>
                    )}

                    <Button
                      type="submit"
                      variant="primary"
                      className="w-full"
                      loading={loading}
                      disabled={retryAfter > 0 || (loginMethod === "password" ? !password : !apiKey)}
                    >
                      {retryAfter > 0
                        ? `Tunggu ${retryAfter}s`
                        : loginMethod === "apikey"
                        ? "Masuk dengan API Key"
                        : "Masuk"}
                    </Button>
                  </form>
                ) : (
                  error && <p className="text-xs text-danger">{error}</p>
                )}
              </div>
            )}
          </Card>

          <p className="text-center text-xs text-text-muted mt-6">
            X Router, self-hosted LLM gateway
          </p>
        </div>
      </div>
    </div>
  );
}
