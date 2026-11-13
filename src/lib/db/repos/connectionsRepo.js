import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { sealCredential, unsealCredential } from "../../vault/credentialVault.js";

const OPTIONAL_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount", "idToken", "lastRefreshAt",
];

const MODEL_LOCK_PREFIX = "modelLock_";

// Credential fields are sealed at rest (see src/lib/vault/credentialVault.js).
const CREDENTIAL_FIELDS = ["apiKey", "accessToken", "refreshToken"];
// Hidden per-connection copy of the ciphertext exactly as stored, so a credential
// this host cannot open is never dropped by a later write.
const SEALED_RAW_KEY = "__sealedCredentials";
// GLM/Z.ai OAuth keeps a plaintext business token beside the sealed access token;
// it is the recovery path when the sealed copy cannot be opened (a database moved
// between hosts, or a rotated storage key).
const GLM_PLAINTEXT_TOKEN_FIELDS = ["zaiBusinessToken", "zcodeJwtToken"];

function readSealedRaw(conn) {
  const sealed = conn?.[SEALED_RAW_KEY];
  return sealed && typeof sealed === "object" ? sealed : null;
}

function carrySealedRaw(target, source) {
  const sealed = readSealedRaw(source);
  if (sealed) {
    Object.defineProperty(target, SEALED_RAW_KEY, {
      value: sealed,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return target;
}

function plaintextGlmToken(extra, field) {
  if (field !== "accessToken") return null;
  const psd = extra?.providerSpecificData;
  if (!psd || typeof psd !== "object") return null;
  for (const key of GLM_PLAINTEXT_TOKEN_FIELDS) {
    const value = psd[key];
    if (typeof value === "string" && value.trim() && !value.startsWith("enc:v1:")) return value.trim();
  }
  return null;
}

// Non-enumerable: `{ ...conn }` in a listing route must never decrypt a
// credential. Resolution is memoised — including a null result — so a failure is
// neither retried nor re-logged on every read, and the raw ciphertext stays
// available for a later write.
function defineLazyCredential(conn, extra, sealedRaw, field) {
  if (typeof extra[field] !== "string" || !extra[field].startsWith("enc:v1:")) return;
  sealedRaw[field] = extra[field];
  let resolved = false;
  let value = null;
  Object.defineProperty(conn, field, {
    get() {
      if (!resolved) {
        resolved = true;
        value = unsealCredential(extra[field]);
        if (value == null) value = plaintextGlmToken(extra, field);
      }
      return value;
    },
    set(v) { resolved = true; value = v; extra[field] = v; },
    enumerable: false,
    configurable: true,
  });
}

function resetHealthStateOnActivation(existing, patch) {
  if (patch?.testStatus !== "active") return patch;

  const normalized = {
    ...patch,
    testStatus: "active",
    lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : null,
    lastErrorAt: Object.hasOwn(patch, "lastErrorAt") ? patch.lastErrorAt : null,
    errorCode: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
  };

  for (const key of Object.keys(existing || {})) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) normalized[key] = null;
  }

  return normalized;
}

function rowToConn(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});

  const conn = {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  // Lazy unseal credentials on demand to prevent CPU stalls when loading thousands of rows
  const sealedRaw = {};
  for (const field of CREDENTIAL_FIELDS) defineLazyCredential(conn, extra, sealedRaw, field);
  if (Object.keys(sealedRaw).length > 0) {
    Object.defineProperty(conn, SEALED_RAW_KEY, {
      value: sealedRaw,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  return conn;
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;

  // Seal sensitive credential fields before writing to SQLite database.
  // The credential getters are non-enumerable, so neither a spread nor the merge
  // in updateProviderConnection / createProviderConnection carries them — collect
  // them explicitly here, and keep a value this host cannot open verbatim instead
  // of overwriting it with null.
  const sealedRaw = readSealedRaw(c);
  const toStore = { ...rest };
  for (const field of CREDENTIAL_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(c, field);
    if (!descriptor) {
      if (sealedRaw?.[field]) toStore[field] = sealedRaw[field];
      continue;
    }
    const value = c[field];
    if (typeof value === "string" && value) {
      toStore[field] = sealCredential(value);
    } else if (descriptor.get) {
      // Getter present but unreadable (null): keep the stored ciphertext.
      if (sealedRaw?.[field]) toStore[field] = sealedRaw[field];
      else delete toStore[field];
    } else {
      // Plain property written by the caller — an explicit clear.
      delete toStore[field];
    }
  }

  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(toStore),
    createdAt,
    updatedAt,
  };
}

function upsert(db, c) {
  const r = connToRow(c);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.provider, r.authType, r.name, r.email, r.priority, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

function deriveConnectionName(data, fallbackName) {
  if (data.provider === "github") {
    return data.providerSpecificData?.githubLogin
      || data.providerSpecificData?.githubEmail
      || data.email
      || data.providerSpecificData?.githubName
      || fallbackName;
  }
  return fallbackName;
}

// Memory snapshot cache for active connections to eliminate N+1 SQL queries during high-concurrency routing
let connectionSnapshotCache = null;
let connectionSnapshotTime = 0;
const SNAPSHOT_TTL_MS = 5000; // 5-second memory snapshot

export function invalidateConnectionSnapshot() {
  connectionSnapshotCache = null;
  connectionSnapshotTime = 0;
}

export async function getRouteSnapshot() {
  const now = Date.now();
  if (connectionSnapshotCache && now - connectionSnapshotTime < SNAPSHOT_TTL_MS) {
    return connectionSnapshotCache;
  }
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM providerConnections WHERE isActive = 1`);
  const list = rows.map(rowToConn);
  list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  
  // Group by provider for instant O(1) lookups
  const byProvider = new Map();
  for (const conn of list) {
    if (!byProvider.has(conn.provider)) byProvider.set(conn.provider, []);
    byProvider.get(conn.provider).push(conn);
  }

  connectionSnapshotCache = { list, byProvider };
  connectionSnapshotTime = now;
  return connectionSnapshotCache;
}

export async function getProviderConnections(filter = {}) {
  // If provider is specified, use targeted SQL query directly (O(1) index hit instead of scanning thousands)
  if (filter.provider) {
    const db = await getAdapter();
    const where = ["provider = ?"];
    const params = [filter.provider];
    if (filter.isActive !== undefined) {
      where.push("isActive = ?");
      params.push(filter.isActive ? 1 : 0);
    }
    const sql = `SELECT * FROM providerConnections WHERE ${where.join(" AND ")}`;
    const rows = db.all(sql, params);
    const list = rows.map(rowToConn);
    list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
    return list;
  }

  // Fast path for all active connections using route snapshot
  if (filter.isActive === true) {
    const snapshot = await getRouteSnapshot();
    return snapshot.list;
  }

  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  const sql = `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const rows = db.all(sql, params);
  const list = rows.map(rowToConn);
  list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return list;
}

export async function getProviderConnectionById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
  return rowToConn(row);
}

// Internal sync reorder — must be called INSIDE a transaction.
//
// Normalizes priorities to a contiguous 1..N after a DELETE or an explicit
// reorder, so gaps don't accumulate over time.
//
// Deliberately NOT called on insert: a new connection already gets
// MAX(priority)+1, which sorts after every existing row, so the order is
// identical with or without the rewrite. Skipping it there is what makes
// import O(1) per key instead of O(pool) — see createProviderConnection.
function reorderInTx(db, providerId) {
  const list = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]).map(rowToConn);
  list.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  list.forEach((c, i) => {
    const want = i + 1;
    if ((c.priority || 0) !== want) {
      db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [want, c.id]);
    }
  });
}

export async function createProviderConnection(data) {
  invalidateConnectionSnapshot();
  const db = await getAdapter();
  const now = new Date().toISOString();
  let result;

  db.transaction(() => {
    // apikey connections are deduped by name and need only the current max
    // priority, so query for those directly instead of loading the whole pool
    // (O(pool) per key — the other half of the import cost in #4311). The oauth
    // branch below still scans, because its identity rules compare fields
    // inside providerSpecificData and have no single-column equivalent.
    const isApikey = data.authType === "apikey" && !!data.name;
    const all = isApikey
      ? db.all(
          `SELECT * FROM providerConnections WHERE provider = ? AND authType = ? AND name = ?`,
          [data.provider, "apikey", data.name]
        ).map(rowToConn)
      : db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);
    const poolSize = isApikey
      ? db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [data.provider])?.n ?? all.length
      : all.length;

    let existing = null;
    if (data.authType === "oauth" && data.email) {
      const incomingUsername = data.providerSpecificData?.username;
      const incomingWs = data.providerSpecificData?.chatgptAccountId;
      existing = all.find(c => {
        if (c.authType !== "oauth" || c.email !== data.email) return false;

        // Codex/OpenAI can issue multiple OAuth grants for the same email.
        // Refresh tokens are rotated single-use; collapsing a new login onto an
        // existing bare-email row overwrites the first account's token pair and
        // makes it look "invalid" after adding a second account. Only update an
        // existing Codex row when both rows expose the same ChatGPT account ID.
        if (data.provider === "codex") {
          const existingWs = c.providerSpecificData?.chatgptAccountId;
          return !!incomingWs && !!existingWs && incomingWs === existingWs;
        }

        // Workspace providers use workspace ID when both sides have it
        const existingWs = c.providerSpecificData?.chatgptAccountId;
        if (incomingWs && existingWs) return incomingWs === existingWs;
        if (incomingWs && !existingWs) return false;
        if (!incomingWs && existingWs) return false;
        // Non-workspace providers: match on (email + username) so cross-IdP
        // accounts don't overwrite each other. Require username on both sides
        // — if only one side has it, treat as a distinct identity rather than
        // collapsing onto the bare-email fallback (which would re-introduce
        // the cross-IdP overwrite).
        const existingUsername = c.providerSpecificData?.username;
        if (incomingUsername && existingUsername) {
          return incomingUsername === existingUsername;
        }
        if (incomingUsername || existingUsername) return false;
        return true;
      });
    } else if (data.authType === "apikey" && data.name) {
      existing = all.find(c => c.authType === "apikey" && c.name === data.name);
    }
    // access_token: never dedup — user manages duplicates manually

    if (existing) {
      // Name collision on an apikey connection used to silently replace the
      // stored apiKey, so a script that reused names ("Key 1", "Key 2", …)
      // destroyed existing pool entries with no 409 and no warning. Callers that
      // genuinely mean "update this one" pass allowOverwrite; everyone else gets
      // a typed error naming the row that would have been replaced. #4311
      if (data.allowOverwrite === false) {
        const err = new Error(
          `A connection named "${existing.name}" already exists for provider "${data.provider}". ` +
          `Pass allowOverwrite: true to replace it.`
        );
        err.code = "PROVIDER_NAME_CONFLICT";
        err.existingId = existing.id;
        err.existingName = existing.name;
        throw err;
      }
      const normalized = resetHealthStateOnActivation(existing, data);
      const merged = carrySealedRaw({ ...existing, ...normalized, updatedAt: now }, existing);
      upsert(db, merged);
      result = merged;
      return;
    }

    let connectionName = data.name || null;
    if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
      connectionName = deriveConnectionName(data, data.email || `Account ${poolSize + 1}`);
    }
    let connectionPriority = data.priority;
    if (!connectionPriority) {
      // MAX(priority)+1 in SQL rather than a reduce over the loaded pool: the
      // apikey path no longer has the whole pool in memory, and the aggregate
      // is served by the index instead of a row scan. #4311
      const maxRow = db.get(`SELECT MAX(priority) AS m FROM providerConnections WHERE provider = ?`, [data.provider]);
      connectionPriority = (maxRow?.m || 0) + 1;
    }

    const conn = {
      id: uuidv4(),
      provider: data.provider,
      authType: data.authType || "oauth",
      name: connectionName,
      priority: connectionPriority,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };
    for (const f of OPTIONAL_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      conn.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) conn.email = data.email;

    upsert(db, conn);
    // No reorderInTx here. `conn.priority` is already MAX(priority)+1, so the
    // row sorts last and the resulting order is what reorderInTx would have
    // produced anyway. The rewrite cost ~2N statements per insert — O(pool) —
    // which made a 5k-key import O(n*m): ~25M statements at a 5k pool, and it
    // serialized every parallel writer on the same transaction. #4311
    result = conn;
  });

  return result;
}

export async function bulkCreateProviderConnections(provider, keys = []) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const created = [];
  const failed = [];

  db.transaction(() => {
    const existingRows = db.all(
      `SELECT * FROM providerConnections WHERE provider = ? AND authType = 'apikey'`,
      [provider]
    ).map(rowToConn);
    const existingByName = new Map(existingRows.map(r => [r.name, r]));

    const maxRow = db.get(`SELECT MAX(priority) AS m FROM providerConnections WHERE provider = ?`, [provider]);
    let nextPriority = (maxRow?.m || 0) + 1;

    for (let i = 0; i < keys.length; i++) {
      const entry = keys[i];
      const apiKey = String(entry.apiKey || "").trim();
      const name = String(entry.name || `Key ${i + 1}`).trim();
      if (!apiKey) {
        failed.push({ index: i, error: "Empty API key" });
        continue;
      }

      try {
        const existing = existingByName.get(name);
        if (existing) {
          const normalized = resetHealthStateOnActivation(existing, {
            apiKey,
            providerSpecificData: entry.providerSpecificData || {},
          });
          const merged = carrySealedRaw({ ...existing, ...normalized, updatedAt: now }, existing);
          upsert(db, merged);
          existingByName.set(name, merged);
          created.push(merged.id);
        } else {
          const conn = {
            id: uuidv4(),
            provider,
            authType: "apikey",
            name,
            apiKey,
            priority: nextPriority++,
            isActive: true,
            testStatus: "unknown",
            providerSpecificData: entry.providerSpecificData || {},
            createdAt: now,
            updatedAt: now,
          };
          upsert(db, conn);
          existingByName.set(name, conn);
          created.push(conn.id);
        }
      } catch (err) {
        failed.push({ index: i, error: err?.message || "Failed to create" });
      }
    }
  });

  return { created, failed };
}

// Critical: OAuth refresh token race — atomic merge inside transaction
export async function updateProviderConnection(id, data) {
  // Only invalidate route snapshot if structural routing fields change, preventing thrashing on volatile stats/pings
  const isStructural = data.isActive !== undefined || data.priority !== undefined || data.provider !== undefined || data.apiKey !== undefined || data.accessToken !== undefined || data.refreshToken !== undefined;
  if (isStructural) invalidateConnectionSnapshot();
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) { result = null; return; }
    const existing = rowToConn(row);
    const normalized = resetHealthStateOnActivation(existing, data);
    const merged = carrySealedRaw({ ...existing, ...normalized, updatedAt: new Date().toISOString() }, existing);
    upsert(db, merged);
    if (data.priority !== undefined) reorderInTx(db, existing.provider);
    result = merged;
  });
  return result;
}

export async function deleteProviderConnection(id) {
  invalidateConnectionSnapshot();
  const db = await getAdapter();
  let ok = false;
  db.transaction(() => {
    const row = db.get(`SELECT provider FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
    reorderInTx(db, row.provider);
    ok = true;
  });
  return ok;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getAdapter();
  const before = db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [providerId]);
  db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId]);
  return before?.n || 0;
}

export async function reorderProviderConnections(providerId) {
  const db = await getAdapter();
  db.transaction(() => reorderInTx(db, providerId));
}

// Bulk prune dead, invalid, and quota-exhausted connections
export async function pruneDeadProviderConnections(options = {}) {
  const db = await getAdapter();
  const all = db.all(`SELECT * FROM providerConnections`).map(rowToConn);
  const deadIds = [];

  for (const c of all) {
    const isUnavailable = c.testStatus === "unavailable" || c.testStatus === "error" || c.testStatus === "expired";
    const status = c.errorCode;
    const err = String(c.lastError || "").toLowerCase();
    const isFatalAuth = (status === 401 || status === 403);
    const isExhausted = status === 402 ||
      err.includes("quota") ||
      err.includes("insufficient") ||
      err.includes("exhausted") ||
      err.includes("out of credits") ||
      err.includes("invalid token") ||
      err.includes("token revoked") ||
      err.includes("account suspended") ||
      err.includes("balance is insufficient");

    if (isUnavailable || isFatalAuth || isExhausted) {
      deadIds.push(c.id);
    }
  }

  if (deadIds.length === 0) return { count: 0, removed: [] };

  const removed = [];
  db.transaction(() => {
    for (const id of deadIds) {
      const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
      if (row) {
        db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
        removed.push(rowToConn(row));
      }
    }
  });

  return { count: removed.length, removed };
}

export async function cleanupProviderConnections() {
  const db = await getAdapter();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM providerConnections`);
    for (const row of rows) {
      const conn = rowToConn(row);
      let dirty = false;
      for (const f of fieldsToCheck) {
        if (conn[f] === null || conn[f] === undefined) {
          if (f in conn) { delete conn[f]; cleaned++; dirty = true; }
        }
      }
      if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
        delete conn.providerSpecificData;
        cleaned++;
        dirty = true;
      }
      if (dirty) upsert(db, conn);
    }
  });
  return cleaned;
}
