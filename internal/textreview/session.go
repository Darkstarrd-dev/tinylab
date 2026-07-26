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
}

// NodeRuntime wraps a configured TextReviewNode with live scheduling state.
// Active is the current in-flight count; Target is the current allowed slot
// count (ramps down on Exhausted, never above the configured Concurrency).
type NodeRuntime struct {
	config.TextReviewNode
	Active int `json:"active"`
	Target int `json:"target"`
}

// CreateSessionRequest is the body of POST /sessions.
type CreateSessionRequest struct {
	FileName     string          `json:"fileName"`
	RawText      string          `json:"rawText"`
	Chapters     []CreateChapter `json:"chapters"`
	SystemPrompt string          `json:"systemPrompt"`
	NodeIDs      []string        `json:"nodeIds"`
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

	mu     sync.Mutex
	paused bool
	cancel context.CancelFunc
	done   chan struct{}
	subs   []*Subscriber
}

// mu helpers — the scheduler and workers lock the session to mutate chapters
// and node runtime state. HTTP handlers use Snapshot for a consistent read.

func (s *Session) lock()   { s.mu.Lock() }
func (s *Session) unlock() { s.mu.Unlock() }

// sessions is the in-memory session store. Sessions do not persist across
// restarts (confirmed decision: no state.yaml for text-review).
var sessions sync.Map // map[string]*Session

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
	s := &Session{
		ID:           apibase.GenerateID("tr"),
		FileName:     req.FileName,
		RawText:      req.RawText,
		Chapters:     chapters,
		Nodes:        nodes,
		SystemPrompt: req.SystemPrompt,
		Status:       SessionIdle,
		CreatedAt:    time.Now(),
	}
	return s
}

// GetSession returns the session with the given ID, or nil if not found.
func GetSession(id string) *Session {
	v, ok := sessions.Load(id)
	if !ok {
		return nil
	}
	return v.(*Session)
}

// StoreSession records a session in the global map.
func StoreSession(s *Session) {
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
	}
}
