// Package catalog is the Go view of the Node provider/model catalogue.
//
// The Node engine keeps ~150 providers and ~1400 models in JavaScript
// (open-sse/config/providerModels.js plus src/shared/constants/providers.js).
// Re-typing that list in Go would guarantee drift on the next Node commit, so
// the Go core embeds a generated JSON artifact instead: scripts/gen-catalog.mjs
// dumps the same modules to internal/catalog/catalog.json, and this package
// loads it once at startup.
//
// Regenerate after a Node catalogue change:
//
//	node scripts/gen-catalog.mjs && go build ./...
package catalog

import (
	_ "embed"
	"encoding/json"
	"sort"
	"strings"
	"sync"
)

//go:embed catalog.json
var raw []byte

// Model is one catalogue entry. Only the fields a routing decision needs are
// captured; provider-specific extras survive in Extras so an endpoint that
// advertises capabilities does not have to be edited when the Node side grows a
// new one.
type Model struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
	// Params, Capabilities, Options and Dimensions are loose on purpose: the
	// Node catalogue mixes objects, string arrays and booleans in these slots
	// (capabilities is a map for some models and a list for others), and a
	// typed field here would fail the whole load on one odd entry.
	Params        []any    `json:"params"`
	Capabilities  any      `json:"capabilities"`
	Options       any      `json:"options"`
	Dimensions    any      `json:"dimensions"`
	ContextWindow any      `json:"contextWindow"`
	UpstreamID    string   `json:"upstreamId"`
	Strip         []string `json:"strip"`
	QuotaFamily   string   `json:"quotaFamily"`
}

// SearchConfig is the subset of a provider's search descriptor the gateway
// advertises through /v1/models/info.
type SearchConfig struct {
	SearchTypes     []string `json:"searchTypes"`
	MaxMaxResults   int      `json:"maxMaxResults"`
	RequiredOptions []string `json:"requiredOptions"`
}

// TTSConfig is the config-driven TTS dispatcher descriptor.
type TTSConfig struct {
	Format   string `json:"format"`
	BaseURL  string `json:"baseUrl"`
	AuthType string `json:"authType"`
}

// Provider is one catalogue provider.
type Provider struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Alias        string        `json:"alias"`
	BaseURL      string        `json:"baseUrl"`
	Kind         string        `json:"kind"`
	Passthrough  bool          `json:"passthroughModels"`
	NoAuth       bool          `json:"noAuth"`
	AuthType     string        `json:"authType"`
	SearchConfig *SearchConfig `json:"searchConfig"`
	TTSConfig    *TTSConfig    `json:"ttsConfig"`
	// Media holds every media descriptor the Node registry ships for this
	// provider — fetchConfig, sttConfig, embeddingConfig, imageConfig,
	// videoConfig, systemoneConfig, searchViaChat and friends — keyed by
	// descriptor name.
	//
	// It is a loose map on purpose. The Node side treats these as open-ended
	// config objects that gain fields over time, and the Go dispatcher is
	// config-driven: pinning a struct here would mean a new Node knob silently
	// disappears on the Go path instead of flowing through.
	Media map[string]map[string]any `json:"media"`
}

type artifact struct {
	GeneratedFrom     string              `json:"generatedFrom"`
	ProviderIDToAlias map[string]string   `json:"providerIdToAlias"`
	Providers         map[string]Provider `json:"providers"`
	Models            map[string][]Model  `json:"models"`
}

// Catalog is the loaded, indexed catalogue.
type Catalog struct {
	Providers     map[string]Provider
	byAlias       map[string]string  // alias → provider id
	modelsByAlias map[string][]Model // alias or provider id → models
	modelIndex    map[string]Model   // "alias/modelID" → model
	source        string
}

var (
	once     sync.Once
	instance *Catalog
	loadErr  error
)

// Load returns the process-wide catalogue, parsing the embedded artifact once.
func Load() (*Catalog, error) {
	once.Do(func() {
		instance, loadErr = parse(raw)
	})
	return instance, loadErr
}

// MustLoad is Load for call sites that cannot continue without a catalogue
// (the gateway at construction time).
func MustLoad() *Catalog {
	c, err := Load()
	if err != nil {
		panic("catalog: " + err.Error())
	}
	return c
}

func parse(data []byte) (*Catalog, error) {
	var a artifact
	if err := json.Unmarshal(data, &a); err != nil {
		return nil, err
	}
	c := &Catalog{
		Providers:     a.Providers,
		byAlias:       map[string]string{},
		modelsByAlias: map[string][]Model{},
		modelIndex:    map[string]Model{},
		source:        a.GeneratedFrom,
	}

	for id, p := range a.Providers {
		c.byAlias[id] = id
		if p.Alias != "" {
			// A provider's own alias never displaces an id that is itself a
			// provider key: Node has the same precedence rule.
			if _, taken := c.byAlias[p.Alias]; !taken {
				c.byAlias[p.Alias] = id
			}
		}
	}
	for key, v := range a.ProviderIDToAlias {
		if _, taken := c.byAlias[key]; !taken && v != "" {
			c.byAlias[key] = key
		}
	}

	for bucket, list := range a.Models {
		c.modelsByAlias[bucket] = list
		for _, m := range list {
			c.modelIndex[bucket+"/"+m.ID] = m
		}
	}
	return c, nil
}

// Source names the module the artifact was generated from.
func (c *Catalog) Source() string { return c.source }

// ResolveID maps an alias or provider id onto the canonical provider id.
func (c *Catalog) ResolveID(aliasOrID string) string {
	if id, ok := c.byAlias[aliasOrID]; ok {
		return id
	}
	return aliasOrID
}

// Provider returns a provider by id or alias.
func (c *Catalog) Provider(aliasOrID string) (Provider, bool) {
	p, ok := c.Providers[c.ResolveID(aliasOrID)]
	return p, ok
}

// Models returns the model list for a provider id or alias. The lookup order
// mirrors Node: alias bucket first, then provider id bucket.
func (c *Catalog) Models(aliasOrID string) []Model {
	if v, ok := c.modelsByAlias[aliasOrID]; ok {
		return v
	}
	return c.modelsByAlias[c.ResolveID(aliasOrID)]
}

// Model looks up a single "alias/modelID" entry.
func (c *Catalog) Model(fullID string) (Model, Provider, bool) {
	m, ok := c.modelIndex[fullID]
	if !ok {
		return Model{}, Provider{}, false
	}
	slash := strings.Index(fullID, "/")
	alias := fullID[:slash]
	p, _ := c.Provider(alias)
	return m, p, true
}

// ProviderIDs returns every provider id, sorted. Deterministic ordering matters
// for the listing endpoints: an unordered map walk would reshuffle the model
// list between requests and break client-side caches.
func (c *Catalog) ProviderIDs() []string {
	out := make([]string, 0, len(c.Providers))
	for id := range c.Providers {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// KindOf returns the model kind, defaulting the way Node's getModelKind does.
func KindOf(m Model) string {
	if m.Kind != "" {
		return m.Kind
	}
	return "llm"
}

// AliasOf returns the provider's display alias, falling back to its id.
func AliasOf(p Provider) string {
	if p.Alias != "" {
		return p.Alias
	}
	return p.ID
}
