package database

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type DB struct {
	sqlDB *sql.DB
	mu    sync.RWMutex
}

type ProviderConnection struct {
	ID        string          `json:"id"`
	Provider  string          `json:"provider"`
	AuthType  string          `json:"authType"`
	Name      string          `json:"name"`
	Email     string          `json:"email"`
	Priority  int             `json:"priority"`
	IsActive  bool            `json:"isActive"`
	Data      json.RawMessage `json:"data"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
}

type ProxyPool struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	IsActive   bool   `json:"isActive"`
	TestStatus string `json:"testStatus"`
	LatencyMs  int    `json:"latencyMs"`
	CreatedAt  string `json:"createdAt"`
}

type TelegramConfig struct {
	Enabled      bool   `json:"enabled"`
	BotToken     string `json:"botToken"`
	UserID       string `json:"userId"`
	WebhookURL   string `json:"webhookUrl"`
	Status       string `json:"status"`
	BotUsername  string `json:"botUsername,omitempty"`
	BotID        int64  `json:"botId,omitempty"`
	LastTestedAt string `json:"lastTestedAt,omitempty"`
}

func Open(dbPath string) (*DB, error) {
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create db directory: %w", err)
	}

	// Optimize SQLite cache and memory footprint for low-spec hosts (1GB RAM, 1 Core):
	// - WAL mode & busy_timeout
	// - cache_size(-1000): limit page cache to ~1MB
	// - mmap_size(0): disable memory-mapped I/O to avoid virtual memory ballooning
	dsn := fmt.Sprintf("%s?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=cache_size(-1000)&_pragma=temp_store(MEMORY)&_pragma=mmap_size(0)", dbPath)
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite database: %w", err)
	}

	sqlDB.SetMaxOpenConns(15)
	sqlDB.SetMaxIdleConns(5)
	sqlDB.SetConnMaxLifetime(time.Hour)

	db := &DB{sqlDB: sqlDB}
	if err := db.initSchema(); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("failed to initialize schema: %w", err)
	}

	log.Printf("[DB] Successfully connected to SQLite WAL database: %s", dbPath)
	return db, nil
}

func (d *DB) Close() error {
	return d.sqlDB.Close()
}

func (d *DB) initSchema() error {
	schema := `
	CREATE TABLE IF NOT EXISTS kv (
		scope TEXT NOT NULL,
		key TEXT NOT NULL,
		value TEXT NOT NULL,
		PRIMARY KEY (scope, key)
	);
	CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope);

	CREATE TABLE IF NOT EXISTS settings (
		id INTEGER PRIMARY KEY,
		data TEXT NOT NULL,
		updatedAt TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS providerConnections (
		id TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		authType TEXT NOT NULL,
		name TEXT,
		email TEXT,
		priority INTEGER,
		isActive INTEGER DEFAULT 1,
		data TEXT NOT NULL,
		createdAt TEXT NOT NULL,
		updatedAt TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider);
	CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive);

	CREATE TABLE IF NOT EXISTS proxyPools (
		id TEXT PRIMARY KEY,
		name TEXT,
		url TEXT NOT NULL,
		isActive INTEGER DEFAULT 1,
		testStatus TEXT,
		latencyMs INTEGER,
		createdAt TEXT NOT NULL,
		updatedAt TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS apiKeys (
		id TEXT PRIMARY KEY,
		key TEXT UNIQUE NOT NULL,
		name TEXT,
		isActive INTEGER DEFAULT 1,
		permissions TEXT,
		createdAt TEXT NOT NULL,
		updatedAt TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS teams (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		apiKey TEXT UNIQUE,
		enabled INTEGER DEFAULT 1,
		description TEXT,
		allowedModels TEXT,
		allowedProviders TEXT,
		rpmLimit INTEGER DEFAULT 0,
		dailyLimit INTEGER DEFAULT 0,
		monthlyLimit INTEGER DEFAULT 0,
		dailySpendLimitUsd REAL DEFAULT 0,
		monthlySpendLimitUsd REAL DEFAULT 0,
		createdAt TEXT NOT NULL,
		updatedAt TEXT NOT NULL
	);
	`
	_, err := d.sqlDB.Exec(schema)
	return err
}

func (d *DB) GetActiveConnections(provider string) ([]ProviderConnection, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	query := `SELECT id, provider, authType, COALESCE(name, ''), COALESCE(email, ''), priority, isActive, data, createdAt, updatedAt
	          FROM providerConnections WHERE provider = ? AND isActive = 1 ORDER BY priority ASC, updatedAt DESC`
	rows, err := d.sqlDB.Query(query, provider)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var conns []ProviderConnection
	for rows.Next() {
		var c ProviderConnection
		var dataStr string
		var isActiveInt int
		if err := rows.Scan(&c.ID, &c.Provider, &c.AuthType, &c.Name, &c.Email, &c.Priority, &isActiveInt, &dataStr, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		c.IsActive = isActiveInt == 1
		c.Data = json.RawMessage(dataStr)
		conns = append(conns, c)
	}
	return conns, nil
}

func (d *DB) GetActiveConnectionCount() (int, int, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	var active, total int
	err := d.sqlDB.QueryRow(`SELECT COUNT(CASE WHEN isActive = 1 THEN 1 END), COUNT(*) FROM providerConnections`).Scan(&active, &total)
	return active, total, err
}

func (d *DB) GetProxyPoolStats() (int, int, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	var live, total int
	err := d.sqlDB.QueryRow(`SELECT COUNT(CASE WHEN isActive = 1 AND (testStatus != 'error' OR testStatus IS NULL) THEN 1 END), COUNT(*) FROM proxyPools`).Scan(&live, &total)
	return live, total, err
}

func (d *DB) PruneDeadProxyPools() (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	res, err := d.sqlDB.Exec(`DELETE FROM proxyPools WHERE testStatus = 'error' OR isActive = 0`)
	if err != nil {
		return 0, err
	}
	rows, _ := res.RowsAffected()
	return int(rows), nil
}

func (d *DB) ValidateApiKey(key string) (bool, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	var exists int
	err := d.sqlDB.QueryRow(`SELECT 1 FROM apiKeys WHERE key = ? AND isActive = 1 LIMIT 1`, key).Scan(&exists)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return exists == 1, err
}

func (d *DB) GetTelegramConfig() (*TelegramConfig, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	var val string
	err := d.sqlDB.QueryRow(`SELECT value FROM kv WHERE scope = 'connection' AND key = 'config' LIMIT 1`).Scan(&val)
	if err == sql.ErrNoRows {
		return &TelegramConfig{Status: "idle"}, nil
	}
	if err != nil {
		return nil, err
	}

	var wrapper struct {
		Telegram TelegramConfig `json:"telegram"`
	}
	if err := json.Unmarshal([]byte(val), &wrapper); err != nil {
		return &TelegramConfig{Status: "idle"}, nil
	}
	return &wrapper.Telegram, nil
}

func (d *DB) SetTelegramConfig(cfg *TelegramConfig) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	wrapper := struct {
		Telegram *TelegramConfig `json:"telegram"`
	}{Telegram: cfg}

	bytes, err := json.Marshal(wrapper)
	if err != nil {
		return err
	}

	query := `INSERT INTO kv(scope, key, value) VALUES('connection', 'config', ?)
	          ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`
	_, err = d.sqlDB.Exec(query, string(bytes))
	return err
}
