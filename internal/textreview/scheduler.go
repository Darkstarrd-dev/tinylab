package textreview

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/tinylab/tinylab/internal/console"
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
// (Active<Target, Enabled, and IntervalSec elapsed), claims the next pending
// in-range chapter for it, and spawns one worker goroutine per chapter. It
// respects pause (blocks until resumed or ctx done) and ctx cancellation. The
// session completes when no in-range chapter is pending and no worker is in
// flight.
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

		nodeIdx, idx := e.acquireAndClaim(s)
		if idx >= 0 {
			atomic.AddInt32(&inFlight, 1)
			go e.runChapter(ctx, s, idx, nodeIdx, &inFlight)
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

// runChapter cleans one chapter on one node. Every request carries exactly one
// chapter — the step-2 split result; there is no multi-chapter batching. OK
// marks the chapter completed; Exhausted/4xx/mid-stream failures apply to the
// chapter alone, with at most one ramp-down per failed request.
func (e *Engine) runChapter(ctx context.Context, s *Session, idx int, nodeIdx int, inFlight *int32) {
	defer atomic.AddInt32(inFlight, -1)

	s.lock()
	node := s.Nodes[nodeIdx]
	nodeID := node.ID
	sysPrompt := s.SystemPrompt
	content := s.Chapters[idx].Content
	s.Chapters[idx].Status = StatusProcessing
	s.Chapters[idx].NodeID = nodeID
	// 在发起 LLM 请求前预先构建并写入 DebugRequest，确保处理中阶段 Debug 面板立即可见请求体
	var preReq string
	if b, err := buildRequestBody(node.ModelID, sysPrompt, content, node.Reasoning); err == nil {
		preReq = string(b)
	}
	if preReq != "" {
		s.Chapters[idx].DebugRequest = preReq
	}
	s.unlock()

	broadcast(s, Event{Type: EventStatus, ChapterIdx: intPtr(idx), Status: StatusProcessing, NodeID: nodeID})
	broadcast(s, Event{Type: EventNode, Nodes: e.nodeSnapshot(s)})

	// onChunk appends a streamed delta to the chapter under the session mutex
	// and broadcasts it to SSE subscribers.
	onChunk := func(delta string) {
		s.lock()
		s.Chapters[idx].Cleaned += delta
		s.unlock()
		broadcast(s, Event{Type: EventChunk, ChapterIdx: intPtr(idx), Delta: delta})
	}

	// onRaw broadcasts unparsed raw stream deltas (with section="thinking" or "content")
	// to SSE subscribers for real-time debug visualization.
	onRaw := func(section, delta string) {
		if delta == "" {
			return
		}
		broadcast(s, Event{Type: EventRaw, ChapterIdx: intPtr(idx), Section: section, Delta: delta})
	}

	var res CleanResult
	if rc, ok := e.cleaner.(RawCleaner); ok {
		res = rc.CleanWithRaw(ctx, node.TextReviewNode, sysPrompt, content, onChunk, onRaw)
	} else {
		res = e.cleaner.Clean(ctx, node.TextReviewNode, sysPrompt, content, onChunk)
	}

	// Apply the result under the lock. Ramp-down happens once per request.
	s.lock()
	s.Nodes[nodeIdx].Active--

	ch := &s.Chapters[idx]
	if res.DebugRequest != "" {
		ch.DebugRequest = res.DebugRequest
	}
	ch.DebugRawBody = res.DebugRawBody
	ch.DebugStatusCode = res.DebugStatusCode

	var status, errMsg string
	switch {
	case res.Exhausted:
		if s.Nodes[nodeIdx].Target > 0 {
			s.Nodes[nodeIdx].Target--
		}
		if s.Nodes[nodeIdx].Target == 0 {
			s.Nodes[nodeIdx].Enabled = false
		}
		ch.Retry++
		if ch.Retry <= maxRetries {
			status, errMsg = StatusPending, ""
		} else {
			status, errMsg = StatusFailed, "node exhausted"
		}
	case res.OK:
		status = StatusCompleted
	case res.Passed4xx:
		status, errMsg = StatusFailed, res.ErrMsg
	default: // mid-stream / other failure
		errMsg = res.ErrMsg
		if errMsg == "" {
			errMsg = "stream interrupted"
		}
		status = StatusFailed
	}
	ch.Status = status
	ch.Error = errMsg
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
	broadcast(s, Event{Type: EventStatus, ChapterIdx: intPtr(idx), Status: status, Error: errMsg, NodeID: nodeID})
}

// nextPendingIdx returns the index of the first pending (or needsReprocess)
// chapter in chapters, or -1 if none. Pure: it does not mutate chapters; the
// caller marks the winner claimed.
func nextPendingIdx(chapters []Chapter) int {
	for i := range chapters {
		st := chapters[i].Status
		if st == StatusPending || st == StatusNeedsReproc {
			return i
		}
	}
	return -1
}

// acquireAndClaim finds the first node with a free slot — Active<Target,
// Enabled, and (when IntervalSec>0) past its last dispatch time — that has
// pending in-range chapters, claims one chapter for it, bumps Active, and
// records the dispatch time. Returns (nodeIdx, chapterIdx); (-1, -1) if no
// node can take work right now.
func (e *Engine) acquireAndClaim(s *Session) (int, int) {
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
		idx := e.nextChapterLocked(s)
		if idx < 0 {
			continue // node free but nothing pending; try the next node
		}
		n.Active++
		n.lastRequest = now
		return i, idx
	}
	return -1, -1
}

// nextChapterLocked picks the first pending, in-range chapter and marks it
// "claimed" so it is not picked twice. Must be called under the session lock.
// Returns the chapter index (-1 if none).
func (e *Engine) nextChapterLocked(s *Session) int {
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
	sel := nextPendingIdx(view)
	if sel < 0 {
		return -1
	}
	idx := orig[sel]
	s.Chapters[idx].Status = "claimed"
	return idx
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
	s.Chapters[idx].DebugRequest = ""
	s.Chapters[idx].DebugRawBody = ""
	s.Chapters[idx].DebugStatusCode = 0
	running := s.Status == SessionRunning || s.Status == SessionPaused
	s.unlock()
	broadcast(s, Event{Type: EventStatus, ChapterIdx: intPtr(idx), Status: StatusPending})
	if !running {
		e.Start(s)
	}
	return true
}
