package registry

import (
	"path/filepath"
	"testing"

	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/state"
)

// TestSnapshotRestore_RoundTripWithDelimiterIDs guards F-21: provider/key IDs
// containing '/' or '::' must survive a snapshot → restore round trip without
// colliding or being mis-split (the historical "::" ReplaceAll encoding was
// ambiguous).
func TestSnapshotRestore_RoundTripWithDelimiterIDs(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Providers = []config.Provider{
		{ID: "p/slash", Prefix: "ps", Keys: []config.Key{{ID: "k1"}, {ID: "k::2"}}},
		{ID: "p2", Prefix: "p2", Keys: []config.Key{{ID: "k/3"}}},
	}
	r := New(cfg)

	// Prime distinct runtime state on each key so a wrong split is detectable.
	prime := map[[2]string]int{
		{"p/slash", "k1"}:   3,
		{"p/slash", "k::2"}: 4,
		{"p2", "k/3"}:       5,
	}
	for ids, level := range prime {
		if ks := r.GetKeyState(ids[0], ids[1]); ks != nil {
			ks.Lock()
			ks.BackoffLevel = level
			ks.Unlock()
		}
	}

	snap := r.SnapshotKeyStates()
	if len(snap) != len(prime) {
		t.Fatalf("SnapshotKeyStates returned %d entries, want %d (delimiter IDs must not alias)", len(snap), len(prime))
	}
	// Structured identity fields must be present on every snapshot.
	for key, ks := range snap {
		if ks.ProviderID == "" || ks.KeyID == "" {
			t.Errorf("snapshot %q missing structured ProviderID/KeyID: %+v", key, ks)
		}
	}

	// Round trip through the state.Manager restore path (the same one used at
	// startup), which prefers the structured fields.
	manager := state.NewManager(filepath.Join(t.TempDir(), "state.yaml"), console.New(10),
		state.WithKeyStateProvider(nil, r.RestoreKeyState))
	s := &state.Snapshot{Version: state.CurrentVersion, Keys: make(map[string]*state.KeySnapshot, len(snap))}
	for k, v := range snap {
		ks := v
		s.Keys[k] = &ks
	}
	if err := manager.Restore(s); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	for ids, level := range prime {
		ks := r.GetKeyState(ids[0], ids[1])
		if ks == nil {
			t.Fatalf("key %v missing after restore", ids)
		}
		ks.Lock()
		got := ks.BackoffLevel
		ks.Unlock()
		if got != level {
			t.Errorf("key %v BackoffLevel = %d, want %d (state restored to wrong key)", ids, got, level)
		}
	}
}

// TestRestore_LegacyColonKeysStillWork guards backward compatibility: a
// state.yaml written by an older build (keys "providerID::keyID", no
// structured fields) must still restore.
func TestRestore_LegacyColonKeysStillWork(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Providers = []config.Provider{{ID: "p1", Prefix: "prov", Keys: []config.Key{{ID: "k1"}}}}
	r := New(cfg)

	legacy := &state.Snapshot{
		Version: 1,
		Keys: map[string]*state.KeySnapshot{
			"p1::k1": {BackoffLevel: 5},
		},
	}
	manager := state.NewManager(filepath.Join(t.TempDir(), "state.yaml"), console.New(10),
		state.WithKeyStateProvider(nil, r.RestoreKeyState))
	if err := manager.Restore(legacy); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	ks := r.GetKeyState("p1", "k1")
	if ks == nil {
		t.Fatal("key p1/k1 missing after legacy restore")
	}
	ks.Lock()
	got := ks.BackoffLevel
	ks.Unlock()
	if got != 5 {
		t.Errorf("BackoffLevel = %d, want 5", got)
	}
}

// TestProbeSnapshotRestore_DelimiterIDs guards F-21 for probe records: model
// IDs containing '::' must survive the probe snapshot → restore round trip.
func TestProbeSnapshotRestore_DelimiterIDs(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Providers = []config.Provider{{ID: "p/slash", Prefix: "ps", Models: []config.ModelDef{{ID: "m::1"}}}}
	r := New(cfg)

	r.UpdateProbeRecord("p/slash", "m::1", state.ProbeRecord{
		ProviderID:   "p/slash",
		ModelID:      "m::1",
		OpenAICompat: state.ProbeDetail{Ok: true, Status: 200, LatencyMs: 12},
	})

	probes := r.SnapshotProbeRecords()
	if len(probes) != 1 {
		t.Fatalf("SnapshotProbeRecords returned %d entries, want 1", len(probes))
	}
	for key, pr := range probes {
		_ = key // encoding is length-prefixed and unambiguous even when IDs contain '::'
		if pr.ProviderID != "p/slash" || pr.ModelID != "m::1" {
			t.Errorf("probe structured fields = %s/%s, want p/slash/m::1", pr.ProviderID, pr.ModelID)
		}
	}

	// Fresh registry + restore via the manager path (structured fields win).
	r2 := New(cfg)
	manager := state.NewManager(filepath.Join(t.TempDir(), "state.yaml"), console.New(10),
		state.WithProbeStateProvider(nil, r2.RestoreProbeRecord))
	s := &state.Snapshot{Version: state.CurrentVersion, Probes: probes}
	if err := manager.Restore(s); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	got := r2.GetProbeRecord("p/slash", "m::1")
	if got == nil {
		t.Fatal("probe missing after restore")
	}
	if !got.OpenAICompat.Ok {
		t.Errorf("probe detail not restored: %+v", got.OpenAICompat)
	}
}
