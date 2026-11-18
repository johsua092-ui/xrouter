/**
 * agyCliPlatform.ts — where the `agy` binary is, and how an agy child is
 * started for one account.
 *
 * Ported from magpie-community/plugins packages/agy-cli platform.mjs and
 * account.mjs. Three things here are not incidental:
 *
 *   - Discovery order. A user-installed agy always wins over the copy the
 *     bridge installs itself, so the bridge never shadows a working install.
 *   - Home isolation. agy keeps ONE sign-in where it looks for it — the system
 *     keyring, or `.gemini/antigravity-cli/antigravity-oauth-token` under its
 *     home. Every account after the first therefore gets a home of its own, and
 *     `SSH_CONNECTION` is set so agy reads "a session over SSH" and keeps the
 *     sign-in in that file instead of the keyring every account would share.
 *   - Windows spawning. `agy` is a `.cmd`/`.bat` wrapper there, so it needs the
 *     Node cross-spawn escaping to reach cmd.exe intact, and a console-less `nc`
 *     so the --ide-mcp-port dial does not flash a window per call.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
function resolveDataDir(env = process.env) {
    const configured = env.DATA_DIR || process.env.DATA_DIR;
    if (configured) {
        if (process.platform === "win32" && /^\//.test(configured)) {
            return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "xrouter");
        }
        return configured;
    }
    if (process.platform === "win32") {
        return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "xrouter");
    }
    return path.join(os.homedir(), ".xrouter");
}
const accountScope = new AsyncLocalStorage();
const HOME_ID = /^[a-z0-9]{8,32}$/;
/**
 * Where the extra accounts' homes live: one folder per account under the
 * OmniRoute data directory, so they sit beside the rest of this install's
 * state instead of in the operator's `~/.local/state`.
 */
export function accountsDir(env = process.env) {
    const configured = typeof env.AGY_CLI_ACCOUNTS_DIR === "string" ? env.AGY_CLI_ACCOUNTS_DIR.trim() : "";
    if (configured)
        return configured;
    return path.join(resolveDataDir(env), "agy-homes");
}
/** The folder of the account home `id` names, or null when `id` is not one. */
export function homeOf(id, env = process.env) {
    return typeof id === "string" && HOME_ID.test(id) ? path.join(accountsDir(env), id) : null;
}
/** The home a saved sign-in names, "" for agy's own (the first account). */
export function homeIdOfAuth(auth) {
    const metadata = auth?.metadata;
    const id = metadata?.agyHome;
    return typeof id === "string" && HOME_ID.test(id) ? id : "";
}
/** The home of the account the current work is for, null for agy's own. */
export function currentHome() {
    return accountScope.getStore()?.home ?? null;
}
/** Run `fn` for the account at `home` (null: agy's own). */
export function inAccount(home, fn) {
    return accountScope.run({ home: home || null }, fn);
}
/** Where agy keeps the sign-in for the account at `home`. */
export function tokenFile(home) {
    return path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}
/** What an agy for the account at `home` is started with. */
export function accountEnv(home, platform = process.platform) {
    return {
        HOME: home,
        ...(platform === "win32" ? { USERPROFILE: home } : {}),
        // agy keeps its sign-in in tokenFile(home), not the shared keyring.
        SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
    };
}
/** Make a home for an account being added: `{ id, home }`. */
export function newHome(env = process.env) {
    const id = randomBytes(8).toString("hex");
    const home = homeOf(id, env);
    if (!home)
        throw new Error("cannot allocate an agy account home");
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    return { id, home };
}
/** Remove an account home, ignoring a folder that is already gone. */
export function dropHome(home) {
    if (!home)
        return;
    try {
        fs.rmSync(home, { recursive: true, force: true });
    }
    catch {
        /* already gone, or held open by a running agy */
    }
}
/**
 * Write the OAuth token for the account at `home`, creating the folder chain.
 * The file is created 0o600: it is a live credential, and agy writes its own
 * copy the same way.
 */
export function writeAccountToken(home, token) {
    const file = tokenFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body = typeof token === "string" ? token : JSON.stringify(token);
    fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
    // `mode` is ignored for an existing file, so make it explicit every time.
    try {
        fs.chmodSync(file, 0o600);
    }
    catch {
        /* Windows has no POSIX mode to set */
    }
    return file;
}
/** Read the token for the account at `home`, or null when there is none. */
export function readAccountToken(home) {
    try {
        return fs.readFileSync(tokenFile(home), "utf8");
    }
    catch {
        return null;
    }
}
// ── Binary discovery (platform.mjs) ─────────────────────────────────────────
/** Every path an agy binary is looked for at, in priority order. */
export function agyCandidates(env, home, platform = process.platform) {
    const windows = platform === "win32";
    const paths = windows ? path.win32 : path.posix;
    const names = windows ? ["agy.exe", "agy.cmd", "agy.bat"] : ["agy"];
    const searchPath = env.PATH || (windows ? env.Path : "") || "";
    const candidates = env.AGY_PATH ? [env.AGY_PATH] : [];
    for (const directory of searchPath.split(windows ? ";" : ":")) {
        if (directory) {
            const clean = directory.replace(/^"|"$/g, "");
            candidates.push(...names.map((name) => paths.join(clean, name)));
        }
    }
    const localAppData = env.LOCALAPPDATA || paths.join(home, "AppData", "Local");
    const directories = windows
        ? [
            paths.join(localAppData, "agy", "bin"),
            paths.join(localAppData, "Programs", "Antigravity", "bin"),
            paths.join(home, ".local", "bin"),
            paths.join(home, ".gemini", "bin"),
        ]
        : [
            paths.join(home, ".local", "bin"),
            paths.join(home, ".gemini", "bin"),
            "/usr/local/bin",
            "/opt/homebrew/bin",
        ];
    for (const directory of directories) {
        candidates.push(...names.map((name) => paths.join(directory, name)));
    }
    // The copy the bridge installed itself goes last: an agy the user installed wins.
    candidates.push(ownAgyPath(env, home, platform));
    return candidates;
}
/** Where the bridge installs agy when the machine has none of its own. */
export function ownAgyPath(env, home, platform = process.platform) {
    if (platform === "win32") {
        const local = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
        return path.win32.join(local, "omniroute-agy-cli", "agy.exe");
    }
    const data = env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME)
        ? env.XDG_DATA_HOME
        : path.posix.join(home, ".local", "share");
    return path.posix.join(data, "omniroute-agy-cli", "agy");
}
/** The first candidate that exists and is executable, or null. */
export function findAgyBinary(env = process.env, home = os.homedir(), platform = process.platform) {
    for (const candidate of agyCandidates(env, home, platform)) {
        try {
            const stat = fs.statSync(candidate);
            if (stat.isFile())
                return candidate;
        }
        catch {
            /* not there; keep looking */
        }
    }
    return null;
}
// ── Windows spawning (platform.mjs) ─────────────────────────────────────────
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
/**
 * Quote one argument for cmd.exe, adapted from node-cross-spawn (MIT, Copyright
 * (c) 2018 Made With MOXY Lda). A caller that interpolates a value into this
 * string instead of passing it as an argument would defeat the escaping
 * entirely — Hard Rule #13.
 */
function cmdArgument(value, doubleEscape) {
    let argument = String(value);
    if (/[\0\r\n]/.test(argument)) {
        throw new Error("a Windows command argument contains a line break or NUL");
    }
    argument = argument.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
    argument = argument.replace(/(?=(\\+?)?)\1$/, "$1$1");
    argument = `"${argument}"`.replace(CMD_META, "^$1");
    // npm's cmd-shim adds a second cmd expansion pass when forwarding %*.
    return doubleEscape ? argument.replace(CMD_META, "^$1") : argument;
}
/**
 * How to spawn `file` with `args`. A `.cmd`/`.bat` on Windows is not an
 * executable image, so it goes through cmd.exe with every argument escaped;
 * anything else is spawned directly.
 */
export function agySpawnSpec(file, args, platform = process.platform, env = process.env) {
    if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(file))
        return { file, args, options: {} };
    if (/[\0\r\n]/.test(file)) {
        throw new Error("a Windows command path contains a line break or NUL");
    }
    const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
    const command = [
        path.win32.normalize(file).replace(CMD_META, "^$1"),
        ...args.map((arg) => cmdArgument(arg, doubleEscape)),
    ].join(" ");
    return {
        file: env.ComSpec || env.COMSPEC || env.comspec || "cmd.exe",
        args: ["/d", "/v:off", "/s", "/c", `"${command}"`],
        options: { windowsVerbatimArguments: true, windowsHide: true },
    };
}
const AUTO_UPDATE_VAR = "AGY_CLI_DISABLE_AUTO_UPDATE";
/**
 * The environment an agy child runs with. A value the operator set for
 * AGY_CLI_DISABLE_AUTO_UPDATE is kept as written; only when nobody set it do
 * the bridge's children run with auto-update off, so a pool of ACP processes
 * does not update the binary under each other while the operator's own `agy`
 * runs keep updating. Work for an account with a home of its own runs agy in
 * that home.
 */
export function childEnv(parent = process.env, extra = {}, platform = process.platform) {
    const env = {};
    const names = new Map();
    const home = currentHome();
    const sources = [
        parent,
        extra,
        home ? accountEnv(home, platform) : null,
    ];
    for (const source of sources) {
        for (const [key, value] of Object.entries(source || {})) {
            if (value === undefined)
                continue;
            // Windows treats env names case-insensitively; keep the caller's PATH.
            const name = platform === "win32" ? key.toUpperCase() : key;
            const previous = names.get(name);
            if (previous !== undefined)
                delete env[previous];
            names.set(name, key);
            env[key] = value;
        }
    }
    const alreadySet = [...names.keys()].some((name) => name.toUpperCase() === AUTO_UPDATE_VAR);
    if (!alreadySet)
        env[AUTO_UPDATE_VAR] = "true";
    return env;
}
/** The `nc` shim agy dials --ide-mcp-port through, as a .cmd file. */
export function windowsMcpShim(executable, server) {
    const quote = (value) => {
        if (/["\0\r\n]/.test(value))
            throw new Error("invalid Windows MCP shim path");
        return `"${value.replace(/%/g, "%%")}"`;
    };
    return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${quote(executable)} ${quote(server)}\r\n`;
}
/**
 * A build spec for a GUI-subsystem `nc.exe`, or null when `runtime` is not Bun.
 * agy dials --ide-mcp-port by running `nc` from PATH, and on Windows a console
 * program started that way can be handed a console of its own: each dial then
 * flashes a window and leaves a conhost.exe behind. A GUI-subsystem binary never
 * gets a console, whatever creation flags agy uses, and still talks over the
 * stdio pipes agy hands it.
 */
export function windowsNcBuild(runtime, server, outfile, versions = process.versions) {
    const bun = versions?.bun;
    if (!bun || !/^(?:magpie-)?bun(?:\.exe)?$/i.test(path.win32.basename(String(runtime || "")))) {
        return null;
    }
    return {
        file: runtime,
        args: ["build", "--compile", "--windows-hide-console", server, "--outfile", outfile],
    };
}
/**
 * One taskkill run that ends each pid and everything it started; null when empty
 * or on a host without `taskkill` — spawning it elsewhere is an ENOENT, so the
 * caller falls back to a plain `kill()` instead.
 */
export function windowsTreeKill(pids, platform = process.platform) {
    if (platform !== "win32")
        return null;
    const live = [
        ...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0)),
    ];
    if (!live.length)
        return null;
    return {
        file: "taskkill",
        args: ["/T", "/F", ...live.flatMap((pid) => ["/PID", String(pid)])],
    };
}
