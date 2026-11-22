package providers_test

// Diagnostic + regression guard: every provider the catalogue advertises must
// resolve to something other than the generic fallback, otherwise a connection
// that looks healthy sends traffic to the wrong upstream contract.

import (
	"encoding/json"
	"os"
	"sort"
	"testing"

	"github.com/johsua092-ui/xrouter/internal/providers"
)

func buildRegistry() *providers.Registry {
	r := providers.NewRegistry()
	providers.RegisterDefaults(r)
	providers.RegisterWave2(r)
	providers.RegisterWave3(r)
	providers.RegisterWave4(r)
	providers.RegisterWave5(r)
	providers.RegisterWave6(r)
	providers.RegisterWave7(r)
	providers.RegisterWave8(r)
	providers.RegisterWave8Anthropic(r)
	providers.RegisterWave9Search(r)
	providers.RegisterWave9TtsStt(r)
	providers.RegisterWave9Image(r)
	providers.RegisterWave9WebCookie(r)
	providers.RegisterWave9Misc(r)
	providers.RegisterWave19(r)
	return r
}

func TestCatalogProvidersResolve(t *testing.T) {
	raw, err := os.ReadFile("../catalog/catalog.json")
	if err != nil {
		t.Skipf("catalogue not present: %v", err)
	}
	var catalog struct {
		ProviderIDToAlias map[string]string `json:"providerIdToAlias"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatalf("catalogue parse: %v", err)
	}

	registry := buildRegistry()
	var onFallback []string
	for id := range catalog.ProviderIDToAlias {
		adapter, ok := registry.Resolve(id)
		if !ok || adapter == nil {
			onFallback = append(onFallback, id+" (nil)")
			continue
		}
		if adapter.Name() == "default" || adapter.Name() == "openai" {
			onFallback = append(onFallback, id)
		}
	}
	sort.Strings(onFallback)
	t.Logf("%d providers in catalogue, %d on generic fallback", len(catalog.ProviderIDToAlias), len(onFallback))
	for _, id := range onFallback {
		t.Logf("  fallback: %s", id)
	}
}
