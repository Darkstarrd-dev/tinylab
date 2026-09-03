package proxy

import (
	"testing"

	"github.com/tinylab/tinylab/internal/config"
)

func TestBackfillThoughtSignatures_MissingField(t *testing.T) {
	cache := NewSignatureCache()
	cache.Put("FL1tqiJ9", "Eo4GCosG===")

	parsed := map[string]any{
		"messages": []any{
			map[string]any{
				"role": "assistant",
				"tool_calls": []any{
					map[string]any{
						"id":       "FL1tqiJ9",
						"type":     "function",
						"function": map[string]any{"name": "task", "arguments": "{}"},
					},
				},
			},
		},
	}

	backfillThoughtSignatures(parsed, cache)

	msgs := parsed["messages"].([]any)
	tc := msgs[0].(map[string]any)["tool_calls"].([]any)[0].(map[string]any)
	extra, ok := tc["extra_content"].(map[string]any)
	if !ok {
		t.Fatalf("expected extra_content to be injected")
	}
	google, ok := extra["google"].(map[string]any)
	if !ok {
		t.Fatalf("expected extra_content.google")
	}
	sig, ok := google["thought_signature"].(string)
	if !ok || sig != "Eo4GCosG===" {
		t.Fatalf("expected injected sig Eo4GCosG===, got %q ok=%v", sig, ok)
	}
}

func TestBackfillThoughtSignatures_AlreadyPresent(t *testing.T) {
	cache := NewSignatureCache()
	cache.Put("FL1tqiJ9", "cached-sig")

	parsed := map[string]any{
		"messages": []any{
			map[string]any{
				"role": "assistant",
				"tool_calls": []any{
					map[string]any{
						"id":   "FL1tqiJ9",
						"type": "function",
						"extra_content": map[string]any{
							"google": map[string]any{"thought_signature": "original-sig"},
						},
					},
				},
			},
		},
	}

	backfillThoughtSignatures(parsed, cache)

	tc := parsed["messages"].([]any)[0].(map[string]any)["tool_calls"].([]any)[0].(map[string]any)
	google := tc["extra_content"].(map[string]any)["google"].(map[string]any)
	sig := google["thought_signature"].(string)
	if sig != "original-sig" {
		t.Fatalf("expected original-sig to be preserved, got %q", sig)
	}
}

func TestBackfillThoughtSignatures_CacheMiss(t *testing.T) {
	cache := NewSignatureCache()

	parsed := map[string]any{
		"messages": []any{
			map[string]any{
				"role": "assistant",
				"tool_calls": []any{
					map[string]any{
						"id":   "unknown",
						"type": "function",
					},
				},
			},
		},
	}

	backfillThoughtSignatures(parsed, cache)

	tc := parsed["messages"].([]any)[0].(map[string]any)["tool_calls"].([]any)[0].(map[string]any)
	if _, ok := tc["extra_content"]; ok {
		t.Fatalf("expected no extra_content injected on cache miss")
	}
}

func TestIsGeminiOpenAICompat(t *testing.T) {
	cases := []struct {
		baseURL string
		want    bool
	}{
		{"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", true},
		{"https://GENERATIVELANGUAGE.GOOGLEAPIS.COM/V1BETA/OPENAI", true},
		{"https://generativelanguage.googleapis.com/v1beta/models", false},
		{"https://generativelanguage.googleapis.com/openai/", true},
		{"https://generativelanguage.googleapis.com/", false},
		{"https://api.openai.com/v1", false},
		{"https://ai.googleapis.com/v1beta/openai", false},
	}
	for _, c := range cases {
		p := config.Provider{BaseURL: c.baseURL}
		if got := p.IsGeminiOpenAICompat(); got != c.want {
			t.Errorf("IsGeminiOpenAICompat(%q) = %v, want %v", c.baseURL, got, c.want)
		}
	}
}
