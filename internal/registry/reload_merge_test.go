package registry

import (
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/config"
)

// TestReload_MergesStates verifies that Reload preserves runtime state for
// keys that remain in the config (instead of rebuilding all states from
// scratch as was the pre-P2.1 behavior).
func TestReload_MergesStates(t *testing.T) {
	cfg := &config.Config{
		Providers: []config.Provider{
			{
				ID: "p1", Name: "P1", Prefix: "p1", BaseURL: "https://example.com",
				IsActive: true,
				Keys: []config.Key{
					{ID: "k1", Key: "sk-1", Name: "K1", IsActive: true},
					{ID: "k2", Key: "sk-2", Name: "K2", IsActive: true},
				},
			},
		},
	}
	r := New(cfg)

	// Simulate k1 being cooled down on model "gpt-4".
	ks1 := r.GetKeyState("p1", "k1")
	if ks1 == nil {
		t.Fatal("expected k1 state to exist")
	}
	ks1.Lock()
	ks1.ModelLocks["gpt-4"] = time.Now().Add(60 * time.Second)
	ks1.ModelStatus["gpt-4"] = "cooldown"
	ks1.BackoffLevel = 2
	ks1.Unlock()

	// Reload with the same key set + a new key k3 + removal of k2.
	cfg2 := &config.Config{
		Providers: []config.Provider{
			{
				ID: "p1", Name: "P1", Prefix: "p1", BaseURL: "https://example.com",
				IsActive: true,
				Keys: []config.Key{
					{ID: "k1", Key: "sk-1", Name: "K1", IsActive: true},
					{ID: "k3", Key: "sk-3", Name: "K3", IsActive: true},
				},
			},
		},
	}
	r.Reload(cfg2)

	// k1 runtime state must be preserved.
	ks1Again := r.GetKeyState("p1", "k1")
	if ks1Again == nil {
		t.Fatal("k1 state lost after Reload")
	}
	ks1Again.Lock()
	defer ks1Again.Unlock()
	if ks1Again.BackoffLevel != 2 {
		t.Errorf("BackoffLevel = %d, want 2 (preserved)", ks1Again.BackoffLevel)
	}
	if _, ok := ks1Again.ModelLocks["gpt-4"]; !ok {
		t.Errorf("ModelLocks[gpt-4] lost after Reload (merge semantics broken)")
	}

	// k2 (removed from config) state must be gone.
	if ks2 := r.GetKeyState("p1", "k2"); ks2 != nil {
		t.Errorf("k2 state should be removed after Reload, got %v", ks2)
	}

	// k3 (newly added) must have a fresh empty state.
	ks3 := r.GetKeyState("p1", "k3")
	if ks3 == nil {
		t.Fatal("k3 state should be initialized (fresh state)")
	}
	ks3.Lock()
	defer ks3.Unlock()
	if len(ks3.ModelLocks) != 0 || ks3.BackoffLevel != 0 {
		t.Errorf("k3 should have empty runtime state, got locks=%d backoff=%d", len(ks3.ModelLocks), ks3.BackoffLevel)
	}
}
