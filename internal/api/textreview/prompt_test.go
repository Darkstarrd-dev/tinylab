package textreview

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/registry"
)

func TestPromptDefaultCRUD(t *testing.T) {
	cfgFile := filepath.Join(t.TempDir(), "config.yaml")
	reg := registry.New(&config.Config{})
	h := NewHandler(&apibase.Deps{
		Reg:        reg,
		ConfigPath: cfgFile,
	})

	r := chi.NewRouter()
	r.Route("/api/text-review", func(r chi.Router) {
		h.Register(r)
	})

	// 1. Initial GET returns built-in prompt
	req := httptest.NewRequest("GET", "/api/text-review/prompt-default", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var res struct {
		SystemPrompt  string `json:"systemPrompt"`
		BuiltinPrompt string `json:"builtinPrompt"`
	}
	if err := json.NewDecoder(w.Body).Decode(&res); err != nil {
		t.Fatalf("decode GET res: %v", err)
	}
	if res.SystemPrompt != defaultCleanSystemPrompt {
		t.Errorf("expected default system prompt, got %q", res.SystemPrompt)
	}
	if res.BuiltinPrompt != defaultCleanSystemPrompt {
		t.Errorf("expected builtin prompt, got %q", res.BuiltinPrompt)
	}

	// 2. POST custom prompt
	custom := "自定义小说清理提示词"
	body, _ := json.Marshal(map[string]string{"systemPrompt": custom})
	req = httptest.NewRequest("POST", "/api/text-review/prompt-default", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 on POST, got %d", w.Code)
	}

	// Verify in-memory registry
	if got := reg.GetTextReviewPrompt(); got != custom {
		t.Errorf("expected in-memory prompt %q, got %q", custom, got)
	}

	// 3. GET returns updated prompt
	req = httptest.NewRequest("GET", "/api/text-review/prompt-default", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var res2 struct {
		SystemPrompt  string `json:"systemPrompt"`
		BuiltinPrompt string `json:"builtinPrompt"`
	}
	json.NewDecoder(w.Body).Decode(&res2)
	if res2.SystemPrompt != custom {
		t.Errorf("expected custom prompt %q, got %q", custom, res2.SystemPrompt)
	}
	if res2.BuiltinPrompt != defaultCleanSystemPrompt {
		t.Errorf("expected builtin prompt unchanged, got %q", res2.BuiltinPrompt)
	}

	// 4. Reset to empty
	body, _ = json.Marshal(map[string]string{"systemPrompt": ""})
	req = httptest.NewRequest("POST", "/api/text-review/prompt-default", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 on reset POST, got %d", w.Code)
	}

	req = httptest.NewRequest("GET", "/api/text-review/prompt-default", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var res3 struct {
		SystemPrompt  string `json:"systemPrompt"`
		BuiltinPrompt string `json:"builtinPrompt"`
	}
	json.NewDecoder(w.Body).Decode(&res3)
	if res3.SystemPrompt != defaultCleanSystemPrompt {
		t.Errorf("expected fallback to default prompt on empty, got %q", res3.SystemPrompt)
	}
}
