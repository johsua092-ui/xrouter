// Update detection for the running install. Two independent signals, because the
// app is deployed in ways that break one of them:
//
//   1. git: how many commits is this checkout behind serenhope/xrouter master.
//      Only works when the deploy ships git history.
//   2. release: the newest version heading in the repository changelog compared
//      with the version this build was made from. Works everywhere, including
//      images built without .git, as long as the build could stamp APP_RELEASE.
//
// Both lookups are cached in process for an hour and every failure path resolves
// to "unknown" rather than "up to date", so a blocked network never claims there
// is nothing new and never breaks the dashboard. When the local revision cannot
// be determined, set APP_REVISION=<sha> at build time; next.config.mjs does this
// automatically for a normal build.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { GITHUB_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config";

const API = "https://api.github.com";
const CHECK_TTL_MS = 60000; // recheck every 1 minute for fast update awareness
const FAILURE_TTL_MS = 300000; // a failed lookup is retried after 5 minutes
const MAX_PAYLOAD = 2 * 1024 * 1024; // never buffer a runaway response
const GIT_UPDATE_CMD = "git pull --ff-only && npm install && npm run build";

const cache = (global.__updateCheck ??= { info: null, fetchedAt: 0, revision: undefined, gitInstall: undefined, remoteRelease: undefined, localRelease: undefined });

function githubJson(endpoint) {
  return new Promise((resolve) => {
    const req = https.get(`${API}${endpoint}`, {
      timeout: 5000,
      headers: {
        "User-Agent": "X Router-App",
        Accept: "application/vnd.github.v3+json",
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    }, (res) => {
      let data = "";
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_PAYLOAD) {
          req.destroy();
          resolve(null);
          return;
        }
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function fetchText(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      timeout: 5000,
      headers: { "User-Agent": "X Router-App" },
    }, (res) => {
      let data = "";
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_PAYLOAD) {
          req.destroy();
          resolve(null);
          return;
        }
        data += chunk;
      });
      res.on("end", () => resolve(res.statusCode === 200 ? data : null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function readGitRevision() {
  return new Promise((resolve) => {
    // Check both cwd and /root/xrouter for git revision
    const targetDirs = ["/root/xrouter", process.cwd(), "/root/xrouter-remake"];
    const checkDir = (dirs) => {
      if (dirs.length === 0) {
        cache.gitInstall = false;
        cache.revision = null;
        return resolve(null);
      }
      const dir = dirs[0];
      const repoDir = path.join(dir, ".git");
      if (!existsSync(repoDir)) return checkDir(dirs.slice(1));
      execFile("git", ["rev-parse", "HEAD"], { cwd: dir, timeout: 4000 }, (error, stdout) => {
        const sha = String(stdout || "").trim();
        if (!error && /^[0-9a-f]{40}$/.test(sha)) {
          cache.gitInstall = true;
          cache.revision = sha;
          return resolve(sha);
        }
        checkDir(dirs.slice(1));
      });
    };
    checkDir(targetDirs);
  });
}

// Which commit master points at right now.
async function fetchRemoteHead() {
  const data = await githubJson(`/repos/${GITHUB_CONFIG.apiRepo}/commits/${GITHUB_CONFIG.branch}?per_page=1`);
  const sha = data?.sha;
  if (!sha) return null;
  return {
    sha,
    message: String(data?.commit?.message || "").split("\n")[0],
    date: data?.commit?.committer?.date || data?.commit?.author?.date || "",
  };
}

// Newest entry of the repository changelog: the version this build should move to,
// with a short preview of what it contains.
async function fetchRemoteRelease() {
  if (cache.remoteRelease !== undefined) return cache.remoteRelease;
  const text = await fetchText(GITHUB_CONFIG.changelogUrl);
  if (!text) return null;
  const release = parseChangelogRelease(text);
  cache.remoteRelease = release;
  return release;
}

// Check npm registry for latest published CLI package version
async function fetchNpmRelease() {
  return new Promise((resolve) => {
    const req = https.get("https://registry.npmjs.org/xrouter-ai/latest", {
      timeout: 5000,
      headers: { "User-Agent": "XRouter-App" },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const pkg = JSON.parse(data);
          if (pkg?.version) {
            resolve({
              version: `v${pkg.version}`,
              notes: [pkg.description || `New release v${pkg.version} available on npm`],
            });
            return;
          }
        } catch {}
        resolve(null);
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function parseChangelogRelease(text) {
  const heading = text.match(/^#\s+(v[0-9][^\s(]*)/m);
  if (!heading) return null;
  const version = heading[1].trim();
  const start = text.indexOf(heading[0]) + heading[0].length;
  const rest = text.slice(start);
  const nextRelease = rest.search(/^#\s+v[0-9]/m);
  const section = nextRelease === -1 ? rest : rest.slice(0, nextRelease);
  const notes = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .slice(0, 4)
    .map((line) => line.replace(/^-\s*/, "").replace(/[*`]/g, "").trim());
  return { version, notes };
}

// The version this build was made from. Stamped into the bundle by next.config.mjs,
// and read from the working copy when the checkout is still on disk.
function readLocalRelease() {
  if (cache.localRelease !== undefined) return cache.localRelease;
  const stamped = String(process.env.APP_RELEASE || "").trim();
  if (stamped) {
    cache.localRelease = stamped.startsWith("v") ? stamped : `v${stamped}`;
    return cache.localRelease;
  }
  let found = null;
  try {
    const text = readFileSync(path.join(process.cwd(), "CHANGELOG.md"), "utf8");
    const heading = text.match(/^#\s+(v[0-9][^\s(]*)/m);
    if (heading) found = heading[1].trim();
  } catch {
    // No changelog next to the running app: the release signal stays unknown.
  }
  cache.localRelease = found;
  return found;
}

// Release headings are "v<major>.<minor>.<patch>" with an optional suffix such as
// "-Custom". Numbers decide. On equal numbers an empty suffix is the older shape and
// a different suffix means the repository moved to another build of that release.
function compareReleases(remote, local) {
  if (!remote || !local) return 0;
  const split = (value) => {
    const cleaned = String(value).trim().replace(/^v/i, "");
    const dash = cleaned.indexOf("-");
    return {
      numbers: (dash === -1 ? cleaned : cleaned.slice(0, dash)).split(".").map((n) => parseInt(n, 10) || 0),
      suffix: dash === -1 ? "" : cleaned.slice(dash + 1).toLowerCase(),
    };
  };
  const a = split(remote);
  const b = split(local);
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a.numbers[i] || 0) - (b.numbers[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (a.suffix === b.suffix) return 0;
  if (!a.suffix) return -1;
  if (!b.suffix) return 1;
  return a.suffix > b.suffix ? 1 : -1;
}

// How many commits the branch has that this checkout does not. GitHub's compare
// reads `ahead_by` from the base (our checkout) toward the head (master), so
// ahead_by is exactly "how far behind the repository we are". An unknown or
// unpublished local sha answers null, and the caller falls back to comparing shas.
async function fetchPending(localSha) {
  const data = await githubJson(`/repos/${GITHUB_CONFIG.apiRepo}/compare/${localSha}...${GITHUB_CONFIG.branch}?per_page=1`);
  if (!data || !["behind", "ahead", "diverged", "identical"].includes(data.status)) return null;
  return { status: data.status, pendingBy: Number(data.ahead_by) || 0 };
}

export async function getUpdateInfo(currentVersion) {
  const localSha = await readGitRevision() || process.env.APP_REVISION;
  const ttl = cache.info && !cache.info.lookupFailed ? CHECK_TTL_MS : FAILURE_TTL_MS;
  if (cache.info && Date.now() - cache.fetchedAt < ttl) {
    return { ...cache.info, currentVersion, checkedAt: cache.fetchedAt };
  }

  const localRelease = readLocalRelease();
  const isGoRepo = existsSync(path.join(process.cwd(), "go.mod")) ||
                   existsSync(path.join(process.cwd(), "cmd")) ||
                   Boolean(localRelease && /^v0\.0\./.test(localRelease));

  const [head, release, npmRelease] = await Promise.all([
    fetchRemoteHead(),
    fetchRemoteRelease(),
    isGoRepo ? Promise.resolve(null) : fetchNpmRelease(),
  ]);
  const effectiveRelease = isGoRepo ? release : (release || npmRelease);
  cache.fetchedAt = Date.now();

  // git signal: commits this checkout is missing. Unavailable without a revision.
  let behindBy = null;
  if (localSha && head) {
    if (localSha === head.sha) behindBy = 0;
    else {
      const compare = await fetchPending(localSha);
      behindBy = compare ? compare.pendingBy : null;
    }
  }
  // A published build carries APP_REVISION from its own checkout, which is a
  // different history than the repository the updater watches. Comparing those
  // shas is meaningless and pinned the bell to "update available" forever, so
  // the npm release is the only signal that counts for a published build.
  const gitSignalUsable = isGoRepo || !npmRelease;
  const gitSaysUpdate = gitSignalUsable && (behindBy === null
    ? Boolean(localSha && head && localSha !== head.sha)
    : behindBy > 0);

  // release signal: the repository's newest changelog entry against this build.
  // ONLY alert if remote version is strictly newer than local version (releaseOrder === 1).
  // If local is equal (0) or newer (-1), NEVER trigger update!
  const releaseOrder = compareReleases(effectiveRelease?.version, localRelease);
  const releaseSaysUpdate = releaseOrder === 1;

  const hasUpdate = gitSaysUpdate || releaseSaysUpdate;
  const known = Boolean(head || effectiveRelease);
  const info = {
    lookupFailed: !known,
    hasUpdate: known && hasUpdate,
    // Which signal produced the answer, so the banner can word it correctly.
    source: gitSaysUpdate ? "git" : releaseSaysUpdate ? "release" : null,
    latestVersion: (gitSaysUpdate && behindBy)
      ? `git-${head.sha.slice(0, 7)}`
      : (effectiveRelease?.version || (head ? `git-${head.sha.slice(0, 7)}` : "")),
    currentRelease: localRelease || null,
    releaseNotes: effectiveRelease?.notes || (head?.message ? [head.message] : []),
    latestRevision: head?.sha || null,
    commitMessage: head?.message || "",
    publishedAt: head?.date || "",
    revisionKnown: Boolean(localSha),
    releaseKnown: Boolean(localRelease),
    currentRevision: localSha ? localSha.slice(0, 7) : null,
    behindBy,
    installCmd: isGoRepo
      ? "git pull origin main && npm run build"
      : (cache.gitInstall === false && !process.env.APP_REVISION
        ? UPDATER_CONFIG.installCmdLatest
        : GIT_UPDATE_CMD),
  };
  cache.info = info;
  cache.fetchedAt = Date.now();
  return { ...info, currentVersion, checkedAt: cache.fetchedAt };
}

export const __test__ = { compareReleases, parseChangelogRelease };
