package trace

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/proxy"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

func setupTraceTest(t *testing.T) (string, *chi.Mux) {
	t.Helper()
	tracesDir := t.TempDir()
	ph := proxy.New(nil, nil, nil, usage.New(100), usage.NewQuotaTracker(), console.New(100), 0)
	ph.SetRequestLogDir(tracesDir)
	deps := &apibase.Deps{ProxyHandler: ph, Logger: console.New(100)}
	h := NewHandler(deps)
	r := chi.NewRouter()
	r.Route("/api/traces", h.Register)
	return tracesDir, r
}

func writeIndexFile(t *testing.T, tracesDir, date string, lines []string) {
	t.Helper()
	path := filepath.Join(tracesDir, "index-"+date+".jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range lines {
		_, _ = f.WriteString(line + "\n")
	}
	f.Close()
}

func writeReqFile(t *testing.T, tracesDir, reqID string, lines []string) {
	t.Helper()
	reqDir := filepath.Join(tracesDir, "req")
	if err := os.MkdirAll(reqDir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(reqDir, reqID+".jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range lines {
		_, _ = f.WriteString(line + "\n")
	}
	f.Close()
}

func mustJSON(m map[string]any) string {
	b, _ := json.Marshal(m)
	return string(b)
}

func f64(m map[string]any, key string) float64 {
	v, ok := m[key].(float64)
	if !ok {
		return 0
	}
	return v
}

func s(m map[string]any, key string) string {
	v, ok := m[key].(string)
	if !ok {
		return ""
	}
	return v
}

func TestTraceDates(t *testing.T) {
	tracesDir, r := setupTraceTest(t)
	writeIndexFile(t, tracesDir, "20260727", []string{
		mustJSON(map[string]any{"type": "index", "ts": "2026-07-27T10:00:00Z", "reqID": "req1", "status": "success"}),
		mustJSON(map[string]any{"type": "index", "ts": "2026-07-27T11:00:00Z", "reqID": "req2", "status": "error"}),
	})
	writeIndexFile(t, tracesDir, "20260726", []string{
		mustJSON(map[string]any{"type": "index", "ts": "2026-07-26T09:00:00Z", "reqID": "req3", "status": "success"}),
	})

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/dates", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}

	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}

	dates, ok := resp["dates"].([]any)
	if !ok {
		t.Fatal("expected dates array")
	}
	if len(dates) != 2 {
		t.Fatalf("expected 2 dates, got %d", len(dates))
	}

	first := dates[0].(map[string]any)
	if s(first, "date") != "2026-07-27" {
		t.Errorf("expected first date 2026-07-27, got %s", first["date"])
	}
	if f64(first, "count") != 2 {
		t.Errorf("expected count 2, got %v", first["count"])
	}
	if first["sizeBytes"] == nil {
		t.Error("expected sizeBytes")
	}

	second := dates[1].(map[string]any)
	if s(second, "date") != "2026-07-26" {
		t.Errorf("expected second date 2026-07-26, got %s", second["date"])
	}
	if f64(second, "count") != 1 {
		t.Errorf("expected count 1, got %v", second["count"])
	}

	if dirVal, ok := resp["dir"].(string); !ok || dirVal != tracesDir {
		t.Errorf("expected dir %q, got %v", tracesDir, resp["dir"])
	}
}

func TestTraceDates_NoDir(t *testing.T) {
	ph := proxy.New(nil, nil, nil, usage.New(100), usage.NewQuotaTracker(), console.New(100), 0)
	deps := &apibase.Deps{ProxyHandler: ph, Logger: console.New(100)}
	h := NewHandler(deps)
	r := chi.NewRouter()
	r.Route("/api/traces", h.Register)

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/dates", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}

	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	dates, ok := resp["dates"].([]any)
	if !ok {
		t.Fatal("expected dates array")
	}
	if len(dates) != 0 {
		t.Fatalf("expected 0 dates, got %d", len(dates))
	}
}

func TestTraceIndex(t *testing.T) {
	tracesDir, r := setupTraceTest(t)

	var lines []string
	for i := range 5 {
		status := "success"
		if i%2 == 0 {
			status = "error"
		}
		lines = append(lines, mustJSON(map[string]any{
			"type": "index", "ts": "2026-07-27T10:00:00Z", "reqID": strconv.Itoa(i),
			"model": "gpt-4", "provider": "openai", "status": status, "error": "",
		}))
	}
	lines = append(lines, mustJSON(map[string]any{
		"type": "index", "ts": "2026-07-27T11:00:00Z", "reqID": "5",
		"model": "claude-3", "provider": "anthropic", "status": "success", "error": "",
	}))
	writeIndexFile(t, tracesDir, "20260727", lines)

	// Basic retrieval.
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}

	respLines, ok := resp["lines"].([]any)
	if !ok {
		t.Fatal("expected lines array")
	}
	if f64(resp, "total") != 6 {
		t.Errorf("expected total 6, got %v", resp["total"])
	}
	if len(respLines) != 6 {
		t.Errorf("expected 6 lines, got %d", len(respLines))
	}

	// Status filter.
	rr = httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727&status=success", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	json.Unmarshal(rr.Body.Bytes(), &resp)
	respLines = resp["lines"].([]any)
	// success: i=1, i=3, claude-3 = 3.
	if f64(resp, "total") != 3 {
		t.Errorf("expected 3 success lines, got %v", resp["total"])
	}
	if len(respLines) != 3 {
		t.Errorf("expected 3 lines after filter, got %d", len(respLines))
	}

	// q filter on model.
	rr = httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727&q=claude", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	json.Unmarshal(rr.Body.Bytes(), &resp)
	respLines = resp["lines"].([]any)
	if f64(resp, "total") != 1 {
		t.Errorf("expected 1 line for q=claude, got %v", resp["total"])
	}

	// q filter on provider.
	rr = httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727&q=anthropic", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	json.Unmarshal(rr.Body.Bytes(), &resp)
	respLines = resp["lines"].([]any)
	if f64(resp, "total") != 1 {
		t.Errorf("expected 1 line for q=anthropic, got %v", resp["total"])
	}

	// Limit and offset.
	rr = httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727&limit=2&offset=1", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	json.Unmarshal(rr.Body.Bytes(), &resp)
	respLines = resp["lines"].([]any)
	if f64(resp, "total") != 6 {
		t.Errorf("expected total 6, got %v", resp["total"])
	}
	if len(respLines) != 2 {
		t.Errorf("expected 2 lines, got %d", len(respLines))
	}
}

func TestTraceIndex_MissingDate(t *testing.T) {
	_, r := setupTraceTest(t)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}

func TestTraceIndex_InvalidDate(t *testing.T) {
	_, r := setupTraceTest(t)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=bad", nil))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}
}

func TestTraceIndex_DashedDate(t *testing.T) {
	tracesDir, r := setupTraceTest(t)

	// Files on disk are named index-YYYYMMDD.jsonl (8-digit, no dashes).
	// The API should accept YYYY-MM-DD (dashed) as the date parameter,
	// normalize it, and find the file.
	writeIndexFile(t, tracesDir, "20260727", []string{
		mustJSON(map[string]any{"type": "index", "ts": "2026-07-27T10:00:00Z", "reqID": "1"}),
	})

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=2026-07-27", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for dashed date, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestTraceReq(t *testing.T) {
	tracesDir, r := setupTraceTest(t)
	reqID := "abc-123"
	writeReqFile(t, tracesDir, reqID, []string{
		mustJSON(map[string]any{"type": "request", "reqID": reqID, "model": "gpt-4"}),
		mustJSON(map[string]any{"type": "attempt", "reqID": reqID, "n": 1, "status": "error", "error": "timeout"}),
		mustJSON(map[string]any{"type": "attempt", "reqID": reqID, "n": 2, "status": "success"}),
	})

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/req/abc-123", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if s(resp, "reqID") != reqID {
		t.Errorf("expected reqID %s, got %v", reqID, resp["reqID"])
	}

	lines, ok := resp["lines"].([]any)
	if !ok {
		t.Fatal("expected lines array")
	}
	if len(lines) != 3 {
		t.Errorf("expected 3 lines, got %d", len(lines))
	}
	if s(lines[0].(map[string]any), "type") != "request" {
		t.Error("expected first line type=request")
	}
	if s(lines[1].(map[string]any), "type") != "attempt" {
		t.Error("expected second line type=attempt")
	}
}

func TestTraceReq_MissingReqID(t *testing.T) {
	_, r := setupTraceTest(t)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/req/nonexistent", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}

func TestTraceReq_PathTraversal(t *testing.T) {
	_, r := setupTraceTest(t)

	// URL-encoded "/" (%2f) survives HTTP parsing but is rejected by sanitizePathParam.
	badIDs := []string{"foo%2f..%2f..%2fbar"}
	for _, badID := range badIDs {
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/req/"+badID, nil))
		if rr.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for reqID %q, got %d", badID, rr.Code)
		}
	}
}

func TestTraceIndex_PathTraversal(t *testing.T) {
	_, r := setupTraceTest(t)

	// URL-encoded "/" (%2f) survives HTTP parsing but is rejected by sanitizePathParam.
	badDates := []string{"foo%2f..%2f..%2fetc"}
	for _, badDate := range badDates {
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date="+badDate, nil))
		if rr.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for date %q, got %d", badDate, rr.Code)
		}
	}
}

func TestTraceIndex_NoDir(t *testing.T) {
	ph := proxy.New(nil, nil, nil, usage.New(100), usage.NewQuotaTracker(), console.New(100), 0)
	deps := &apibase.Deps{ProxyHandler: ph, Logger: console.New(100)}
	h := NewHandler(deps)
	r := chi.NewRouter()
	r.Route("/api/traces", h.Register)

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}

func TestTraceReq_NoDir(t *testing.T) {
	ph := proxy.New(nil, nil, nil, usage.New(100), usage.NewQuotaTracker(), console.New(100), 0)
	deps := &apibase.Deps{ProxyHandler: ph, Logger: console.New(100)}
	h := NewHandler(deps)
	r := chi.NewRouter()
	r.Route("/api/traces", h.Register)

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/req/abc-123", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}

func TestTraceIndex_LimitCap(t *testing.T) {
	tracesDir, r := setupTraceTest(t)

	var lines []string
	for i := range 5 {
		lines = append(lines, mustJSON(map[string]any{
			"type": "index", "ts": "2026-07-27T10:00:00Z", "reqID": strconv.Itoa(i),
			"model": "gpt-4", "status": "success",
		}))
	}
	writeIndexFile(t, tracesDir, "20260727", lines)

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727&limit=5000", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}

	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	respLines, ok := resp["lines"].([]any)
	if !ok {
		t.Fatal("expected lines array")
	}
	if len(respLines) != 5 {
		t.Errorf("expected 5 lines, got %d", len(respLines))
	}
}

func TestTraceIndex_QFilterProvider(t *testing.T) {
	tracesDir, r := setupTraceTest(t)
	writeIndexFile(t, tracesDir, "20260727", []string{
		mustJSON(map[string]any{"type": "index", "ts": "2026-07-27T10:00:00Z", "reqID": "1", "provider": "openai", "model": "gpt-4", "status": "success"}),
		mustJSON(map[string]any{"type": "index", "ts": "2026-07-27T11:00:00Z", "reqID": "2", "provider": "anthropic", "model": "claude-3", "status": "success"}),
	})

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727&q=anth", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}

	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	respLines, ok := resp["lines"].([]any)
	if !ok {
		t.Fatal("expected lines array")
	}
	if len(respLines) != 1 {
		t.Errorf("expected 1 line for q=anth, got %d", len(respLines))
	}
}

func TestTraceIndex_QFilterError(t *testing.T) {
	tracesDir, r := setupTraceTest(t)
	writeIndexFile(t, tracesDir, "20260727", []string{
		mustJSON(map[string]any{"type": "index", "ts": "2026-07-27T10:00:00Z", "reqID": "1", "status": "error", "error": "timeout", "model": "gpt-4"}),
		mustJSON(map[string]any{"type": "index", "ts": "2026-07-27T11:00:00Z", "reqID": "2", "status": "success", "model": "gpt-4"}),
	})

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727&q=timeout", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}

	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	respLines, ok := resp["lines"].([]any)
	if !ok {
		t.Fatal("expected lines array")
	}
	if len(respLines) != 1 {
		t.Errorf("expected 1 line for q=timeout, got %d", len(respLines))
	}
}

func TestTraceIndex_ReverseOrder(t *testing.T) {
	tracesDir, r := setupTraceTest(t)
	writeIndexFile(t, tracesDir, "20260727", []string{
		mustJSON(map[string]any{"type": "index", "ts": "2026-07-27T08:00:00Z", "reqID": "1", "model": "gpt-4", "status": "success"}),
		mustJSON(map[string]any{"type": "index", "ts": "2026-07-27T09:00:00Z", "reqID": "2", "model": "gpt-4", "status": "success"}),
		mustJSON(map[string]any{"type": "index", "ts": "2026-07-27T10:00:00Z", "reqID": "3", "model": "gpt-4", "status": "success"}),
	})

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}

	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}

	respLines, ok := resp["lines"].([]any)
	if !ok {
		t.Fatal("expected lines array")
	}
	if len(respLines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(respLines))
	}

	// First line should be the newest (reqID=3).
	if s(respLines[0].(map[string]any), "reqID") != "3" {
		t.Errorf("expected first line reqID=3, got %v", respLines[0])
	}
	// Last line should be the oldest (reqID=1).
	if s(respLines[2].(map[string]any), "reqID") != "1" {
		t.Errorf("expected last line reqID=1, got %v", respLines[2])
	}
}

func TestTraceReq_InvalidReqID(t *testing.T) {
	tracesDir, r := setupTraceTest(t)
	writeReqFile(t, tracesDir, "valid-req", []string{
		mustJSON(map[string]any{"type": "request", "reqID": "valid-req"}),
	})

	// Valid reqID should work.
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/req/valid-req", nil))

}

// TestSanitizePathParam verifies the path traversal protection logic directly.
func TestSanitizePathParam(t *testing.T) {
	cases := []struct {
		input    string
		expected bool
	}{
		{"abc-123", true},
		{"foo/bar", false},
		{"foo\\bar", false},
		{"../etc/passwd", false},
		{"foo/../bar", false},
		{"foo\x00bar", false},
	}
	for _, tc := range cases {
		got := sanitizePathParam(tc.input)
		if got != tc.expected {
			t.Errorf("sanitizePathParam(%q) = %v, want %v", tc.input, got, tc.expected)
		}
	}
}

// TestTraceIndex_LargeFileStreaming verifies the two-pass streaming reader
// over a large index file: only the requested page is returned (newest-first),
// the full file is never loaded into memory, and all trace fields survive the
// read projection.
func TestTraceIndex_LargeFileStreaming(t *testing.T) {
	tracesDir, r := setupTraceTest(t)
	const totalLines = 20000
	var lines []string
	for i := range totalLines {
		lines = append(lines, mustJSON(map[string]any{
			"type": "index", "ts": "2026-07-27T10:00:00Z", "reqID": "req-" + strconv.Itoa(i),
			"model": "gpt-4", "provider": "openai", "status": "success",
			"finalKey": "key-" + strconv.Itoa(i), "finalKeyName": "Key-" + strconv.Itoa(i),
			"upstreamURL": "https://user:pass@example.com/v1",
		}))
	}
	writeIndexFile(t, tracesDir, "20260727", lines)

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727&limit=50&offset=0", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if f64(resp, "total") != totalLines {
		t.Errorf("expected total %d, got %v", totalLines, resp["total"])
	}
	page, ok := resp["lines"].([]any)
	if !ok {
		t.Fatal("expected lines array")
	}
	if len(page) != 50 {
		t.Fatalf("expected 50 lines, got %d", len(page))
	}
	// Newest first: the last-written line must be first.
	if s(page[0].(map[string]any), "reqID") != "req-19999" {
		t.Errorf("expected newest line req-19999 first, got %v", page[0])
	}
	// Trace metadata remains available while URL userinfo is masked.
	first := page[0].(map[string]any)
	if s(first, "finalKey") != "key-19999" {
		t.Errorf("expected finalKey key-19999, got %v", first["finalKey"])
	}
	if s(first, "finalKeyName") != "Key-19999" {
		t.Errorf("expected finalKeyName Key-19999, got %v", first["finalKeyName"])
	}
	if got := s(first, "upstreamURL"); got != "https://user:******@example.com/v1" {
		t.Errorf("expected masked upstream URL, got %q", got)
	}

	// A window deep into the file (offset near total) returns the matching
	// oldest lines reversed.
	rr = httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727&limit=50&offset=19950", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	json.Unmarshal(rr.Body.Bytes(), &resp)
	page = resp["lines"].([]any)
	if len(page) != 50 {
		t.Fatalf("expected 50 lines at offset 19950, got %d", len(page))
	}
	if s(page[0].(map[string]any), "reqID") != "req-49" {
		t.Errorf("expected req-49 first at offset 19950, got %v", page[0])
	}
}

// TestTraceIndex_PaginationBoundaries pins the offset/limit edge semantics:
// first/last page, offset at or beyond total (empty page), and invalid limit
// values falling back to the default.
func TestTraceIndex_PaginationBoundaries(t *testing.T) {
	tracesDir, r := setupTraceTest(t)
	var lines []string
	for i := range 5 {
		lines = append(lines, mustJSON(map[string]any{
			"type": "index", "ts": "2026-07-27T10:00:00Z", "reqID": strconv.Itoa(i),
			"model": "gpt-4", "status": "success",
		}))
	}
	writeIndexFile(t, tracesDir, "20260727", lines)

	cases := []struct {
		query     string
		wantFirst string // first returned reqID; "" means an empty page
		wantCount int
	}{
		{"date=20260727&limit=2&offset=0", "4", 2},
		{"date=20260727&limit=2&offset=2", "2", 2},
		{"date=20260727&limit=2&offset=4", "0", 1}, // short page: offset+limit > total
		{"date=20260727&limit=2&offset=5", "", 0},  // offset == total
		{"date=20260727&limit=2&offset=9", "", 0},  // offset > total
		{"date=20260727&limit=1000&offset=0", "4", 5},
		{"date=20260727&limit=0", "4", 5},   // invalid limit -> default
		{"date=20260727&limit=-1", "4", 5},  // negative limit -> default
		{"date=20260727&limit=abc", "4", 5}, // non-numeric limit -> default
		{"date=20260727&offset=abc", "4", 5},
	}
	for _, tc := range cases {
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?"+tc.query, nil))
		if rr.Code != http.StatusOK {
			t.Errorf("query %q: expected 200, got %d", tc.query, rr.Code)
			continue
		}
		var resp map[string]any
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Errorf("query %q: invalid JSON: %v", tc.query, err)
			continue
		}
		if f64(resp, "total") != 5 {
			t.Errorf("query %q: expected total 5, got %v", tc.query, resp["total"])
			continue
		}
		page, ok := resp["lines"].([]any)
		if !ok {
			t.Errorf("query %q: expected lines array", tc.query)
			continue
		}
		if len(page) != tc.wantCount {
			t.Errorf("query %q: expected %d lines, got %d", tc.query, tc.wantCount, len(page))
			continue
		}
		if tc.wantFirst == "" {
			continue
		}
		if s(page[0].(map[string]any), "reqID") != tc.wantFirst {
			t.Errorf("query %q: expected first reqID %s, got %v", tc.query, tc.wantFirst, page[0])
		}
	}
}

func TestTraceIndex_QFilterTooLong(t *testing.T) {
	_, r := setupTraceTest(t)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727&q="+strings.Repeat("a", maxQFilterLen+1), nil))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for oversized q, got %d", rr.Code)
	}
}

func TestTraceIndex_ImpossibleDate(t *testing.T) {
	_, r := setupTraceTest(t)
	for _, date := range []string{"2026-13-99", "20260230"} {
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/index?date="+date, nil))
		if rr.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for date %q, got %d", date, rr.Code)
		}
	}
}

func TestTraceReq_ReqIDTooLong(t *testing.T) {
	_, r := setupTraceTest(t)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/req/"+strings.Repeat("a", maxReqIDLen+1), nil))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for oversized reqID, got %d", rr.Code)
	}
}

// TestTraceReq_LargeFileTruncation verifies the line cap on per-request trace
// files: a file with more than maxReqDetailLines lines returns the first
// maxReqDetailLines lines in chronological order and flags truncated.
func TestTraceReq_LargeFileTruncation(t *testing.T) {
	tracesDir, r := setupTraceTest(t)
	reqID := "big-req"
	var lines []string
	for i := range maxReqDetailLines * 3 {
		lines = append(lines, mustJSON(map[string]any{
			"type": "attempt", "reqID": reqID, "n": i + 1, "status": "success", "model": "gpt-4",
		}))
	}
	writeReqFile(t, tracesDir, reqID, lines)

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/req/"+reqID, nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	page, ok := resp["lines"].([]any)
	if !ok {
		t.Fatal("expected lines array")
	}
	if len(page) != maxReqDetailLines {
		t.Errorf("expected %d lines, got %d", maxReqDetailLines, len(page))
	}
	if tr, ok := resp["truncated"].(bool); !ok || !tr {
		t.Errorf("expected truncated=true, got %v", resp["truncated"])
	}
	// Chronological order preserved: first line is attempt 1.
	if f64(page[0].(map[string]any), "n") != 1 {
		t.Errorf("expected first line n=1, got %v", page[0])
	}
}

// TestTraceReq_ResponseByteBudget verifies the response byte cap: large bodies
// must stop collection well before the line cap and the wire response must
// stay bounded.
func TestTraceReq_ResponseByteBudget(t *testing.T) {
	tracesDir, r := setupTraceTest(t)
	reqID := "big-body-req"
	big := strings.Repeat("x", 512*1024)
	var lines []string
	for i := range 40 {
		lines = append(lines, mustJSON(map[string]any{
			"type": "attempt", "reqID": reqID, "n": i + 1, "status": "success", "respBody": big,
		}))
	}
	writeReqFile(t, tracesDir, reqID, lines)

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/req/"+reqID, nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	page, ok := resp["lines"].([]any)
	if !ok {
		t.Fatal("expected lines array")
	}
	if len(page) == 0 {
		t.Fatal("expected at least one line")
	}
	if len(page) == 40 {
		t.Fatal("expected the byte budget to truncate the page")
	}
	if tr, ok := resp["truncated"].(bool); !ok || !tr {
		t.Errorf("expected truncated=true, got %v", resp["truncated"])
	}
	// The wire response stays bounded by the budget (plus envelope slack).
	if rr.Body.Len() > maxTraceResponseBytes+4096 {
		t.Errorf("response too large: %d bytes", rr.Body.Len())
	}
}

// TestTraceReq_TransparentRecord verifies that trace fields remain visible and
// only credential values are masked at the read boundary.
func TestTraceReq_TransparentRecord(t *testing.T) {
	tracesDir, r := setupTraceTest(t)
	reqID := "secret-req"
	const secret = "sk-test-super-secret-value-123456"
	const userinfo = "https://user:sekrit@api.example.com/v1/chat/completions"
	writeReqFile(t, tracesDir, reqID, []string{
		mustJSON(map[string]any{
			"type": "request", "reqID": reqID,
			"reqHeaders": map[string]any{
				"Authorization": []any{"Bearer " + secret},
				"X-Api-Key":     []any{"plain-key-value"},
				"Cookie":        []any{"session=visible"},
				"X-Custom":      []any{"ok"},
				"X-Masked":      []any{"***abcd"},
			},
			"upstreamURL": userinfo,
			"newField":    "must remain visible",
		}),
		mustJSON(map[string]any{
			"type": "attempt", "reqID": reqID, "n": 1, "status": "success",
			"finalKey": "key-1", "finalKeyName": "Key-1", "upstreamURL": userinfo,
		}),
	})

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/traces/req/"+reqID, nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	body := rr.Body.String()
	if strings.Contains(body, secret) {
		t.Error("response leaked the raw secret value")
	}
	if strings.Contains(body, "sekrit") {
		t.Error("response leaked upstream URL userinfo")
	}
	if !strings.Contains(body, "finalKey") || !strings.Contains(body, "key-1") {
		t.Error("response omitted finalKey metadata")
	}
	if !strings.Contains(body, "upstreamURL") || !strings.Contains(body, "newField") {
		t.Error("response omitted transparent trace fields")
	}

	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	page, ok := resp["lines"].([]any)
	if !ok || len(page) != 2 {
		t.Fatalf("expected 2 lines, got %v", resp["lines"])
	}
	headers, ok := page[0].(map[string]any)["reqHeaders"].(map[string]any)
	if !ok {
		t.Fatal("expected reqHeaders object")
	}
	headerVal := func(name string) string {
		vals, ok := headers[name].([]any)
		if !ok || len(vals) == 0 {
			return ""
		}
		s, _ := vals[0].(string)
		return s
	}
	if got := headerVal("Authorization"); got != "Bearer ******" {
		t.Errorf("Authorization not masked, got %q", got)
	}
	if got := headerVal("X-Api-Key"); got != "******" {
		t.Errorf("X-Api-Key not masked, got %q", got)
	}
	if got := headerVal("Cookie"); got != "session=visible" {
		t.Errorf("ordinary Cookie header should pass through, got %q", got)
	}
	if got := headerVal("X-Custom"); got != "ok" {
		t.Errorf("non-secret header should pass through, got %q", got)
	}
	if got := headerVal("X-Masked"); got != "***abcd" {
		t.Errorf("already-masked header should pass through unchanged, got %q", got)
	}
}

// TestTraceIndex_ContextCancellation verifies a canceled request aborts the
// read before scanning the file or writing a response.
func TestTraceIndex_ContextCancellation(t *testing.T) {
	tracesDir, r := setupTraceTest(t)
	var lines []string
	for i := range 5000 {
		lines = append(lines, mustJSON(map[string]any{
			"type": "index", "ts": "2026-07-27T10:00:00Z", "reqID": strconv.Itoa(i), "status": "success",
		}))
	}
	writeIndexFile(t, tracesDir, "20260727", lines)

	req := httptest.NewRequest(http.MethodGet, "/api/traces/index?date=20260727", nil)
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	req = req.WithContext(ctx)

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	if rr.Body.Len() != 0 {
		t.Errorf("expected no response body after cancellation, got %d bytes", rr.Body.Len())
	}
}

func TestTraceReq_ContextCancellation(t *testing.T) {
	tracesDir, r := setupTraceTest(t)
	reqID := "cancel-req"
	var lines []string
	for i := range 5000 {
		lines = append(lines, mustJSON(map[string]any{
			"type": "attempt", "reqID": reqID, "n": i + 1, "status": "success",
		}))
	}
	writeReqFile(t, tracesDir, reqID, lines)

	req := httptest.NewRequest(http.MethodGet, "/api/traces/req/"+reqID, nil)
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	req = req.WithContext(ctx)

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	if rr.Body.Len() != 0 {
		t.Errorf("expected no response body after cancellation, got %d bytes", rr.Body.Len())
	}
}
