package cache

import (
	"sync"
	"time"
)

// TTLMap is a bounded in-memory key/value cache with per-entry expiry.
//
// The gateway needs a few of these (affinity bindings, alias lookups, provider
// health windows). They all want the same three properties and nothing more:
// concurrent access, expiry, and a hard ceiling so a hostile or merely busy
// client cannot grow the map without bound. A generic implementation keeps those
// three rules in one place instead of re-derived per call site.
type TTLMap[V any] struct {
	mu    sync.Mutex
	items map[string]ttlItem[V]
	// ttl is the default lifetime for entries stored without an explicit one.
	ttl time.Duration
	// maxItems is the ceiling; 0 means MaxAffinityEntries.
	maxItems int
	now      func() time.Time
}

type ttlItem[V any] struct {
	value     V
	expiresAt time.Time
}

// NewTTLMap builds a cache with a default lifetime and an entry ceiling.
func NewTTLMap[V any](ttl time.Duration, maxItems int) *TTLMap[V] {
	if ttl <= 0 {
		ttl = DefaultCacheTTL
	}
	if maxItems <= 0 {
		maxItems = MaxAffinityEntries
	}
	return &TTLMap[V]{
		items:    make(map[string]ttlItem[V]),
		ttl:      ttl,
		maxItems: maxItems,
		now:      time.Now,
	}
}

// Get returns the value and whether it was live. An expired entry is removed on
// read rather than merely reported missing, so memory reflects liveness.
func (m *TTLMap[V]) Get(key string) (V, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var zero V
	it, ok := m.items[key]
	if !ok {
		return zero, false
	}
	if !m.now().Before(it.expiresAt) {
		delete(m.items, key)
		return zero, false
	}
	return it.value, true
}

// Set stores a value with the map's default lifetime.
func (m *TTLMap[V]) Set(key string, value V) {
	m.SetTTL(key, value, m.ttl)
}

// SetTTL stores a value with an explicit lifetime, for entries whose correct
// window is not the map default.
func (m *TTLMap[V]) SetTTL(key string, value V, ttl time.Duration) {
	if key == "" {
		return
	}
	if ttl <= 0 {
		ttl = m.ttl
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	m.evictIfFullLocked()
	m.items[key] = ttlItem[V]{value: value, expiresAt: m.now().Add(ttl)}
}

// Delete removes a key.
func (m *TTLMap[V]) Delete(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.items, key)
}

// Len reports the current entry count.
func (m *TTLMap[V]) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.items)
}

// Sweep drops expired entries, returning how many were removed.
func (m *TTLMap[V]) Sweep() int {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := m.now()
	dropped := 0
	for k, it := range m.items {
		if !now.Before(it.expiresAt) {
			delete(m.items, k)
			dropped++
		}
	}
	return dropped
}

// evictIfFullLocked makes room when at capacity. Callers must hold the mutex.
func (m *TTLMap[V]) evictIfFullLocked() {
	if len(m.items) < m.maxItems {
		return
	}

	// An expired entry is the cheapest thing to lose, so prefer one of those.
	now := m.now()
	for k, it := range m.items {
		if !now.Before(it.expiresAt) {
			delete(m.items, k)
			return
		}
	}
	// Otherwise drop one arbitrary entry. Map iteration order is randomised, so
	// there is no deterministic "oldest" to find without extra bookkeeping; an
	// eviction only costs a refill, which is cheaper than the bookkeeping.
	for k := range m.items {
		delete(m.items, k)
		return
	}
}
