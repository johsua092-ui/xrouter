/**
 * Dual-Stage High-Precision Semantic Prompt Caching Helper for XRouter
 * 
 * Inspired by messkan/prompt-cache:
 * - Tier 1: Exact Request Hash Match (0ms instant return)
 * - Tier 2: Strict Lexical-Semantic N-Gram & Bag-of-Words Similarity (calibrated high precision)
 * 
 * Caches and replays responses for duplicate & semantically identical prompts.
 */

import crypto from "crypto";

const responseCache = new Map();

let cacheTtlMs = 3 * 60 * 60 * 1000; // 3 hours default
let maxEntries = 1000; // 1000 entries cap
// Raised default threshold to 0.92 for strict high-accuracy matching.
// Prevents false positives while still catching polite fillers/spaces.
let similarityThreshold = 0.92;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "in", "on", "at", "to", "for", "of", "with",
  "is", "are", "was", "were", "be", "been", "being",
  "tolong", "mohon", "bisa", "dong", "ya", "nih", "kah", "sih",
  "please", "can", "could", "would", "you", "tell", "me", "show"
]);

const stats = {
  hits: 0,
  exactHits: 0,
  semanticHits: 0,
  misses: 0,
  saves: 0,
  evictions: 0
};

export function setSemanticCacheMaxEntries(n) {
  const v = Math.floor(Number(n));
  if (Number.isFinite(v) && v >= 10) maxEntries = Math.min(v, 10000);
}

export function getSemanticCacheMaxEntries() {
  return maxEntries;
}

export function setSemanticCacheTtlMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return;
  cacheTtlMs = Math.min(Math.max(n, 60 * 1000), 30 * 24 * 60 * 60 * 1000);
}

export function getSemanticCacheTtlMs() {
  return cacheTtlMs;
}

export function setSemanticSimilarityThreshold(val) {
  const n = Number(val);
  if (Number.isFinite(n) && n >= 0.5 && n <= 1.0) {
    similarityThreshold = n;
  }
}

export function getSemanticSimilarityThreshold() {
  return similarityThreshold;
}

export function getSemanticCacheStats() {
  return {
    ...stats,
    entries: responseCache.size,
    ttlMs: cacheTtlMs,
    similarityThreshold,
  };
}

export function resetSemanticCacheStats() {
  stats.hits = 0;
  stats.exactHits = 0;
  stats.semanticHits = 0;
  stats.misses = 0;
  stats.saves = 0;
  stats.evictions = 0;
}

function normalizePrompt(text) {
  if (typeof text !== "string") return "";
  return text
    .toLowerCase()
    .replace(/[^\w\s\u00C0-\u024F\u1E00-\u1EFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTokens(norm) {
  return norm.split(" ").filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

function getCharNgrams(norm, n = 3) {
  const set = new Set();
  const clean = norm.replace(/\s/g, "");
  if (clean.length <= n) {
    if (clean) set.add(clean);
    return set;
  }
  for (let i = 0; i <= clean.length - n; i++) {
    set.add(clean.slice(i, i + n));
  }
  return set;
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

function tokenCosineSimilarity(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const freqA = {};
  const freqB = {};
  for (const t of tokensA) freqA[t] = (freqA[t] || 0) + 1;
  for (const t of tokensB) freqB[t] = (freqB[t] || 0) + 1;

  let dotProduct = 0;
  for (const t in freqA) {
    if (freqB[t]) dotProduct += freqA[t] * freqB[t];
  }

  let magA = 0;
  for (const t in freqA) magA += freqA[t] * freqA[t];
  let magB = 0;
  for (const t in freqB) magB += freqB[t] * freqB[t];

  if (!magA || !magB) return 0;
  return dotProduct / (Math.sqrt(magA) * Math.sqrt(magB));
}

function computeSimilarity(normA, tokensA, ngramsA, entryB) {
  if (normA === entryB.normPrompt) return 1.0;
  const wordSim = tokenCosineSimilarity(tokensA, entryB.tokens);
  const charSim = jaccardSimilarity(ngramsA, entryB.ngrams);
  return 0.6 * wordSim + 0.4 * charSim;
}

/**
 * Extract system instruction text vs active user question text separately.
 * Prevents large shared system prompts from causing false semantic hits on different user queries.
 */
function extractSeparatedPrompt(messages) {
  if (!Array.isArray(messages)) {
    const s = String(messages || "");
    return { systemText: "", userText: s, fullText: s };
  }

  const systemParts = [];
  const userParts = [];
  const allParts = [];

  for (const m of messages) {
    if (!m) continue;
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .map((c) => (typeof c === "string" ? c : c?.text || ""))
        .filter(Boolean)
        .join(" ");
    }

    if (content) {
      allParts.push(`${m.role || "user"}: ${content}`);
      if (m.role === "system") {
        systemParts.push(content);
      } else if (m.role === "user") {
        userParts.push(content);
      }
    }
  }

  return {
    systemText: systemParts.join("\n"),
    userText: userParts.join("\n"),
    fullText: allParts.join("\n"),
  };
}

function hashObject(obj) {
  try {
    return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
  } catch {
    return null;
  }
}

export function checkSemanticCache(body, model) {
  if (!body) return null;
  if (body.tool_choice && body.tool_choice !== "auto") return null;

  const messages = body.messages || body.input || body.contents || [];
  const keyData = { model, messages };
  const hashKey = hashObject(keyData);
  if (!hashKey) return null;

  const now = Date.now();

  // Tier 1: Exact Hash Match (0ms)
  const cached = responseCache.get(hashKey);
  if (cached && now < cached.expiresAt) {
    stats.hits++;
    stats.exactHits++;
    cached.lastAccessed = now;
    console.log(`[SemanticCache] EXACT HIT for ${model} (total hits: ${stats.hits})`);
    return cached.response;
  }

  if (cached) {
    responseCache.delete(hashKey);
    stats.evictions++;
  }

  // Tier 2: Calibrated Semantic Similarity Match (<1ms)
  const { systemText, userText, fullText } = extractSeparatedPrompt(messages);
  
  // Guard 1: Must have user question text of at least 3 characters
  if (userText && userText.length >= 3) {
    const normUser = normalizePrompt(userText);
    const normSystem = normalizePrompt(systemText);
    const userTokens = getTokens(normUser);
    const userNgrams = getCharNgrams(normUser, 3);

    let bestMatch = null;
    let bestScore = 0;

    for (const [key, entry] of responseCache.entries()) {
      if (now >= entry.expiresAt) {
        responseCache.delete(key);
        stats.evictions++;
        continue;
      }

      if (entry.model !== model) continue;

      // Guard 2: If system prompt differs significantly, do not match
      if (normSystem && entry.normSystem && normSystem !== entry.normSystem) {
        continue;
      }

      // Guard 3: User prompt length ratio check - prevents short query matching a long one
      const lenRatio = Math.min(entry.normUser.length, normUser.length) / Math.max(entry.normUser.length, normUser.length || 1);
      if (lenRatio < 0.65) continue;

      // Score user-intent specifically rather than diluting with static system instructions
      const userScore = computeSimilarity(normUser, userTokens, userNgrams, {
        normPrompt: entry.normUser,
        tokens: entry.userTokens,
        ngrams: entry.userNgrams,
      });

      if (userScore > bestScore) {
        bestScore = userScore;
        bestMatch = entry;
      }
    }

    if (bestMatch && bestScore >= similarityThreshold) {
      stats.hits++;
      stats.semanticHits++;
      bestMatch.lastAccessed = now;
      console.log(`[SemanticCache] SEMANTIC HIT for ${model} (similarity: ${(bestScore * 100).toFixed(1)}%, hits: ${stats.hits})`);
      return bestMatch.response;
    }
  }

  stats.misses++;
  return null;
}

export function saveToSemanticCache(body, model, responseBody) {
  if (!body || !responseBody) return;
  if (body.stream) return; // Do not cache raw stream requests
  if (body.tool_choice && body.tool_choice !== "auto") return;
  if (responseBody.error || responseBody.is_error) return;

  const messages = body.messages || body.input || body.contents || [];
  const keyData = { model, messages };
  const hashKey = hashObject(keyData);
  if (!hashKey) return;

  const { systemText, userText, fullText } = extractSeparatedPrompt(messages);
  const normUser = normalizePrompt(userText);
  const normSystem = normalizePrompt(systemText);
  const userTokens = getTokens(normUser);
  const userNgrams = getCharNgrams(normUser, 3);

  const entry = {
    model,
    hashKey,
    normUser,
    normSystem,
    userTokens,
    userNgrams,
    response: responseBody,
    expiresAt: Date.now() + cacheTtlMs,
    lastAccessed: Date.now(),
  };

  responseCache.set(hashKey, entry);
  stats.saves++;

  // LRU Eviction
  if (responseCache.size > maxEntries) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of responseCache.entries()) {
      if (v.lastAccessed < oldestTime) {
        oldestTime = v.lastAccessed;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      responseCache.delete(oldestKey);
      stats.evictions++;
    }
  }
}
