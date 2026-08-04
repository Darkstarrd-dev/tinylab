package settings

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/config"
)

// TestRotationPatchPreservesStatePersist guards the audit fix for the
// rotation PATCH endpoint: a partial rotation update (the 5 frontend-managed
// fields strategy/stickyLimit/maxRetries/retryDelaySec/backoffMaxSec) must
// never wipe RotationConfig.StatePersist/StatePath, which gate the
// state.Manager persistence layer (internal/app/app.go).
func TestRotationPatchPreservesStatePersist(t *testing.T) {
	var updates struct {
		Rotation *rotationPatch `json:"rotation"`
	}
	payload := `{"rotation":{"strategy":"failover","stickyLimit":5,"maxRetries":3,"retryDelaySec":5,"backoffMaxSec":300}}`
	if err := json.Unmarshal([]byte(payload), &updates); err != nil {
		t.Fatalf("decode PATCH payload: %v", err)
	}
	if updates.Rotation == nil {
		t.Fatal("rotation patch not decoded")
	}

	cfg := config.DefaultConfig()
	cfg.Rotation.StatePersist = true
	cfg.Rotation.StatePath = "state.yaml"

	applyRotationUpdates(cfg, updates.Rotation)

	if cfg.Rotation.Strategy != "failover" {
		t.Errorf("Strategy = %q, want failover", cfg.Rotation.Strategy)
	}
	if cfg.Rotation.StickyLimit != 5 || cfg.Rotation.MaxRetries != 3 ||
		cfg.Rotation.RetryDelaySec != 5 || cfg.Rotation.BackoffMaxSec != 300 {
		t.Errorf("rotation fields not applied: %+v", cfg.Rotation)
	}
	if !cfg.Rotation.StatePersist {
		t.Error("StatePersist was wiped by rotation PATCH")
	}
	if cfg.Rotation.StatePath != "state.yaml" {
		t.Errorf("StatePath = %q, want state.yaml (wiped by rotation PATCH)", cfg.Rotation.StatePath)
	}

	// Persistence round-trip: Save must keep StatePersist/StatePath on disk.
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := config.Save(path, cfg); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !loaded.Rotation.StatePersist {
		t.Error("StatePersist lost after Save/Load round-trip")
	}
	if loaded.Rotation.StatePath != "state.yaml" {
		t.Errorf("StatePath = %q after round-trip, want state.yaml", loaded.Rotation.StatePath)
	}
}

// TestRotationPatchPartialUpdate verifies a single-field patch leaves the
// other rotation fields (and StatePersist) at their existing values.
func TestRotationPatchPartialUpdate(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Rotation.Strategy = "sticky"
	cfg.Rotation.StickyLimit = 42
	cfg.Rotation.StatePersist = true

	applyRotationUpdates(cfg, &rotationPatch{Strategy: strPtr("round-robin")})

	if cfg.Rotation.Strategy != "round-robin" {
		t.Errorf("Strategy = %q, want round-robin", cfg.Rotation.Strategy)
	}
	if cfg.Rotation.StickyLimit != 42 {
		t.Errorf("StickyLimit = %d, want 42 (untouched)", cfg.Rotation.StickyLimit)
	}
	if !cfg.Rotation.StatePersist {
		t.Error("StatePersist wiped by single-field patch")
	}
}

// TestThemePatchPersistsStyle verifies that a partial theme PATCH updates the
// style dimension without wiping the other persisted theme preferences.
func TestThemePatchPersistsStyle(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Theme.DarkVariant = "dracula"
	cfg.Theme.LightVariant = "cream"
	cfg.Theme.Style = "default"

	applyThemeUpdates(cfg, &config.ThemeConfig{Style: "soft"})

	if cfg.Theme.Style != "soft" {
		t.Errorf("Style = %q, want soft", cfg.Theme.Style)
	}
	if cfg.Theme.DarkVariant != "dracula" {
		t.Errorf("DarkVariant = %q, want dracula", cfg.Theme.DarkVariant)
	}
	if cfg.Theme.LightVariant != "cream" {
		t.Errorf("LightVariant = %q, want cream", cfg.Theme.LightVariant)
	}
}

func strPtr(s string) *string { return &s }
