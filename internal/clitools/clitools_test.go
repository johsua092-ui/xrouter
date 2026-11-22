package clitools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// tempHome gives each test an isolated home directory so nothing touches the
// real ~/.claude or ~/.codex on this host.
func tempHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, ".local", "share"))
	return home
}

func TestClaudeSettingsWriteReadReset(t *testing.T) {
	home := tempHome(t)
	params := Params{BaseURL: "http://127.0.0.1:20128", APIKey: "sk-test", Model: "cc/sonnet", Home: home}

	result, err := Install("claude", params)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if !result.Written {
		t.Fatalf("install did not report a write")
	}

	blob, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(blob, &doc); err != nil {
		t.Fatalf("settings is not JSON: %v", err)
	}
	env, _ := doc["env"].(map[string]any)
	if got := env["ANTHROPIC_BASE_URL"]; got != "http://127.0.0.1:20128/v1" {
		t.Fatalf("base url = %v, want /v1 suffix", got)
	}
	if got := env["ANTHROPIC_AUTH_TOKEN"]; got != "sk-test" {
		t.Fatalf("token = %v", got)
	}
	if got := env["ANTHROPIC_DEFAULT_SONNET_MODEL"]; got != "cc/sonnet" {
		t.Fatalf("model = %v", got)
	}

	status, err := StatusOf("claude", params)
	if err != nil || !status.Configured {
		t.Fatalf("status configured = %v (%v)", status.Configured, err)
	}

	if _, err := Reset("claude", params); err != nil {
		t.Fatalf("reset: %v", err)
	}
	status, _ = StatusOf("claude", params)
	if status.Configured {
		t.Fatalf("still configured after reset")
	}
}

func TestClaudePreservesForeignKeys(t *testing.T) {
	home := tempHome(t)
	target := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	seed := `{"model":"opus","permissions":{"allow":["Bash"]},"env":{"KEEP":"me"}}`
	if err := os.WriteFile(target, []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Install("claude", Params{BaseURL: "http://localhost:20128", APIKey: "sk-x", Model: "m", Home: home}); err != nil {
		t.Fatalf("install: %v", err)
	}

	doc, err := readJSONFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if doc["model"] != "opus" {
		t.Fatalf("clobbered foreign key model: %v", doc["model"])
	}
	permissions, _ := doc["permissions"].(map[string]any)
	if permissions == nil {
		t.Fatalf("clobbered permissions block")
	}
	env, _ := doc["env"].(map[string]any)
	if env["KEEP"] != "me" {
		t.Fatalf("dropped unrelated env var")
	}

	backup := target + ".xrouter.bak"
	if _, err := os.Stat(backup); err != nil {
		t.Fatalf("no backup written: %v", err)
	}
}

func TestCorruptConfigIsRefused(t *testing.T) {
	home := tempHome(t)
	target := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("{ not json"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Install("claude", Params{BaseURL: "http://x", APIKey: "k", Model: "m", Home: home}); err == nil {
		t.Fatalf("expected refusal on unparseable config")
	}
	blob, _ := os.ReadFile(target)
	if !strings.Contains(string(blob), "not json") {
		t.Fatalf("handler overwrote a corrupt file instead of refusing")
	}
}

func TestCodexTomlSection(t *testing.T) {
	home := tempHome(t)
	target := filepath.Join(home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	seed := "approval_policy = \"never\"\n\n[history]\npersistence = \"save-all\"\n"
	if err := os.WriteFile(target, []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Install("codex", Params{BaseURL: "http://127.0.0.1:20128", APIKey: "sk-abc", Model: "cx/gpt-5", Home: home}); err != nil {
		t.Fatalf("install: %v", err)
	}

	blob, _ := os.ReadFile(target)
	text := string(blob)
	for _, want := range []string{
		"[model_providers.xrouter]",
		`base_url = "http://127.0.0.1:20128/v1"`,
		`Authorization = "Bearer sk-abc"`,
		"approval_policy",
		"[history]",
		`model = "cx/gpt-5"`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("config missing %q\n%s", want, text)
		}
	}
	if strings.Count(text, "[model_providers.xrouter]") != 1 {
		t.Fatalf("section written more than once:\n%s", text)
	}

	if _, err := Install("codex", Params{BaseURL: "http://127.0.0.1:20128", APIKey: "sk-abc", Model: "cx/gpt-5", Home: home}); err != nil {
		t.Fatal(err)
	}
	blob, _ = os.ReadFile(target)
	if strings.Count(string(blob), "[model_providers.xrouter]") != 1 {
		t.Fatalf("re-install duplicated the section:\n%s", blob)
	}

	if _, err := Reset("codex", Params{Home: home}); err != nil {
		t.Fatalf("reset: %v", err)
	}
	blob, _ = os.ReadFile(target)
	if strings.Contains(string(blob), "model_providers.xrouter") {
		t.Fatalf("section survived reset:\n%s", blob)
	}
	if !strings.Contains(string(blob), "approval_policy") {
		t.Fatalf("reset dropped unrelated keys:\n%s", blob)
	}
}

func TestProviderMapTools(t *testing.T) {
	for _, id := range []string{"crush", "smelt", "openclaw", "pi", "droid"} {
		t.Run(id, func(t *testing.T) {
			home := tempHome(t)
			if _, err := Install(id, Params{BaseURL: "http://127.0.0.1:20128", APIKey: "sk-m", Model: "openai/gpt-5", Home: home}); err != nil {
				t.Fatalf("install: %v", err)
			}
			status, err := StatusOf(id, Params{Home: home})
			if err != nil {
				t.Fatalf("status: %v", err)
			}
			if !status.Configured {
				t.Fatalf("%s not configured after install (path %s)", id, status.Path)
			}
			if _, err := Reset(id, Params{Home: home}); err != nil {
				t.Fatalf("reset: %v", err)
			}
			status, _ = StatusOf(id, Params{Home: home})
			if status.Configured {
				t.Fatalf("%s still configured after reset", id)
			}
		})
	}
}

func TestOpencodeShape(t *testing.T) {
	home := tempHome(t)
	if _, err := Install("opencode", Params{BaseURL: "http://127.0.0.1:20128", APIKey: "sk-o", Model: "openai/gpt-5", Home: home}); err != nil {
		t.Fatalf("install: %v", err)
	}
	doc, err := readJSONFile(filepath.Join(home, ".config", "opencode", "opencode.json"))
	if err != nil {
		t.Fatal(err)
	}
	providers, _ := doc["provider"].(map[string]any)
	entry, _ := providers["xrouter"].(map[string]any)
	if entry == nil {
		t.Fatalf("no xrouter provider block: %v", doc)
	}
	options, _ := entry["options"].(map[string]any)
	if options["baseURL"] != "http://127.0.0.1:20128/v1" {
		t.Fatalf("baseURL = %v", options["baseURL"])
	}
	if doc["model"] != "xrouter/openai/gpt-5" {
		t.Fatalf("default model = %v", doc["model"])
	}
}

func TestAllStatusesCoversRegistry(t *testing.T) {
	home := tempHome(t)
	statuses := AllStatuses(Params{Home: home})
	if len(statuses) != len(Tools) {
		t.Fatalf("statuses = %d, tools = %d", len(statuses), len(Tools))
	}
	for id, status := range statuses {
		if status.Error != "" && status.Path != "" {
			continue // unreadable file is reported, not fatal
		}
		if status.Configured {
			t.Fatalf("%s reported configured on an empty home", id)
		}
	}
}
