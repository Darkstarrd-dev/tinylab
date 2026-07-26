package textreview

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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

// TestHTTPEventsSSE verifies /events streams SSE-formatted events.
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

	// Subscribe to the SSE stream with a short timeout context; collect a few
	// events then cancel. We use httptest with a cancelable context.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("GET", "/api/text-review/sessions/"+create.SessionID+"/events", nil).WithContext(ctx)
	rec2 := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		mux.ServeHTTP(rec2, req)
		close(done)
	}()

	// Wait until we see at least one "data:" line, then cancel.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		body := rec2.Body.String()
		if strings.Count(body, "data: ") > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	<-done

	body := rec2.Body.String()
	if !strings.Contains(body, "data: ") {
		t.Fatalf("expected SSE data lines, got: %q", body)
	}
	if rec2.Header().Get("Content-Type") != "text/event-stream" {
		t.Errorf("expected text/event-stream, got %q", rec2.Header().Get("Content-Type"))
	}
	if rec2.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("expected no-cache, got %q", rec2.Header().Get("Cache-Control"))
	}
}
