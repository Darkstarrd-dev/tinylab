package proxy

import (
	"encoding/json"
	"sync/atomic"
	"time"
)

// requestIDCounter generates globally unique string IDs for inflight usage
// entries. Format: "r<base62-nanos>-<base62-counter>". The nanos prefix (in
// base62 to keep IDs compact for JSON transport) gives a time-ordered
// component; the atomic counter folded into the suffix guarantees uniqueness
// even for requests that start within the same nanosecond.
var requestIDCounter int64

func generateRequestID() string {
	// Nanos as a base62 prefix for compact, time-ordered IDs; the atomic
	// counter suffix disambiguates concurrent requests that share the same
	// nanosecond (the pre-fix code discarded the counter and derived the
	// "random" suffix from time.Now() alone, so two requests in the same
	// nanosecond collided).
	n := atomic.AddInt64(&requestIDCounter, 1)
	ts := time.Now().UnixNano()
	tsStr := encodeBase62(ts)
	return "r" + tsStr + "-" + encodeBase62(n)
}

func encodeBase62(n int64) string {
	if n == 0 {
		return "0"
	}
	const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	var buf [24]byte
	i := len(buf)
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = chars[n%62]
		n /= 62
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// RequestEvent is the payload sent over the RequestUpdates broadcaster. The
// frontend subscribes to GET /api/monitor/events and receives typed chunks for
// each stage of a request lifecycle.
type RequestEvent struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Status  string          `json:"status,omitempty"`
	Section string          `json:"section,omitempty"`
	Delta   string          `json:"delta,omitempty"`
	Entry   json.RawMessage `json:"entry,omitempty"`
}
