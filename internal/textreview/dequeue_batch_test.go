package textreview

import (
	"reflect"
	"strings"
	"testing"
)

// mkChapters builds a slice of pending chapters whose Content lengths are the
// given sizes (filled with 'x').
func mkChapters(sizes []int) []Chapter {
	cs := make([]Chapter, len(sizes))
	for i, n := range sizes {
		cs[i] = Chapter{Index: i, Status: StatusPending, Content: strings.Repeat("x", n)}
	}
	return cs
}

// TestDequeueBatchSingleExceedsMax verifies the first pending chapter is always
// taken even when its content alone exceeds maxChars.
func TestDequeueBatchSingleExceedsMax(t *testing.T) {
	ch := mkChapters([]int{100})
	got := dequeueBatch(ch, 10)
	want := []int{0}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("first chapter unconditional: got %v want %v", got, want)
	}
}

// TestDequeueBatchAccumulate verifies chapters accumulate while they fit within
// maxChars, stopping once the accumulated size reaches maxChars.
func TestDequeueBatchAccumulate(t *testing.T) {
	// 2 + 2 = 4 == maxChars(4) → [0,1]; a third would exceed (accChars >= max).
	ch := mkChapters([]int{2, 2, 2})
	got := dequeueBatch(ch, 4)
	want := []int{0, 1}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("accumulate up to maxChars: got %v want %v", got, want)
	}
}

// TestDequeueBatchStopAtMax verifies a chapter that would push the accumulated
// size past maxChars is not taken (the batch stops at the current size).
func TestDequeueBatchStopAtMax(t *testing.T) {
	// first 2 fits; next 3 would push acc to 5 > 3 → stop at [0].
	ch := mkChapters([]int{2, 3, 2})
	got := dequeueBatch(ch, 3)
	want := []int{0}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("stop at maxChars: got %v want %v", got, want)
	}
}

// TestDequeueBatchNoBatching verifies maxChars<=0 yields exactly one chapter.
func TestDequeueBatchNoBatching(t *testing.T) {
	ch := mkChapters([]int{1, 1, 1})
	got := dequeueBatch(ch, 0)
	want := []int{0}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("no batching (maxChars=0): got %v want %v", got, want)
	}
}

// TestDequeueBatchSkipsNonPending verifies only pending/needsReprocess chapters
// are selectable; completed/failed/claimed chapters are skipped.
func TestDequeueBatchSkipsNonPending(t *testing.T) {
	ch := []Chapter{
		{Index: 0, Status: StatusCompleted, Content: "aa"},
		{Index: 1, Status: StatusFailed, Content: "bb"},
		{Index: 2, Status: "claimed", Content: "cc"},
		{Index: 3, Status: StatusPending, Content: "dd"},
		{Index: 4, Status: StatusNeedsReproc, Content: "ee"},
	}
	got := dequeueBatch(ch, 100)
	want := []int{3, 4}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("skip non-pending: got %v want %v", got, want)
	}
}
