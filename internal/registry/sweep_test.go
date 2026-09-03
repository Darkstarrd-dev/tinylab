package registry

import (
	"testing"

	"github.com/tinylab/tinylab/internal/config"
)

func sweepTestConfig() *config.Config {
	return &config.Config{
		Providers: []config.Provider{
			{
				ID: "p1", Name: "P1", Prefix: "p1", BaseURL: "https://example.com", IsActive: true,
				Models: []config.ModelDef{{ID: "m1"}, {ID: "m2", Alias: "fast"}},
			},
			{
				ID: "p2", Name: "P2", Prefix: "p2", BaseURL: "https://example.org", IsActive: true,
				Models: []config.ModelDef{{ID: "m9"}},
			},
		},
		Combos: []config.Combo{
			{ID: "c1", Name: "C1", Strategy: "fallback", Models: []string{"p1/m1", "p1/gone", "zx/nope", "bare", "C2"}},
			{ID: "c2", Name: "C2", Strategy: "fallback", Models: []string{"p2/m9"}},
		},
		QuickSlots: []config.QuickSlot{
			{ID: "q1", Name: "Q1", Models: []string{"p1/m1", "p1/gone", "C1", "C-missing"}, Order: 1, SelectedIndex: 1},
		},
	}
}

func TestSweepStaleComboModels(t *testing.T) {
	r := New(sweepTestConfig())
	removed := r.SweepStaleComboModels()
	// C1: "p1/gone", "zx/nope", "bare" dropped; "C2" kept (live combo name).
	if removed != 3 {
		t.Fatalf("removed = %d, want 3", removed)
	}
	c, _ := r.GetComboByID("c1")
	if len(c.Models) != 2 || c.Models[0] != "p1/m1" || c.Models[1] != "C2" {
		t.Fatalf("C1 models = %v", c.Models)
	}
}

func TestSweepStaleQuickSlotModels(t *testing.T) {
	r := New(sweepTestConfig())
	removed := r.SweepStaleQuickSlotModels()
	// Q1: "p1/gone", "C-missing" dropped; selected was idx1 ("p1/gone"),
	// so index should remap to a surviving entry in range.
	if removed != 2 {
		t.Fatalf("removed = %d, want 2", removed)
	}
	qs, _ := r.GetQuickSlot("q1")
	if len(qs.Models) != 2 {
		t.Fatalf("Q1 models = %v", qs.Models)
	}
	if qs.SelectedIndex < 0 || qs.SelectedIndex >= len(qs.Models) {
		t.Fatalf("SelectedIndex %d out of range for %v", qs.SelectedIndex, qs.Models)
	}
}

func TestSweepKeepsAliasRefs(t *testing.T) {
	r := New(sweepTestConfig())
	r.config.Combos[0].Models = append(r.config.Combos[0].Models, "p1/fast")
	removed := r.SweepStaleComboModels()
	if removed != 3 {
		t.Fatalf("removed = %d, want 3 (alias ref must survive)", removed)
	}
}

func TestDeleteModelAutoSweeps(t *testing.T) {
	r := New(sweepTestConfig())
	if !r.DeleteModel("p1", "m1") {
		t.Fatal("DeleteModel should return true")
	}
	c, _ := r.GetComboByID("c1")
	for _, m := range c.Models {
		if m == "p1/m1" {
			t.Fatalf("stale ref p1/m1 still in combo: %v", c.Models)
		}
	}
	qs, _ := r.GetQuickSlot("q1")
	for _, m := range qs.Models {
		if m == "p1/m1" {
			t.Fatalf("stale ref p1/m1 still in quickslot: %v", qs.Models)
		}
	}
}

func TestDeleteProviderAutoSweeps(t *testing.T) {
	r := New(sweepTestConfig())
	if !r.DeleteProvider("p2") {
		t.Fatal("DeleteProvider should return true")
	}
	c, _ := r.GetComboByID("c2")
	if len(c.Models) != 0 {
		t.Fatalf("c2 models = %v, want empty after provider delete", c.Models)
	}
}
