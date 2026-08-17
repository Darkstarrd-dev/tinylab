package textreview

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	tr "github.com/tinyrouter/tinyrouter/internal/textreview"
)

// slowCleaner is a fake Cleaner used by the HTTP tests; it returns OK after a
// short delay, emitting one chunk. A per-node map allows customizing results.
type httpFakeCleaner struct {
	results map[string]tr.CleanResult
	calls   int
}

func (c *httpFakeCleaner) Clean(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string)) tr.CleanResult {
	c.calls++
	res := c.results["default"]
	if r, ok := c.results[node.ID]; ok {
		res = r
	}
	if res.OK && onChunk != nil {
		onChunk("cleaned:" + node.ID)
	}
	return res
}

// newTestHandler builds a Handler wired to a fresh registry with the given
// nodes and an injected fake cleaner.
func newTestHandler(t *testing.T, nodes []config.TextReviewNode, cleaner tr.Cleaner) (*Handler, *apibase.Deps) {
	t.Helper()
	cfg := &config.Config{}
	cfg.TextReview.Nodes = nodes
	reg := registry.New(cfg)
	d := &apibase.Deps{Reg: reg, Logger: console.New(0)}
	h := NewHandler(d)
	h.SetCleanerForTest(cleaner)
	return h, d
}

// newTestRouter mounts the handler under /api/text-review (mirroring router.go).
func newTestRouter(h *Handler) http.Handler {
	r := chi.NewRouter()
	r.Route("/api/text-review", func(r chi.Router) {
		h.Register(r)
	})
	return r
}

func doJSON(t *testing.T, mux http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		r = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// TestHTTPCreateSession verifies POST /sessions creates + starts a session.
func TestHTTPCreateSession(t *testing.T) {
	cleaner := &httpFakeCleaner{results: map[string]tr.CleanResult{"default": {OK: true}}}
	nodes := []config.TextReviewNode{{ID: "n1", ProviderID: "p1", ModelID: "m1", Concurrency: 2, Enabled: true}}
	h, _ := newTestHandler(t, nodes, cleaner)
	mux := newTestRouter(h)

	rec := doJSON(t, mux, "POST", "/api/text-review/sessions", map[string]any{
		"fileName": "test.txt",
		"rawText":  "raw",
		"chapters": []map[string]string{{"title": "Ch1", "content": "c1"}},
		"nodeIds":  []string{"n1"},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.SessionID == "" {
		t.Fatal("empty sessionId")
	}
}

// TestHTTPGetSession verifies GET /sessions/{id} returns the snapshot.
func TestHTTPGetSession(t *testing.T) {
	cleaner := &httpFakeCleaner{results: map[string]tr.CleanResult{"default": {OK: true}}}
	nodes := []config.TextReviewNode{{ID: "n1", ProviderID: "p1", ModelID: "m1", Concurrency: 1, Enabled: true}}
	h, _ := newTestHandler(t, nodes, cleaner)
	mux := newTestRouter(h)

	rec := doJSON(t, mux, "POST", "/api/text-review/sessions", map[string]any{
		"fileName": "test.txt",
		"chapters": []map[string]string{{"title": "Ch1", "content": "c1"}, {"title": "Ch2", "content": "c2"}},
		"nodeIds":  []string{"n1"},
	})
	var create struct {
		SessionID string `json:"sessionId"`
	}
	json.Unmarshal(rec.Body.Bytes(), &create)

	// Wait for processing to settle.
	waitFor := func() bool {
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			gr := doJSON(t, mux, "GET", "/api/text-review/sessions/"+create.SessionID, nil)
			var snap struct {
				Chapters []struct {
					Status string `json:"status"`
				} `json:"chapters"`
			}
			json.Unmarshal(gr.Body.Bytes(), &snap)
			allDone := true
			for _, c := range snap.Chapters {
				if c.Status != tr.StatusCompleted && c.Status != tr.StatusFailed {
					allDone = false
				}
			}
			if allDone && len(snap.Chapters) > 0 {
				return true
			}
			time.Sleep(20 * time.Millisecond)
		}
		return false
	}
	if !waitFor() {
		t.Fatal("chapters did not settle")
	}

	gr := doJSON(t, mux, "GET", "/api/text-review/sessions/"+create.SessionID, nil)
	if gr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", gr.Code)
	}
	var snap struct {
		ID       string `json:"id"`
		Status   string `json:"status"`
		Chapters []struct {
			Title   string `json:"title"`
			Cleaned string `json:"cleaned"`
			Status  string `json:"status"`
		} `json:"chapters"`
		Nodes []struct {
			ID     string `json:"id"`
			Target int    `json:"target"`
			Active int    `json:"active"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(gr.Body.Bytes(), &snap); err != nil {
		t.Fatalf("decode snapshot: %v body=%s", err, gr.Body.String())
	}
	if snap.ID != create.SessionID {
		t.Errorf("snapshot id mismatch: %q vs %q", snap.ID, create.SessionID)
	}
	if len(snap.Chapters) != 2 {
		t.Fatalf("expected 2 chapters, got %d", len(snap.Chapters))
	}
	for _, c := range snap.Chapters {
		if c.Status != tr.StatusCompleted {
			t.Errorf("chapter %q not completed: %q", c.Title, c.Status)
		}
		if c.Cleaned == "" {
			t.Errorf("chapter %q has empty cleaned", c.Title)
		}
	}
	if len(snap.Nodes) != 1 || snap.Nodes[0].ID != "n1" {
		t.Errorf("unexpected nodes: %+v", snap.Nodes)
	}
}

// TestHTTPPauseResumeStop verifies the control endpoints.
func TestHTTPPauseResumeStop(t *testing.T) {
	// Use a cleaner that blocks so we can exercise pause while in-flight.
	blockCh := make(chan struct{})
	cleaner := &blockingCleaner{blockCh: blockCh, res: tr.CleanResult{OK: true}, chunk: "x"}
	nodes := []config.TextReviewNode{{ID: "n1", ProviderID: "p1", ModelID: "m1", Concurrency: 1, Enabled: true}}
	h, _ := newTestHandler(t, nodes, cleaner)
	mux := newTestRouter(h)

	rec := doJSON(t, mux, "POST", "/api/text-review/sessions", map[string]any{
		"chapters": []map[string]string{{"title": "Ch1", "content": "c1"}, {"title": "Ch2", "content": "c2"}},
		"nodeIds":  []string{"n1"},
	})
	var create struct {
		SessionID string `json:"sessionId"`
	}
	json.Unmarshal(rec.Body.Bytes(), &create)

	// Pause.
	if pr := doJSON(t, mux, "POST", "/api/text-review/sessions/"+create.SessionID+"/pause", map[string]any{}); pr.Code != http.StatusOK {
		t.Fatalf("pause: expected 200, got %d %s", pr.Code, pr.Body.String())
	}
	// Release in-flight + resume.
	close(blockCh)
	if rr := doJSON(t, mux, "POST", "/api/text-review/sessions/"+create.SessionID+"/resume", map[string]any{}); rr.Code != http.StatusOK {
		t.Fatalf("resume: expected 200, got %d %s", rr.Code, rr.Body.String())
	}
	// Stop.
	if sr := doJSON(t, mux, "POST", "/api/text-review/sessions/"+create.SessionID+"/stop", map[string]any{}); sr.Code != http.StatusOK {
		t.Fatalf("stop: expected 200, got %d %s", sr.Code, sr.Body.String())
	}
}

// blockingCleaner blocks until blockCh is closed, then returns res + chunk.
type blockingCleaner struct {
	blockCh chan struct{}
	res     tr.CleanResult
	chunk   string
}

func (c *blockingCleaner) Clean(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string)) tr.CleanResult {
	select {
	case <-c.blockCh:
	case <-ctx.Done():
		return tr.CleanResult{OK: false, ErrMsg: "stream interrupted"}
	}
	if c.res.OK && onChunk != nil {
		onChunk(c.chunk)
	}
	return c.res
}

// TestHTTPReprocess verifies the reprocess endpoint.
func TestHTTPReprocess(t *testing.T) {
	cleaner := &httpFakeCleaner{results: map[string]tr.CleanResult{"default": {OK: true}}}
	nodes := []config.TextReviewNode{{ID: "n1", ProviderID: "p1", ModelID: "m1", Concurrency: 1, Enabled: true}}
	h, _ := newTestHandler(t, nodes, cleaner)
	mux := newTestRouter(h)

	rec := doJSON(t, mux, "POST", "/api/text-review/sessions", map[string]any{
		"chapters": []map[string]string{{"title": "Ch1", "content": "c1"}},
		"nodeIds":  []string{"n1"},
	})
	var create struct {
		SessionID string `json:"sessionId"`
	}
	json.Unmarshal(rec.Body.Bytes(), &create)

	// Wait for completion.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		gr := doJSON(t, mux, "GET", "/api/text-review/sessions/"+create.SessionID, nil)
		var snap struct {
			Chapters []struct {
				Status string `json:"status"`
			} `json:"chapters"`
		}
		json.Unmarshal(gr.Body.Bytes(), &snap)
		if len(snap.Chapters) > 0 && snap.Chapters[0].Status == tr.StatusCompleted {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	rr := doJSON(t, mux, "POST", "/api/text-review/sessions/"+create.SessionID+"/chapters/0/reprocess", map[string]any{})
	if rr.Code != http.StatusOK {
		t.Fatalf("reprocess: expected 200, got %d %s", rr.Code, rr.Body.String())
	}

	// Wait for re-completion.
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		gr := doJSON(t, mux, "GET", "/api/text-review/sessions/"+create.SessionID, nil)
		var snap struct {
			Chapters []struct {
				Status string `json:"status"`
			} `json:"chapters"`
		}
		json.Unmarshal(gr.Body.Bytes(), &snap)
		if len(snap.Chapters) > 0 && snap.Chapters[0].Status == tr.StatusCompleted {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("chapter did not re-complete after reprocess")
}

// TestHTTPNotFound verifies missing-session endpoints return 404.
func TestHTTPNotFound(t *testing.T) {
	cleaner := &httpFakeCleaner{results: map[string]tr.CleanResult{"default": {OK: true}}}
	h, _ := newTestHandler(t, nil, cleaner)
	mux := newTestRouter(h)

	cases := []struct{ method, path string }{
		{"GET", "/api/text-review/sessions/nope"},
		{"POST", "/api/text-review/sessions/nope/pause"},
		{"POST", "/api/text-review/sessions/nope/resume"},
		{"POST", "/api/text-review/sessions/nope/stop"},
		{"POST", "/api/text-review/sessions/nope/chapters/0/reprocess"},
	}
	for _, c := range cases {
		rec := doJSON(t, mux, c.method, c.path, map[string]any{})
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s: expected 404, got %d", c.method, c.path, rec.Code)
		}
	}
}

// TestHTTPEmptyChapters verifies validation errors.
func TestHTTPEmptyChapters(t *testing.T) {
	cleaner := &httpFakeCleaner{results: map[string]tr.CleanResult{"default": {OK: true}}}
	h, _ := newTestHandler(t, nil, cleaner)
	mux := newTestRouter(h)

	rec := doJSON(t, mux, "POST", "/api/text-review/sessions", map[string]any{
		"chapters": []map[string]string{},
		"nodeIds":  []string{"n1"},
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty chapters, got %d", rec.Code)
	}
}

// lockedRecorder is a concurrency-safe stand-in for httptest.ResponseRecorder
// for the SSE test, where the handler writes from its own goroutine while the
// test reads the accumulated body. httptest.ResponseRecorder's body is a plain
// bytes.Buffer, so concurrent read/write is a data race (reported by -race);
// this type guards header/body/status with a mutex and signals on Flush.
type lockedRecorder struct {
	mu      sync.Mutex
	header  http.Header
	body    bytes.Buffer
	code    int
	flushed chan struct{} // closed on the first Flush (response headers sent)
}

func newLockedRecorder() *lockedRecorder {
	return &lockedRecorder{header: make(http.Header), code: http.StatusOK, flushed: make(chan struct{})}
}

func (r *lockedRecorder) Header() http.Header {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.header
}

func (r *lockedRecorder) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.Write(p)
}

func (r *lockedRecorder) WriteHeader(code int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.code = code
}

// Flush implements http.Flusher. The first flush marks the response headers as
// sent; per-event flushes afterwards only need the write visibility the mutex
// already provides.
func (r *lockedRecorder) Flush() {
	r.mu.Lock()
	defer r.mu.Unlock()
	select {
	case <-r.flushed:
	default:
		close(r.flushed)
	}
}

// BodyString returns the accumulated body, safe to call while the handler is
// still writing.
func (r *lockedRecorder) BodyString() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.String()
}

// HeaderGet returns a header value, safe to call while the handler is still
// writing.
func (r *lockedRecorder) HeaderGet(key string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.header.Get(key)
}

// sseFrame is one parsed "event: <type>\ndata: <json>" frame.
type sseFrame struct {
	event string
	data  string
}

// parseSSEFrames splits an SSE body into frames on blank-line boundaries.
func parseSSEFrames(body string) []sseFrame {
	var frames []sseFrame
	var ev, data string
	for _, line := range strings.Split(body, "\n") {
		switch {
		case line == "":
			if ev != "" || data != "" {
				frames = append(frames, sseFrame{event: ev, data: data})
				ev, data = "", ""
			}
		case strings.HasPrefix(line, "event: "):
			ev = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			data += strings.TrimPrefix(line, "data: ")
		}
	}
	if ev != "" || data != "" {
		frames = append(frames, sseFrame{event: ev, data: data})
	}
	return frames
}

// TestHTTPEventsSSE verifies /events streams SSE-formatted events in wire
// order. A reprocess is used as the event trigger: the initial run is waited
// out to completion first, so the reprocess broadcast burst arrives entirely
// after the SSE handler has subscribed and has a fixed, documented order
// (chapter pending precedes session running; chunk precedes completion).
func TestHTTPEventsSSE(t *testing.T) {
	cleaner := &httpFakeCleaner{results: map[string]tr.CleanResult{"default": {OK: true}}}
	nodes := []config.TextReviewNode{{ID: "n1", ProviderID: "p1", ModelID: "m1", Concurrency: 1, Enabled: true}}
	h, _ := newTestHandler(t, nodes, cleaner)
	mux := newTestRouter(h)

	rec := doJSON(t, mux, "POST", "/api/text-review/sessions", map[string]any{
		"chapters": []map[string]string{{"title": "Ch1", "content": "c1"}},
		"nodeIds":  []string{"n1"},
	})
	var create struct {
		SessionID string `json:"sessionId"`
	}
	json.Unmarshal(rec.Body.Bytes(), &create)

	// Wait for the initial run to settle (session completed) so the session is
	// idle; the reprocess below then triggers a fresh, deterministic burst.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		gr := doJSON(t, mux, "GET", "/api/text-review/sessions/"+create.SessionID, nil)
		var snap struct {
			Status   string `json:"status"`
			Chapters []struct {
				Status string `json:"status"`
			} `json:"chapters"`
		}
		json.Unmarshal(gr.Body.Bytes(), &snap)
		if snap.Status == tr.SessionCompleted && len(snap.Chapters) > 0 && snap.Chapters[0].Status == tr.StatusCompleted {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Subscribe to the SSE stream with a cancelable context. The handler runs
	// in its own goroutine and writes into the concurrency-safe recorder.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("GET", "/api/text-review/sessions/"+create.SessionID+"/events", nil).WithContext(ctx)
	rec2 := newLockedRecorder()
	done := make(chan struct{})
	go func() {
		mux.ServeHTTP(rec2, req)
		close(done)
	}()

	// The handler flushes the response headers before subscribing. Waiting for
	// that flush before triggering the burst guarantees the subscriber is live
	// when the reprocess broadcasts fire: SSE is forward-only, so events
	// broadcast before subscribe are dropped by design (snapshot compensates).
	select {
	case <-rec2.flushed:
	case <-time.After(2 * time.Second):
		t.Fatal("SSE handler did not start streaming")
	}
	rr := doJSON(t, mux, "POST", "/api/text-review/sessions/"+create.SessionID+"/chapters/0/reprocess", map[string]any{})
	if rr.Code != http.StatusOK {
		t.Fatalf("reprocess: expected 200, got %d %s", rr.Code, rr.Body.String())
	}

	// Wait until the burst's terminal event (session completed) arrives.
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(rec2.BodyString(), `data: {"type":"status","status":"completed"}`) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	<-done

	body := rec2.BodyString()
	frames := parseSSEFrames(body)
	if len(frames) == 0 {
		t.Fatalf("expected SSE frames, got: %q", body)
	}
	// Every frame must be well-formed: "event: <type>" naming the same type
	// the JSON payload carries.
	for i, f := range frames {
		var ev struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal([]byte(f.data), &ev); err != nil {
			t.Fatalf("frame %d: data is not JSON: %q (frame %+v)", i, f.data, f)
		}
		if ev.Type != f.event {
			t.Errorf("frame %d: event %q does not match payload type %q", i, f.event, ev.Type)
		}
	}

	// The reprocess burst has a fixed wire order (documented contract):
	// chapter pending precedes session running; chunk precedes completion.
	type wantFrame struct {
		typ    string
		status string // for status frames; "" otherwise
		chIdx  int    // chapter index for chapter-level frames; -1 for session-level
		delta  string // for chunk frames
	}
	want := []wantFrame{
		{typ: tr.EventStatus, status: tr.StatusPending, chIdx: 0},
		{typ: tr.EventStatus, status: tr.SessionRunning, chIdx: -1},
		{typ: tr.EventStatus, status: tr.StatusProcessing, chIdx: 0},
		{typ: tr.EventNode},
		{typ: tr.EventChunk, chIdx: 0, delta: "cleaned:n1"},
		{typ: tr.EventNode},
		{typ: tr.EventStatus, status: tr.StatusCompleted, chIdx: 0},
		{typ: tr.EventStatus, status: tr.SessionCompleted, chIdx: -1},
	}
	if len(frames) != len(want) {
		t.Fatalf("expected %d SSE frames, got %d:\n%s", len(want), len(frames), body)
	}
	for i, w := range want {
		var ev struct {
			Type       string `json:"type"`
			ChapterIdx *int   `json:"chapterIdx"`
			Status     string `json:"status"`
			Delta      string `json:"delta"`
			Nodes      []struct {
				ID string `json:"id"`
			} `json:"nodes"`
		}
		if err := json.Unmarshal([]byte(frames[i].data), &ev); err != nil {
			t.Fatalf("frame %d: decode: %v", i, err)
		}
		if ev.Type != w.typ {
			t.Errorf("frame %d: type = %q, want %q", i, ev.Type, w.typ)
		}
		if w.status != "" && ev.Status != w.status {
			t.Errorf("frame %d: status = %q, want %q", i, ev.Status, w.status)
		}
		evIdx := -1
		if ev.ChapterIdx != nil {
			evIdx = *ev.ChapterIdx
		}
		switch w.typ {
		case tr.EventChunk:
			if evIdx != w.chIdx || ev.Delta != w.delta {
				t.Errorf("frame %d: chunk = idx %d delta %q, want idx %d delta %q", i, evIdx, ev.Delta, w.chIdx, w.delta)
			}
		case tr.EventStatus:
			if w.chIdx >= 0 && evIdx != w.chIdx {
				t.Errorf("frame %d: chapterIdx = %d, want %d", i, evIdx, w.chIdx)
			}
		case tr.EventNode:
			if len(ev.Nodes) != 1 || ev.Nodes[0].ID != "n1" {
				t.Errorf("frame %d: nodes = %+v, want [n1]", i, ev.Nodes)
			}
		}
	}

	if got := rec2.HeaderGet("Content-Type"); got != "text/event-stream" {
		t.Errorf("expected text/event-stream, got %q", got)
	}
	if got := rec2.HeaderGet("Cache-Control"); got != "no-cache" {
		t.Errorf("expected no-cache, got %q", got)
	}
	if got := rec2.HeaderGet("Connection"); got != "keep-alive" {
		t.Errorf("expected keep-alive, got %q", got)
	}
}
