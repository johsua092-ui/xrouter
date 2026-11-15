package providers

// Devin MCP config bridge.
//
// Devin discovers MCP servers from a config file in its own directory, not only
// from the `mcpServers` array on session/new. The Node executor proves this:
// it merges the servers into devin's real config, runs the turn, then removes
// exactly the entries it added, leaving any pre-existing ones alone.
//
// The Go executor uses an isolated config home instead. Pointing devin at a
// throwaway directory via XDG_CONFIG_HOME means the user's own config is never
// read, never written, and cannot be corrupted by a gateway request — the merge
// and careful undo the Node executor performs are replaced by the file simply
// not existing afterwards.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// devinMCPEnv returns the environment overrides for a subprocess running against
// an isolated config home. With an empty home, nothing is overridden and devin
// uses its normal config.
func devinMCPEnv(home string) []string {
	if home == "" {
		return nil
	}
	return []string{"XDG_CONFIG_HOME=" + home}
}

// devinWriteMCPConfig writes client-declared MCP servers into an isolated devin
// config directory and returns that directory plus a cleanup function.
//
// An empty server list is normal: the client has no tools, so the turn runs
// without any, and no directory is created at all.
func devinWriteMCPConfig(body []byte) (string, func(), error) {
	servers := devinMCPFromBody(body)
	if len(servers) == 0 {
		return "", nil, nil
	}

	home, err := os.MkdirTemp("", "xrouter-devin-config-")
	if err != nil {
		return "", nil, fmt.Errorf("devin: create isolated config home: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(home) }

	// devin reads its config from a platform-specific subdirectory.
	var configDir string
	switch runtime.GOOS {
	case "darwin":
		configDir = filepath.Join(home, "devin")
	case "windows":
		configDir = filepath.Join(home, "devin")
	default:
		configDir = filepath.Join(home, "devin")
	}
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("devin: create config dir: %w", err)
	}

	config := map[string]any{"mcpServers": servers}
	encoded, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		cleanup()
		return "", nil, fmt.Errorf("devin: encode MCP config: %w", err)
	}

	path := filepath.Join(configDir, "config.json")
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("devin: write MCP config: %w", err)
	}
	return home, cleanup, nil
}

// devinMCPFromBody collects MCP server declarations from the request.
//
// Clients announce tools in one of three places: an OpenAI `mcp_servers` array,
// a `tools` array of function definitions, or the Responses API `tools` shape.
// All three are read so a client that only sends `tools` still gets its tools
// exposed to the agent rather than a silent no-tool turn.
func devinMCPFromBody(body []byte) []map[string]any {
	var parsed struct {
		MCPServers []struct {
			Command string            `json:"command"`
			Args    []string          `json:"args"`
			Env     map[string]string `json:"env"`
			Name    string            `json:"name"`
			URL     string            `json:"url"`
		} `json:"mcp_servers"`
		Tools []struct {
			Type     string `json:"type"`
			Function struct {
				Name string `json:"name"`
			} `json:"function"`
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil
	}

	var servers []map[string]any

	for _, s := range parsed.MCPServers {
		entry := map[string]any{}
		if s.Name != "" {
			entry["name"] = s.Name
		}
		if s.Command != "" {
			entry["command"] = s.Command
			if len(s.Args) > 0 {
				entry["args"] = s.Args
			}
			if len(s.Env) > 0 {
				entry["env"] = s.Env
			}
		} else if s.URL != "" {
			entry["url"] = s.URL
		}
		if len(entry) > 0 {
			servers = append(servers, entry)
		}
	}

	// A `tools` list is not an MCP server list, but a client that sends only
	// tools still needs the agent to be able to call them. The tool names are
	// recorded so the turn can surface a matching call; the bridge to real
	// execution is the client's responsibility, exactly as in the Node
	// executor, which forwards the call back over the API.
	if len(servers) == 0 {
		var names []string
		for _, t := range parsed.Tools {
			n := t.Function.Name
			if n == "" {
				n = t.Name
			}
			if n != "" {
				names = append(names, n)
			}
		}
		if len(names) > 0 {
			servers = append(servers, map[string]any{"_clientTools": names})
		}
	}
	return servers
}
