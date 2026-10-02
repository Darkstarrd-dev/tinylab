package registry

import (
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/keystate"
)

// Regression 2026-10-02: the jethub/webhub bridges used to refresh their
// bridged provider via DeleteProvider+AddProvider. DeleteProvider fires the
// stale-reference sweep, and during that window the provider is absent — so
// every {prefix}/{model} combo/quickslot ref was wiped at every startup sync
// (the user's combo lost its FreeHub model after an app restart).
// UpsertProvider is the refresh path and must NOT sweep.

func TestUpsertProviderReplacesInPlaceWithoutSweep(t *testing.T) {
	r := New(sweepTestConfig())
	// Seed a keystate for the old key so survival across the refresh is
	// observable.
	r.states["p1/k1"] = &keystate.KeyRuntimeState{
		ModelLocks:  map[string]time.Time{},
		ModelStatus: map[string]string{},
		ModelErrors: map[string]string{},
	}

	fresh := config.Provider{
		ID: "p1", Name: "P1", Prefix: "p1", BaseURL: "https://example.com", IsActive: true,
		Keys: []config.Key{
			{ID: "k2", Key: "new", IsActive: true}, // k1 vanishes, k2 appears
		},
		Models: []config.ModelDef{{ID: "m1"}, {ID: "m2", Alias: "fast"}}, // same model surface
	}
	r.UpsertProvider(fresh)

	p, ok := r.GetProvider("p1")
	if !ok {
		t.Fatal("p1 missing after upsert")
	}
	if len(p.Models) != 2 || len(p.Keys) != 1 || p.Keys[0].ID != "k2" {
		t.Fatalf("provider not replaced in place: keys=%d models=%d", len(p.Keys), len(p.Models))
	}
	if _, ok := r.GetProvider("p2"); !ok {
		t.Fatal("p2 must be untouched")
	}

	// The regression core: combo/quickslot refs survive a refresh.
	c, _ := r.GetComboByID("c1")
	if len(c.Models) != 5 {
		t.Fatalf("combo models = %v, want untouched (no sweep on refresh)", c.Models)
	}
	qs, _ := r.GetQuickSlot("q1")
	if len(qs.Models) != 4 || qs.SelectedIndex != 1 {
		t.Fatalf("quickslot = %v (sel %d), want untouched", qs.Models, qs.SelectedIndex)
	}

	// Keystate reconciliation: k1 state kept? No — k1 is gone from the fresh
	// provider, its state must be dropped; k2 must be initialized.
	if _, exists := r.states["p1/k1"]; exists {
		t.Fatal("keystate of the vanished key must be dropped")
	}
	if ks, exists := r.states["p1/k2"]; !exists || ks.ModelLocks == nil {
		t.Fatal("new key must get initialized keystate")
	}
}

func TestUpsertProviderInsertsWhenAbsent(t *testing.T) {
	r := New(sweepTestConfig())
	p := config.Provider{
		ID: "p9", Name: "P9", Prefix: "p9", BaseURL: "https://example.net", IsActive: true,
		Keys:   []config.Key{{ID: "k9", Key: "x", IsActive: true}},
		Models: []config.ModelDef{{ID: "m9"}},
	}
	r.UpsertProvider(p)
	if got, ok := r.GetProvider("p9"); !ok || got.Prefix != "p9" {
		t.Fatalf("p9 not inserted: ok=%v", ok)
	}
	if _, exists := r.states["p9/k9"]; !exists {
		t.Fatal("inserted provider key must get keystate")
	}
}

func TestUpsertProviderKeepsSurvivingKeyState(t *testing.T) {
	r := New(sweepTestConfig())
	r.states["p1/k1"] = &keystate.KeyRuntimeState{
		ModelLocks:  map[string]time.Time{"m1": time.Unix(123, 0).UTC()},
		ModelStatus: map[string]string{},
		ModelErrors: map[string]string{},
	}
	fresh := sweepTestConfig().Providers[0]
	fresh.Keys = []config.Key{{ID: "k1", Key: "same-key", IsActive: true}}
	r.UpsertProvider(fresh)
	ks, ok := r.states["p1/k1"]
	if !ok {
		t.Fatal("surviving key must keep its keystate")
	}
	if _, locked := ks.ModelLocks["m1"]; !locked {
		t.Fatal("surviving key runtime state (cooldown/lock) must be preserved")
	}
}
