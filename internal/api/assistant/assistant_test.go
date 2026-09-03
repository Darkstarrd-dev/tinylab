package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/assistant"
)

func setupTestHandler(t *testing.T) (*Handler, chi.Router) {
	c, err := assistant.LoadContract()
	if err != nil {
		t.Fatalf("LoadContract failed: %v", err)
	}

	routes := map[string]bool{
		"POST /v1/images/generations": true,
		"POST /api/editor/save":       true,
		"POST /api/traces/clear":      true,
		"GET /api/traces":             true,
	}
	ast, _ := c.BuildAssistant(routes, true)

	events := NewEventBroadcaster()
	todos := NewTodoStore()
	h := NewHandler(nil, ast, c, events, todos)

	r := chi.NewRouter()
	r.Route("/api/assistant", func(sub chi.Router) {
		h.Register(sub)
	})

	return h, r
}

func TestGetTools(t *testing.T) {
	_, r := setupTestHandler(t)

	req := httptest.NewRequest("GET", "/api/assistant/tools", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var resp struct {
		Tools []ToolSchema `json:"tools"`
		Wired []string     `json:"wired"`
		Count int          `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	if resp.Count == 0 || len(resp.Tools) == 0 {
		t.Error("expected non-empty tools")
	}
	if len(resp.Wired) == 0 {
		t.Error("expected wired tools list")
	}
}

func TestDispatchIntent(t *testing.T) {
	_, r := setupTestHandler(t)

	body, _ := json.Marshal(map[string]any{
		"intent": "生成一张猫的图片",
	})
	req := httptest.NewRequest("POST", "/api/assistant/dispatch", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp DispatchResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	if len(resp.Tools) == 0 {
		t.Fatal("expected at least 1 resolved tool")
	}
	if resp.Tools[0].Tool != "image.generate" {
		t.Fatalf("expected image.generate, got %s", resp.Tools[0].Tool)
	}
}

func TestJobsEndpoints(t *testing.T) {
	_, r := setupTestHandler(t)

	// List jobs
	req := httptest.NewRequest("GET", "/api/assistant/jobs", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Create job
	body, _ := json.Marshal(map[string]any{
		"name":        "custom-sweep",
		"intervalSec": 300,
	})
	req = httptest.NewRequest("POST", "/api/assistant/jobs", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on create, got %d: %s", rec.Code, rec.Body.String())
	}

	// Delete job
	req = httptest.NewRequest("DELETE", "/api/assistant/jobs/custom-sweep", nil)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on delete, got %d", rec.Code)
	}
}

func TestTodosEndpoints(t *testing.T) {
	_, r := setupTestHandler(t)

	// Create Todo
	body, _ := json.Marshal(map[string]any{
		"text":  "Check model benchmarks",
		"dueAt": time.Now().Add(-1 * time.Minute).Format(time.RFC3339),
	})
	req := httptest.NewRequest("POST", "/api/assistant/todos", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var createResp struct {
		Todo TodoItem `json:"todo"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &createResp)
	if createResp.Todo.ID == "" {
		t.Fatal("expected non-empty todo ID")
	}

	// List Todos
	req = httptest.NewRequest("GET", "/api/assistant/todos", nil)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	var listResp struct {
		Todos []TodoItem `json:"todos"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &listResp)
	if len(listResp.Todos) != 1 {
		t.Fatalf("expected 1 todo, got %d", len(listResp.Todos))
	}

	// Delete Todo
	req = httptest.NewRequest("DELETE", "/api/assistant/todos/"+createResp.Todo.ID, nil)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on delete, got %d", rec.Code)
	}
}

func TestEventBroadcaster(t *testing.T) {
	b := NewEventBroadcaster()
	ch, unsub := b.Subscribe()
	defer unsub()

	b.Broadcast(Event{
		Type:    "notify",
		Title:   "Test Alert",
		Message: "Hello",
	})

	select {
	case evt := <-ch:
		if evt.Title != "Test Alert" {
			t.Fatalf("expected 'Test Alert', got %q", evt.Title)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("timed out waiting for broadcast event")
	}
}

// mockLLM is a test double for the intentClassifier interface, returning a
// fixed tool list or error to exercise the classifyIntent orchestration
// (LLM-first → filter-by-Resolve → keyword fallback) without a real upstream.
type mockLLM struct {
	tools []string
	err   error
}

func (m mockLLM) Classify(_ context.Context, _ string) ([]string, error) {
	return m.tools, m.err
}

// TestClassifyIntent_LLMOrchestration behaviorally verifies the smart-assistant
// dispatch path (item 3): the bench measures llm_dispatch_wired structurally,
// but the orchestration (use LLM tools when resolvable, else fall back to the
// keyword brain) is proven here with an injected mock — no network.
func TestClassifyIntent_LLMOrchestration(t *testing.T) {
	h, _ := setupTestHandler(t)
	ast := h.Assistant()
	ctx := context.Background()

	// Case 1: LLM returns a resolvable tool → it is used (not the keyword path).
	h.SetLLMClassifier(mockLLM{tools: []string{"image.generate"}})
	got := h.classifyIntent(ctx, ast, "随便说点什么")
	if len(got) != 1 || got[0] != "image.generate" {
		t.Fatalf("case1: expected [image.generate] from LLM, got %v", got)
	}

	// Case 2: LLM errors → keyword fallback.
	h.SetLLMClassifier(mockLLM{err: errors.New("upstream unavailable")})
	got = h.classifyIntent(ctx, ast, "生成一张猫的图片")
	if len(got) == 0 || got[0] != "image.generate" {
		t.Fatalf("case2: expected keyword fallback to image.generate, got %v", got)
	}

	// Case 3: LLM returns an unresolvable tool → filtered out → keyword fallback.
	h.SetLLMClassifier(mockLLM{tools: []string{"nonexistent.tool"}})
	got = h.classifyIntent(ctx, ast, "清理过期的日志")
	if len(got) == 0 || got[0] != "trace.clear" {
		t.Fatalf("case3: expected keyword fallback to trace.clear, got %v", got)
	}

	// Case 4: no injected LLM and nil deps → config-built classifier is nil → keyword.
	h.SetLLMClassifier(nil)
	got = h.classifyIntent(ctx, ast, "写一篇文档并保存")
	if len(got) == 0 || got[0] != "editor.save" {
		t.Fatalf("case4: expected keyword editor.save, got %v", got)
	}
}
