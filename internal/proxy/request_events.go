package proxy

import (
	"encoding/json"
	"sync/atomic"
	"time"
)

// requestIDCounter generates globally unique string IDs for inflight usage
// entries. Format: "r<base62-nanos>-<6-char-random-hex>". The nanos prefix
// (in base62 to keep IDs compact for JSON transport) gives a time-ordered
// component while the random suffix guarantees uniqueness even for requests
// that start within the same nanosecond.
var requestIDCounter int64
var requestIDSeed [2]byte

func init() {
	// Seed the random suffix generator once at startup.
	r := time.Now().UnixNano()
	requestIDSeed[0] = byte(r >> 56)
	requestIDSeed[1] = byte(r >> 48)
}

func generateRequestID() string {
	// Use nanos as base62 prefix for compact, time-ordered IDs.
	_ = atomic.AddInt64(&requestIDCounter, 1)
	ts := time.Now().UnixNano()
	// Encode nanos in base62 (compact, alphanumeric, safe for JSON keys)
	tsStr := encodeBase62(ts)
	return "r" + tsStr + "-" + hexSuffix(requestIDSeed)
}

func hexSuffix(seed [2]byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 6)
	v := uint32(seed[0])<<24 | uint32(seed[1])<<16 | uint32(time.Now().UnixNano())>>16
	for i := 5; i >= 0; i-- {
		out[i] = digits[v%16]
		v /= 16
	}
	return string(out)
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
