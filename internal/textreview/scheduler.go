package textreview

import (
	"context"
	"sync/atomic"
	"time"

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

// dispatch is the main scheduling loop. It pops the next pending (or
// needsReprocess) chapter, finds a node with Active < Target && Enabled, and
// spawns a worker goroutine for it. It respects pause (blocks until resumed
// or ctx done) and ctx cancellation. When no chapter is pending and no worker
// is in flight, it marks the session completed.
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

		idx, ok := e.nextPendingChapter(s)
		if !ok {
			// No pending chapter. If no workers in flight, we're done.
			if atomic.LoadInt32(&inFlight) == 0 {
				e.finalizeCompleted(s)
				return
			}
			// Workers still running; wait briefly and re-check.
			select {
			case <-ctx.Done():
				e.finalizeCancelled(s)
				return
			case <-time.After(50 * time.Millisecond):
			}
			continue
		}

		nodeIdx := e.acquireNode(s)
		if nodeIdx < 0 {
			// No node available right now. Mark the chapter back to pending
			// (it was popped as processing) and wait for a worker to release.
			e.requeueChapter(s, idx)
			select {
			case <-ctx.Done():
				e.finalizeCancelled(s)
				return
			case <-time.After(50 * time.Millisecond):
			}
			continue
		}

		atomic.AddInt32(&inFlight, 1)
		go e.runWorker(ctx, s, idx, nodeIdx, &inFlight)
	}
}

// runWorker processes one chapter on one node. It sets the chapter to
// processing, calls the cleaner, then applies the failure rules.
func (e *Engine) runWorker(ctx context.Context, s *Session, chapterIdx, nodeIdx int, inFlight *int32) {
	defer atomic.AddInt32(inFlight, -1)

	s.lock()
	ch := &s.Chapters[chapterIdx]
	ch.Status = StatusProcessing
	ch.NodeID = s.Nodes[nodeIdx].ID
	node := s.Nodes[nodeIdx]
	s.Nodes[nodeIdx].Active++
	content := ch.Content
	s.unlock()
	broadcast(s, Event{Type: EventStatus, ChapterIdx: chapterIdx, Status: StatusProcessing, NodeID: node.ID})
	broadcast(s, Event{Type: EventNode, Nodes: e.nodeSnapshot(s)})

	// Accumulate deltas under the session mutex; broadcast each chunk.
	onChunk := func(delta string) {
		s.lock()
		s.Chapters[chapterIdx].Cleaned += delta
		s.unlock()
		broadcast(s, Event{Type: EventChunk, ChapterIdx: chapterIdx, Delta: delta})
	}

	res := e.cleaner.Clean(ctx, node.TextReviewNode, s.SystemPrompt, content, onChunk)

	s.lock()
	s.Nodes[nodeIdx].Active--
	switch {
	case res.OK:
		s.Chapters[chapterIdx].Status = StatusCompleted
		s.Chapters[chapterIdx].Error = ""
	case res.Exhausted:
		// Ramp-down: Target-- (min 0); at 0 disable.
		if s.Nodes[nodeIdx].Target > 0 {
			s.Nodes[nodeIdx].Target--
		}
		if s.Nodes[nodeIdx].Target == 0 {
			s.Nodes[nodeIdx].Enabled = false
		}
		// Persist the ramp-down decision (outside lock below).
		s.Chapters[chapterIdx].Retry++
		if s.Chapters[chapterIdx].Retry <= maxRetries {
			s.Chapters[chapterIdx].Status = StatusPending
		} else {
			s.Chapters[chapterIdx].Status = StatusFailed
			s.Chapters[chapterIdx].Error = "node exhausted"
		}
	case res.Passed4xx:
		s.Chapters[chapterIdx].Status = StatusFailed
		s.Chapters[chapterIdx].Error = res.ErrMsg
	default: // mid-stream / other failure
		s.Chapters[chapterIdx].Status = StatusFailed
		s.Chapters[chapterIdx].Error = res.ErrMsg
		if s.Chapters[chapterIdx].Error == "" {
			s.Chapters[chapterIdx].Error = "stream interrupted"
		}
	}
	nodeID := s.Nodes[nodeIdx].ID
	target := s.Nodes[nodeIdx].Target
	enabled := s.Nodes[nodeIdx].Enabled
	status := s.Chapters[chapterIdx].Status
	errMsg := s.Chapters[chapterIdx].Error
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
	broadcast(s, Event{Type: EventStatus, ChapterIdx: chapterIdx, Status: status, Error: errMsg, NodeID: nodeID})
}

// nextPendingChapter pops the next chapter whose status is pending or
// needsReprocess, marking it (transiently) processing so it isn't picked
// twice. Returns (index, true) or (-1, false) if none.
func (e *Engine) nextPendingChapter(s *Session) (int, bool) {
	s.lock()
	defer s.unlock()
	for i := range s.Chapters {
		st := s.Chapters[i].Status
		if st == StatusPending || st == StatusNeedsReproc {
			// Leave it pending; the worker will set processing. To avoid
			// double-dispatch we mark it needsReprocess-cleared by setting
			// processing only at worker start. Instead use a claim: set a
			// transitional status here.
			s.Chapters[i].Status = "claimed"
			return i, true
		}
	}
	return -1, false
}

// requeueChapter returns a claimed chapter to pending (no node was available).
func (e *Engine) requeueChapter(s *Session, idx int) {
	s.lock()
	defer s.unlock()
	if s.Chapters[idx].Status == "claimed" {
		s.Chapters[idx].Status = StatusPending
	}
}

// acquireNode finds the first node with Active < Target && Enabled and returns
// its index. The caller bumps Active in the worker (after the chapter is
// claimed) — acquireNode just selects.
func (e *Engine) acquireNode(s *Session) int {
	s.lock()
	defer s.unlock()
	for i := range s.Nodes {
		if s.Nodes[i].Enabled && s.Nodes[i].Active < s.Nodes[i].Target {
			return i
		}
	}
	return -1
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
