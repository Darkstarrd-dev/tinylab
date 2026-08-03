package proxy

import (
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/usage"
)

func TestEntryTracker_RegisterAndGet(t *testing.T) {
	tracker := NewEntryTracker()
	e := usage.Entry{ID: "req-1", Status: "processing", Model: "gpt-4"}
	if !tracker.Register(e) {
		t.Fatal("expected Register to return true for new entry")
	}
	got, ok := tracker.Get("req-1")
	if !ok {
		t.Fatal("expected Get to find registered entry")
	}
	if got.Status != "processing" || got.Model != "gpt-4" {
		t.Fatalf("unexpected entry: %+v", got)
	}
}

func TestEntryTracker_RegisterDuplicate(t *testing.T) {
	tracker := NewEntryTracker()
	e := usage.Entry{ID: "req-1", Status: "processing"}
	if !tracker.Register(e) {
		t.Fatal("expected Register to return true for first insert")
	}
	if tracker.Register(e) {
		t.Fatal("expected Register to return false for duplicate ID")
	}
}

func TestEntryTracker_Remove(t *testing.T) {
	tracker := NewEntryTracker()
	tracker.Register(usage.Entry{ID: "req-1", Status: "processing"})
	if !tracker.Remove("req-1") {
		t.Fatal("expected Remove to return true for existing entry")
	}
	if tracker.Remove("req-1") {
		t.Fatal("expected Remove to return false for already removed entry")
	}
	if tracker.Exists("req-1") {
		t.Fatal("expected entry to not exist after Remove")
	}
}

func TestEntryTracker_All(t *testing.T) {
	tracker := NewEntryTracker()
	tracker.Register(usage.Entry{ID: "a", Status: "processing"})
	tracker.Register(usage.Entry{ID: "b", Status: "processing"})
	all := tracker.All()
	if len(all) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(all))
	}
}

func TestEntryTracker_SetTTFT(t *testing.T) {
	tracker := NewEntryTracker()
	tracker.Register(usage.Entry{ID: "req-1", Status: "processing"})
	tracker.SetTTFT("req-1", 123)
	e, _ := tracker.Get("req-1")
	if e.TTFTMs != 123 {
		t.Fatalf("expected TTFTMs=123, got %d", e.TTFTMs)
	}
}

func TestEntryTracker_UpdateTokens(t *testing.T) {
	tracker := NewEntryTracker()
	tracker.Register(usage.Entry{ID: "req-1", Status: "processing", InputTokens: 10, OutputTokens: 20})
	tracker.UpdateTokens("req-1", 100, -1) // skip output
	e, _ := tracker.Get("req-1")
	if e.InputTokens != 100 {
		t.Fatalf("expected InputTokens=100, got %d", e.InputTokens)
	}
	if e.OutputTokens != 20 {
		t.Fatalf("expected OutputTokens=20 (unchanged), got %d", e.OutputTokens)
	}
	tracker.UpdateTokens("req-1", -1, 200) // skip input
	e, _ = tracker.Get("req-1")
	if e.InputTokens != 100 {
		t.Fatalf("expected InputTokens=100 (unchanged), got %d", e.InputTokens)
	}
	if e.OutputTokens != 200 {
		t.Fatalf("expected OutputTokens=200, got %d", e.OutputTokens)
	}
}

// TestEntryTracker_SweepStale_RemovesOnlyOldEntries verifies that SweepStale
// returns only entries whose timestamp is older than maxAge, and removes them
// from the tracker while leaving recent entries intact.
func TestEntryTracker_SweepStale_RemovesOnlyOldEntries(t *testing.T) {
	tracker := NewEntryTracker()
	now := time.Now()

	// Register an old entry (timestamp = 15 minutes ago)
	tracker.Register(usage.Entry{ID: "old-1", Status: "processing", Timestamp: now.Add(-15 * time.Minute)})
	// Register a very old entry (timestamp = 30 minutes ago)
	tracker.Register(usage.Entry{ID: "old-2", Status: "processing", Timestamp: now.Add(-30 * time.Minute)})
	// Register a recent entry (timestamp = 1 minute ago)
	tracker.Register(usage.Entry{ID: "recent", Status: "processing", Timestamp: now.Add(-1 * time.Minute)})
	// Register a current entry (now)
	tracker.Register(usage.Entry{ID: "current", Status: "processing", Timestamp: now})

	// Sweep with 10 minute maxAge
	stale := tracker.SweepStale(10 * time.Minute)

	// Should have returned 2 stale entries
	if len(stale) != 2 {
		t.Fatalf("expected 2 stale entries, got %d", len(stale))
	}

	// Verify stale IDs are old-1 and old-2
	staleIDs := make(map[string]bool)
	for _, e := range stale {
		staleIDs[e.ID] = true
	}
	if !staleIDs["old-1"] || !staleIDs["old-2"] {
		t.Fatalf("expected stale entries to be old-1 and old-2, got %v", staleIDs)
	}

	// Verify stale entries were removed from tracker
	if tracker.Exists("old-1") {
		t.Error("expected old-1 to be removed from tracker")
	}
	if tracker.Exists("old-2") {
		t.Error("expected old-2 to be removed from tracker")
	}

	// Verify recent entries remain
	if !tracker.Exists("recent") {
		t.Error("expected recent entry to remain in tracker")
	}
	if !tracker.Exists("current") {
		t.Error("expected current entry to remain in tracker")
	}

	// Verify total remaining count
	all := tracker.All()
	if len(all) != 2 {
		t.Fatalf("expected 2 remaining entries, got %d", len(all))
	}
}

// TestEntryTracker_SweepStale_EmptyTracker verifies that SweepStale returns nil
// when the tracker is empty.
func TestEntryTracker_SweepStale_EmptyTracker(t *testing.T) {
	tracker := NewEntryTracker()
	stale := tracker.SweepStale(10 * time.Minute)
	if stale != nil {
		t.Fatalf("expected nil for empty tracker, got %v", stale)
	}
}

// TestEntryTracker_SweepStale_NoStaleEntries verifies that SweepStale returns
// nil when no entries are old enough.
func TestEntryTracker_SweepStale_NoStaleEntries(t *testing.T) {
	tracker := NewEntryTracker()
	now := time.Now()
	tracker.Register(usage.Entry{ID: "fresh", Status: "processing", Timestamp: now.Add(-1 * time.Minute)})
	tracker.Register(usage.Entry{ID: "current", Status: "processing", Timestamp: now})

	stale := tracker.SweepStale(10 * time.Minute)
	if len(stale) != 0 {
		t.Fatalf("expected empty/nil slice for no stale entries, got %v (len=%d)", stale, len(stale))
	}

	// Verify all entries still exist
	if !tracker.Exists("fresh") || !tracker.Exists("current") {
		t.Error("expected all entries to remain after SweepStale with no stale")
	}
}

// TestEntryTracker_SweepStale_PreservesEntryFields verifies that the returned
// stale entries carry their original field values (Status, Provider, Model, etc.)
// so the caller can construct an error record from them.
func TestEntryTracker_SweepStale_PreservesEntryFields(t *testing.T) {
	tracker := NewEntryTracker()
	now := time.Now()

	// Register an old entry with specific fields
	original := usage.Entry{
		ID:            "req-xyz",
		Status:        "processing",
		Timestamp:     now.Add(-15 * time.Minute),
		Provider:      "OpenAI",
		Model:         "gpt-4",
		OriginalModel: "gpt-4",
		KeyID:         "k1",
		KeyName:       "Key Main",
		InputTokens:   50,
		Source:        "",
	}
	tracker.Register(original)

	stale := tracker.SweepStale(10 * time.Minute)
	if len(stale) != 1 {
		t.Fatalf("expected 1 stale entry, got %d", len(stale))
	}

	e := stale[0]
	if e.ID != "req-xyz" || e.Provider != "OpenAI" || e.Model != "gpt-4" {
		t.Fatalf("stale entry fields mismatch: %+v", e)
	}
	if e.KeyID != "k1" || e.KeyName != "Key Main" {
		t.Fatalf("stale entry key fields mismatch: %+v", e)
	}
	if e.InputTokens != 50 {
		t.Fatalf("expected InputTokens=50, got %d", e.InputTokens)
	}
}

// TestEntryTracker_ConcurrentSafety verifies that Register/Remove/SweepStale
// are safe under concurrent access.
func TestEntryTracker_ConcurrentSafety(t *testing.T) {
	tracker := NewEntryTracker()

	// Register some entries
	for i := 0; i < 10; i++ {
		id := string(rune('a' + i))
		tracker.Register(usage.Entry{ID: "req-" + id, Status: "processing", Timestamp: time.Now()})
	}

	// Run concurrent operations
	done := make(chan struct{})
	go func() {
		for i := 0; i < 50; i++ {
			tracker.Register(usage.Entry{ID: "concurrent", Status: "processing"})
		}
		done <- struct{}{}
	}()
	go func() {
		for i := 0; i < 50; i++ {
			tracker.Remove("req-a")
		}
		done <- struct{}{}
	}()
	go func() {
		for i := 0; i < 50; i++ {
			tracker.SweepStale(10 * time.Minute)
		}
		done <- struct{}{}
	}()

	for i := 0; i < 3; i++ {
		<-done
	}
}
