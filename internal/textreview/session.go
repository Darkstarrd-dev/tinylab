package textreview

import (
	"context"
	"sync"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

// Chapter status constants.
const (
	StatusPending     = "pending"
	StatusProcessing  = "processing"
	StatusCompleted   = "completed"
	StatusFailed      = "failed"
	StatusNeedsReproc = "needsReprocess"
)

// Session lifecycle statuses.
const (
	SessionIdle      = "idle"
	SessionRunning   = "running"
	SessionPaused    = "paused"
	SessionCompleted = "completed"
	SessionCancelled = "cancelled"
)

// Chapter is one unit of text to be cleaned. Content is immutable; Cleaned
// accumulates the streamed result under the session mutex.
type Chapter struct {
	Index   int    `json:"index"`
	Title   string `json:"title"`
	Content string `json:"content"`
	Cleaned string `json:"cleaned"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
	NodeID  string `json:"nodeId,omitempty"`
	Retry   int    `json:"retry"`

	// 调试信息：最近一次清洗尝试的请求/响应原始数据
	DebugRequest    string `json:"debugRequest,omitempty"`
	DebugRawBody    string `json:"debugRawBody,omitempty"`
	DebugStatusCode int    `json:"debugStatusCode,omitempty"`
}

// NodeRuntime wraps a configured TextReviewNode with live scheduling state.
// Active is the current in-flight count; Target is the current allowed slot
// count (ramps down on Exhausted, never above the configured Concurrency).
type NodeRuntime struct {
	config.TextReviewNode
	Active int `json:"active"`
	Target int `json:"target"`
	// lastRequest is the dispatch time of the most recent batch on this node,
	// used for IntervalSec rate-limiting. Unexported — not serialized.
	lastRequest time.Time
}

// CreateSessionRequest is the body of POST /sessions.
type CreateSessionRequest struct {
	FileName     string          `json:"fileName"`
	RawText      string          `json:"rawText"`
	Chapters     []CreateChapter `json:"chapters"`
	SystemPrompt string          `json:"systemPrompt"`
	NodeIDs      []string        `json:"nodeIds"`
	// RangeStart/RangeEnd restrict cleaning to chapters in the half-open
	// index range [RangeStart, RangeEnd). Both 0 (the default) means all
	// chapters are cleaned.
	RangeStart int `json:"rangeStart,omitempty"`
	RangeEnd   int `json:"rangeEnd,omitempty"`
}

// CreateChapter is one chapter in a create-session request.
type CreateChapter struct {
	Title   string `json:"title"`
	Content string `json:"content"`
}

// Session holds the full state of one text-review run. It is safe for
// concurrent use: all mutable fields are guarded by mu. The dispatcher and
// workers run in their own goroutines; HTTP handlers read snapshots.
type Session struct {
	ID           string        `json:"id"`
	FileName     string        `json:"fileName"`
	RawText      string        `json:"-"`
	Chapters     []Chapter     `json:"chapters"`
	Nodes        []NodeRuntime `json:"nodes"`
	SystemPrompt string        `json:"systemPrompt"`
	Status       string        `json:"status"`
	CreatedAt    time.Time     `json:"createdAt"`
	LastAccess   time.Time     `json:"-"`
	RangeStart   int           `json:"rangeStart,omitempty"`
	RangeEnd     int           `json:"rangeEnd,omitempty"`
	Eligible     []int         `json:"-"` // chapter indices eligible for this session (snapshot at creation)

	mu     sync.Mutex
	paused bool
	cancel context.CancelFunc
	done   chan struct{}
	subs   []*Subscriber
}

// mu helpers — the scheduler and workers lock the session to mutate chapters
// and node runtime state. HTTP handlers use Snapshot for a consistent read.

// Lock exposes the session mutex for handler use (e.g. restart). Prefer the
// internal lock/unlock helpers inside the textreview package.
func (s *Session) Lock()   { s.mu.Lock() }
func (s *Session) Unlock() { s.mu.Unlock() }

func (s *Session) lock()   { s.mu.Lock() }
func (s *Session) unlock() { s.mu.Unlock() }

func (s *Session) touchLocked() { s.LastAccess = time.Now() }
func (s *Session) Touch() {
	s.lock()
	s.touchLocked()
	s.unlock()
}

// sessions is the in-memory session store. Sessions do not persist across
// restarts (confirmed decision: no state.yaml for text-review).
var sessions sync.Map // map[string]*Session

// P1-03c: bounds to prevent unbounded growth.
const (
	MaxSessions      = 50
	MaxSessionBytes  = 50 << 20 // ~50 MiB aggregate RawText+Cleaned estimate
	SessionTTL       = 2 * time.Hour
	SweepInterval    = 15 * time.Minute
)

var sweepOnce sync.Once

func EnsureSweep() {
	sweepOnce.Do(func() {
		go func() {
			t := time.NewTicker(SweepInterval)
			defer t.Stop()
			for range t.C {
				SweepExpired(time.Now())
			}
		}()
	})
}

func SweepExpired(now time.Time) int {
	n := 0
	sessions.Range(func(key, val any) bool {
		s, _ := val.(*Session)
		if s == nil {
			return true
		}
		s.lock()
		expired := !s.LastAccess.IsZero() && now.Sub(s.LastAccess) > SessionTTL
		isTerminal := s.Status == SessionCompleted || s.Status == SessionCancelled
		s.unlock()
		if expired || (isTerminal && now.Sub(s.CreatedAt) > SessionTTL) {
			if s2, ok := sessions.LoadAndDelete(key); ok {
				if ss, ok := s2.(*Session); ok {
					ss.lock()
					if ss.cancel != nil {
						ss.cancel()
					}
					ss.unlock()
				}
				n++
			}
		}
		return true
	})
	return n
}

func SessionCount() int {
	c := 0
	sessions.Range(func(_, _ any) bool { c++; return true })
	return c
}

func EstimateBytes() int64 {
	var total int64
	sessions.Range(func(_, val any) bool {
		s, _ := val.(*Session)
		if s == nil {
			return true
		}
		s.lock()
		for i := range s.Chapters {
			total += int64(len(s.Chapters[i].Content))
			total += int64(len(s.Chapters[i].Cleaned))
		}
		total += int64(len(s.RawText))
		s.unlock()
		return true
	})
	return total
}

// ClearAllSessions stops all active sessions, removes them from the store,
// and frees resources.
func ClearAllSessions() {
	sessions.Range(func(key, _ any) bool {
		if id, ok := key.(string); ok {
			DeleteSession(id)
		}
		return true
	})
}

// CreateSession builds a Session from the request, resolving nodeIds against
// the configured processing pool. Chapters are indexed by array position.
// Returns the session (not yet started). The caller invokes Start.
func CreateSession(req CreateSessionRequest, d *apibase.Deps) *Session {
	configNodes := map[string]config.TextReviewNode{}
	if d != nil && d.Reg != nil {
		for _, n := range d.Reg.ListTextReviewNodes() {
			configNodes[n.ID] = n
		}
	}
	chapters := make([]Chapter, len(req.Chapters))
	for i, c := range req.Chapters {
		chapters[i] = Chapter{
			Index:   i,
			Title:   c.Title,
			Content: c.Content,
			Status:  StatusPending,
		}
	}
	nodes := make([]NodeRuntime, 0, len(req.NodeIDs))
	for _, id := range req.NodeIDs {
		n, ok := configNodes[id]
		if !ok {
			continue
		}
		nodes = append(nodes, NodeRuntime{
			TextReviewNode: n,
			Target:         n.Concurrency,
		})
	}
	// Compute eligible chapter indices: positions [RangeStart, RangeEnd) in the
	// pending queue at session creation (all chapters start pending, so this is
	// just the index range). The session processes only these chapters and
	// completes when they're all done — the user can Start again with the same
	// range to process the next batch.
	eligibleEnd := len(chapters)
	if req.RangeEnd > 0 && req.RangeEnd < eligibleEnd {
		eligibleEnd = req.RangeEnd
	}
	eligibleStart := req.RangeStart
	if eligibleStart > len(chapters) {
		eligibleStart = len(chapters)
	}
	eligible := make([]int, 0, eligibleEnd-eligibleStart)
	for i := eligibleStart; i < eligibleEnd; i++ {
		eligible = append(eligible, i)
	}
	now := time.Now()
	s := &Session{
		ID:           apibase.GenerateID("tr"),
		FileName:     req.FileName,
		RawText:      req.RawText,
		Chapters:     chapters,
		Nodes:        nodes,
		SystemPrompt: req.SystemPrompt,
		Status:       SessionIdle,
		CreatedAt:    now,
		LastAccess:   now,
		RangeStart:   req.RangeStart,
		RangeEnd:     req.RangeEnd,
		Eligible:     eligible,
	}
	return s
}

// GetSession returns the session with the given ID, or nil if not found.
func GetSession(id string) *Session {
	v, ok := sessions.Load(id)
	if !ok {
		return nil
	}
	s := v.(*Session)
	s.Touch()
	return s
}

// StoreSession records a session in the global map.
func StoreSession(s *Session) {
	EnsureSweep()
	// Enforce MaxSessions by evicting oldest terminal/oldest if needed.
	if SessionCount() >= MaxSessions {
		// Evict one expired or oldest terminal first.
		SweepExpired(time.Now())
	}
	sessions.Store(s.ID, s)
}

// DeleteSession removes a session from the global map. It cancels any running
// work first. Returns false if the session did not exist.
func DeleteSession(id string) bool {
	v, ok := sessions.LoadAndDelete(id)
	if !ok {
		return false
	}
	s := v.(*Session)
	s.lock()
	if s.cancel != nil {
		s.cancel()
	}
	s.unlock()
	return true
}

// Snapshot returns a deep-enough copy of the session for JSON serialization:
// chapter Cleaned/Status/Error/NodeID/Retry and node Active/Target reflect
// the current live state, taken under the session mutex. The returned copy
// is safe to encode without holding the lock.
func (s *Session) Snapshot() *Session {
	s.lock()
	s.touchLocked()
	defer s.unlock()
	chapters := make([]Chapter, len(s.Chapters))
	copy(chapters, s.Chapters)
	nodes := make([]NodeRuntime, len(s.Nodes))
	copy(nodes, s.Nodes)
	return &Session{
		ID:           s.ID,
		FileName:     s.FileName,
		Chapters:     chapters,
		Nodes:        nodes,
		SystemPrompt: s.SystemPrompt,
		Status:       s.Status,
		CreatedAt:    s.CreatedAt,
		LastAccess:   s.LastAccess,
		RangeStart:   s.RangeStart,
		RangeEnd:     s.RangeEnd,
	}
}
