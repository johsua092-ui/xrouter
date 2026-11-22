package clitools

// Registry of the CLI agents the dashboard can configure. Every entry writes
// through the same read-modify-write + backup + verify path.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Tools lists every supported agent, keyed by the dashboard's tool id.
var Tools = map[string]*Tool{}

func register(tool *Tool) { Tools[tool.ID] = tool }

// ---------------------------------------------------------------- generic shapes

// providerMapTool writes {"providers":{"xrouter":{...}}} JSON configs.
type providerMapTool struct {
	path      func(home string) string
	typeValue string
	extra     func(entry map[string]any, params Params)
	modelKey  string
}

func (p providerMapTool) write(home string, params Params) (Result, error) {
	target := p.path(home)
	doc, err := readJSONFile(target)
	if err != nil {
		return Result{}, err
	}
	providers := nestedMap(doc, "providers")
	entry := map[string]any{
		"base_url": normaliseBase(params.BaseURL, "/v1"),
		"api_key":  params.APIKey,
	}
	if p.typeValue != "" {
		entry["type"] = p.typeValue
	}
	if params.Model != "" {
		if p.modelKey != "" {
			entry[p.modelKey] = params.Model
		} else {
			entry["models"] = []any{map[string]any{
				"id": params.Model, "name": params.Model, "context_window": 128000,
			}}
		}
	}
	if p.extra != nil {
		p.extra(entry, params)
	}
	providers["xrouter"] = entry
	backup, err := writeJSONFile(target, doc)
	if err != nil {
		return Result{}, err
	}
	return Result{Tool: "", Name: "", Path: target, Written: true, Backup: backup}, nil
}

func (p providerMapTool) read(home string) (Status, error) {
	target := p.path(home)
	doc, err := readJSONFile(target)
	if err != nil {
		return Status{}, err
	}
	providers, _ := doc["providers"].(map[string]any)
	entry, _ := providers["xrouter"].(map[string]any)
	status := Status{Path: target, Configured: entry != nil}
	if entry != nil {
		status.Config = entry
	}
	return status, nil
}

func (p providerMapTool) reset(home string) (Result, error) {
	target := p.path(home)
	doc, err := readJSONFile(target)
	if err != nil {
		return Result{}, err
	}
	providers, _ := doc["providers"].(map[string]any)
	if providers == nil {
		return Result{Path: target, Message: "no config file to reset"}, nil
	}
	delete(providers, "xrouter")
	if len(providers) == 0 {
		delete(doc, "providers")
	}
	backup, err := writeJSONFile(target, doc)
	if err != nil {
		return Result{}, err
	}
	return Result{Path: target, Written: true, Backup: backup}, nil
}

// envProviderTool writes a TOML `[openai]` table (forge / codewhale / deepseek).
type tomlProviderTool struct {
	path    func(home string) string
	basePad string
	header  string
}

func (t tomlProviderTool) write(home string, params Params) (Result, error) {
	target := t.path(home)
	existing, _ := os.ReadFile(target)
	text := stripBlock(string(existing))
	base := normaliseBase(params.BaseURL, t.basePad)
	body := []string{
		fmt.Sprintf("[%s]", t.header),
		"base_url = " + tomlQuote(base),
		"api_key = " + tomlQuote(params.APIKey),
		"model = " + tomlQuote(params.Model),
	}
	updated := writeBlock(text, body)
	if err := ensureDir(target); err != nil {
		return Result{}, err
	}
	backup, _ := backupFile(target)
	if err := os.WriteFile(target, []byte(updated), 0o644); err != nil {
		return Result{}, err
	}
	return Result{Path: target, Written: true, Backup: backup}, nil
}

func (t tomlProviderTool) read(home string) (Status, error) {
	target := t.path(home)
	blob, err := os.ReadFile(target)
	if err != nil && !os.IsNotExist(err) {
		return Status{}, err
	}
	text := string(blob)
	status := Status{Path: target, Configured: containsLine(text, blockStart) || containsLine(text, "["+t.header+"]")}
	if status.Configured {
		status.Raw = text
	}
	return status, nil
}

func (t tomlProviderTool) reset(home string) (Result, error) {
	target := t.path(home)
	blob, err := os.ReadFile(target)
	if err != nil {
		return Result{Path: target, Message: "no config file to reset"}, nil
	}
	updated := stripSection(stripBlock(string(blob)), t.header)
	backup, _ := backupFile(target)
	if strings.TrimSpace(updated) == "" {
		_ = os.Remove(target)
		return Result{Path: target, Written: true, Backup: backup, Message: "config removed"}, nil
	}
	if err := os.WriteFile(target, []byte(updated+"\n"), 0o644); err != nil {
		return Result{}, err
	}
	return Result{Path: target, Written: true, Backup: backup}, nil
}

// ---------------------------------------------------------------- claude code

var claudeTool = &Tool{
	ID:   "claude",
	Name: "Claude Code",
}

func init() {
	claudeTool.write = func(home string, params Params) (Result, error) {
		target := expand(home, ".claude/settings.json")
		doc, err := readJSONFile(target)
		if err != nil {
			return Result{}, err
		}
		env := nestedMap(doc, "env")
		env["ANTHROPIC_BASE_URL"] = normaliseBase(params.BaseURL, "/v1")
		env["ANTHROPIC_AUTH_TOKEN"] = params.APIKey
		env["API_TIMEOUT_MS"] = "600000"
		if params.Model != "" {
			env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = params.Model
			env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = params.Model
			env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = params.Model
		}
		backup, err := writeJSONFile(target, doc)
		if err != nil {
			return Result{}, err
		}
		return Result{Tool: "claude", Name: claudeTool.Name, Path: target, Written: true, Backup: backup}, nil
	}
	claudeTool.read = func(home string) (Status, error) {
		target := expand(home, ".claude/settings.json")
		doc, err := readJSONFile(target)
		if err != nil {
			return Status{}, err
		}
		env, _ := doc["env"].(map[string]any)
		configured := env != nil && env["ANTHROPIC_BASE_URL"] != nil
		return Status{Tool: "claude", Name: claudeTool.Name, Path: target, Configured: configured, Config: env}, nil
	}
	claudeTool.reset = func(home string) (Result, error) {
		target := expand(home, ".claude/settings.json")
		doc, err := readJSONFile(target)
		if err != nil {
			return Result{}, err
		}
		env, _ := doc["env"].(map[string]any)
		if env == nil {
			return Result{Path: target, Message: "no config file to reset"}, nil
		}
		for _, key := range []string{
			"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_DEFAULT_OPUS_MODEL",
			"ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "API_TIMEOUT_MS",
		} {
			delete(env, key)
		}
		if len(env) == 0 {
			delete(doc, "env")
		}
		backup, err := writeJSONFile(target, doc)
		if err != nil {
			return Result{}, err
		}
		return Result{Path: target, Written: true, Backup: backup}, nil
	}
	register(claudeTool)
}

// ---------------------------------------------------------------- codex

func init() {
	codex := &Tool{ID: "codex", Name: "Codex CLI"}
	path := func(home string) string { return expand(home, ".codex/config.toml") }
	codex.write = func(home string, params Params) (Result, error) {
		target := path(home)
		existing, _ := os.ReadFile(target)
		text := stripBlock(stripSection(string(existing), "model_providers.xrouter"))
		base := normaliseBase(params.BaseURL, "/v1")
		block := []string{
			"[model_providers.xrouter]",
			`name = "X Router"`,
			"base_url = " + tomlQuote(base),
			`wire_api = "responses"`,
			"[model_providers.xrouter.http_headers]",
			"Authorization = " + tomlQuote("Bearer "+params.APIKey),
		}
		updated := writeBlock(text, block)
		if params.Model != "" {
			updated = setTopLevelScalar(updated, "model", tomlQuote(params.Model))
			updated = setTopLevelScalar(updated, "model_provider", `"xrouter"`)
		}
		if err := ensureDir(target); err != nil {
			return Result{}, err
		}
		backup, _ := backupFile(target)
		return Result{Tool: "codex", Name: codex.Name, Path: target, Written: true, Backup: backup},
			os.WriteFile(target, []byte(updated), 0o644)
	}
	codex.read = func(home string) (Status, error) {
		target := path(home)
		blob, err := os.ReadFile(target)
		if err != nil && !os.IsNotExist(err) {
			return Status{}, err
		}
		text := string(blob)
		return Status{
			Tool: "codex", Name: codex.Name, Path: target,
			Configured: containsLine(text, "[model_providers.xrouter]"),
			Raw:        text,
		}, nil
	}
	codex.reset = func(home string) (Result, error) {
		target := path(home)
		blob, err := os.ReadFile(target)
		if err != nil {
			return Result{Path: target, Message: "no config file to reset"}, nil
		}
		text := stripBlock(stripSection(string(blob), "model_providers.xrouter"))
		if strings.Contains(text, `model_provider = "xrouter"`) {
			text = dropTopLevelScalar(text, "model_provider")
			text = dropTopLevelScalar(text, "model")
		}
		backup, _ := backupFile(target)
		return Result{Path: target, Written: true, Backup: backup}, os.WriteFile(target, []byte(text), 0o644)
	}
	register(codex)

	profiles := &Tool{ID: "codex-profiles", Name: "Codex profiles"}
	profiles.write = func(home string, params Params) (Result, error) {
		name := sanitiseProfileName(params.Profile)
		if name == "" {
			return Result{}, fmt.Errorf("profiles needs a name")
		}
		target := expand(home, ".codex/"+name+".config.toml")
		body := fmt.Sprintf("# codex -p %s\nmodel = %s\nmodel_provider = \"xrouter\"\n", name, tomlQuote(params.Model))
		if err := ensureDir(target); err != nil {
			return Result{}, err
		}
		backup, _ := backupFile(target)
		return Result{Tool: "codex-profiles", Name: profiles.Name, Path: target, Written: true, Backup: backup},
			os.WriteFile(target, []byte(body), 0o644)
	}
	profiles.read = func(home string) (Status, error) {
		dir := expand(home, ".codex")
		matches, _ := filepath.Glob(filepath.Join(dir, "*.config.toml"))
		return Status{
			Tool: "codex-profiles", Name: profiles.Name, Path: dir,
			Configured: len(matches) > 0, Config: map[string]any{"profiles": len(matches)},
		}, nil
	}
	profiles.reset = func(home string) (Result, error) {
		dir := expand(home, ".codex")
		matches, _ := filepath.Glob(filepath.Join(dir, "*.config.toml"))
		removed := 0
		for _, match := range matches {
			blob, _ := os.ReadFile(match)
			if strings.Contains(string(blob), `model_provider = "xrouter"`) {
				if err := os.Remove(match); err == nil {
					removed++
				}
			}
		}
		return Result{Tool: "codex-profiles", Path: dir, Written: removed > 0,
			Message: fmt.Sprintf("removed %d profile(s)", removed)}, nil
	}
	register(profiles)
}

func sanitiseProfileName(name string) string {
	cleaned := strings.TrimSpace(name)
	cleaned = strings.ReplaceAll(cleaned, "/", "-")
	cleaned = strings.ReplaceAll(cleaned, "\\", "-")
	cleaned = strings.ReplaceAll(cleaned, "..", "")
	return cleaned
}

// ---------------------------------------------------------------- opencode

func init() {
	opencode := &Tool{ID: "opencode", Name: "OpenCode"}
	path := func(home string) string { return filepath.Join(dataDir(home), "opencode", "opencode.json") }
	opencode.write = func(home string, params Params) (Result, error) {
		target := path(home)
		doc, err := readJSONFile(target)
		if err != nil {
			return Result{}, err
		}
		provider := nestedMap(nestedMap(doc, "provider"), "xrouter")
		provider["npm"] = "@ai-sdk/openai-compatible"
		provider["name"] = "X Router"
		options := nestedMap(provider, "options")
		options["baseURL"] = normaliseBase(params.BaseURL, "/v1")
		options["apiKey"] = params.APIKey
		if params.Model != "" {
			models := nestedMap(provider, "models")
			models[params.Model] = map[string]any{"name": params.Model}
			doc["model"] = "xrouter/" + params.Model
		}
		backup, err := writeJSONFile(target, doc)
		if err != nil {
			return Result{}, err
		}
		return Result{Tool: "opencode", Name: opencode.Name, Path: target, Written: true, Backup: backup}, nil
	}
	opencode.read = func(home string) (Status, error) {
		target := path(home)
		doc, err := readJSONFile(target)
		if err != nil {
			return Status{}, err
		}
		providers, _ := doc["provider"].(map[string]any)
		entry, _ := providers["xrouter"].(map[string]any)
		return Status{Tool: "opencode", Name: opencode.Name, Path: target,
			Configured: entry != nil, Config: entry}, nil
	}
	opencode.reset = func(home string) (Result, error) {
		target := path(home)
		doc, err := readJSONFile(target)
		if err != nil {
			return Result{}, err
		}
		providers, _ := doc["provider"].(map[string]any)
		if providers == nil {
			return Result{Path: target, Message: "no config file to reset"}, nil
		}
		delete(providers, "xrouter")
		if model, _ := doc["model"].(string); strings.HasPrefix(model, "xrouter/") {
			delete(doc, "model")
		}
		backup, err := writeJSONFile(target, doc)
		if err != nil {
			return Result{}, err
		}
		return Result{Path: target, Written: true, Backup: backup}, nil
	}
	register(opencode)
}

// ---------------------------------------------------------------- cline / kilo

func clineStyle(id, name, dataPath, statePrefix string, secretsPath func(home string) string) *Tool {
	tool := &Tool{ID: id, Name: name}
	tool.write = func(home string, params Params) (Result, error) {
		statePath := expand(home, dataPath)
		state, err := readJSONFile(statePath)
		if err != nil {
			return Result{}, err
		}
		base := normaliseBase(params.BaseURL, "")
		base = strings.TrimSuffix(base, "/v1")
		state["actModeApiProvider"] = "openai"
		state["planModeApiProvider"] = "openai"
		state["openAiBaseUrl"] = base
		state["openAiModelId"] = params.Model
		state["planModeOpenAiModelId"] = params.Model
		backup, err := writeJSONFile(statePath, state)
		if err != nil {
			return Result{}, err
		}
		if secretsPath != nil {
			secretFile := secretsPath(home)
			secrets, err := readJSONFile(secretFile)
			if err != nil {
				return Result{}, err
			}
			secrets["openAiApiKey"] = params.APIKey
			if _, err := writeJSONFile(secretFile, secrets); err != nil {
				return Result{}, err
			}
		}
		return Result{Tool: id, Name: name, Path: statePath, Written: true, Backup: backup}, nil
	}
	tool.read = func(home string) (Status, error) {
		statePath := expand(home, dataPath)
		state, err := readJSONFile(statePath)
		if err != nil {
			return Status{}, err
		}
		_, configured := state["openAiBaseUrl"]
		return Status{Tool: id, Name: name, Path: statePath, Configured: configured, Config: state}, nil
	}
	tool.reset = func(home string) (Result, error) {
		statePath := expand(home, dataPath)
		state, err := readJSONFile(statePath)
		if err != nil {
			return Result{}, err
		}
		delete(state, "openAiBaseUrl")
		delete(state, "openAiModelId")
		delete(state, "planModeOpenAiModelId")
		backup, err := writeJSONFile(statePath, state)
		if err != nil {
			return Result{}, err
		}
		return Result{Path: statePath, Written: true, Backup: backup}, nil
	}
	register(tool)
	return tool
}

func init() {
	clineStyle("cline", "Cline", ".cline/data/globalState.json", "cline",
		func(home string) string { return expand(home, ".cline/data/secrets.json") })
	clineStyle("kilo", "Kilo Code", ".local/share/kilo/globalState.json", "kilo",
		func(home string) string { return expand(home, ".local/share/kilo/secrets.json") })
	clineStyle("roo", "Roo Code", ".roo/data/globalState.json", "roo",
		func(home string) string { return expand(home, ".roo/data/secrets.json") })
	clineStyle("continue", "Continue", ".continue/globalState.json", "continue", nil)
}

// ---------------------------------------------------------------- simple JSON tools

func init() {
	register(&Tool{
		ID:   "crush",
		Name: "Crush",
		write: providerMapTool{
			path:      func(home string) string { return filepath.Join(dataDir(home), "crush", "crush.json") },
			typeValue: "openai-compat",
		}.write,
		read: providerMapTool{
			path: func(home string) string { return filepath.Join(dataDir(home), "crush", "crush.json") },
		}.read,
		reset: providerMapTool{
			path: func(home string) string { return filepath.Join(dataDir(home), "crush", "crush.json") },
		}.reset,
	})

	register(&Tool{
		ID:   "smelt",
		Name: "Smelt",
		write: providerMapTool{
			path:     func(home string) string { return expand(home, ".smelt/config.json") },
			modelKey: "model",
		}.write,
		read: providerMapTool{
			path: func(home string) string { return expand(home, ".smelt/config.json") },
		}.read,
		reset: providerMapTool{
			path: func(home string) string { return expand(home, ".smelt/config.json") },
		}.reset,
	})

	register(&Tool{
		ID:   "openclaw",
		Name: "OpenClaw",
		write: providerMapTool{
			path: func(home string) string { return expand(home, ".openclaw/openclaw.json") },
			extra: func(entry map[string]any, params Params) {
				entry["models"] = []any{params.Model}
			},
		}.write,
		read: providerMapTool{
			path: func(home string) string { return expand(home, ".openclaw/openclaw.json") },
		}.read,
		reset: providerMapTool{
			path: func(home string) string { return expand(home, ".openclaw/openclaw.json") },
		}.reset,
	})

	register(&Tool{
		ID:   "pi",
		Name: "Pi",
		write: providerMapTool{
			path:     func(home string) string { return expand(home, ".pi/agent/models.json") },
			modelKey: "default_model",
		}.write,
		read: providerMapTool{
			path: func(home string) string { return expand(home, ".pi/agent/models.json") },
		}.read,
		reset: providerMapTool{
			path: func(home string) string { return expand(home, ".pi/agent/models.json") },
		}.reset,
	})

	register(&Tool{
		ID:   "droid",
		Name: "Droid",
		write: providerMapTool{
			path:     func(home string) string { return expand(home, ".factory/settings.json") },
			modelKey: "default_model",
		}.write,
		read: providerMapTool{
			path: func(home string) string { return expand(home, ".factory/settings.json") },
		}.read,
		reset: providerMapTool{
			path: func(home string) string { return expand(home, ".factory/settings.json") },
		}.reset,
	})
}

// ---------------------------------------------------------------- TOML tools

func init() {
	register(&Tool{
		ID:   "forge",
		Name: "Forge",
		write: tomlProviderTool{
			path:    func(home string) string { return expand(home, ".forge/config.toml") },
			basePad: "/v1", header: "openai",
		}.write,
		read: tomlProviderTool{
			path: func(home string) string { return expand(home, ".forge/config.toml") },
			header: "openai",
		}.read,
		reset: tomlProviderTool{
			path: func(home string) string { return expand(home, ".forge/config.toml") },
			header: "openai",
		}.reset,
	})

	register(&Tool{
		ID:   "codewhale",
		Name: "CodeWhale",
		write: tomlProviderTool{
			path:    func(home string) string { return expand(home, ".codewhale/config.toml") },
			basePad: "/v1", header: "openai",
		}.write,
		read: tomlProviderTool{
			path: func(home string) string { return expand(home, ".codewhale/config.toml") },
			header: "openai",
		}.read,
		reset: tomlProviderTool{
			path: func(home string) string { return expand(home, ".codewhale/config.toml") },
			header: "openai",
		}.reset,
	})

	register(&Tool{
		ID:   "deepseek-tui",
		Name: "DeepSeek TUI",
		write: tomlProviderTool{
			path:    func(home string) string { return expand(home, ".deepseek/config.toml") },
			basePad: "/v1", header: "openai",
		}.write,
		read: tomlProviderTool{
			path: func(home string) string { return expand(home, ".deepseek/config.toml") },
			header: "openai",
		}.read,
		reset: tomlProviderTool{
			path: func(home string) string { return expand(home, ".deepseek/config.toml") },
			header: "openai",
		}.reset,
	})

	register(&Tool{
		ID:   "jcode",
		Name: "JCode",
		write: tomlProviderTool{
			path:    func(home string) string { return expand(home, ".jcode/config.toml") },
			basePad: "/v1", header: "providers.xrouter",
		}.write,
		read: tomlProviderTool{
			path: func(home string) string { return expand(home, ".jcode/config.toml") },
			header: "providers.xrouter",
		}.read,
		reset: tomlProviderTool{
			path: func(home string) string { return expand(home, ".jcode/config.toml") },
			header: "providers.xrouter",
		}.reset,
	})

	register(&Tool{
		ID:   "grok-build",
		Name: "Grok Build",
		write: tomlProviderTool{
			path:    func(home string) string { return expand(home, ".grok/config.toml") },
			basePad: "/v1", header: "model_providers.xrouter",
		}.write,
		read: tomlProviderTool{
			path: func(home string) string { return expand(home, ".grok/config.toml") },
			header: "model_providers.xrouter",
		}.read,
		reset: tomlProviderTool{
			path: func(home string) string { return expand(home, ".grok/config.toml") },
			header: "model_providers.xrouter",
		}.reset,
	})
}

// ---------------------------------------------------------------- copilot

func init() {
	copilot := &Tool{ID: "copilot", Name: "GitHub Copilot (VS Code)"}
	path := func(home string) string {
		return filepath.Join(dataDir(home), "Code", "User", "chatLanguageModels.json")
	}
	copilot.write = func(home string, params Params) (Result, error) {
		target := path(home)
		var entries []any
		if blob, err := os.ReadFile(target); err == nil && strings.TrimSpace(string(blob)) != "" {
			_ = json.Unmarshal(blob, &entries)
		}
		entry := map[string]any{
			"name":    "X Router",
			"apiKey":  params.APIKey,
			"models":  []any{map[string]any{
				"id": params.Model, "name": params.Model,
				"url": normaliseBase(params.BaseURL, "/v1") + "/chat/completions",
				"toolCalling": true, "vision": false,
				"maxInputTokens": 128000, "maxOutputTokens": 16000,
			}},
		}
		replaced := false
		for index, item := range entries {
			if row, ok := item.(map[string]any); ok && row["name"] == "X Router" {
				entries[index] = entry
				replaced = true
			}
		}
		if !replaced {
			entries = append(entries, entry)
		}
		backup, err := writeJSONFile(target, entries)
		if err != nil {
			return Result{}, err
		}
		return Result{Tool: "copilot", Name: copilot.Name, Path: target, Written: true, Backup: backup}, nil
	}
	copilot.read = func(home string) (Status, error) {
		target := path(home)
		blob, err := os.ReadFile(target)
		if err != nil && !os.IsNotExist(err) {
			return Status{}, err
		}
		configured := strings.Contains(string(blob), "X Router")
		return Status{Tool: "copilot", Name: copilot.Name, Path: target, Configured: configured}, nil
	}
	copilot.reset = func(home string) (Result, error) {
		target := path(home)
		var entries []map[string]any
		if blob, err := os.ReadFile(target); err == nil {
			_ = json.Unmarshal(blob, &entries)
		}
		kept := make([]any, 0, len(entries))
		for _, entry := range entries {
			if entry["name"] != "X Router" {
				kept = append(kept, entry)
			}
		}
		backup, err := writeJSONFile(target, kept)
		if err != nil {
			return Result{}, err
		}
		return Result{Path: target, Written: true, Backup: backup}, nil
	}
	register(copilot)
}

// ---------------------------------------------------------------- hermes

func init() {
	hermes := &Tool{ID: "hermes", Name: "Hermes"}
	hermes.write = func(home string, params Params) (Result, error) {
		target := filepath.Join(dataDir(home), "hermes", "config.yaml")
		blob, _ := os.ReadFile(target)
		base := normaliseBase(params.BaseURL, "/v1")
		block := []string{
			"# >>> xrouter managed — edits inside this block are overwritten",
			"provider:",
			"  openai:",
			"    base_url: " + base,
			"    api_key: " + params.APIKey,
			"    model: " + params.Model,
			"# <<< xrouter managed",
		}
		text := string(blob)
		if start := strings.Index(text, "# >>> xrouter managed"); start >= 0 {
			if end := strings.Index(text[start:], "# <<< xrouter managed"); end >= 0 {
				end += start + len("# <<< xrouter managed")
				text = text[:start] + text[end:]
			}
		}
		updated := strings.TrimRight(text, "\n")
		if updated != "" {
			updated += "\n\n"
		}
		updated += strings.Join(block, "\n") + "\n"
		if err := ensureDir(target); err != nil {
			return Result{}, err
		}
		backup, _ := backupFile(target)
		return Result{Tool: "hermes", Name: hermes.Name, Path: target, Written: true, Backup: backup},
			os.WriteFile(target, []byte(updated), 0o644)
	}
	hermes.read = func(home string) (Status, error) {
		target := filepath.Join(dataDir(home), "hermes", "config.yaml")
		blob, err := os.ReadFile(target)
		if err != nil && !os.IsNotExist(err) {
			return Status{}, err
		}
		return Status{Tool: "hermes", Name: hermes.Name, Path: target,
			Configured: strings.Contains(string(blob), "# >>> xrouter managed")}, nil
	}
	hermes.reset = func(home string) (Result, error) {
		target := filepath.Join(dataDir(home), "hermes", "config.yaml")
		blob, err := os.ReadFile(target)
		if err != nil {
			return Result{Path: target, Message: "no config file to reset"}, nil
		}
		text := string(blob)
		if start := strings.Index(text, "# >>> xrouter managed"); start >= 0 {
			if end := strings.Index(text[start:], "# <<< xrouter managed"); end >= 0 {
				end += start + len("# <<< xrouter managed")
				text = strings.TrimRight(text[:start]+text[end:], "\n") + "\n"
			}
		}
		backup, _ := backupFile(target)
		return Result{Path: target, Written: true, Backup: backup}, os.WriteFile(target, []byte(text), 0o644)
	}
	register(hermes)
}

// ---------------------------------------------------------------- public API

// Install configures one tool.
func Install(id string, params Params) (Result, error) {
	tool, ok := Tools[id]
	if !ok {
		return Result{}, fmt.Errorf("unknown tool %q", id)
	}
	if params.BaseURL == "" {
		return Result{}, fmt.Errorf("baseUrl is required")
	}
	result, err := tool.write(homeDir(params), params)
	if err != nil {
		return Result{}, err
	}
	result.Tool = tool.ID
	result.Name = tool.Name
	return result, nil
}

// Status reports whether a tool is configured on this host.
func StatusOf(id string, params Params) (Status, error) {
	tool, ok := Tools[id]
	if !ok {
		return Status{}, fmt.Errorf("unknown tool %q", id)
	}
	status, err := tool.read(homeDir(params))
	if err != nil {
		return Status{}, err
	}
	status.Tool = tool.ID
	status.Name = tool.Name
	return status, nil
}

// Reset removes the X Router provider from a tool.
func Reset(id string, params Params) (Result, error) {
	tool, ok := Tools[id]
	if !ok {
		return Result{}, fmt.Errorf("unknown tool %q", id)
	}
	result, err := tool.reset(homeDir(params))
	if err != nil {
		return Result{}, err
	}
	result.Tool = tool.ID
	result.Name = tool.Name
	return result, nil
}

// AllStatuses walks every registered tool.
func AllStatuses(params Params) map[string]Status {
	out := make(map[string]Status, len(Tools))
	for id := range Tools {
		status, err := StatusOf(id, params)
		if err != nil {
			status = Status{Tool: id, Error: err.Error(), Configured: false}
		}
		out[id] = status
	}
	return out
}

// IDs lists the registered tool ids.
func IDs() []string {
	ids := make([]string, 0, len(Tools))
	for id := range Tools {
		ids = append(ids, id)
	}
	sortStrings(ids)
	return ids
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

var _ = sortedKeys
