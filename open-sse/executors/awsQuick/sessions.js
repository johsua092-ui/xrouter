// Quick thread reuse.
//
// Ported from magpie-aws-quick lib/sessions.mjs (MIT). OpenAI clients resend
// the whole history every request, while the Quick bidi socket keeps
// server-side history per thread_id. We recognise a request as the
// continuation of a thread we answered by hashing its message chain:
//
//   scope = H(account, agent_mode, system prompt, tool schemas)
//   key   = H(scope, m1, …, mk, our reply)
//
// A later request whose messages start with exactly that prefix continues the
// same Quick thread with only the messages after it. Anything else (edited or
// branched history, changed system prompt/tools/mode, expired or evicted
// entry) starts a fresh thread. Entries are claimed when used so a retry never
// replays a turn. Memory only (globalThis-cached — Next hot reload recreates
// module state, and cold thread ids are safe: the executor retries fresh).

import { createHash } from "node:crypto";
import { textOf, canonRole } from "./translate.js";

// 24h idle TTL: real agent sessions pause far longer than 30min between turns.
// A stale threadId is safe — the handler retries once on a fresh thread.
// `max` is per identity shard (see shardFor): a single global cap let one busy
// connection evict every other connection's continuations.
export const SESSION_DEFAULTS = Object.freeze({ ttlMs: 24 * 60 * 60 * 1000, max: 200 });

const sha = (s) => createHash("sha256").update(s).digest("hex");
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Canonical form of one message, tolerant to client/gateway rewrites. */
export function canonMessage(m) {
  if (!m) return "";
  const role = canonRole(m.role);
  if (role === "assistant") {
    // ids + names only: arguments get re-serialised; reasoning is often dropped
    const calls = (m.tool_calls || []).map((c) => `${c.id}:${c.function?.name ?? ""}`).join(",");
    return `assistant|${norm(textOf(m.content))}|${calls}`;
  }
  if (role === "tool") return `tool|${m.tool_call_id ?? m.id ?? ""}|${norm(textOf(m.content))}`;
  if (m.role === "function") return `function|${m.name ?? ""}|${norm(textOf(m.content))}`;
  return `${role}|${norm(textOf(m.content))}`;
}

/** Assistant message as we answered it (text + any tool calls we emitted). */
export function replyMessage(text, toolCalls) {
  const m = { role: "assistant", content: text ?? "" };
  if (toolCalls?.length) {
    m.tool_calls = toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name ?? c.function?.name, arguments: c.arguments ?? c.function?.arguments ?? "{}" },
    }));
  }
  return m;
}

export function sessionScope(identity, agentMode, systemText, tools) {
  return sha(`${sha(`quick:${identity}`)}|${agentMode}|${sha(norm(systemText))}|${sha(JSON.stringify(tools ?? []))}`);
}

/** h[k] = hash of the first k messages under scope (h[0] = scope). */
export function chainHashes(scope, messages) {
  const h = [scope];
  for (const m of messages) h.push(sha(`${h[h.length - 1]}\n${canonMessage(m)}`));
  return h;
}

export const extendHash = (prev, m) => sha(`${prev}\n${canonMessage(m)}`);

/**
 * Fuzzy-resume anchors. Agents like pi run context extensions that prune or
 * rewrite old history, which breaks the strict prefix chain. Our own reply
 * echo plus the messages that preceded it survive such edits, so they make a
 * position-independent fingerprint: replyKey matches the echoed assistant
 * message, tailKey matches the 3 messages right before it.
 */
export const replyAnchor = (scope, reply) => sha(`${scope}|reply|${canonMessage(reply)}`);
export const tailAnchor = (scope, msgs) => sha(`${scope}|tail|${(msgs ?? []).map(canonMessage).join("\n")}`);

/**
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] idle expiry (default 24h)
 * @param {number} [opts.max]   LRU cap (default 200)
 * @param {Function} [opts.now] clock override for tests
 */
export function createSessionStore({ ttlMs = SESSION_DEFAULTS.ttlMs, max = SESSION_DEFAULTS.max, now = () => Date.now() } = {}) {
  const map = new Map(); // key → {entry, at}; insertion order = LRU order
  const live = (key) => {
    const v = map.get(key);
    if (!v) return undefined;
    if (now() - v.at > ttlMs) {
      map.delete(key);
      return undefined;
    }
    return v;
  };
  return {
    has: (key) => !!live(key),
    /** First live entry matching pred → {key, entry}; does not remove it. */
    findEntry(pred) {
      for (const [key, v] of map) {
        if (now() - v.at > ttlMs) {
          map.delete(key);
          continue;
        }
        if (pred(v.entry)) return { key, entry: v.entry };
      }
      return undefined;
    },
    take(key) {
      const v = live(key);
      if (!v) return undefined;
      map.delete(key);
      return v.entry;
    },
    set(key, entry) {
      map.delete(key);
      map.set(key, { entry, at: now() });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
    clear() {
      map.clear();
    },
  };
}

// Process-wide stores, globalThis-cached so hot reload can't fork them.
// Sharded per identity (connection): a single global LRU let one busy
// connection evict every other connection's threads, which silently turned
// their continuations into fresh (expensive) threads.
const storeHolder = (globalThis.__awsQuickSessionStores ||= new Map());
const DEFAULT_SHARD = "default";

function shardFor(identity) {
  const key = identity ? String(identity) : DEFAULT_SHARD;
  let store = storeHolder.get(key);
  if (!store) {
    store = createSessionStore();
    storeHolder.set(key, store);
  }
  return store;
}

/** Every shard, for lookups that were not given an identity. */
function allShards() {
  return storeHolder.values();
}

/**
 * Find the newest cached thread state that this conversation extends.
 * @returns {{index:number, entry:object, delta:Array}|undefined}
 */
export function findContinuation(store, hashes, convo) {
  for (let i = convo.length - 1; i >= 1; i--) {
    if (canonRole(convo[i - 1]?.role) !== "assistant") continue;
    if (!store.has(hashes[i])) continue;
    const delta = convo.slice(i);
    // only new user turns / tool results can be appended to server-side history
    if (!delta.length || delta.some((m) => !["user", "tool", "function"].includes(canonRole(m.role)))) return undefined;
    const entry = store.take(hashes[i]);
    return entry ? { index: i, entry, delta } : undefined;
  }
  return undefined;
}

/** The gateway's per-identity session store; identity defaults to one shard. */
export function sharedFindContinuation(hashes, convo, identity) {
  return findContinuation(shardFor(identity), hashes, convo);
}

export function sharedSet(key, entry, identity) {
  shardFor(identity).set(key, entry);
}

export function sharedHas(key, identity) {
  if (identity) return shardFor(identity).has(key);
  for (const store of allShards()) if (store.has(key)) return true;
  return false;
}

export function sharedTake(key, identity) {
  if (identity) return shardFor(identity).take(key);
  for (const store of allShards()) {
    const entry = store.take(key);
    if (entry) return entry;
  }
  return undefined;
}

export function sharedFindEntry(pred, identity) {
  if (identity) return shardFor(identity).findEntry(pred);
  for (const store of allShards()) {
    const hit = store.findEntry(pred);
    if (hit) return hit;
  }
  return undefined;
}
