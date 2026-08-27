package textreview

import "testing"

// TestNextPendingIdxFirst verifies the first pending chapter wins.
func TestNextPendingIdxFirst(t *testing.T) {
	ch := []Chapter{
		{Index: 0, Status: StatusCompleted},
		{Index: 1, Status: StatusPending},
		{Index: 2, Status: StatusPending},
	}
	if got := nextPendingIdx(ch); got != 1 {
		t.Fatalf("first pending index = %d, want 1", got)
	}
}

// TestNextPendingIdxSkipsNonPending verifies completed/failed/claimed chapters
// are skipped and needsReprocess is selectable.
func TestNextPendingIdxSkipsNonPending(t *testing.T) {
	ch := []Chapter{
		{Index: 0, Status: StatusCompleted},
		{Index: 1, Status: StatusFailed},
		{Index: 2, Status: "claimed"},
		{Index: 3, Status: StatusPending},
		{Index: 4, Status: StatusNeedsReproc},
	}
	if got := nextPendingIdx(ch); got != 3 {
		t.Fatalf("skip non-pending: got %d, want 3", got)
	}
	ch[3].Status = "claimed"
	if got := nextPendingIdx(ch); got != 4 {
		t.Fatalf("needsReprocess selectable after claim: got %d, want 4", got)
	}
}

// TestNextPendingIdxNone verifies an all-settled slice yields -1.
func TestNextPendingIdxNone(t *testing.T) {
	ch := []Chapter{
		{Index: 0, Status: StatusCompleted},
		{Index: 1, Status: StatusFailed},
	}
	if got := nextPendingIdx(ch); got != -1 {
		t.Fatalf("no pending: got %d, want -1", got)
	}
}
