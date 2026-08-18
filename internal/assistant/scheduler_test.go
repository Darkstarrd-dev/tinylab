package assistant

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestSchedulerStartStop(t *testing.T) {
	s := NewScheduler()
	s.RegisterJob(Job{Name: "test-job", IntervalSec: 1})

	if !s.Has("test-job") {
		t.Fatal("expected test-job to be registered")
	}
	if s.Count() != 1 {
		t.Fatalf("expected count 1, got %d", s.Count())
	}

	var runs atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	s.Start(ctx, func(name string) {
		if name == "test-job" {
			runs.Add(1)
		}
	})

	// Wait for at least 1 tick
	time.Sleep(1200 * time.Millisecond)

	if got := runs.Load(); got < 1 {
		t.Fatalf("expected at least 1 run, got %d", got)
	}

	s.Stop()
	currentRuns := runs.Load()

	// Wait a bit to ensure it really stopped
	time.Sleep(1200 * time.Millisecond)
	if got := runs.Load(); got != currentRuns {
		t.Fatalf("job kept running after Stop: was %d, now %d", currentRuns, got)
	}
}

func TestSchedulerCRUD(t *testing.T) {
	s := NewScheduler()
	s.RegisterJob(Job{Name: "j1", IntervalSec: 10})
	s.RegisterJob(Job{Name: "j2", IntervalSec: 20})

	if s.Count() != 2 {
		t.Fatalf("expected 2 jobs, got %d", s.Count())
	}

	j, ok := s.Get("j1")
	if !ok || j.IntervalSec != 10 {
		t.Fatalf("expected j1 with interval 10, got %v, ok=%v", j, ok)
	}

	jobs := s.Jobs()
	if len(jobs) != 2 {
		t.Fatalf("expected 2 jobs in snapshot, got %d", len(jobs))
	}

	s.RemoveJob("j1")
	if s.Has("j1") {
		t.Fatal("expected j1 to be removed")
	}
	if s.Count() != 1 {
		t.Fatalf("expected 1 job after removal, got %d", s.Count())
	}
}
