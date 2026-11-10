// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
export const SCHEMA_VERSION = 16;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 16777216;
PRAGMA cache_size = -16384;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 10000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      tokenLimit: "INTEGER DEFAULT 0",
      usedTokens: "INTEGER DEFAULT 0",
      resetInterval: "TEXT DEFAULT 'never'",
      lastResetAt: "TEXT",
      allowedModels: "TEXT DEFAULT '*'",
      rpmLimit: "INTEGER DEFAULT 0",
      tpmLimit: "INTEGER DEFAULT 0",
      ipWhitelist: "TEXT DEFAULT ''",
      expiresAt: "TEXT",
      systemPrompt: "TEXT DEFAULT ''",
      permissions: "TEXT DEFAULT ''",
      createdBy: "TEXT DEFAULT ''",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)"],
  },
  teams: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      apiKey: "TEXT",
      enabled: "INTEGER DEFAULT 1",
      description: "TEXT DEFAULT ''",
      allowedModels: "TEXT DEFAULT '*'",
      allowedProviders: "TEXT DEFAULT '*'",
      rpmLimit: "INTEGER DEFAULT 0",
      dailyLimit: "INTEGER DEFAULT 0",
      monthlyLimit: "INTEGER DEFAULT 0",
      dailySpendLimitUsd: "REAL DEFAULT 0",
      monthlySpendLimitUsd: "REAL DEFAULT 0",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_team_name ON teams(name)",
      "CREATE INDEX IF NOT EXISTS idx_team_apikey ON teams(apiKey)",
    ],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      // 0 means auto: the window follows the largest member model.
      contextWindow: "INTEGER DEFAULT 0",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },
  vouchers: {
    columns: {
      id: "TEXT PRIMARY KEY",
      code: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      description: "TEXT DEFAULT ''",
      tokenLimit: "INTEGER DEFAULT 100000",
      allowedModels: "TEXT DEFAULT '*'",
      rpmLimit: "INTEGER DEFAULT 0",
      tpmLimit: "INTEGER DEFAULT 0",
      expiresInDays: "INTEGER DEFAULT 30",
      maxUses: "INTEGER DEFAULT 1",
      usedCount: "INTEGER DEFAULT 0",
      isBansos: "INTEGER DEFAULT 0",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_voucher_code ON vouchers(code)",
      "CREATE INDEX IF NOT EXISTS idx_voucher_active ON vouchers(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_voucher_bansos ON vouchers(isBansos)",
    ],
  },
  voucherClaims: {
    columns: {
      id: "TEXT PRIMARY KEY",
      voucherId: "TEXT NOT NULL",
      voucherCode: "TEXT NOT NULL",
      apiKeyId: "TEXT NOT NULL",
      apiKey: "TEXT NOT NULL",
      clientIp: "TEXT",
      deviceFp: "TEXT DEFAULT ''",
      hardwareFp: "TEXT DEFAULT ''",
      claimedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_vc_voucher ON voucherClaims(voucherId)",
      "CREATE INDEX IF NOT EXISTS idx_vc_key ON voucherClaims(apiKeyId)",
      "CREATE INDEX IF NOT EXISTS idx_vc_ip ON voucherClaims(clientIp)",
      "CREATE INDEX IF NOT EXISTS idx_vc_fp ON voucherClaims(deviceFp)",
      "CREATE INDEX IF NOT EXISTS idx_vc_hw ON voucherClaims(hardwareFp)",
    ],
  },
  // Persistent security trail. loginLimiter kept failures in a Map that died
  // with the process, so repeated probing across restarts was invisible.
  securityEvents: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      at: "TEXT NOT NULL",
      type: "TEXT NOT NULL",
      severity: "TEXT NOT NULL",
      ip: "TEXT NOT NULL",
      actor: "TEXT",
      method: "TEXT",
      path: "TEXT",
      status: "INTEGER DEFAULT 0",
      detail: "TEXT",
      userAgent: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_se_at ON securityEvents(at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_se_severity ON securityEvents(severity)",
      "CREATE INDEX IF NOT EXISTS idx_se_type ON securityEvents(type)",
    ],
  },
  // Recent dashboard/API traffic (excluding LLM streams), trimmed in place.
  accessEvents: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      at: "TEXT NOT NULL",
      method: "TEXT",
      path: "TEXT",
      status: "INTEGER DEFAULT 0",
      ms: "INTEGER DEFAULT 0",
      ip: "TEXT",
      role: "TEXT",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ae_at ON accessEvents(at DESC)"],
  },
  // Settings history: before-image snapshots of every settings mutation.
  settingsHistory: {
    columns: {
      id: "TEXT PRIMARY KEY",
      at: "TEXT NOT NULL",
      actor: "TEXT",
      reason: "TEXT",
      snapshot: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_sh_at ON settingsHistory(at DESC)",
    ],
  },
  // Dashboard notification feed (bell icon).
  notifications: {
    columns: {
      id: "TEXT PRIMARY KEY",
      kind: "TEXT NOT NULL",
      severity: "TEXT",
      title: "TEXT NOT NULL",
      body: "TEXT",
      link: "TEXT",
      dedupeKey: "TEXT",
      createdAt: "TEXT NOT NULL",
      readAt: "TEXT",
      clearedAt: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(createdAt DESC)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe ON notifications(dedupeKey) WHERE dedupeKey IS NOT NULL",
    ],
  },
  // IP bans — abusive clients (failed logins, key brute force, scraping) held
  // out before any key is even looked at. banExpiresAt null means permanent.
  ipBans: {
    columns: {
      ip: "TEXT PRIMARY KEY",
      reason: "TEXT NOT NULL DEFAULT 'manual'",
      failedAttempts: "INTEGER NOT NULL DEFAULT 1",
      banStartedAt: "TEXT NOT NULL",
      banExpiresAt: "TEXT",
      notes: "TEXT DEFAULT ''",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ipb_expires ON ipBans(banExpiresAt)",
      "CREATE INDEX IF NOT EXISTS idx_ipb_started ON ipBans(banStartedAt DESC)",
    ],
  },
  // Per-key deny-list + provider allowlist. A separate table on purpose: apiKeys
  // keeps its own shape, so an exported database still restores into a build
  // that has never heard of these columns.
  apiKeyAcls: {
    columns: {
      apiKeyId: "TEXT PRIMARY KEY",
      deniedModels: "TEXT DEFAULT ''",
      allowedProviders: "TEXT DEFAULT ''",
      notes: "TEXT DEFAULT ''",
      updatedAt: "TEXT",
    },
  },
  // Public usage-share links: one token shows one key's aggregates and nothing else.
  shareTokens: {
    columns: {
      token: "TEXT PRIMARY KEY",
      apiKeyId: "TEXT NOT NULL",
      label: "TEXT DEFAULT ''",
      expiresAt: "TEXT",
      viewCount: "INTEGER NOT NULL DEFAULT 0",
      lastViewedAt: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_sharetok_key ON shareTokens(apiKeyId)",
      "CREATE INDEX IF NOT EXISTS idx_sharetok_expires ON shareTokens(expiresAt)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
