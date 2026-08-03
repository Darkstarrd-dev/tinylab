package textreview

import (
	"context"
	"strconv"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
)

// NodePersister persists concurrency ramp-down decisions back to config. The
// real implementation lives in the api package (registry + SaveConfig); this
// interface keeps the engine testable without touching config persistence.
type NodePersister interface {
	// UpdateNodeConcurrency persists the new concurrency (Target) for the
	// node, keeping it enabled. Returns false if the node was not found.
	UpdateNodeConcurrency(id string, concurrency int) bool
	// DisableNode marks the node disabled with concurrency 0 and persists.
	// Returns false if the node was not found.
	DisableNode(id string) bool
}

// Engine drives the text-review scheduler: it dispatches chapters to worker
// goroutines across the node pool, classifies each clean result, and applies
// the failure rules (ramp-down on Exhausted, fail-fast on 4xx/mid-stream).
type Engine struct {
	cleaner   Cleaner
	persister NodePersister
	log       *console.Logger
}

// NewEngine builds an Engine with the given cleaner and persister.
func NewEngine(cleaner Cleaner, persister NodePersister, log *console.Logger) *Engine {
	return &Engine{cleaner: cleaner, persister: persister, log: log}
}

// maxRetries is the per-chapter retry cap on node exhaustion.
const maxRetries = 3

// Start validates the session and launches the dispatcher goroutine. It is
// idempotent: calling Start on an already-running session is a no-op. The
// session must already be stored (see CreateSession + storeSession).
func (e *Engine) Start(s *Session) bool {
	s.lock()
	if s.Status == SessionRunning || s.Status == SessionPaused {
		s.unlock()
		return false
	}
	enabled := false
	for i := range s.Nodes {
		if s.Nodes[i].Enabled && s.Nodes[i].Target > 0 {
			enabled = true
			break
		}
	}
	if !enabled {
		s.Status = SessionCompleted
		s.unlock()
		broadcast(s, Event{Type: EventStatus, Status: SessionCompleted})
		return false
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.done = make(chan struct{})
	s.Status = SessionRunning
	s.unlock()
	broadcast(s, Event{Type: EventStatus, Status: SessionRunning})
	go e.dispatch(ctx, s)
	return true
}

// dispatch is the main scheduling loop. It acquires a node with a free slot
// (Active<Target, Enabled, and IntervalSec elapsed), claims a batch of pending
// in-range chapters sized to that node's BatchChars, and spawns one worker
// goroutine per batch. It respects pause (blocks until resumed or ctx done)
// and ctx cancellation. The session completes when no in-range chapter is
// pending and no worker is in flight.
func (e *Engine) dispatch(ctx context.Context, s *Session) {
	defer close(s.done)
	var inFlight int32
	for {
		// Respect pause: block here until resumed or cancelled.
		if e.isPaused(s) {
			if !e.waitWhilePaused(ctx, s) {
				return // ctx cancelled
			}
		}
		select {
		case <-ctx.Done():
			e.finalizeCancelled(s)
			return
		default:
		}

		nodeIdx, batch := e.acquireAndClaim(s)
		if len(batch) > 0 {
			atomic.AddInt32(&inFlight, 1)
			go e.runBatch(ctx, s, batch, nodeIdx, &inFlight)
			continue
		}

		// Nothing dispatched: no free node, or no pending in-range chapter. If no
		// worker is in flight and nothing remains pending, the run is complete.
		if atomic.LoadInt32(&inFlight) == 0 && !e.hasPending(s) {
			e.finalizeCompleted(s)
			return
		}
		select {
		case <-ctx.Done():
			e.finalizeCancelled(s)
			return
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// runBatch processes one batch of chapters on one node. A single-chapter
// batch (the node's BatchChars<=0) is exactly the original one-chapter-per-
// request path: OK marks the chapter completed with no quality gate. A
// multi-chapter batch (BatchChars>0) merges the chapters into one LLM call;
// the streamed result is split per chapter and, on OK, any chapter whose
// cleaned text is <10 chars is marked failed. Exhausted/4xx/mid-stream
// failures apply to the whole batch (one ramp-down per batch).
func (e *Engine) runBatch(ctx context.Context, s *Session, batch []int, nodeIdx int, inFlight *int32) {
	defer atomic.AddInt32(inFlight, -1)

	s.lock()
	node := s.Nodes[nodeIdx]
	nodeID := node.ID
	sysPrompt := s.SystemPrompt
	batchChs := make([]BatchChapter, len(batch))
	for j, idx := range batch {
		s.Chapters[idx].Status = StatusProcessing
		s.Chapters[idx].NodeID = nodeID
		batchChs[j] = BatchChapter{Key: strconv.Itoa(idx), Content: s.Chapters[idx].Content}
	}
	s.unlock()

	for _, idx := range batch {
		broadcast(s, Event{Type: EventStatus, ChapterIdx: idx, Status: StatusProcessing, NodeID: nodeID})
	}
	broadcast(s, Event{Type: EventNode, Nodes: e.nodeSnapshot(s)})

	// onChunk routes a streamed delta back to its chapter under the session
	// mutex and broadcasts it to SSE subscribers.
	onChunk := func(chapterKey string, delta string) {
		idx, err := strconv.Atoi(chapterKey)
		if err != nil {
			return
		}
		s.lock()
		s.Chapters[idx].Cleaned += delta
		s.unlock()
		broadcast(s, Event{Type: EventChunk, ChapterIdx: idx, Delta: delta})
	}

	var res CleanResult
	switch {
	case len(batch) == 1:
		idx := batch[0]
		single := func(delta string) { onChunk(strconv.Itoa(idx), delta) }
		res = e.cleaner.Clean(ctx, node.TextReviewNode, sysPrompt, batchChs[0].Content, single)
	default:
		if bc, ok := e.cleaner.(BatchCleaner); ok {
			res = bc.CleanBatch(ctx, node.TextReviewNode, sysPrompt, batchChs, onChunk)
		} else {
			res = e.cleanBatchFallback(ctx, node.TextReviewNode, sysPrompt, batchChs, onChunk)
		}
	}

	// Apply the result under the lock. Ramp-down happens once per batch.
	s.lock()
	s.Nodes[nodeIdx].Active--
	gateEmpty := len(batch) > 1 // <10-char quality gate only for true batches
	if res.Exhausted {
		if s.Nodes[nodeIdx].Target > 0 {
			s.Nodes[nodeIdx].Target--
		}
		if s.Nodes[nodeIdx].Target == 0 {
			s.Nodes[nodeIdx].Enabled = false
		}
	}
	type outcome struct {
		idx    int
		status string
		errMsg string
	}
	outs := make([]outcome, len(batch))
	for j, idx := range batch {
		ch := &s.Chapters[idx]
		switch {
		case res.OK:
			if gateEmpty && len(ch.Cleaned) < 10 {
				ch.Status = StatusFailed
				ch.Error = "empty result"
				outs[j] = outcome{idx, StatusFailed, "empty result"}
			} else {
				ch.Status = StatusCompleted
				ch.Error = ""
				outs[j] = outcome{idx, StatusCompleted, ""}
			}
		case res.Exhausted:
			ch.Retry++
			if ch.Retry <= maxRetries {
				ch.Status = StatusPending
				outs[j] = outcome{idx, StatusPending, ""}
			} else {
				ch.Status = StatusFailed
				ch.Error = "node exhausted"
				outs[j] = outcome{idx, StatusFailed, "node exhausted"}
			}
		case res.Passed4xx:
			ch.Status = StatusFailed
			ch.Error = res.ErrMsg
			outs[j] = outcome{idx, StatusFailed, res.ErrMsg}
		default: // mid-stream / other failure
			msg := res.ErrMsg
			if msg == "" {
				msg = "stream interrupted"
			}
			ch.Status = StatusFailed
			ch.Error = msg
			outs[j] = outcome{idx, StatusFailed, msg}
		}
	}
	nodeID = s.Nodes[nodeIdx].ID
	target := s.Nodes[nodeIdx].Target
	enabled := s.Nodes[nodeIdx].Enabled
	s.unlock()

	// Persist ramp-down decision to config.yaml (permanent write).
	if res.Exhausted {
		if target == 0 || !enabled {
			if e.persister != nil {
				e.persister.DisableNode(nodeID)
			}
		} else if e.persister != nil {
			e.persister.UpdateNodeConcurrency(nodeID, target)
		}
	}

	broadcast(s, Event{Type: EventNode, Nodes: e.nodeSnapshot(s)})
	for _, o := range outs {
		broadcast(s, Event{Type: EventStatus, ChapterIdx: o.idx, Status: o.status, Error: o.errMsg, NodeID: nodeID})
	}
}

// cleanBatchFallback handles a multi-chapter batch when the cleaner does not
// implement BatchCleaner (e.g. a test fake): it cleans each chapter with a
// separate Clean call, stopping at the first non-OK result. This is not true
// batching but keeps behavior correct; production uses ProxyCleaner.CleanBatch.
func (e *Engine) cleanBatchFallback(ctx context.Context, node config.TextReviewNode, sysPrompt string, batchChs []BatchChapter, onChunk func(chapterKey string, delta string)) CleanResult {
	var res CleanResult
	for _, bc := range batchChs {
		key := bc.Key
		single := func(delta string) { onChunk(key, delta) }
		res = e.cleaner.Clean(ctx, node, sysPrompt, bc.Content, single)
		if !res.OK {
			return res
		}
	}
	return res
}

// dequeueBatch selects a batch of chapter indices to clean in one request. It
// scans chapters in order; the first pending (or needsReprocess) chapter is
// always taken, then pending chapters are accumulated while their content fits
// within maxChars. maxChars<=0 means no batching: exactly one chapter is taken.
// dequeueBatch is pure: it does not mutate chapters; the caller marks them
// claimed.
func dequeueBatch(chapters []Chapter, maxChars int) []int {
	var batch []int
	accChars := 0
	for i := range chapters {
		st := chapters[i].Status
		if st != StatusPending && st != StatusNeedsReproc {
			continue
		}
		if len(batch) == 0 {
			batch = append(batch, i)
			accChars += utf8.RuneCountInString(chapters[i].Content)
			continue
		}
		if maxChars <= 0 {
			break // no batching: one chapter only
		}
		if accChars >= maxChars {
			break
		}
		if accChars+utf8.RuneCountInString(chapters[i].Content) > maxChars {
			break
		}
		batch = append(batch, i)
		accChars += utf8.RuneCountInString(chapters[i].Content)
	}
	return batch
}

// acquireAndClaim finds the first node with a free slot — Active<Target,
// Enabled, and (when IntervalSec>0) past its last dispatch time — that has
// pending in-range chapters, claims a batch for it sized to the node's
// BatchChars, bumps Active, and records the dispatch time. Returns
// (nodeIdx, batch); (-1, nil) if no node can take work right now.
func (e *Engine) acquireAndClaim(s *Session) (int, []int) {
	s.lock()
	defer s.unlock()
	now := time.Now()
	for i := range s.Nodes {
		n := &s.Nodes[i]
		if !n.Enabled || n.Active >= n.Target {
			continue
		}
		if n.IntervalSec > 0 && !n.lastRequest.IsZero() && now.Sub(n.lastRequest) < time.Duration(n.IntervalSec)*time.Second {
			continue
		}
		batch := e.nextBatchLocked(s, n.BatchChars)
		if len(batch) == 0 {
			continue // node free but nothing pending; try the next node
		}
		n.Active++
		n.lastRequest = now
		return i, batch
	}
	return -1, nil
}

// nextBatchLocked dequeues a batch of pending, in-range chapters sized to
// maxChars and marks each "claimed" so it is not picked twice. Must be called
// under the session lock. Returns the chapter indices (empty if none).
func (e *Engine) nextBatchLocked(s *Session, maxChars int) []int {
	// Only consider eligible chapters (snapshot at session creation) that are
	// still pending or need reprocessing. Fall back to all chapters if Eligible
	// is nil (e.g. test sessions created without CreateSession).
	eligible := s.Eligible
	if eligible == nil {
		eligible = make([]int, len(s.Chapters))
		for i := range s.Chapters {
			eligible[i] = i
		}
	}
	var view []Chapter
	var orig []int
	for _, idx := range eligible {
		st := s.Chapters[idx].Status
		if st != StatusPending && st != StatusNeedsReproc {
			continue
		}
		view = append(view, s.Chapters[idx])
		orig = append(orig, idx)
	}
	sel := dequeueBatch(view, maxChars)
	batch := make([]int, len(sel))
	for j, f := range sel {
		batch[j] = orig[f]
	}
	for _, idx := range batch {
		s.Chapters[idx].Status = "claimed"
	}
	return batch
}

// hasPending reports whether any eligible chapter is still pending or marked
// needsReprocess. When false, the session has processed its full range and
// should finalize.
func (e *Engine) hasPending(s *Session) bool {
	s.lock()
	defer s.unlock()
	eligible := s.Eligible
	if eligible == nil {
		eligible = make([]int, len(s.Chapters))
		for i := range s.Chapters {
			eligible[i] = i
		}
	}
	for _, idx := range eligible {
		st := s.Chapters[idx].Status
		if st == StatusPending || st == StatusNeedsReproc {
			return true
		}
	}
	return false
}

// nodeSnapshot returns a copy of the node runtime slice for SSE broadcast.
func (e *Engine) nodeSnapshot(s *Session) []NodeRuntime {
	s.lock()
	defer s.unlock()
	out := make([]NodeRuntime, len(s.Nodes))
	copy(out, s.Nodes)
	return out
}

// isPaused reports whether the session is paused (under lock).
func (e *Engine) isPaused(s *Session) bool {
	s.lock()
	defer s.unlock()
	return s.paused
}

// waitWhilePaused blocks until the session is resumed or ctx is cancelled.
// Returns true if resumed, false if cancelled.
func (e *Engine) waitWhilePaused(ctx context.Context, s *Session) bool {
	for {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(50 * time.Millisecond):
		}
		if !e.isPaused(s) {
			return true
		}
	}
}

// finalizeCompleted marks the session completed (no pending, no in-flight).
func (e *Engine) finalizeCompleted(s *Session) {
	s.lock()
	if s.Status != SessionCancelled {
		s.Status = SessionCompleted
	}
	status := s.Status
	s.unlock()
	broadcast(s, Event{Type: EventStatus, Status: status})
}

// finalizeCancelled marks the session cancelled (stop/cancel).
func (e *Engine) finalizeCancelled(s *Session) {
	s.lock()
	s.Status = SessionCancelled
	s.unlock()
	broadcast(s, Event{Type: EventStatus, Status: SessionCancelled})
}

// Pause sets the paused flag; in-flight workers continue, the dispatcher stops
// picking up new chapters. No-op if not running.
func (e *Engine) Pause(s *Session) {
	s.lock()
	if s.Status == SessionRunning {
		s.Status = SessionPaused
		s.paused = true
	}
	status := s.Status
	s.unlock()
	broadcast(s, Event{Type: EventStatus, Status: status})
}

func (e *Engine) Resume(s *Session) {
	s.lock()
	s.paused = false
	if s.Status == SessionPaused {
		s.Status = SessionRunning
	}
	status := s.Status
	s.unlock()
	broadcast(s, Event{Type: EventStatus, Status: status})
}

// Stop cancels the dispatcher and in-flight workers, marking the session
// cancelled. Idempotent.
func (e *Engine) Stop(s *Session) {
	s.lock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.Status = SessionCancelled
	s.paused = false
	s.unlock()
	broadcast(s, Event{Type: EventStatus, Status: SessionCancelled})
}

// ReprocessChapter resets a single chapter to pending (clearing its cleaned
// text and retry count) and nudges the dispatcher. If the session is not
// running, it starts it.
func (e *Engine) ReprocessChapter(s *Session, idx int) bool {
	s.lock()
	if idx < 0 || idx >= len(s.Chapters) {
		s.unlock()
		return false
	}
	s.Chapters[idx].Cleaned = ""
	s.Chapters[idx].Status = StatusPending
	s.Chapters[idx].Retry = 0
	s.Chapters[idx].Error = ""
	running := s.Status == SessionRunning || s.Status == SessionPaused
	s.unlock()
	broadcast(s, Event{Type: EventStatus, ChapterIdx: idx, Status: StatusPending})
	if !running {
		e.Start(s)
	}
	return true
}
