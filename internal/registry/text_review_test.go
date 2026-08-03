package registry

import (
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/config"
)

// TestUpdateTextReviewNodeFieldsPreservesStaticFields covers the scheduler
// ramp-down writeback contract: a concurrency/enabled-only merge must never
// wipe ProviderID/ModelID/IntervalSec/BatchChars.
func TestUpdateTextReviewNodeFieldsPreservesStaticFields(t *testing.T) {
	r := New(&config.Config{})
	r.AddTextReviewNode(config.TextReviewNode{
		ID:          "n1",
		ProviderID:  "p1",
		ModelID:     "m1",
		Concurrency: 3,
		Enabled:     true,
		IntervalSec: 5,
		BatchChars:  8000,
	})

	// Ramp-down writeback: concurrency 1, still enabled.
	c := 1
	if !r.UpdateTextReviewNodeFields("n1", &c, nil) {
		t.Fatal("UpdateTextReviewNodeFields(n1, 1, nil) = false, want true")
	}
	// Disable writeback: concurrency 0, disabled.
	e := false
	if !r.UpdateTextReviewNodeFields("n1", nil, &e) {
		t.Fatal("UpdateTextReviewNodeFields(n1, nil, false) = false, want true")
	}

	nodes := r.ListTextReviewNodes()
	if len(nodes) != 1 {
		t.Fatalf("len(nodes) = %d, want 1", len(nodes))
	}
	n := nodes[0]
	if n.ProviderID != "p1" || n.ModelID != "m1" {
		t.Errorf("writeback wiped static fields: provider=%q model=%q, want p1/m1", n.ProviderID, n.ModelID)
	}
	if n.IntervalSec != 5 || n.BatchChars != 8000 {
		t.Errorf("writeback wiped tuning fields: interval=%d batchChars=%d, want 5/8000", n.IntervalSec, n.BatchChars)
	}
	if n.Concurrency != 1 || n.Enabled {
		t.Errorf("writeback did not apply ramp fields: concurrency=%d enabled=%v, want 1/false", n.Concurrency, n.Enabled)
	}

	if r.UpdateTextReviewNodeFields("missing", &c, &e) {
		t.Error("UpdateTextReviewNodeFields(missing) = true, want false")
	}
}
