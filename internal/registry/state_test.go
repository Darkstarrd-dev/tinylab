package registry

import (
	"sync"
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/keystate"
	"github.com/tinyrouter/tinyrouter/internal/state"
)

func TestIncInFlight(t *testing.T) {
	s := &keystate.KeyRuntimeState{}
	if got := s.GetInFlight(); got != 0 {
		t.Fatalf("expected 0, got %d", got)
	}
	s.IncInFlight()
	if got := s.GetInFlight(); got != 1 {
		t.Fatalf("expected 1, got %d", got)
	}
	s.IncInFlight()
	if got := s.GetInFlight(); got != 2 {
		t.Fatalf("expected 2, got %d", got)
	}
}

func TestDecInFlight(t *testing.T) {
	s := &keystate.KeyRuntimeState{}
	s.InFlight = 3
	s.DecInFlight()
	if got := s.GetInFlight(); got != 2 {
		t.Fatalf("expected 2, got %d", got)
	}
	s.DecInFlight()
	s.DecInFlight()
	if got := s.GetInFlight(); got != 0 {
		t.Fatalf("expected 0, got %d", got)
	}
}

func TestDecInFlightClamp(t *testing.T) {
	s := &keystate.KeyRuntimeState{}
	// Dec below 0 should clamp at 0
	s.DecInFlight()
	if got := s.GetInFlight(); got != 0 {
		t.Fatalf("expected 0 (clamped), got %d", got)
	}
	s.DecInFlight()
	s.DecInFlight()
	if got := s.GetInFlight(); got != 0 {
		t.Fatalf("expected 0 (still clamped), got %d", got)
	}
}

func TestIncDecConcurrent(t *testing.T) {
	s := &keystate.KeyRuntimeState{}
	var wg sync.WaitGroup
	n := 100
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.IncInFlight()
			s.DecInFlight()
		}()
	}
	wg.Wait()
	if got := s.GetInFlight(); got != 0 {
		t.Fatalf("expected 0 after %d concurrent Inc/Dec pairs, got %d", n, got)
	}
}

func TestSnapshotKeyState_PersistsExhaustedModelLimits(t *testing.T) {
	ks := &keystate.KeyRuntimeState{
		ModelQuotas: map[string]*keystate.QuotaInfo{
			"m1": {ModelLimit: 100, ModelRemaining: 0},
			"m2": {ModelLimit: 100, ModelRemaining: 80},
		},
	}
	s := snapshotKeyState(ks)
	if s.ExhaustedModelLimits == nil {
		t.Fatal("expected non-nil ExhaustedModelLimits")
	}
	if len(s.ExhaustedModelLimits) != 1 {
		t.Fatalf("expected 1 exhausted entry, got %d", len(s.ExhaustedModelLimits))
	}
	if v, ok := s.ExhaustedModelLimits["m1"]; !ok {
		t.Error("expected exhausted model 'm1' in ExhaustedModelLimits")
	} else if v != 100 {
		t.Errorf("expected limit 100 for m1, got %d", v)
	}
	if _, ok := s.ExhaustedModelLimits["m2"]; ok {
		t.Error("did NOT expect partial-usage model 'm2' in ExhaustedModelLimits")
	}
}

func TestRestoreKeyState_RestoresExhaustedAsZeroRemaining(t *testing.T) {
	r := New(crudTestConfig())

	// Restore exhausted-model-limits snapshot
	s := state.KeySnapshot{
		ExhaustedModelLimits: map[string]int{"m1": 100},
	}
	err := r.RestoreKeyState("p1", "k1", s)
	if err != nil {
		t.Fatalf("RestoreKeyState: %v", err)
	}

	// Verify restored entry is exhausted
	q := r.GetKeyState("p1", "k1").GetQuota("m1")
	if q == nil {
		t.Fatal("expected non-nil QuotaInfo for m1 after restore")
	}
	if q.ModelLimit != 100 {
		t.Errorf("expected ModelLimit=100, got %d", q.ModelLimit)
	}
	if q.ModelRemaining != 0 {
		t.Errorf("expected ModelRemaining=0 (exhausted), got %d", q.ModelRemaining)
	}

	// Verify that a fresh probe populating ModelQuotas is NOT clobbered by
	// re-restore (restore only fills nil entries).
	ks := r.GetKeyState("p1", "k1")
	ks.Lock()
	ks.ModelQuotas["m1"] = &keystate.QuotaInfo{
		ModelLimit:     100,
		ModelRemaining: 50, // partially replenished by live probe
		LastUpdated:    time.Now(),
	}
	ks.Unlock()

	// Re-restore should NOT overwrite the live entry
	err = r.RestoreKeyState("p1", "k1", s)
	if err != nil {
		t.Fatalf("RestoreKeyState (second): %v", err)
	}
	q2 := r.GetKeyState("p1", "k1").GetQuota("m1")
	if q2 == nil {
		t.Fatal("expected non-nil QuotaInfo after second restore")
	}
	if q2.ModelRemaining != 50 {
		t.Errorf("expected ModelRemaining=50 (live, not clobbered), got %d", q2.ModelRemaining)
	}
}
