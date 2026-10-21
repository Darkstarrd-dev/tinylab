package jethub

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestModelscopeFallbackModels(t *testing.T) {
	models := modelscopeFallbackModels()
	if len(models) != 36 {
		t.Fatalf("expected 36 fallback models, got %d", len(models))
	}
	foundDeepseek := false
	foundQwen := false
	for _, m := range models {
		if m.ID == "deepseek-ai/DeepSeek-V4.1-Flash" {
			foundDeepseek = true
			if !strings.Contains(m.Note, "1048576") || !strings.Contains(m.Note, "image") || !strings.Contains(m.Note, "efforts none") {
				t.Fatalf("DeepSeek-V4.1-Flash note drifted: %s", m.Note)
			}
		}
		if m.ID == "Qwen/Qwen3.8-Flash-Next" {
			foundQwen = true
		}
	}
	if !foundDeepseek || !foundQwen {
		t.Fatal("expected DeepSeek-V4.1-Flash and Qwen3.8-Flash-Next in modelscope fallback models")
	}
}

func TestModelscopeAddAccountAndCredential(t *testing.T) {
	mgr, err := NewManager(t.TempDir(), "", nil)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}

	// Invalid format
	if _, _, err := mgr.AddModelscopeAccount("invalid-key", ""); err == nil {
		t.Fatal("expected error on invalid key format")
	}

	validKey := "ms-1234567890abcdef1234"
	id, reused, err := mgr.AddModelscopeAccount(validKey, "")
	if err != nil {
		t.Fatalf("add account failed: %v", err)
	}
	if reused {
		t.Fatal("expected new account, got reused")
	}

	// Check dedup / reuse
	id2, reused2, err := mgr.AddModelscopeAccount(validKey, "")
	if err != nil {
		t.Fatalf("add account duplicate failed: %v", err)
	}
	if !reused2 || id2 != id {
		t.Fatalf("expected reuse of %s, got id=%s reused=%v", id, id2, reused2)
	}

	// Verify credential retrieval
	cred, err := mgr.modelscopeCredentialFor(id)
	if err != nil {
		t.Fatalf("modelscopeCredentialFor: %v", err)
	}
	if cred.AccessToken != validKey {
		t.Fatalf("credential mismatch: got %q, want %q", cred.AccessToken, validKey)
	}
}

func TestModelscopeAugment(t *testing.T) {
	mgr, err := NewManager(t.TempDir(), "", nil)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	key := "ms-1234567890abcdef1234"
	id, _, err := mgr.AddModelscopeAccount(key, "Test Nick")
	if err != nil {
		t.Fatalf("add account: %v", err)
	}

	req, _ := http.NewRequest(http.MethodPost, "http://localhost/v1/chat/completions", nil)
	rawBody := []byte(`{
		"model": "deepseek-ai/DeepSeek-V4.1-Flash",
		"messages": [{"role": "user", "content": "hi"}],
		"tools": [
			{"name": "fetch", "description": "get url", "parameters": {"type": "object"}}
		]
	}`)

	augmented, err := mgr.modelscopeAugment(req, rawBody, "jethub-modelscope", id, "deepseek-ai/DeepSeek-V4.1-Flash")
	if err != nil {
		t.Fatalf("augment failed: %v", err)
	}

	if req.Header.Get("Authorization") != "Bearer "+key {
		t.Fatalf("Authorization header mismatch: %s", req.Header.Get("Authorization"))
	}
	if req.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("Content-Type header mismatch: %s", req.Header.Get("Content-Type"))
	}

	// Check tools wrapped in {type: "function", function: {...}}
	var parsed map[string]any
	if err := json.Unmarshal(augmented, &parsed); err != nil {
		t.Fatalf("unmarshal augmented: %v", err)
	}
	tools, ok := parsed["tools"].([]any)
	if !ok || len(tools) != 1 {
		t.Fatalf("tools should be array of len 1, got %+v", parsed["tools"])
	}
	firstTool, ok := tools[0].(map[string]any)
	if !ok || firstTool["type"] != "function" {
		t.Fatalf("expected tool type='function', got %+v", firstTool)
	}
	fn, ok := firstTool["function"].(map[string]any)
	if !ok || fn["name"] != "fetch" {
		t.Fatalf("expected function.name='fetch', got %+v", fn)
	}
}

func TestModelscopeBalance(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ms-1234567890abcdef1234" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"data": map[string]any{
				"total_balance":     281.0,
				"available_balance": 277.0,
			},
		})
	}))
	defer server.Close()

	mgr, err := NewManager(t.TempDir(), "", nil)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	key := "ms-1234567890abcdef1234"
	_, _, err = mgr.AddModelscopeAccount(key, "Test")
	if err != nil {
		t.Fatalf("add account: %v", err)
	}

	// Swap client for test
	mgr.sharedClients.direct = server.Client()

	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, nil)
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := server.Client().Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("mock test call failed: %v", err)
	}
}
