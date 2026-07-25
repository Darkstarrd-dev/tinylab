package registry

import (
	"sync"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/keystate"
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
