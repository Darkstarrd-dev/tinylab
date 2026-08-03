package mediaedit

import (
	"fmt"
	"testing"
)

// TestTrimBoundsEvictsFinishedJobs verifies the in-memory job pool stays bounded:
// finished jobs beyond the cap are evicted, running jobs are kept.
func TestTrimBoundsEvictsFinishedJobs(t *testing.T) {
	m := NewManager()
	const total = maxJobs + 50
	for i := 0; i < total; i++ {
		status := StatusCompleted
		if i >= maxJobs { // the last 50 stay "running"
			status = StatusRunning
		}
		job := &Job{ID: fmt.Sprintf("j%03d", i), Status: status}
		m.jobs.Store(job.ID, job)
		m.order = append(m.order, job.ID)
	}

	m.trimBounds()

	count := 0
	m.jobs.Range(func(k, v any) bool {
		count++
		return true
	})
	if count != maxJobs {
		t.Fatalf("jobs count = %d, want %d", count, maxJobs)
	}
	// All running jobs (the last 50) must survive eviction.
	for i := maxJobs; i < total; i++ {
		if _, ok := m.jobs.Load(fmt.Sprintf("j%03d", i)); !ok {
			t.Errorf("running job j%03d was evicted", i)
		}
	}
	if len(m.order) != maxJobs {
		t.Errorf("order len = %d, want %d", len(m.order), maxJobs)
	}
}

// TestTrimBoundsDropsOldestWhenAllRunning covers the pathological case: more
// than maxJobs concurrent running jobs still bounds the map (oldest dropped).
func TestTrimBoundsDropsOldestWhenAllRunning(t *testing.T) {
	m := NewManager()
	const total = maxJobs + 10
	for i := 0; i < total; i++ {
		job := &Job{ID: fmt.Sprintf("j%03d", i), Status: StatusRunning}
		m.jobs.Store(job.ID, job)
		m.order = append(m.order, job.ID)
	}

	m.trimBounds()

	count := 0
	m.jobs.Range(func(k, v any) bool {
		count++
		return true
	})
	if count != maxJobs {
		t.Fatalf("jobs count = %d, want %d", count, maxJobs)
	}
	if _, ok := m.jobs.Load("j000"); ok {
		t.Error("oldest running job j000 should have been evicted")
	}
}
