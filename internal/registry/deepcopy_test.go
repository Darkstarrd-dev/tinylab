package registry

import (
	"sync"
	"testing"

	"github.com/tinylab/tinylab/internal/config"
)

// TestConfigSnapshot_IsDeepCopy guards F-18: Config() must return a full deep
// copy. Mutating every slice/map in the returned snapshot must never affect
// the registry-owned config.
func TestConfigSnapshot_IsDeepCopy(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Providers = []config.Provider{
		{
			ID: "p1", Prefix: "prov", Name: "P",
			Keys:   []config.Key{{ID: "k1", Key: "sk-secret"}},
			Models: []config.ModelDef{{ID: "m1", QuotaType: "limited", Protocols: []string{"openai-compat"}}},
			CustomHeaders: map[string]string{
				"X-Custom": "v",
			},
			NIMConfig: &config.NIMSettings{RequestCountPerKey: 5},
		},
	}
	cfg.Combos = []config.Combo{{ID: "c1", Name: "c", Strategy: "round-robin", Models: []string{"prov/m1"}}}
	cfg.Shortcuts = config.ShortcutsConfig{"global.goto-monitor": {Key: "F5"}}
	cfg.TextReview.SplitPatterns = []config.SplitPattern{{Key: "zhang", Regex: "^第"}}

	r := New(cfg)
	snap := r.Config()

	// Mutate every slice/map reachable from the snapshot.
	snap.Providers[0].Keys[0].Key = "MUTATED"
	snap.Providers[0].Models[0].Protocols[0] = "MUTATED"
	snap.Providers[0].CustomHeaders["X-Custom"] = "MUTATED"
	snap.Providers[0].NIMConfig.RequestCountPerKey = 999
	snap.Combos[0].Models[0] = "MUTATED"
	snap.Shortcuts["global.goto-monitor"] = config.ShortcutBinding{Key: "F6"}
	snap.TextReview.SplitPatterns[0].Key = "MUTATED"

	got := r.Config()
	if got.Providers[0].Keys[0].Key != "sk-secret" {
		t.Errorf("key slice leaked through snapshot: %q", got.Providers[0].Keys[0].Key)
	}
	if got.Providers[0].Models[0].Protocols[0] != "openai-compat" {
		t.Errorf("model Protocols slice leaked through snapshot: %q", got.Providers[0].Models[0].Protocols[0])
	}
	if got.Providers[0].CustomHeaders["X-Custom"] != "v" {
		t.Errorf("CustomHeaders map leaked through snapshot: %q", got.Providers[0].CustomHeaders["X-Custom"])
	}
	if got.Providers[0].NIMConfig.RequestCountPerKey != 5 {
		t.Errorf("NIMConfig pointer leaked through snapshot: %d", got.Providers[0].NIMConfig.RequestCountPerKey)
	}
	if got.Combos[0].Models[0] != "prov/m1" {
		t.Errorf("Combo Models slice leaked through snapshot: %q", got.Combos[0].Models[0])
	}
	if got.Shortcuts["global.goto-monitor"].Key != "F5" {
		t.Errorf("Shortcuts map leaked through snapshot: %+v", got.Shortcuts["global.goto-monitor"])
	}
	if got.TextReview.SplitPatterns[0].Key != "zhang" {
		t.Errorf("SplitPatterns slice leaked through snapshot: %q", got.TextReview.SplitPatterns[0].Key)
	}
}

// TestConfigSnapshot_ConcurrentWithReload guards F-18 under the race
// detector: readers holding snapshots must never share mutable state with
// concurrent Reload/CRUD writers (run with -race).
func TestConfigSnapshot_ConcurrentWithReload(t *testing.T) {
	base := func() *config.Config {
		c := config.DefaultConfig()
		c.Providers = []config.Provider{
			{ID: "p1", Prefix: "prov", Name: "P1", Keys: []config.Key{{ID: "k1", Key: "sek"}}, Models: []config.ModelDef{{ID: "m1"}}},
		}
		c.Combos = []config.Combo{{ID: "c1", Name: "rr", Strategy: "round-robin", Models: []string{"prov/m1"}}}
		return c
	}
	r := New(base())

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				snap := r.Config()
				_ = snap.Providers
				_ = snap.Combos
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for j := 0; j < 100; j++ {
			r.Reload(base())
			r.Config()
		}
	}()
	wg.Wait()
}
