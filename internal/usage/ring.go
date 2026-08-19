package usage

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// Entry records a single request's usage.
type Entry struct {
	ID            string          `json:"id"`
	Timestamp     time.Time       `json:"timestamp"`
	Provider      string          `json:"provider"`
	Model         string          `json:"model"`
	OriginalModel string          `json:"originalModel"` // original request model name (alias, before resolution)
	KeyID         string          `json:"keyId"`
	KeyName       string          `json:"keyName"`
	Status        string          `json:"status"` // "success" | "error" | "retry" | "processing"
	LatencyMs     int64           `json:"latencyMs"`
	TTFTMs        int64           `json:"ttftMs"`
	InputTokens   int             `json:"inputTokens"`
	OutputTokens  int             `json:"outputTokens"`
	Error         string          `json:"error,omitempty"`
	ReqPayload    json.RawMessage `json:"reqPayload,omitempty"`
	RespPayload   json.RawMessage `json:"respPayload,omitempty"`
	RespHeaders   http.Header     `json:"respHeaders,omitempty"`
	RespStatus    int             `json:"respStatus,omitempty"`
	ReqHeaders    http.Header     `json:"reqHeaders,omitempty"`
	UpstreamURL   string          `json:"upstreamUrl,omitempty"`
	Decision      string          `json:"decision,omitempty"`
	Provenance    string          `json:"provenance,omitempty"`
	Source        string          `json:"source,omitempty"`     // origin tag, e.g. "playground"
	SessionKey    string          `json:"sessionKey,omitempty"` // inferred conversation root hash; empty = single-shot/ungrouped
}

// UsageStore provides write access to usage entries.
// *RingBuffer implements this interface.
type UsageStore interface {
	Add(entry Entry)
}

// RingBuffer is a fixed-size circular buffer for usage entries. It also
// embeds an Accumulator that keeps process-level cumulative statistics which
// are not affected by ring eviction.
type RingBuffer struct {
	mu      sync.RWMutex
	entries []Entry
	head    int
	size    int
	max     int
	acc     *Accumulator
}

// New creates a RingBuffer with the given capacity.
func New(max int) *RingBuffer {
	if max <= 0 {
		max = 500
	}
	return &RingBuffer{
		entries: make([]Entry, max),
		max:     max,
		acc:     NewAccumulator(),
	}
}

// Add appends an entry to the buffer and feeds it to the accumulator.
func (rb *RingBuffer) Add(entry Entry) {
	rb.acc.Record(entry)
	rb.mu.Lock()
	defer rb.mu.Unlock()
	rb.entries[rb.head] = entry
	rb.head = (rb.head + 1) % rb.max
	if rb.size < rb.max {
		rb.size++
	}
}

// allLocked returns all entries in reverse chronological order. Caller must hold the lock.
func (rb *RingBuffer) allLocked() []Entry {
	result := make([]Entry, rb.size)
	for i := 0; i < rb.size; i++ {
		idx := (rb.head - 1 - i + rb.max) % rb.max
		result[i] = rb.entries[idx]
	}
	return result
}

// All returns all entries in reverse chronological order.
func (rb *RingBuffer) All() []Entry {
	rb.mu.RLock()
	defer rb.mu.RUnlock()
	return rb.allLocked()
}

// ByID returns the entry with the given ID, or zero value and false if not found.
// The ring is searched in reverse chronological order (newest first).
func (rb *RingBuffer) ByID(id string) (Entry, bool) {
	if id == "" {
		return Entry{}, false
	}
	rb.mu.RLock()
	defer rb.mu.RUnlock()
	for i := 0; i < rb.size; i++ {
		idx := (rb.head - 1 - i + rb.max) % rb.max
		if rb.entries[idx].ID == id {
			return rb.entries[idx], true
		}
	}
	return Entry{}, false
}

// Summary returns cumulative aggregate statistics since process start.
// The numbers are independent of the ring buffer capacity.
func (rb *RingBuffer) Summary() CumulativeSummary {
	return rb.acc.Summary()
}

// Accumulator returns the underlying accumulator for direct per-key stat queries.
func (rb *RingBuffer) Accumulator() *Accumulator {
	return rb.acc
}

// ModelStats returns per-model cumulative aggregate statistics.
func (rb *RingBuffer) ModelStats() []ModelStatEntry {
	return rb.acc.ModelStats()
}

// Clear empties the ring buffer but preserves the cumulative accumulator
// (process-level totals are not reset by clearing the recent-requests view).
func (rb *RingBuffer) Clear() {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	rb.head = 0
	rb.size = 0
}

// Resize changes the buffer capacity.
func (rb *RingBuffer) Resize(newMax int) {
	if newMax <= 0 {
		return
	}
	rb.mu.Lock()
	defer rb.mu.Unlock()
	old := rb.allLocked()
	if newMax < len(old) {
		old = old[:newMax]
	}
	rb.entries = make([]Entry, newMax)
	rb.max = newMax
	rb.size = 0
	rb.head = 0
	for i := len(old) - 1; i >= 0; i-- {
		e := old[i]
		rb.entries[rb.head] = e
		rb.head = (rb.head + 1) % rb.max
		if rb.size < rb.max {
			rb.size++
		}
	}
}

// Size returns the current number of entries in the ring buffer.
func (rb *RingBuffer) Size() int {
	rb.mu.RLock()
	defer rb.mu.RUnlock()
	return rb.size
}

// ModelStatEntry holds per-model aggregate statistics for the UI.
type ModelStatEntry struct {
	Provider     string `json:"provider"`
	Model        string `json:"model"`
	SuccessCount int    `json:"successCount"`
	ErrorCount   int    `json:"errorCount"`
	InputTokens  int    `json:"inputTokens"`
	OutputTokens int    `json:"outputTokens"`
}

// Compile-time interface check.
var _ UsageStore = (*RingBuffer)(nil)
