package rotation

import (
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/tinylab/tinylab/internal/config"
)

// QuotaSnapshot holds rate-limit info extracted from response headers.
type QuotaSnapshot struct {
	ModelLimit      int
	ModelRemaining  int
	GlobalLimit     int
	GlobalRemaining int
}

// HasQuota returns true if any rate-limit info was found.
func (q *QuotaSnapshot) HasQuota() bool {
	return q != nil && (q.ModelLimit > 0 || q.GlobalLimit > 0)
}

// ModelExhausted returns true if the per-model quota is depleted.
func (q *QuotaSnapshot) ModelExhausted() bool {
	return q != nil && q.ModelLimit > 0 && q.ModelRemaining == 0
}

// RatelimitAdapter extracts quota info from upstream response headers.
type RatelimitAdapter interface {
	ParseHeaders(headers http.Header) *QuotaSnapshot
}

// ModelScopeAdapter parses Modelscope-Ratelimit-* headers.
type ModelScopeAdapter struct{}

func (a *ModelScopeAdapter) ParseHeaders(headers http.Header) *QuotaSnapshot {
	if headers.Get("Modelscope-Ratelimit-Requests-Limit") == "" &&
		headers.Get("Modelscope-Ratelimit-Model-Requests-Limit") == "" {
		return nil
	}
	return &QuotaSnapshot{
		ModelLimit:      atoiSafe(headers.Get("Modelscope-Ratelimit-Model-Requests-Limit")),
		ModelRemaining:  atoiSafe(headers.Get("Modelscope-Ratelimit-Model-Requests-Remaining")),
		GlobalLimit:     atoiSafe(headers.Get("Modelscope-Ratelimit-Requests-Limit")),
		GlobalRemaining: atoiSafe(headers.Get("Modelscope-Ratelimit-Requests-Remaining")),
	}
}

// NoopAdapter is the default adapter for providers without rate-limit headers.
type NoopAdapter struct{}

func (a *NoopAdapter) ParseHeaders(headers http.Header) *QuotaSnapshot {
	return nil
}

// adapterRegistry maps provider base URL patterns to adapters.
var adapterRegistry = struct {
	mu      sync.RWMutex
	entries map[string]RatelimitAdapter
}{
	entries: map[string]RatelimitAdapter{},
}

func init() {
	adapterRegistry.entries["modelscope.cn"] = &ModelScopeAdapter{}
}

// GetAdapter returns the appropriate adapter for a provider.
func GetAdapter(p config.Provider) RatelimitAdapter {
	adapterRegistry.mu.RLock()
	defer adapterRegistry.mu.RUnlock()
	for pattern, adapter := range adapterRegistry.entries {
		if strings.Contains(strings.ToLower(p.BaseURL), pattern) {
			return adapter
		}
	}
	return &NoopAdapter{}
}

func atoiSafe(s string) int {
	v, _ := strconv.Atoi(strings.TrimSpace(s))
	return v
}
