// Package clitools writes X Router provider settings into the config files of
// the CLI coding agents the dashboard supports.
//
// Every writer follows the same three rules, because these files belong to the
// operator and a bad write breaks their editor:
//
//  1. read-modify-write — never clobber keys the tool owns;
//  2. back up the original to <file>.xrouter.bak before the first change;
//  3. validate after writing (JSON must parse) and roll back on failure.
package clitools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Params is what the dashboard posts: a base URL, a key and a model.
type Params struct {
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
	Model   string `json:"model"`
	// Home overrides the resolved home directory (tests, multi-user hosts).
	Home string `json:"home,omitempty"`
	// Profile selects a named profile for tools that have them (codex, hermes).
	Profile string `json:"profile,omitempty"`
}

// Status is the read side of the same contract.
type Status struct {
	Tool       string         `json:"tool"`
	Name       string         `json:"name"`
	Path       string         `json:"path"`
	Configured bool           `json:"configured"`
	Config     map[string]any `json:"config,omitempty"`
	Raw        string         `json:"raw,omitempty"`
	Error      string         `json:"error,omitempty"`
}

// Result reports what a write actually did.
type Result struct {
	Tool    string `json:"tool"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Written bool   `json:"written"`
	Backup  string `json:"backup,omitempty"`
	Message string `json:"message,omitempty"`
}

// Tool is one supported CLI agent.
type Tool struct {
	ID    string
	Name  string
	write func(home string, params Params) (Result, error)
	read  func(home string) (Status, error)
	reset func(home string) (Result, error)
}

// ---------------------------------------------------------------- helpers

func homeDir(params Params) string {
	if params.Home != "" {
		return params.Home
	}
	if home, err := os.UserHomeDir(); err == nil {
		return home
	}
	return "/root"
}

func expand(home, pattern string) string {
	return filepath.Join(home, filepath.FromSlash(pattern))
}

// dataDir mirrors the XDG/OS split the dashboard uses for VS Code forks.
func dataDir(home string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support")
	case "windows":
		if appData := os.Getenv("APPDATA"); appData != "" {
			return appData
		}
		return filepath.Join(home, "AppData", "Roaming")
	default:
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			return xdg
		}
		return filepath.Join(home, ".config")
	}
}

func localDataDir(home string) string {
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support")
	}
	if runtime.GOOS == "windows" {
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			return local
		}
		return filepath.Join(home, "AppData", "Local")
	}
	if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
		return xdg
	}
	return filepath.Join(home, ".local", "share")
}

func readJSONFile(path string) (map[string]any, error) {
	blob, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	trimmed := strings.TrimSpace(string(blob))
	if trimmed == "" {
		return map[string]any{}, nil
	}
	// These configs are frequently JSONC; drop trailing commas before parsing.
	cleaned := trailingComma.ReplaceAllString(trimmed, "$1")
	var out map[string]any
	if err := json.Unmarshal([]byte(cleaned), &out); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

var trailingComma = mustRegexp(`,(\s*[}\]])`)

func writeJSONFile(path string, value any) (string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	backup, err := backupFile(path)
	if err != nil {
		return "", err
	}
	blob, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return "", err
	}
	blob = append(blob, '\n')
	if err := os.WriteFile(path, blob, 0o644); err != nil {
		return backup, err
	}
	// Verify the file we just wrote really parses; restore if it does not.
	if _, err := readJSONFile(path); err != nil {
		if backup != "" {
			_ = os.Rename(backup, path)
		}
		return backup, fmt.Errorf("write verification failed, original restored: %w", err)
	}
	return backup, nil
}

// backupFile keeps exactly one copy of the pre-change file.
func backupFile(path string) (string, error) {
	blob, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	target := path + ".xrouter.bak"
	if err := os.WriteFile(target, blob, 0o644); err != nil {
		return "", err
	}
	return target, nil
}

func ensureDir(path string) error {
	return os.MkdirAll(filepath.Dir(path), 0o755)
}

func nestedMap(parent map[string]any, key string) map[string]any {
	child, ok := parent[key].(map[string]any)
	if !ok {
		child = map[string]any{}
		parent[key] = child
	}
	return child
}

func normaliseBase(base string, suffix string) string {
	base = strings.TrimSpace(base)
	base = strings.TrimSuffix(base, "/")
	if suffix == "" {
		return base
	}
	if strings.HasSuffix(base, suffix) {
		return base
	}
	return base + suffix
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
