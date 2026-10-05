package state

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/console"
)

// TestManagerStatsDebounceClass verifies the F-08 persistence-class split:
// stats-class writes (ScheduleStatsWrite) use a long debounce and never
// preempt or cancel a pending critical write (ScheduleWrite, 500ms).
func TestManagerStatsDebounceClass(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.yaml")
	logger := console.New(100)

	m := NewManager(path, logger,
		WithKeyStateProvider(
			func() map[string]KeySnapshot {
				return map[string]KeySnapshot{
					"stats::test": {ConsecCount: 1},
				}
			},
			func(providerID, keyID string, s KeySnapshot) error { return nil },
		),
	)

	// Stats write must NOT hit disk within the critical debounce window
	// (500ms): schedule both classes at t=0, then check at ~300ms.
	m.ScheduleStatsWrite()
	m.ScheduleWrite()

	time.Sleep(300 * time.Millisecond)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("state.yaml written before critical debounce elapsed: %v", err)
	}

	// Critical write lands after its 500ms debounce.
	time.Sleep(400 * time.Millisecond)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("state.yaml not written after critical debounce: %v", err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.Keys["stats::test"] == nil {
		t.Fatal("critical flush snapshot missing stats key")
	}

	// Stats-only change must NOT flush within the critical window afterwards.
	os.Remove(path)
	m.ScheduleStatsWrite()
	time.Sleep(400 * time.Millisecond)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("stats write used critical debounce instead of stats debounce")
	}
}

// TestManagerStatsWriteEventuallyFlushes verifies a stats-only schedule lands
// on disk without any critical schedule ever firing. The stats debounce is
// shortened to keep the suite fast; the window semantics are unchanged.
func TestManagerStatsWriteEventuallyFlushes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.yaml")
	logger := console.New(100)

	m := NewManager(path, logger,
		WithKeyStateProvider(
			func() map[string]KeySnapshot {
				return map[string]KeySnapshot{
					"stats::only": {ConsecCount: 7},
				}
			},
			func(providerID, keyID string, s KeySnapshot) error { return nil },
		),
	)

	m.mu.Lock()
	m.statsDebounce = 100 * time.Millisecond
	m.mu.Unlock()

	m.ScheduleStatsWrite()
	time.Sleep(300 * time.Millisecond)

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.Keys["stats::only"] == nil || loaded.Keys["stats::only"].ConsecCount != 7 {
		t.Fatal("stats-class write not persisted after stats debounce")
	}
}

// TestManagerFlushSyncCancelsStatsTimer verifies shutdown discards a pending
// stats timer and writes synchronously.
func TestManagerFlushSyncCancelsStatsTimer(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.yaml")
	logger := console.New(100)

	var writes atomic.Int32
	m := NewManager(path, logger,
		WithKeyStateProvider(
			func() map[string]KeySnapshot {
				writes.Add(1)
				return map[string]KeySnapshot{
					"sync::test": {ConsecCount: 1},
				}
			},
			func(providerID, keyID string, s KeySnapshot) error { return nil },
		),
	)

	m.mu.Lock()
	m.statsDebounce = 100 * time.Millisecond
	m.mu.Unlock()

	m.ScheduleStatsWrite()
	if err := m.FlushSync(); err != nil {
		t.Fatalf("FlushSync: %v", err)
	}

	// Wait well past the stats debounce: the cancelled timer must not fire a
	// second flush after close.
	time.Sleep(400 * time.Millisecond)
	if got := writes.Load(); got != 1 {
		t.Fatalf("expected exactly 1 snapshot extraction (cancelled timer must not refire), got %d", got)
	}
}
