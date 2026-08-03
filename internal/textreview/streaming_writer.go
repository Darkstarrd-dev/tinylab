package textreview

import (
	"context"
	"net/http"
	"strings"
	"sync"
)

// streamingResponseWriter is a custom http.ResponseWriter + http.Flusher that
// captures streamed output live. The proxy's streamResponse path checks
// w.(http.Flusher) (stream.go:32-37) and writes SSE lines via w.Write then
// w.Flush. We mirror those writes onto a channel with backpressure, so a
// concurrent consumer (the Cleaner) can parse SSE chunks as the upstream emits
// them — without waiting for the full stream to end.
//
// Concurrency: the proxy writes from one goroutine; the Cleaner consumes from
// chunks on its own. Write blocks until the consumer reads OR ctx is canceled
// (natural backpressure, no dropped bytes). closeChunks (signalling
// end-of-stream) is guarded by sync.Once. The captured body is the complete
// byte stream, used for error classification after the fact.
type streamingResponseWriter struct {
	ctx        context.Context
	header     http.Header
	statusCode int
	mu         sync.Mutex
	body       strings.Builder
	chunks     chan []byte
	closeOnce  sync.Once
}

func newStreamingResponseWriter(ctx context.Context) *streamingResponseWriter {
	return &streamingResponseWriter{
		ctx:    ctx,
		header: http.Header{},
		chunks: make(chan []byte, 64),
	}
}

// Header returns the response headers (the proxy sets Content-Type etc.).
func (w *streamingResponseWriter) Header() http.Header {
	return w.header
}

// WriteHeader records the status code under w.mu so concurrent readers (the
// classify path reads body/statusCode while the proxy goroutine may still be
// writing) never observe a torn value. Only the first call counts, matching
// net/http semantics.
func (w *streamingResponseWriter) WriteHeader(code int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.statusCode != 0 {
		return
	}
	w.statusCode = code
}

// Write appends p to the captured body and forwards a copy to chunks so the
// consumer can parse SSE live. It blocks until the consumer reads OR ctx is
// canceled — backpressure without dropping bytes. Returns len(p), nil.
func (w *streamingResponseWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	w.mu.Lock()
	w.body.Write(p)
	w.mu.Unlock()
	cp := append([]byte(nil), p...)
	select {
	case w.chunks <- cp:
	case <-w.ctx.Done():
	}
	return len(p), nil
}

// Flush is a no-op presence marker: implementing http.Flusher is what makes
// the proxy's streaming path happy (stream.go:32-37). The actual delivery to
// the consumer happened in Write; Flush just signals "you may read now."
func (w *streamingResponseWriter) Flush() {}

// closeChunks closes the chunk channel once, signalling end-of-stream to the
// consumer. Called when the proxy returns.
func (w *streamingResponseWriter) closeChunks() {
	w.closeOnce.Do(func() { close(w.chunks) })
}
