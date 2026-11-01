import pkg from "../../../package.json" with { type: "json" };

// App configuration
export const APP_CONFIG = {
  name: "X Router",
  description: "AI Infrastructure Management",
  version: pkg.version,
};

// GitHub configuration
export const GITHUB_CONFIG = {
  changelogUrl: "https://raw.githubusercontent.com/johsua092-ui/xrouter/refs/heads/main/CHANGELOG.md",
  donateUrl: "https://xrouter.com/api/donate",
  repoUrl: "https://github.com/johsua092-ui/xrouter",
  apiRepo: "johsua092-ui/xrouter", // update checks compare the running checkout with this
  branch: "main",
};

// Post-login thank-you dialog: shown once per login, skippable forever.
export const WELCOME_CONFIG = {
  shownKey: "xrouter:welcomeAfterLogin",
  hideKey: "xrouter:welcomeNeverShow",
};

// Updater configuration
export const UPDATER_CONFIG = {
  npmPackageName: "github:johsua092-ui/x-router",
  installCmd: "npm i -g github:johsua092-ui/x-router",
  installCmdLatest: "npm i -g github:johsua092-ui/x-router --prefer-online",
  shutdownCountdownSec: 3,
  exitDelayMs: 500,
  statusPort: 20129,
  statusPollIntervalMs: 1000,
  statusLogTailLines: 8,
  installRetries: 3,
  installRetryDelayMs: 5000,
  lingerAfterDoneMs: 30000,
  waitForExitMinMs: 5000,
  waitForExitMaxMs: 20000,
  waitForExitCheckMs: 500,
  appPort: 20128,
};

// The port the app server is actually listening on. Next.js writes the resolved listen
// port to process.env.PORT at server startup (next/dist/server/lib/start-server.js) for
// both `next dev --port` and `next start --port`; the CLI launcher sets PORT explicitly.
// Fall back to the canonical appPort when PORT is unset/invalid.
export function getAppPort() {
  const p = Number.parseInt(process.env.PORT, 10);
  return Number.isFinite(p) && p > 0 ? p : UPDATER_CONFIG.appPort;
}

// Theme configuration
export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "dark", // "light" | "dark" | "system"
};

// Subscription
export const SUBSCRIPTION_CONFIG = {
  price: 1.0,
  currency: "USD",
  interval: "month",
  planName: "Pro Plan",
};

// API endpoints
export const API_ENDPOINTS = {
  users: "/api/users",
  providers: "/api/providers",
  payments: "/api/payments",
  auth: "/api/auth",
};

export const CONSOLE_LOG_CONFIG = {
  maxLines: 200,
  pollIntervalMs: 1000,
};

// Client-side store TTL: how long fetched data stays fresh before re-fetching
export const CLIENT_STORE_TTL_MS = 60000;

// Quota auto-ping: keep 5h windows warm by sending a tiny request right after reset.
export const QUOTA_AUTOPING_CONFIG = {
  tickIntervalMs: 60000,                // scheduler tick
  pingLeadMs: 5000,                     // fire once reset passes (within tolerance)
  refreshAheadMs: 300000,               // refetch usage when within 5min of reset
  failureCooldownMs: 900000,            // avoid failed ping spam while upstream/auth is unhealthy
  providers: {
    claude: {
      settingsKey: "claudeAutoPing",    // preserve existing settings contract
      quotaKey: "session (5h)",         // quota key returned by usage handler
      pingModel: "claude-haiku-4-5-20251001",
      pingText: "hi",
      pingMaxTokens: 1,
    },
    codex: {
      settingsKey: "codexAutoPing",
      quotaKey: "session",
      pingWhenResetAtSlides: true,
      resetAtDriftMs: 30000,
      minPingIntervalMs: 600000,
      skipWhenBlockingQuotaExhausted: true,
      // Free and Plus Codex accounts both expose gpt-5.5; avoid fallback probes that waste requests.
      pingModel: "gpt-5.5",
      pingText: "hi",
      pingInstructions: "Reply with OK.",
      pingReasoningEffort: "none",
    },
  },
};

// Telegram auto-backup: send the full DB export (same payload as the manual
// Download Backup) to the owner chat on an interval.
export const AUTO_BACKUP_CONFIG = {
  minIntervalHours: 1, // refuse schedules tighter than hourly
  retryDelayMs: 1800000, // retry after a failed send (30min)
  maxBytes: 45 * 1024 * 1024, // Telegram bot upload cap is 50MB. stay under it
};

// Re-export from providers.js for backward compatibility
export {
  FREE_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  AI_PROVIDERS,
  AUTH_METHODS,
} from "./providers.js";

// Re-export from models.js for backward compatibility
export {
  PROVIDER_MODELS,
  AI_MODELS,
} from "./models.js";
