package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/assistant"
)

// DispatchedTool represents a resolved tool and execution/navigation details.
type DispatchedTool struct {
	Tool       string `json:"tool"`
	Method     string `json:"method"`
	Path       string `json:"path"`
	NeedsModel bool   `json:"needsModel"`
	Actionable bool   `json:"actionable"`
	NavigateTo string `json:"navigateTo,omitempty"`
	Executed   bool   `json:"executed,omitempty"`
	Status     int    `json:"status,omitempty"`
	Result     any    `json:"result,omitempty"`
	Error      string `json:"error,omitempty"`
}

// DispatchRequest specifies the user intent or tool call to dispatch.
type DispatchRequest struct {
	Intent  string         `json:"intent,omitempty"`
	Tool    string         `json:"tool,omitempty"`
	Args    map[string]any `json:"args,omitempty"`
	Execute bool           `json:"execute,omitempty"`
	Stream  bool           `json:"stream,omitempty"`
}

// DispatchResponse is the returned payload for non-streaming dispatch.
type DispatchResponse struct {
	Intent string           `json:"intent"`
	Tools  []DispatchedTool `json:"tools"`
}

// Handler provides HTTP handlers for the 小精灵 Assistant API.
type Handler struct {
	d        *apibase.Deps
	contract *assistant.Contract
	ast      *assistant.Assistant
	events   *EventBroadcaster
	todos    *TodoStore
	mu       sync.RWMutex
}

// NewHandler constructs an assistant Handler.
func NewHandler(d *apibase.Deps, ast *assistant.Assistant, contract *assistant.Contract, events *EventBroadcaster, todos *TodoStore) *Handler {
	if events == nil {
		events = NewEventBroadcaster()
	}
	if todos == nil {
		todos = NewTodoStore()
	}
	return &Handler{
		d:        d,
		contract: contract,
		ast:      ast,
		events:   events,
		todos:    todos,
	}
}

// SetDeps updates the shared API dependencies.
func (h *Handler) SetDeps(d *apibase.Deps) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.d = d
}

// SetAssistant updates the live Assistant instance while preserving existing scheduler state.
func (h *Handler) SetAssistant(ast *assistant.Assistant) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ast != nil && h.ast.Scheduler() != nil && ast != nil {
		ast.SetScheduler(h.ast.Scheduler())
	}
	h.ast = ast
}

// Assistant returns the live Assistant instance.
func (h *Handler) Assistant() *assistant.Assistant {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.ast
}

// EventsBroadcaster returns the assistant's event broadcaster.
func (h *Handler) EventsBroadcaster() *EventBroadcaster {
	return h.events
}

// Todos returns the assistant's todo store.
func (h *Handler) Todos() *TodoStore {
	return h.todos
}

// getTools handles GET /api/assistant/tools
func (h *Handler) getTools(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	c := h.contract
	ast := h.ast
	h.mu.RUnlock()

	schemas := ToolsSchemaFromContract(c)
	var wiredTools []string
	if ast != nil && ast.Registry() != nil {
		if c != nil {
			for _, t := range c.DistinctTools() {
				if _, ok := ast.Resolve(t); ok {
					wiredTools = append(wiredTools, t)
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"tools": schemas,
		"wired": wiredTools,
		"count": len(schemas),
	})
}

// dispatch handles POST /api/assistant/dispatch
func (h *Handler) dispatch(w http.ResponseWriter, r *http.Request) {
	var req DispatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	h.mu.RLock()
	ast := h.ast
	h.mu.RUnlock()

	if ast == nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "assistant is not initialized yet")
		return
	}

	var toolNames []string
	if req.Tool != "" {
		toolNames = []string{req.Tool}
	} else if req.Intent != "" {
		toolNames = h.classifyIntent(r.Context(), ast, req.Intent)
	}

	var dispatched []DispatchedTool
	for _, name := range toolNames {
		spec, ok := ast.Resolve(name)
		if !ok {
			continue
		}
		dt := DispatchedTool{
			Tool:       spec.Name,
			Method:     spec.Method,
			Path:       spec.Path,
			NeedsModel: spec.NeedsModel,
		}

		// Determine actionability vs navigation page
		dt.NavigateTo = resolveNavigationPage(spec.Path)
		dt.Actionable = (dt.NavigateTo == "") // If it doesn't navigate to a page, it's an actionable API

		// Auto execute if requested and actionable (e.g. POST /api/traces/clear)
		if req.Execute && dt.Actionable {
			status, res, err := h.executeSubRequest(r.Context(), dt.Method, dt.Path, req.Args)
			dt.Executed = true
			dt.Status = status
			dt.Result = res
			if err != nil {
				dt.Error = err.Error()
			}
		}

		dispatched = append(dispatched, dt)
	}

	// If stream requested, stream out via SSE
	if req.Stream {
		flusher, ok := w.(http.Flusher)
		if ok {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Connection", "keep-alive")

			for i, dt := range dispatched {
				payload, _ := json.Marshal(map[string]any{
					"step":  i + 1,
					"total": len(dispatched),
					"tool":  dt,
				})
				fmt.Fprintf(w, "event: progress\ndata: %s\n\n", string(payload))
				flusher.Flush()
			}

			finalPayload, _ := json.Marshal(map[string]any{
				"intent": req.Intent,
				"tools":  dispatched,
			})
			fmt.Fprintf(w, "event: done\ndata: %s\n\n", string(finalPayload))
			flusher.Flush()
			return
		}
	}

	// Normal JSON response
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(DispatchResponse{
		Intent: req.Intent,
		Tools:  dispatched,
	})
}

// resolveNavigationPage returns SPA hash route (e.g. "#editor") if the route represents a UI page.
func resolveNavigationPage(path string) string {
	switch {
	case strings.HasPrefix(path, "/api/editor"):
		return "#editor"
	case strings.HasPrefix(path, "/api/providers"):
		return "#providers"
	case strings.HasPrefix(path, "/api/combos"):
		return "#combos"
	case strings.HasPrefix(path, "/api/monitor"):
		return "#monitor"
	case strings.HasPrefix(path, "/api/downloads"):
		return "#downloads"
	case strings.HasPrefix(path, "/api/gallery"):
		return "#gallery"
	case strings.HasPrefix(path, "/api/playground"):
		return "#playground"
	case strings.HasPrefix(path, "/api/settings"):
		return "#settings"
	case strings.HasPrefix(path, "/api/text-review"):
		return "#editor"
	default:
		return ""
	}
}

// classifyIntent picks tools for an intent: LLM-assisted classification
// (item 3) when a model is configured, falling back to the keyword brain
// (Assistant.Classify) when no model is set, the upstream is unavailable,
// or the LLM returns no resolvable tools. This replaces the functional
// instant keyword-only reply with a model-assisted path while keeping the
// keyword classifier as the always-available fallback.
func (h *Handler) classifyIntent(ctx context.Context, ast *assistant.Assistant, intent string) []string {
	if llm := h.llmClassifier(ast); llm != nil {
		if names, err := llm.Classify(ctx, intent); err == nil {
			var wired []string
			seen := map[string]bool{}
			for _, n := range names {
				if _, ok := ast.Resolve(n); ok && !seen[n] {
					seen[n] = true
					wired = append(wired, n)
				}
			}
			if len(wired) > 0 {
				return wired
			}
		}
	}
	return ast.Classify(intent)
}

// llmClassifier builds an LLMClassifier from the current config + contract,
// offering only tools that resolve to a real registered route (wired via
// BuildAssistant). Returns nil when no assistant model is configured (the
// caller then uses the keyword fallback).
func (h *Handler) llmClassifier(ast *assistant.Assistant) *assistant.LLMClassifier {
	if h.d == nil || ast == nil {
		return nil
	}
	cfg := h.d.Reg.Config()
	model := cfg.Assistant.Model
	if model == "" {
		return nil
	}
	port := cfg.Port
	if port <= 0 {
		port = 20128
	}
	h.mu.RLock()
	c := h.contract
	h.mu.RUnlock()
	tools := h.llmTools(ast, c)
	if len(tools) == 0 {
		return nil
	}
	return &assistant.LLMClassifier{
		Addr:  fmt.Sprintf("http://127.0.0.1:%d", port),
		Model: model,
		Tools: tools,
	}
}

// llmTools builds the LLM-offered tool list from the contract, restricted to
// tools that resolve to a real registered route.
func (h *Handler) llmTools(ast *assistant.Assistant, c *assistant.Contract) []assistant.LLMTool {
	if c == nil || ast == nil {
		return nil
	}
	seen := map[string]bool{}
	var list []assistant.LLMTool
	for _, r := range c.Rules {
		if _, ok := ast.Resolve(r.Tool); ok && !seen[r.Tool] {
			seen[r.Tool] = true
			list = append(list, assistant.LLMTool{Name: r.Tool, Desc: r.Desc})
		}
	}
	return list
}

// executeSubRequest performs an in-process HTTP call to the project's own API.
func (h *Handler) executeSubRequest(ctx context.Context, method, path string, args map[string]any) (int, any, error) {
	if h.d == nil {
		return 500, nil, fmt.Errorf("deps not configured")
	}

	port := h.d.Reg.Config().Port
	if port <= 0 {
		port = 20128
	}
	url := fmt.Sprintf("http://127.0.0.1:%d%s", port, path)

	var bodyReader io.Reader
	if args != nil && len(args) > 0 {
		data, err := json.Marshal(args)
		if err != nil {
			return 400, nil, fmt.Errorf("marshal args: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return 500, nil, fmt.Errorf("create sub-request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{
		Timeout: 30 * time.Second,
	}

	resp, err := client.Do(req)
	if err != nil {
		return 502, nil, fmt.Errorf("sub-request execution failed: %w", err)
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, fmt.Errorf("read response body: %w", err)
	}

	var parsed any
	if len(respBytes) > 0 {
		if json.Unmarshal(respBytes, &parsed) != nil {
			parsed = string(respBytes)
		}
	}

	return resp.StatusCode, parsed, nil
}
