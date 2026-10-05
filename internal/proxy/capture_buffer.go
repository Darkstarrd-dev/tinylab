package proxy

import "bytes"

// cappedBodyBuffer is a bounded capture buffer for streaming response bodies
// (F-06). It retains the first cap bytes written to it and counts the total
// so the caller can emit a truncation marker carrying the true stream size.
// Token/usage extraction in the streaming read loop is incremental (per SSE
// line) and does not depend on this buffer — the buffer exists only for the
// diagnostic payload captured at end of stream. Writes are goroutine-safe by
// construction of the call sites: only the single stream read loop writes.
type cappedBodyBuffer struct {
	buf   bytes.Buffer
	total int64
	cap   int
}

func newCappedBodyBuffer(capacity int) *cappedBodyBuffer {
	return &cappedBodyBuffer{cap: capacity}
}

// Write appends p up to the remaining budget and always reports len(p)
// written; bytes beyond the cap are counted but discarded.
func (b *cappedBodyBuffer) Write(p []byte) (int, error) {
	b.total += int64(len(p))
	if remaining := b.cap - b.buf.Len(); remaining > 0 {
		if len(p) > remaining {
			b.buf.Write(p[:remaining])
		} else {
			b.buf.Write(p)
		}
	}
	return len(p), nil
}

// Bytes returns the retained head of the stream (at most cap bytes).
func (b *cappedBodyBuffer) Bytes() []byte { return b.buf.Bytes() }

// Total returns the true number of bytes written, including the discarded
// tail.
func (b *cappedBodyBuffer) Total() int64 { return b.total }

// Truncated reports whether any bytes were discarded.
func (b *cappedBodyBuffer) Truncated() bool { return b.total > int64(b.buf.Len()) }
