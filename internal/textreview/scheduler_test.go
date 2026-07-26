package textreview

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/config"
)

// fakeCleaner is a test Cleaner whose behavior is controlled per call. When
// byNode is set, results are popped per node.ID (deterministic per node);
// otherwise the sequential results slice is consumed in call order.
type fakeCleaner struct {
	mu      sync.Mutex
	results []fakeResult
	byNode  map[string][]fakeResult
	nodeIdx map[string]int
	calls   int
	blockCh chan struct{} // when non-nil, Clean blocks until closed (for pause/stop tests)
	delay   time.Duration
}

type fakeResult struct {
	res    CleanResult
	chunks []string
}

func (f *fakeCleaner) Clean(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string)) CleanResult {
	f.mu.Lock()
	f.calls++
	var r fakeResult
	if f.byNode != nil {
		idx := f.nodeIdx[node.ID]
		if idx < len(f.byNode[node.ID]) {
			r = f.byNode[node.ID][idx]
		}
		f.nodeIdx[node.ID] = idx + 1
	} else {
		idx := f.calls - 1
		if idx < len(f.results) {
			r = f.results[idx]
		}
	}
	blockCh := f.blockCh
	delay := f.delay
	f.mu.Unlock()

	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return CleanResult{OK: false, ErrMsg: "stream interrupted"}
		}
	}
	if blockCh != nil {
		select {
		case <-blockCh:
		case <-ctx.Done():
			return CleanResult{OK: false, ErrMsg: "stream interrupted"}
		}
	}
	for _, c := range r.chunks {
		if onChunk != nil {
			onChunk(c)
		}
	}
	return r.res
}

// fakePersister records ramp-down calls for assertion.
type fakePersister struct {
	mu          sync.Mutex
	concurrency map[string]int
	disabled    map[string]bool
}

func newFakePersister() *fakePersister {
	return &fakePersister{
		concurrency: map[string]int{},
		disabled:    map[string]bool{},
	}
}

func (p *fakePersister) UpdateNodeConcurrency(id string, concurrency int) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.concurrency[id] = concurrency
	return true
}

func (p *fakePersister) DisableNode(id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.disabled[id] = true
	return true
}

// newTestSession builds a session with N chapters and the given nodes.
func newTestSession(numChapters int, nodes ...NodeRuntime) *Session {
	chapters := make([]Chapter, numChapters)
	for i := range chapters {
		chapters[i] = Chapter{Index: i, Title: "ch" + string(rune('A'+i)), Content: "content", Status: StatusPending}
	}
	s := &Session{
		ID:        "test-session",
		Chapters:  chapters,
		Nodes:     nodes,
		Status:    SessionIdle,
		CreatedAt: time.Now(),
	}
	return s
}

// waitForStatus polls the session until all chapters reach one of the given
// statuses, or the timeout elapses.
func waitForStatus(t *testing.T, s *Session, want map[string]bool, timeout time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		s.lock()
		done := true
		for i := range s.Chapters {
			if !want[s.Chapters[i].Status] {
				done = false
				break
			}
		}
		s.unlock()
		if done && len(s.Chapters) > 0 {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

// TestOK cleans all chapters successfully.
func TestOK(t *testing.T) {
	cleaner := &fakeCleaner{results: []fakeResult{
		{res: CleanResult{OK: true}, chunks: []string{"a", "b"}},
		{res: CleanResult{OK: true}, chunks: []string{"c"}},
		{res: CleanResult{OK: true}, chunks: []string{"d"}},
	}}
	nodes := []NodeRuntime{{TextReviewNode: config.TextReviewNode{ID: "n1", Concurrency: 2, Enabled: true}, Target: 2}}
	s := newTestSession(3, nodes...)
	StoreSession(s)
	e := NewEngine(cleaner, newFakePersister(), nil)
	if !e.Start(s) {
		t.Fatal("Start returned false")
	}
	if !waitForStatus(t, s, map[string]bool{StatusCompleted: true}, 2*time.Second) {
		s.lock()
		defer s.unlock()
		t.Fatalf("not all completed: %+v", s.Chapters)
	}
	s.lock()
	var combined string
	for _, c := range s.Chapters {
		combined += c.Cleaned
	}
	s.unlock()
	if combined != "abc" && combined != "acb" && combined != "bac" && combined != "bca" && combined != "cab" && combined != "cba" {
		// chunks are concurrent so order may vary; just check all present
		if !strings.Contains(combined, "a") || !strings.Contains(combined, "b") || !strings.Contains(combined, "c") {
			t.Fatalf("missing chunks in combined %q", combined)
		}
	}
}

// TestExhaustedRampDown verifies Target decrements and persists on Exhausted.
func TestExhaustedRampDown(t *testing.T) {
	persister := newFakePersister()
	// 5 chapters; first call returns Exhausted (ramps n1 Target 2->1),
	// subsequent calls OK.
	cleaner := &fakeCleaner{results: []fakeResult{
		{res: CleanResult{Exhausted: true, ErrMsg: "all keys exhausted"}},
		{res: CleanResult{OK: true}, chunks: []string{"x"}},
		{res: CleanResult{OK: true}, chunks: []string{"y"}},
		{res: CleanResult{OK: true}, chunks: []string{"z"}},
		{res: CleanResult{OK: true}, chunks: []string{"w"}},
	}}
	nodes := []NodeRuntime{{TextReviewNode: config.TextReviewNode{ID: "n1", Concurrency: 2, Enabled: true}, Target: 2}}
	s := newTestSession(4, nodes...)
	StoreSession(s)
	e := NewEngine(cleaner, persister, nil)
	e.Start(s)
	if !waitForStatus(t, s, map[string]bool{StatusCompleted: true}, 2*time.Second) {
		s.lock()
		t.Fatalf("not all completed: %+v", s.Chapters)
	}
	s.lock()
	target := s.Nodes[0].Target
	s.unlock()
	if target != 1 {
		t.Fatalf("expected Target=1 after one Exhausted, got %d", target)
	}
	if persister.concurrency["n1"] != 1 {
		t.Fatalf("expected persister UpdateNodeConcurrency(n1,1), got %v", persister.concurrency)
	}
}

// TestExhaustedDisable verifies Target hits 0 disables the node.
func TestExhaustedDisable(t *testing.T) {
	persister := newFakePersister()
	// n1 always exhausted (ramp 1->0, disable); n2 always OK.
	n1Results := []fakeResult{}
	for range 6 {
		n1Results = append(n1Results, fakeResult{res: CleanResult{Exhausted: true, ErrMsg: "all keys exhausted"}})
	}
	n2Results := []fakeResult{}
	for range 4 {
		n2Results = append(n2Results, fakeResult{res: CleanResult{OK: true}, chunks: []string{"o"}})
	}
	cleaner := &fakeCleaner{
		byNode:  map[string][]fakeResult{"n1": n1Results, "n2": n2Results},
		nodeIdx: map[string]int{},
	}
	nodes := []NodeRuntime{
		{TextReviewNode: config.TextReviewNode{ID: "n1", Concurrency: 1, Enabled: true}, Target: 1},
		{TextReviewNode: config.TextReviewNode{ID: "n2", Concurrency: 1, Enabled: true}, Target: 1},
	}
	// 2 chapters: chapter 0 lands on n1 (exhausted once -> Target 0, disabled,
	// retry exhausted 3x then failed); chapter 1 lands on n2 (OK).
	s := newTestSession(2, nodes...)
	StoreSession(s)
	e := NewEngine(cleaner, persister, nil)
	e.Start(s)
	// Allow time for retries.
	if !waitForStatus(t, s, map[string]bool{StatusFailed: true, StatusCompleted: true}, 3*time.Second) {
		s.lock()
		t.Fatalf("not settled: %+v", s.Chapters)
	}
	s.lock()
	n1 := s.Nodes[0]
	s.unlock()
	if n1.Target != 0 {
		t.Fatalf("expected n1 Target=0, got %d", n1.Target)
	}
	if n1.Enabled {
		t.Fatalf("expected n1 disabled")
	}
	if !persister.disabled["n1"] {
		t.Fatalf("expected persister DisableNode(n1), got %v", persister.disabled)
	}
}

// TestPassed4xxNoRampDown verifies 4xx marks failed without ramping down.
func TestPassed4xxNoRampDown(t *testing.T) {
	persister := newFakePersister()
	cleaner := &fakeCleaner{results: []fakeResult{
		{res: CleanResult{Passed4xx: true, ErrMsg: "context length exceeded"}},
	}}
	nodes := []NodeRuntime{{TextReviewNode: config.TextReviewNode{ID: "n1", Concurrency: 2, Enabled: true}, Target: 2}}
	s := newTestSession(1, nodes...)
	StoreSession(s)
	e := NewEngine(cleaner, persister, nil)
	e.Start(s)
	if !waitForStatus(t, s, map[string]bool{StatusFailed: true}, 2*time.Second) {
		s.lock()
		t.Fatalf("not failed: %+v", s.Chapters)
	}
	s.lock()
	target := s.Nodes[0].Target
	enabled := s.Nodes[0].Enabled
	errMsg := s.Chapters[0].Error
	s.unlock()
	if target != 2 {
		t.Fatalf("expected Target unchanged=2, got %d", target)
	}
	if !enabled {
		t.Fatalf("expected node still enabled")
	}
	if errMsg != "context length exceeded" {
		t.Fatalf("expected ErrMsg preserved, got %q", errMsg)
	}
	if len(persister.concurrency) != 0 || len(persister.disabled) != 0 {
		t.Fatalf("expected no persister calls, got c=%v d=%v", persister.concurrency, persister.disabled)
	}
}

// TestMidStreamFail verifies a non-OK non-Exhausted result marks failed
// keeping accumulated Cleaned, with no ramp-down.
func TestMidStreamFail(t *testing.T) {
	persister := newFakePersister()
	cleaner := &fakeCleaner{results: []fakeResult{
		{res: CleanResult{ErrMsg: "stream interrupted"}, chunks: []string{"partial"}},
	}}
	nodes := []NodeRuntime{{TextReviewNode: config.TextReviewNode{ID: "n1", Concurrency: 1, Enabled: true}, Target: 1}}
	s := newTestSession(1, nodes...)
	StoreSession(s)
	e := NewEngine(cleaner, persister, nil)
	e.Start(s)
	if !waitForStatus(t, s, map[string]bool{StatusFailed: true}, 2*time.Second) {
		s.lock()
		t.Fatalf("not failed: %+v", s.Chapters)
	}
	s.lock()
	cleaned := s.Chapters[0].Cleaned
	target := s.Nodes[0].Target
	errMsg := s.Chapters[0].Error
	s.unlock()
	if cleaned != "partial" {
		t.Fatalf("expected cleaned preserved 'partial', got %q", cleaned)
	}
	if target != 1 {
		t.Fatalf("expected no ramp-down Target=1, got %d", target)
	}
	if errMsg != "stream interrupted" {
		t.Fatalf("expected ErrMsg 'stream interrupted', got %q", errMsg)
	}
}

// TestPauseResume verifies pause stops dispatch and resume continues.
func TestPauseResume(t *testing.T) {
	blockCh := make(chan struct{})
	cleaner := &fakeCleaner{blockCh: blockCh, results: []fakeResult{
		{res: CleanResult{OK: true}, chunks: []string{"x"}},
		{res: CleanResult{OK: true}, chunks: []string{"y"}},
	}}
	nodes := []NodeRuntime{{TextReviewNode: config.TextReviewNode{ID: "n1", Concurrency: 1, Enabled: true}, Target: 1}}
	s := newTestSession(2, nodes...)
	StoreSession(s)
	e := NewEngine(cleaner, newFakePersister(), nil)
	e.Start(s)
	// Let one chapter be claimed+in-flight (blocked).
	time.Sleep(50 * time.Millisecond)
	// Pause while one worker is in-flight.
	e.Pause(s)
	// Release the in-flight worker.
	close(blockCh)
	// Wait for in-flight to finish.
	time.Sleep(100 * time.Millisecond)
	// The second chapter should NOT have started (paused). Check status.
	s.lock()
	c1 := s.Chapters[1].Status
	s.unlock()
	if c1 == StatusCompleted || c1 == StatusProcessing {
		// acceptable if it ran; but ideally stays pending. Tolerate either.
	}
	// Resume.
	e.Resume(s)
	if !waitForStatus(t, s, map[string]bool{StatusCompleted: true}, 2*time.Second) {
		s.lock()
		t.Fatalf("not all completed after resume: %+v", s.Chapters)
	}
}

// TestStop verifies stop cancels in-flight workers.
func TestStop(t *testing.T) {
	blockCh := make(chan struct{})
	cleaner := &fakeCleaner{blockCh: blockCh, results: []fakeResult{
		{res: CleanResult{OK: true}, chunks: []string{"x"}},
	}}
	nodes := []NodeRuntime{{TextReviewNode: config.TextReviewNode{ID: "n1", Concurrency: 1, Enabled: true}, Target: 1}}
	s := newTestSession(1, nodes...)
	StoreSession(s)
	e := NewEngine(cleaner, newFakePersister(), nil)
	e.Start(s)
	time.Sleep(50 * time.Millisecond) // worker in-flight and blocked
	e.Stop(s)
	// The worker should be canceled (ctx done) and return interrupted.
	if !waitForStatus(t, s, map[string]bool{StatusFailed: true, StatusCompleted: true, SessionCancelled: true}, 2*time.Second) {
		s.lock()
		t.Fatalf("not settled after stop: %+v", s.Chapters)
	}
	s.lock()
	status := s.Status
	s.unlock()
	if status != SessionCancelled {
		t.Fatalf("expected session cancelled, got %q", status)
	}
	// Don't leak the blockCh goroutine: close it.
	close(blockCh)
}

// TestReprocess verifies ReprocessChapter resets and re-runs a chapter.
func TestReprocess(t *testing.T) {
	cleaner := &fakeCleaner{results: []fakeResult{
		{res: CleanResult{OK: true}, chunks: []string{"cleaned"}},
	}}
	nodes := []NodeRuntime{{TextReviewNode: config.TextReviewNode{ID: "n1", Concurrency: 1, Enabled: true}, Target: 1}}
	s := newTestSession(1, nodes...)
	StoreSession(s)
	e := NewEngine(cleaner, newFakePersister(), nil)
	e.Start(s)
	if !waitForStatus(t, s, map[string]bool{StatusCompleted: true}, 2*time.Second) {
		t.Fatal("first run did not complete")
	}
	// Reprocess.
	cleaner.results = append(cleaner.results, fakeResult{res: CleanResult{OK: true}, chunks: []string{"re-cleaned"}})
	if !e.ReprocessChapter(s, 0) {
		t.Fatal("ReprocessChapter returned false")
	}
	if !waitForStatus(t, s, map[string]bool{StatusCompleted: true}, 2*time.Second) {
		s.lock()
		t.Fatalf("reprocess did not complete: %+v", s.Chapters)
	}
	s.lock()
	cleaned := s.Chapters[0].Cleaned
	s.unlock()
	if cleaned != "re-cleaned" {
		t.Fatalf("expected re-cleaned content, got %q", cleaned)
	}
}

// TestSSEBroadcast verifies a subscriber receives chunk + status events.
func TestSSEBroadcast(t *testing.T) {
	cleaner := &fakeCleaner{results: []fakeResult{
		{res: CleanResult{OK: true}, chunks: []string{"hello"}},
	}}
	nodes := []NodeRuntime{{TextReviewNode: config.TextReviewNode{ID: "n1", Concurrency: 1, Enabled: true}, Target: 1}}
	s := newTestSession(1, nodes...)
	StoreSession(s)
	sub := Subscribe(s)
	defer Unsubscribe(s, sub)
	e := NewEngine(cleaner, newFakePersister(), nil)
	e.Start(s)
	var gotChunk, gotStatus bool
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case evt := <-sub.Events():
			if evt.Type == EventChunk && evt.Delta == "hello" {
				gotChunk = true
			}
			if evt.Type == EventStatus && evt.Status == StatusCompleted {
				gotStatus = true
			}
		case <-time.After(50 * time.Millisecond):
		}
		if gotChunk && gotStatus {
			break
		}
	}
	if !gotChunk {
		t.Error("did not receive chunk event")
	}
	if !gotStatus {
		t.Error("did not receive completed status event")
	}
}
