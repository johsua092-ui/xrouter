package catalog

import "testing"

func TestCatalogLoadsEveryProviderAndModel(t *testing.T) {
	c := MustLoad()

	if len(c.ProviderIDs()) < 140 {
		t.Fatalf("expected at least 140 providers, got %d", len(c.ProviderIDs()))
	}

	total := 0
	for _, id := range c.ProviderIDs() {
		total += len(c.Models(AliasOf(c.Providers[id])))
	}
	if total < 1000 {
		t.Fatalf("expected at least 1000 models, got %d", total)
	}
}

func TestAliasResolvesToProvider(t *testing.T) {
	c := MustLoad()

	// "oc" is the short alias clients put in front of a model id; the catalogue
	// has to map it back to the provider that owns the credentials.
	id := c.ResolveID("oc")
	if id == "" {
		t.Fatal("alias oc did not resolve")
	}
	if id != "opencode" && id != "opencode-zen" {
		t.Fatalf("alias oc resolved to unexpected provider %q", id)
	}
	if again := c.ResolveID(id); again != id {
		t.Fatalf("canonical id %q did not round-trip: got %q", id, again)
	}
}

func TestModelLookupFindsProviderAndKind(t *testing.T) {
	c := MustLoad()

	var want string
	for _, id := range c.ProviderIDs() {
		alias := AliasOf(c.Providers[id])
		models := c.Models(alias)
		if len(models) > 0 {
			want = alias + "/" + models[0].ID
			break
		}
	}
	if want == "" {
		t.Fatal("catalogue has no models")
	}

	model, provider, ok := c.Model(want)
	if !ok {
		t.Fatalf("lookup failed for %q", want)
	}
	if model.ID == "" {
		t.Fatal("lookup returned an empty model id")
	}
	if provider.ID == "" {
		t.Fatal("lookup returned an empty provider")
	}
}

func TestKindOfDefaultsToLLM(t *testing.T) {
	c := MustLoad()
	for _, id := range c.ProviderIDs() {
		alias := AliasOf(c.Providers[id])
		for _, m := range c.Models(alias) {
			if kind := KindOf(m); kind == "" {
				t.Fatalf("model %s/%s has no kind", alias, m.ID)
			}
			return
		}
	}
}

func TestMediaDescriptorsSurviveGeneration(t *testing.T) {
	c := MustLoad()

	// TTS providers are the widest media set in the registry; if the generator
	// stops copying config objects this silently empties out.
	tts := 0
	for _, id := range c.ProviderIDs() {
		if c.Providers[id].Media["ttsConfig"] != nil {
			tts++
		}
	}
	if tts < 10 {
		t.Fatalf("expected at least 10 TTS providers in the catalogue, got %d", tts)
	}
}
