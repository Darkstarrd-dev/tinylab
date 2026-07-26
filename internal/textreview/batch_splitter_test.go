package textreview

import (
	"strings"
	"testing"
)

// runSplitter feeds `input` into a fresh batchSplitter in `pushSize`-sized
// pieces, finishing at the end, and returns the concatenated output per key.
func runSplitter(input string, pushSize int) map[string]string {
	got := map[string]*strings.Builder{}
	sp := &batchSplitter{onChunk: func(key, delta string) {
		if got[key] == nil {
			got[key] = &strings.Builder{}
		}
		got[key].WriteString(delta)
	}}
	for i := 0; i < len(input); i += pushSize {
		end := i + pushSize
		if end > len(input) {
			end = len(input)
		}
		sp.push(input[i:end])
	}
	sp.finish()
	out := map[string]string{}
	for k, b := range got {
		out[k] = b.String()
	}
	return out
}

// TestBatchSplitterWhole feeds a well-formed two-chapter output in one push and
// verifies each chapter's content is routed under its key.
func TestBatchSplitterWhole(t *testing.T) {
	in := "===CHAPTER_ID:0===\nAAA" + ChapterSep + "===CHAPTER_ID:1===\nBBB"
	got := runSplitter(in, len(in))
	if got["0"] != "AAA" {
		t.Errorf("chapter 0 = %q want AAA", got["0"])
	}
	if got["1"] != "BBB" {
		t.Errorf("chapter 1 = %q want BBB", got["1"])
	}
}

// TestBatchSplitterIncremental feeds the same output byte-by-byte (and at a few
// other chunk sizes that split the 22-char separator mid-way) to verify the
// holdback logic never emits a partial separator as chapter content.
func TestBatchSplitterIncremental(t *testing.T) {
	in := "===CHAPTER_ID:0===\nAAA" + ChapterSep + "===CHAPTER_ID:1===\nBBB"
	for _, size := range []int{1, 2, 3, 7, 13} {
		got := runSplitter(in, size)
		if got["0"] != "AAA" {
			t.Errorf("pushSize %d: chapter 0 = %q want AAA", size, got["0"])
		}
		if got["1"] != "BBB" {
			t.Errorf("pushSize %d: chapter 1 = %q want BBB", size, got["1"])
		}
	}
}

// TestBatchSplitterPreambleDropped verifies text before the first header is
// discarded, not routed to any chapter.
func TestBatchSplitterPreambleDropped(t *testing.T) {
	in := "preamble junk\n===CHAPTER_ID:5===\nZZZ" + ChapterSep
	got := runSplitter(in, len(in))
	if got["5"] != "ZZZ" {
		t.Errorf("chapter 5 = %q want ZZZ", got["5"])
	}
	if _, leaked := got[""]; leaked {
		t.Errorf("preamble leaked to empty key: %q", got[""])
	}
}

// TestBatchSplitterSplitMidSeparator pushes the input split exactly inside the
// separator to exercise the longest-suffix holdback directly.
func TestBatchSplitterSplitMidSeparator(t *testing.T) {
	head := "===CHAPTER_ID:0===\nAAA<<<||"
	tail := "|CHAPTER_SEP|||>>>===CHAPTER_ID:1===\nBBB"
	got := map[string]*strings.Builder{}
	sp := &batchSplitter{onChunk: func(key, delta string) {
		if got[key] == nil {
			got[key] = &strings.Builder{}
		}
		got[key].WriteString(delta)
	}}
	sp.push(head)
	sp.push(tail)
	sp.finish()
	if got["0"].String() != "AAA" {
		t.Errorf("chapter 0 = %q want AAA (partial sep must not leak)", got["0"].String())
	}
	if got["1"].String() != "BBB" {
		t.Errorf("chapter 1 = %q want BBB", got["1"].String())
	}
}
