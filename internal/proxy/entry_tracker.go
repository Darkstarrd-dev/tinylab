package proxy

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/usage"
)

// EntryTracker keeps a concurrent-safe map of in-flight (processing) usage
// entries keyed by their request ID. It is separate from InflightTracker
// which tracks byte-level streaming stats by int64 IDs.
type EntryTracker struct {
	mu      sync.RWMutex
	entries map[string]usage.Entry
	// lastActive records the last heartbeat per request ID. Refresh writes
	// here instead of mutating Entry.Timestamp, so Timestamp stays the true
	// request start (GT/TTFT anchoring, Recent display) while SweepStale
	// still sees stream liveness.
	lastActive map[string]time.Time
}

// NewEntryTracker creates a new EntryTracker.
func NewEntryTracker() *EntryTracker {
	return &EntryTracker{entries: make(map[string]usage.Entry), lastActive: make(map[string]time.Time)}
}

// Register stores a processing entry. Returns true if the entry was newly
// added (false if it already existed with the same ID).
func (t *EntryTracker) Register(e usage.Entry) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, exists := t.entries[e.ID]; exists {
		return false
	}
	t.entries[e.ID] = e
	t.lastActive[e.ID] = time.Now()
	return true
}

// Get returns the entry for the given ID or zero value.
func (t *EntryTracker) Get(id string) (usage.Entry, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	e, ok := t.entries[id]
	return e, ok
}

// Remove deletes the entry for the given ID.
func (t *EntryTracker) Remove(id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	_, ok := t.entries[id]
	if ok {
		delete(t.entries, id)
		delete(t.lastActive, id)
	}
	return ok
}

// All returns a snapshot of all in-flight entries. The caller must treat the
// returned slice as immutable.
func (t *EntryTracker) All() []usage.Entry {
	t.mu.RLock()
	defer t.mu.RUnlock()
	result := make([]usage.Entry, 0, len(t.entries))
	for _, e := range t.entries {
		result = append(result, e)
	}
	return result
}

// Exists returns true if an entry with the given ID is currently tracked.
func (t *EntryTracker) Exists(id string) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	_, ok := t.entries[id]
	return ok
}

// SetTTFT updates the TTFTMs field of a tracked processing entry.
func (t *EntryTracker) SetTTFT(id string, ttftMs int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if e, ok := t.entries[id]; ok {
		e.TTFTMs = ttftMs
		t.entries[id] = e
	}
}

// UpdateTokens updates the InputTokens and OutputTokens fields of a tracked
// processing entry. Pass -1 for either field to skip updating it.
func (t *EntryTracker) UpdateTokens(id string, input, output int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if e, ok := t.entries[id]; ok {
		if input >= 0 {
			e.InputTokens = input
		}
		if output >= 0 {
			e.OutputTokens = output
		}
		t.entries[id] = e
	}
}

// UpdateTokensSplit is the RES/CT-segregated variant: res/ct update the
// per-split live estimates alongside the aggregate output. Monotonic: live
// estimates only move forward, so stale ticker interleavings never regress
// the Recent columns.
// The encrypted sentinel (res == -1) sticks only over the zero value: it
// marks "hidden reasoning seen, nothing countable yet". Any counted plaintext
// (res > current) overwrites it, so plaintext always wins.
func (t *EntryTracker) UpdateTokensSplit(id string, input, output, res, ct int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if e, ok := t.entries[id]; ok {
		if input >= 0 {
			e.InputTokens = input
		}
		if output >= 0 && output > e.OutputTokens {
			e.OutputTokens = output
		}
		if res == reasoningEncryptedSentinel {
			if e.ReasoningTokens == 0 {
				e.ReasoningTokens = res
			}
		} else if res > e.ReasoningTokens && (res != 0 || e.ReasoningTokens != reasoningEncryptedSentinel) {
			// A no-info zero (aggregate-only broadcast) must not clear "enc".
			e.ReasoningTokens = res
		}
		if ct > e.ContentTokens {
			e.ContentTokens = ct
		}
		t.entries[id] = e
	}
}

// Refresh records a liveness heartbeat without touching Entry.Timestamp.
// Called periodically during long streams so an active request is not swept
// as a stale timeout. Timestamp stays the request start: the frontend GT
// anchor (ts+ttft) and TTFT ticking depend on it never moving mid-stream.
func (t *EntryTracker) Refresh(id string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.entries[id]; ok {
		t.lastActive[id] = time.Now()
	}
}

// MarshalEntryJSON returns the JSON representation of an entry, or nil bytes
// if marshalling fails.
func MarshalEntryJSON(e usage.Entry) json.RawMessage {
	b, err := json.Marshal(e)
	if err != nil {
		return nil
	}
	return b
}

// MarshalEntryJSONLight returns a lightweight JSON representation of an entry,
// omitting ReqPayload, RespPayload, ReqHeaders, and RespHeaders to reduce
// transfer size for list/SSE endpoints.
func MarshalEntryJSONLight(e usage.Entry) json.RawMessage {
	e.ReqPayload = nil
	e.RespPayload = nil
	e.ReqHeaders = nil
	e.RespHeaders = nil
	b, err := json.Marshal(e)
	if err != nil {
		return nil
	}
	return b
}

// SweepStale removes and returns entries whose liveness heartbeat (Refresh,
// falling back to Timestamp for entries that never refreshed) is older than
// maxAge.
// The caller is responsible for writing final error records for each returned
// entry and broadcasting request-done events. This is a safety net for
// processing entries that were never completed (e.g. due to a client disconnect
// that bypassed recordUsage).
func (t *EntryTracker) SweepStale(maxAge time.Duration) []usage.Entry {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.entries) == 0 {
		return nil
	}
	cutoff := time.Now().Add(-maxAge)
	var stale []usage.Entry
	for id, e := range t.entries {
		last, ok := t.lastActive[id]
		if !ok {
			last = e.Timestamp
		}
		if last.Before(cutoff) {
			stale = append(stale, e)
			delete(t.entries, id)
			delete(t.lastActive, id)
		}
	}
	return stale
}
