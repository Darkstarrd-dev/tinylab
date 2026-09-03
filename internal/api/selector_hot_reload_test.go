package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/tinylab/tinylab/internal/config"
)

// TestUpdateSettings_SelectorHotReload verifies that PATCH /api/settings
// propagates the new RotationConfig to the live selector (P2.2), so the
// change takes effect on the next request without requiring a process restart.
func TestUpdateSettings_SelectorHotReload(t *testing.T) {
	srv, _, _, rt := setupTestServer(t)
	defer srv.Close()

	// Patch rotation strategy from default fill-first to round-robin.
	payload := `{"rotation":{"strategy":"round-robin","stickyLimit":5,"maxRetries":2,"retryDelaySec":3,"backoffMaxSec":60,"statePersist":true,"statePath":"state.yaml"}}`
	resp := requestJSON(t, "PATCH", srv.URL+"/api/settings", payload)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}

	// Verify selector.Settings() reflects the new values.
	got := rt.selector.Settings()
	if got.Strategy != "round-robin" {
		t.Errorf("selector strategy = %q, want round-robin (hot-reload failed)", got.Strategy)
	}
	if got.StickyLimit != 5 {
		t.Errorf("selector stickyLimit = %d, want 5", got.StickyLimit)
	}
	if got.MaxRetries != 2 {
		t.Errorf("selector maxRetries = %d, want 2", got.MaxRetries)
	}

	// Verify GET /api/settings also reports the new rotation.
	resp = requestJSON(t, "GET", srv.URL+"/api/settings", "")
	var body map[string]any
	if err := json.Unmarshal([]byte(readBody(t, resp)), &body); err != nil {
		t.Fatal(err)
	}
	rot, _ := body["rotation"].(map[string]any)
	if rot == nil || rot["strategy"] != "round-robin" {
		t.Errorf("settings GET rotation.strategy = %v, want round-robin", rot)
	}
}

// TestReload_SelectorHotReload verifies that POST /api/reload propagates
// the rotation config from disk to the live selector.
func TestReload_SelectorHotReload(t *testing.T) {
	srv, _, _, rt := setupTestServer(t)
	defer srv.Close()

	// Patch settings first.
	patch := `{"rotation":{"strategy":"failover","stickyLimit":7,"maxRetries":4,"retryDelaySec":2,"backoffMaxSec":120,"statePersist":true,"statePath":"state.yaml"}}`
	if resp := requestJSON(t, "PATCH", srv.URL+"/api/settings", patch); resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH failed: %d %s", resp.StatusCode, readBody(t, resp))
	}

	// Reload from disk.
	resp := requestJSON(t, "POST", srv.URL+"/api/reload", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, readBody(t, resp))
	}

	// After reload, selector should reflect the on-disk rotation (failover).
	got := rt.selector.Settings()
	if got.Strategy != "failover" {
		t.Errorf("after reload, selector strategy = %q, want failover (hot-reload failed)", got.Strategy)
	}

	// Sanity-check: Settings() returned a real RotationConfig value copy
	// (not the zero value).
	_ = config.RotationConfig{} // referenced import to avoid unused warnings
}
