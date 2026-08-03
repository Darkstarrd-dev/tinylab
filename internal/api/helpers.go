package api

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

// saveConfig persists the given config to disk via config.Save. It performs no
// registry reload and is used by handlers whose in-memory changes do not need to
// be re-applied to the running registry (e.g. plain CRUD persistence).
func (rt *Router) saveConfig(cfg *config.Config) error {
	return config.Save(rt.configPath, cfg)
}

// saveConfigAndReload persists the given config to disk and then reloads it into
// the registry so the running proxy/rotation state reflects the saved changes.
// It is the single convergence point for the "modify cfg -> Save -> Reload"
// pattern that previously repeated across the per-domain CRUD handlers.
func (rt *Router) saveConfigAndReload(cfg *config.Config) error {
	if err := config.Save(rt.configPath, cfg); err != nil {
		return err
	}
	rt.reg.Reload(cfg)
	return nil
}

// writeAPIError writes a JSON error envelope with the given HTTP status.
func writeAPIError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// checkPortAvailable tests whether a TCP port can be bound on 127.0.0.1.
func checkPortAvailable(port int) error {
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("port %d is not available: %w", port, err)
	}
	ln.Close()
	return nil
}

// getIntQuery reads an integer query parameter with a default fallback.
func (rt *Router) getIntQuery(r *http.Request, key string, defaultVal int) int {
	valStr := r.URL.Query().Get(key)
	if valStr == "" {
		return defaultVal
	}
	val, err := strconv.Atoi(valStr)
	if err != nil || val < 0 {
		return defaultVal
	}
	return val
}

var idCounter int64

// generateID returns a process-unique ID with the given prefix, encoded in
// base36. SyncIDCounter must be called at startup so the counter starts above
// the highest existing ID and avoids collisions across restarts.
func generateID(prefix string) string {
	// Delegate to apibase so all ID generation shares a single counter.
	return apibase.GenerateID(prefix)
}

// SyncIDCounter scans existing IDs in the config and advances idCounter past
// the highest numeric suffix found for each prefix. This must be called once
// at startup, after config is loaded, to prevent ID collisions after restart.
func SyncIDCounter(cfg *config.Config) {
	// Delegated to apibase; kept for backward compatibility.
	apibase.SyncIDCounter(cfg)
}

// firstActiveKey returns the first active key for a provider, or nil if none found.
func firstActiveKey(provider *config.Provider) *config.Key {
	for i := range provider.Keys {
		if provider.Keys[i].IsActive {
			return &provider.Keys[i]
		}
	}
	return nil
}
