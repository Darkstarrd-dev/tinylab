package proxy

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/rotation"
)

// F-02: streaming upstreams previously had NO timeout at all — a hung
// upstream (connected but never sending response headers, or stopping
// mid-stream without closing) pinned the handler goroutine and the key
// forever, and failover never triggered. Two independent bounds apply:
//
//   - First-byte timeout (defaultStreamTTFBTimeoutSec): dial → request sent →
//     response headers. Enforced by a derived context canceled by a timer;
//     a timeout surfaces as a Do error inside forwardWithRetry and takes the
//     network-error branch — the key is cooled and the loop fails over.
//   - Idle timeout (defaultStreamIdleTimeoutSec): max gap between reads of an
//     established stream. Enforced by idleTimeoutBody; a timeout aborts the
//     read with StreamIdleTimeoutError. The 200 was already committed to the
//     client, so no failover is possible — the point is to free the goroutine
//     and connection and record an error instead of hanging forever.
//
// Reasoning-model compatibility: the idle window resets on every byte read,
// so SSE keep-alive comments/heartbeats and reasoning deltas count as
// activity; only a complete byte-level silence trips it.
//
// Both are per-provider overridable (config.Provider.StreamTTFBTimeoutSec /
// StreamIdleTimeoutSec): nil = default, <=0 = disabled.
const (
	defaultStreamTTFBTimeoutSec = 120
	defaultStreamIdleTimeoutSec = 300
)

// StreamIdleTimeoutError reports a streaming upstream that sent no bytes for
// the configured idle window. streamResponse/streamResponsesAsChat match it
// with errors.As to record the attempt as an error instead of a clean EOF.
type StreamIdleTimeoutError struct {
	Timeout time.Duration
}

// Error implements error.
func (e *StreamIdleTimeoutError) Error() string {
	return fmt.Sprintf("stream idle timeout: no data from upstream for %s", e.Timeout)
}

// streamTimeouts resolves the (ttfb, idle) bounds for p. A nil field uses the
// default; <=0 disables that bound. Both disabled (or timeouts equal to
// "<=0, <=0") make doStream a plain Do.
func streamTimeouts(p config.Provider) (ttfb, idle time.Duration) {
	ttfbSec := defaultStreamTTFBTimeoutSec
	if p.StreamTTFBTimeoutSec != nil {
		ttfbSec = *p.StreamTTFBTimeoutSec
	}
	idleSec := defaultStreamIdleTimeoutSec
	if p.StreamIdleTimeoutSec != nil {
		idleSec = *p.StreamIdleTimeoutSec
	}
	if ttfbSec > 0 {
		ttfb = time.Duration(ttfbSec) * time.Second
	}
	if idleSec > 0 {
		idle = time.Duration(idleSec) * time.Second
	}
	return ttfb, idle
}

// doStream executes a streaming upstream request with the F-02 bounds
// resolved from sel.Provider. The request's context stays authoritative for
// client cancellation (F-01): the derived context is only ever canceled by
// our own timers, never the other way round.
func (h *Handler) doStream(client *http.Client, req *http.Request, sel *rotation.SelectedKey) (*http.Response, error) {
	ttfb, idle := streamTimeouts(sel.Provider)
	if ttfb <= 0 && idle <= 0 {
		return client.Do(req)
	}
	ctx, cancel := context.WithCancel(req.Context())
	if ttfb > 0 {
		timer := time.AfterFunc(ttfb, cancel)
		resp, err := client.Do(req.WithContext(ctx))
		if !timer.Stop() {
			// The timer fired: the TTFB window elapsed. Do may have won the
			// race and returned a response anyway — its body rides a canceled
			// context and is unusable, so fail the attempt uniformly.
			if resp != nil {
				_ = resp.Body.Close()
			}
			cancel()
			return nil, fmt.Errorf("stream first-byte timeout: no response headers within %s", ttfb)
		}
		if err != nil {
			cancel()
			return nil, err
		}
		if idle <= 0 {
			// Headers arrived in time and no idle watchdog is configured: keep
			// the derived context alive for the body, released on Close.
			resp.Body = &cancelOnCloseBody{ReadCloser: resp.Body, cancel: cancel}
			return resp, nil
		}
		resp.Body = newIdleTimeoutBody(resp.Body, idle, cancel)
		return resp, nil
	}
	resp, err := client.Do(req.WithContext(ctx))
	if err != nil {
		cancel()
		return nil, err
	}
	resp.Body = newIdleTimeoutBody(resp.Body, idle, cancel)
	return resp, nil
}

// cancelOnCloseBody releases the derived request context when the body is
// closed (used when only the TTFB bound is configured).
type cancelOnCloseBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

// Close implements io.Closer.
func (b *cancelOnCloseBody) Close() error {
	err := b.ReadCloser.Close()
	b.cancel()
	return err
}

// idleTimeoutBody aborts reads on a streaming body that goes silent: every
// successful read resets the window; when the timer fires, the derived
// request context is canceled, unblocking the in-flight Read with an error
// that is then reported as StreamIdleTimeoutError.
type idleTimeoutBody struct {
	body     io.ReadCloser
	timeout  time.Duration
	cancel   context.CancelFunc
	timer    *time.Timer
	timedOut atomic.Bool
}

// newIdleTimeoutBody wraps body with the idle watchdog and arms the timer.
// cancel must be the cancel func of the request's derived context; it is
// always called on Close (timer fired or not) to release context resources.
func newIdleTimeoutBody(body io.ReadCloser, timeout time.Duration, cancel context.CancelFunc) *idleTimeoutBody {
	b := &idleTimeoutBody{body: body, timeout: timeout, cancel: cancel}
	b.timer = time.AfterFunc(timeout, func() {
		b.timedOut.Store(true)
		cancel()
	})
	return b
}

// Read implements io.Reader.
func (b *idleTimeoutBody) Read(p []byte) (int, error) {
	n, err := b.body.Read(p)
	if n > 0 {
		b.timer.Reset(b.timeout)
	}
	if err != nil && err != io.EOF && b.timedOut.Load() {
		return n, &StreamIdleTimeoutError{Timeout: b.timeout}
	}
	return n, err
}

// Close implements io.Closer.
func (b *idleTimeoutBody) Close() error {
	b.timer.Stop()
	b.cancel()
	return b.body.Close()
}
