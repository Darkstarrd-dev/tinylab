package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/usage"
)

// smallChunkReader wraps a string reader and returns at most chunkSize bytes
// per Read call, so the streamResponse read loop makes multiple iterations
// even with small payloads.
type smallChunkReader struct {
	reader    io.Reader
	chunkSize int
}

func (r *smallChunkReader) Read(p []byte) (int, error) {
	if len(p) > r.chunkSize {
		p = p[:r.chunkSize]
	}
	return r.reader.Read(p)
}

// failAfterWriter wraps an httptest.ResponseRecorder and returns io.ErrUnexpectedEOF
// on every Write call after the first successful one (or after a configurable
// number of successWrites). This simulates a client disconnect mid-stream.
type failAfterWriter struct {
	*httptest.ResponseRecorder
	successWrites int
	writeCount    int
}

func (w *failAfterWriter) Write(b []byte) (int, error) {
	w.writeCount++
	if w.writeCount > w.successWrites {
		return 0, io.ErrUnexpectedEOF
	}
	return w.ResponseRecorder.Write(b)
}

// checkUsageEntry is a helper to verify the usage entry in the ring buffer.
func checkUsageEntry(t *testing.T, h *Handler, reqID string, expectError bool) {
	t.Helper()
	rb, ok := h.usage.(*usage.RingBuffer)
	if !ok {
		t.Fatalf("usage is %T, expected *usage.RingBuffer", h.usage)
	}
	entries := rb.All()
	var found bool
	for _, e := range entries {
		if e.ID == reqID {
			found = true
			if expectError {
				if e.Status != "error" {
					t.Errorf("expected status=error, got %q", e.Status)
				}
				if e.Error != "client disconnected" {
					t.Errorf("expected Error='client disconnected', got %q", e.Error)
				}
			} else {
				if e.Status != "success" {
					t.Errorf("expected status=success, got %q", e.Status)
				}
			}
			break
		}
	}
	if !found {
		ids := make([]string, len(entries))
		for i, e := range entries {
			ids[i] = e.ID
		}
		t.Fatalf("expected entry with ID %q in ring buffer, found IDs: %v", reqID, ids)
	}
}

// TestStreamResponse_ClientDisconnect_NonNormalize verifies that in the
// non-normalize path, when the client disconnects mid-stream, the usage entry
// is recorded with status="error" and errMsg="client disconnected".
func TestStreamResponse_ClientDisconnect_NonNormalize(t *testing.T) {
	raw := "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n" +
		"data: [DONE]\n"

	h := newTestHandlerWithCustomProvider(t, sseTestProvider("http://localhost:9999"),
		config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300})
	sel := sseSelectedKey()

	w := &failAfterWriter{
		ResponseRecorder: httptest.NewRecorder(),
		successWrites:    1, // first write succeeds, subsequent writes fail
	}

	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		// Use smallChunkReader so the non-normalize w.Write(buf[:n]) gets
		// called multiple times (one per small chunk read).
		Body: io.NopCloser(&smallChunkReader{
			reader:    strings.NewReader(raw),
			chunkSize: 50,
		}),
	}
	h.streamResponse(w, resp, "gpt-4", sel, 5, []byte("{}"), false, "test-disconnect-non-norm", nil, "", combo.EntryFormatOpenAI, "", "")

	checkUsageEntry(t, h, "test-disconnect-non-norm", true)
}

// TestStreamResponse_ClientDisconnect_NormalizePath verifies the same for the
// normalize path (normalizeSSEChunk enabled).
func TestStreamResponse_ClientDisconnect_NormalizePath(t *testing.T) {
	raw := "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n" +
		"data: {\"choices\":null}\n" +
		"data: [DONE]\n"

	h := newTestHandlerWithCustomProvider(t, sseTestProvider("http://localhost:9999"),
		config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300})
	sel := sseSelectedKey()

	w := &failAfterWriter{
		ResponseRecorder: httptest.NewRecorder(),
		successWrites:    1,
	}

	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(raw)),
	}
	h.streamResponse(w, resp, "gpt-4", sel, 5, []byte("{}"), true, "test-disconnect-norm", nil, "", combo.EntryFormatOpenAI, "", "")

	checkUsageEntry(t, h, "test-disconnect-norm", true)
}

// TestStreamResponse_ClientDisconnect_Immediate verifies that if the client
// disconnects on the very first Write (zero successful writes), the error
// status is still recorded.
func TestStreamResponse_ClientDisconnect_Immediate(t *testing.T) {
	raw := "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n"

	h := newTestHandlerWithCustomProvider(t, sseTestProvider("http://localhost:9999"),
		config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300})
	sel := sseSelectedKey()

	w := &failAfterWriter{
		ResponseRecorder: httptest.NewRecorder(),
		successWrites:    0, // fail immediately
	}

	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body: io.NopCloser(&smallChunkReader{
			reader:    strings.NewReader(raw),
			chunkSize: 50,
		}),
	}
	h.streamResponse(w, resp, "gpt-4", sel, 5, []byte("{}"), false, "test-disconnect-immediate", nil, "", combo.EntryFormatOpenAI, "", "")

	checkUsageEntry(t, h, "test-disconnect-immediate", true)
}

// TestStreamResponse_ClientDisconnect_RemovesEntryTracker verifies that
// recordUsage is called (the entry appears in the ring buffer) after a
// client disconnect, which is the prerequisite for forward.go to correctly
// call EntryTracker.Remove.
func TestStreamResponse_ClientDisconnect_RemovesEntryTracker(t *testing.T) {
	raw := "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n"

	h := newTestHandlerWithCustomProvider(t, sseTestProvider("http://localhost:9999"),
		config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300})
	sel := sseSelectedKey()

	// Pre-register the entry like forwardWithRetry would
	h.EntryTracker.Register(usage.Entry{
		ID: "test-tracker-cleanup", Status: "processing", Timestamp: time.Now(),
		Provider: "Test", Model: "gpt-4", KeyID: "k1", KeyName: "K1",
	})

	w := &failAfterWriter{
		ResponseRecorder: httptest.NewRecorder(),
		successWrites:    0, // fail immediately
	}

	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body: io.NopCloser(&smallChunkReader{
			reader:    strings.NewReader(raw),
			chunkSize: 50,
		}),
	}
	h.streamResponse(w, resp, "gpt-4", sel, 5, []byte("{}"), false, "test-tracker-cleanup", nil, "", combo.EntryFormatOpenAI, "", "")

	// Verify the usage entry was recorded as error (pre-requisite for cleanup)
	checkUsageEntry(t, h, "test-tracker-cleanup", true)
}

// TestStreamResponse_NormalPathNoDisconnect verifies that when the client does
// NOT disconnect, the usage entry is recorded as success (regression test).
func TestStreamResponse_NormalPathNoDisconnect(t *testing.T) {
	raw := "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n" +
		"data: [DONE]\n"

	h := newTestHandlerWithCustomProvider(t, sseTestProvider("http://localhost:9999"),
		config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300})
	sel := sseSelectedKey()
	w := httptest.NewRecorder()

	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(raw)),
	}
	h.streamResponse(w, resp, "gpt-4", sel, 5, []byte("{}"), false, "test-normal-success", nil, "", combo.EntryFormatOpenAI, "", "")

	checkUsageEntry(t, h, "test-normal-success", false)
}
