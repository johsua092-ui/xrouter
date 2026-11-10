// OpenCode version resolver.
//
// OpenCode's v2 UA is `opencode/<channel>/<version>/<client>` and the upstream
// gate checks the version it names: a fixed literal ages out every time OpenCode
// ships (the CLI that reports 2.2.5 looks stale once 2.2.6 exists). OpenCode's own
// updater is the source of truth, so the newest release it names is used, read in
// the background at most every 6 hours and never on the request path — a slow or
// dead updater keeps the last known good version instead of stalling a chat.
//
// OPENCODE_VERSION_FLOOR is the last version known to satisfy the gate: it answers
// immediately on a cold start and remains the answer whenever the updater can't be
// read. Override with OPENCODE_VERSION when pinning deliberately.

const OPENCODE_UPDATER_URL = "https://opencode.ai/update/api/latest/cli/npm";
const OPENCODE_VERSION_FLOOR = "2.2.5";
const OPENCODE_VERSION_TTL_MS = 6 * 60 * 60 * 1000;
const OPENCODE_VERSION_TIMEOUT_MS = 5000;

export const OPENCODE_CHANNEL = "latest";
export const OPENCODE_CLIENT = "cli";

const RELEASE_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

function envVersion() {
  const v = String(process.env.OPENCODE_VERSION || "").trim();
  return RELEASE_RE.test(v) ? v : "";
}

const state = {
  value: envVersion() || OPENCODE_VERSION_FLOOR,
  fetchedAt: 0,
  asking: false,
};

function refreshInBackground() {
  if (state.asking) return;
  if (Date.now() - state.fetchedAt < OPENCODE_VERSION_TTL_MS) return;
  state.asking = true;
  try {
    fetch(OPENCODE_UPDATER_URL, { signal: AbortSignal.timeout(OPENCODE_VERSION_TIMEOUT_MS) })
      .then((res) => (res && res.ok ? res.json() : null))
      .then((json) => {
        const v = typeof json?.version === "string" ? json.version.trim() : "";
        if (RELEASE_RE.test(v)) state.value = v;
      })
      .catch(() => {})
      .finally(() => {
        state.fetchedAt = Date.now();
        state.asking = false;
      });
  } catch {
    state.asking = false;
  }
}

/** Newest version OpenCode's updater named, else the floor. Never blocks. */
export function getOpencodeVersion() {
  refreshInBackground();
  return state.value;
}

/** The v2 UA OpenCode itself would send: opencode/<channel>/<version>/<client>. */
export function getOpencodeUa() {
  return `opencode/${OPENCODE_CHANNEL}/${getOpencodeVersion()}/${OPENCODE_CLIENT}`;
}

/** Test/introspection hook: force a value without touching the network. */
export function __setOpencodeVersion(v) {
  if (RELEASE_RE.test(String(v || ""))) state.value = String(v);
}

export { OPENCODE_VERSION_FLOOR };
