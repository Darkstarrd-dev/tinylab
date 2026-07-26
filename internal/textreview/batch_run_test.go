package textreview

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/config"
)

// batchFakeCleaner implements both Cleaner (unused in these tests) and
// BatchCleaner so runBatch takes the multi-chapter path. batchFn drives the
// per-call result and onChunk routing.
type batchFakeCleaner struct {
	mu      sync.Mutex
	calls   int
	batchFn func(batch []BatchChapter, onChunk func(chapterKey string, delta string)) CleanResult
}

func (f *batchFakeCleaner) Clean(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string)) CleanResult {
	return CleanResult{ErrMsg: "Clean must not be called on the batch path"}
}

func (f *batchFakeCleaner) CleanBatch(ctx context.Context, node config.TextReviewNode, systemPrompt string, batch []BatchChapter, onChunk func(chapterKey string, delta string)) CleanResult {
	f.mu.Lock()
	f.calls++
	fn := f.batchFn
	f.mu.Unlock()
	if fn != nil {
		return fn(batch, onChunk)
	}
	return CleanResult{OK: true}
}

// TestBatchRunEmptyGate verifies a multi-chapter batch is cleaned in ONE
// CleanBatch call, chunks route per chapter key, and on OK a chapter whose
// cleaned text is <10 chars is marked failed while the rest complete.
func TestBatchRunEmptyGate(t *testing.T) {
	cleaner := &batchFakeCleaner{batchFn: func(batch []BatchChapter, onChunk func(string, string)) CleanResult {
		// Chapter "0" gets enough text; chapter "1" gets <10 chars.
		onChunk("0", "this is a long enough cleaned result")
		onChunk("1", "tiny")
		return CleanResult{OK: true}
	}}
	// BatchChars large enough to merge both 7-char chapters into one batch.
	nodes := []NodeRuntime{{TextReviewNode: config.TextReviewNode{
		ID: "n1", Concurrency: 1, Enabled: true, BatchChars: 100000,
	}, Target: 1}}
	s := newTestSession(2, nodes...)
	StoreSession(s)
	e := NewEngine(cleaner, newFakePersister(), nil)
	e.Start(s)

	if !waitForStatus(t, s, map[string]bool{StatusCompleted: true, StatusFailed: true}, 2*time.Second) {
		s.lock()
		t.Fatalf("not settled: %+v", s.Chapters)
	}
	s.lock()
	c0 := s.Chapters[0]
	c1 := s.Chapters[1]
	calls := cleaner.calls
	s.unlock()

	if calls != 1 {
		t.Errorf("CleanBatch calls = %d, want 1 (both chapters batched into one call)", calls)
	}
	if c0.Status != StatusCompleted {
		t.Errorf("chapter 0 status = %q, want completed", c0.Status)
	}
	if c0.Cleaned != "this is a long enough cleaned result" {
		t.Errorf("chapter 0 cleaned = %q", c0.Cleaned)
	}
	if c1.Status != StatusFailed {
		t.Errorf("chapter 1 status = %q, want failed (<10 chars)", c1.Status)
	}
	if c1.Error != "empty result" {
		t.Errorf("chapter 1 error = %q, want 'empty result'", c1.Error)
	}
}

// TestBatchRunSingleFallsBackToClean verifies a node with BatchChars=0 still
// uses the single-chapter Clean path (no <10 gate), preserving the original
// behavior even when the cleaner also implements BatchCleaner.
func TestBatchRunSingleFallsBackToClean(t *testing.T) {
	var cleanCalls int
	cleaner := &batchFakeCleaner{batchFn: func(batch []BatchChapter, onChunk func(string, string)) CleanResult {
		t.Error("CleanBatch must not be called when BatchChars=0")
		return CleanResult{OK: true}
	}}
	// Wrap to count Clean calls: override Clean via a separate field.
	counting := &cleanCountingBatch{inner: cleaner, onClean: func() { cleanCalls++ }}
	nodes := []NodeRuntime{{TextReviewNode: config.TextReviewNode{
		ID: "n1", Concurrency: 1, Enabled: true, BatchChars: 0,
	}, Target: 1}}
	s := newTestSession(1, nodes...)
	StoreSession(s)
	e := NewEngine(counting, newFakePersister(), nil)
	e.Start(s)
	if !waitForStatus(t, s, map[string]bool{StatusCompleted: true}, 2*time.Second) {
		s.lock()
		t.Fatalf("not completed: %+v", s.Chapters)
	}
	if cleanCalls != 1 {
		t.Errorf("Clean calls = %d, want 1", cleanCalls)
	}
	s.lock()
	if s.Chapters[0].Status != StatusCompleted {
		t.Errorf("chapter 0 = %q, want completed (no gate on single path)", s.Chapters[0].Status)
	}
	s.unlock()
}

// cleanCountingBatch wraps a BatchCleaner to also satisfy Cleaner and count
// single-chapter Clean calls.
type cleanCountingBatch struct {
	inner   *batchFakeCleaner
	onClean func()
}

func (c *cleanCountingBatch) Clean(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string)) CleanResult {
	if c.onClean != nil {
		c.onClean()
	}
	onChunk("ok")
	return CleanResult{OK: true}
}

func (c *cleanCountingBatch) CleanBatch(ctx context.Context, node config.TextReviewNode, systemPrompt string, batch []BatchChapter, onChunk func(chapterKey string, delta string)) CleanResult {
	return c.inner.CleanBatch(ctx, node, systemPrompt, batch, onChunk)
}
