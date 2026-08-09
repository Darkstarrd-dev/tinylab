package registry

import (
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/state"
)

func TestUpdateProbeRecord_RoundTrip(t *testing.T) {
	r := New(crudTestConfig())

	rec := state.ProbeRecord{
		ProviderID: "p1",
		ModelID:    "m1",
		OpenAICompat: state.ProbeDetail{
			Ok:        true,
			Status:    200,
			LatencyMs: 17,
			LastAt:    time.Now(),
		},
		OpenAIResponses: state.ProbeDetail{Ok: false, Status: 404, Error: "nope"},
		Anthropic:       state.ProbeDetail{Ok: true, Status: 200, LatencyMs: 21},
		Protocols:       []string{"openai-compat", "anthropic"},
		LastProbeAt:     time.Now(),
	}
	r.UpdateProbeRecord("p1", "m1", rec)

	got := r.GetProbeRecord("p1", "m1")
	if got == nil {
		t.Fatal("GetProbeRecord returned nil")
	}
	if got.ProviderID != "p1" || got.ModelID != "m1" {
		t.Fatalf("identity mismatch: %+v", got)
	}
	if !got.OpenAICompat.Ok || got.OpenAICompat.LatencyMs != 17 {
		t.Fatalf("openai-compat mismatch: %+v", got.OpenAICompat)
	}
	if got.OpenAIResponses.Status != 404 {
		t.Fatalf("openai-responses mismatch: %+v", got.OpenAIResponses)
	}
	if len(got.Protocols) != 2 || got.Protocols[0] != "openai-compat" {
		t.Fatalf("protocols mismatch: %+v", got.Protocols)
	}

	// Snapshot should include the record with structured identity fields.
	snap := r.SnapshotProbeRecords()
	if len(snap) != 1 {
		t.Fatalf("SnapshotProbeRecords len = %d, want 1", len(snap))
	}
	var rec1 *state.ProbeRecord
	for _, pr := range snap {
		rec1 = pr
		break
	}
	if rec1 == nil || rec1.ProviderID != "p1" || rec1.ModelID != "m1" || !rec1.Anthropic.Ok {
		t.Fatalf("snapshot value mismatch: %+v", snap)
	}

	// Missing record returns nil.
	if r.GetProbeRecord("ghost", "mX") != nil {
		t.Fatal("expected nil for missing probe record")
	}
}

func TestRestoreProbeRecord(t *testing.T) {
	r := New(crudTestConfig())
	rec := state.ProbeRecord{
		ProviderID:   "p1",
		ModelID:      "m1",
		OpenAICompat: state.ProbeDetail{Ok: true, Status: 200},
		Protocols:    []string{"openai-compat"},
	}
	if err := r.RestoreProbeRecord("p1", "m1", rec); err != nil {
		t.Fatalf("RestoreProbeRecord: %v", err)
	}
	got := r.GetProbeRecord("p1", "m1")
	if got == nil || len(got.Protocols) != 1 {
		t.Fatalf("restore mismatch: %+v", got)
	}
}
