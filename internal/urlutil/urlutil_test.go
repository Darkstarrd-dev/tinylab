package urlutil

import "testing"

func TestBuildUpstreamURL(t *testing.T) {
	tests := []struct {
		baseURL string
		path    string
		want    string
	}{
		{"https://api.deepseek.com", "/v1/chat/completions", "https://api.deepseek.com/v1/chat/completions"},
		{"https://api.deepseek.com/v1", "/v1/chat/completions", "https://api.deepseek.com/v1/chat/completions"},
		{"https://api.deepseek.com/v1/chat/completions", "/v1/chat/completions", "https://api.deepseek.com/v1/chat/completions"},
		{"https://api.deepseek.com/", "/v1/chat/completions", "https://api.deepseek.com/v1/chat/completions"},
		{"https://generativelanguage.googleapis.com/v1beta/openai", "/v1/chat/completions", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"},
		{"https://generativelanguage.googleapis.com/v1beta/openai", "/v1/models", "https://generativelanguage.googleapis.com/v1beta/openai/models"},
		{"https://host/openai/v1", "/v1/chat/completions", "https://host/openai/v1/chat/completions"},
		{"https://example.com/custom/chat*", "/v1/chat/completions", "https://example.com/custom/chat"},
		{"https://example.com/custom/chat*", "/v1/models", "https://example.com/custom/chat"},
		{"https://example.com/custom/chat/completions*", "/v1/chat/completions", "https://example.com/custom/chat/completions"},
		// OpenRouter /api 无 /v1 → 注入 /v1
		{"https://openrouter.ai/api", "/v1/chat/completions", "https://openrouter.ai/api/v1/chat/completions"},
		// OpenRouter /api/v1 → 重复 /v1 不发生
		{"https://openrouter.ai/api/v1", "/v1/chat/completions", "https://openrouter.ai/api/v1/chat/completions"},
		// OpenRouter /api/v1/chat/completions → 归一化 + 后追加
		{"https://openrouter.ai/api/v1/chat/completions", "/v1/chat/completions", "https://openrouter.ai/api/v1/chat/completions"},
		// OpenRouter 根 → 注入
		{"https://openrouter.ai", "/v1/chat/completions", "https://openrouter.ai/v1/chat/completions"},
		// Gemini /v1beta/openai 含版本段 v1beta → 不注入 /v1
		{"https://generativelanguage.googleapis.com/v1beta/openai", "/v1/chat/completions", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"},
		// Anthropic /v1/messages 完整 → 归一化 + 后追加
		{"https://api.anthropic.com/v1/messages", "/v1/messages", "https://api.anthropic.com/v1/messages"},
		// Anthropic 根 → 注入 /v1
		{"https://api.anthropic.com", "/v1/messages", "https://api.anthropic.com/v1/messages"},
		// Responses 端点
		{"https://api.openai.com", "/v1/responses", "https://api.openai.com/v1/responses"},
		{"https://api.openai.com/v1", "/v1/responses", "https://api.openai.com/v1/responses"},
		// /v2 版本段也识别：不注入
		{"https://api.example.com/v2", "/v1/chat/completions", "https://api.example.com/v2/chat/completions"},
		// Ollama (cloud): user-entered path is dropped, /v1 is injected uniformly.
		{"https://ollama.com", "/v1/chat/completions", "https://ollama.com/v1/chat/completions"},
		{"https://ollama.com/api", "/v1/chat/completions", "https://ollama.com/v1/chat/completions"},
		{"https://ollama.com/api/tags", "/v1/models", "https://ollama.com/v1/models"},
		{"https://ollama.com/api/chat", "/v1/chat/completions", "https://ollama.com/v1/chat/completions"},
		{"https://ollama.com/v1", "/v1/chat/completions", "https://ollama.com/v1/chat/completions"},
		{"https://ollama.com/v1/chat/completions", "/v1/chat/completions", "https://ollama.com/v1/chat/completions"},
		// Ollama (local default port): same path-dropping behavior.
		{"http://localhost:11434", "/v1/chat/completions", "http://localhost:11434/v1/chat/completions"},
		{"http://localhost:11434/api", "/v1/chat/completions", "http://localhost:11434/v1/chat/completions"},
		{"http://localhost:11434/api/chat", "/v1/chat/completions", "http://localhost:11434/v1/chat/completions"},
		{"http://127.0.0.1:11434/api/tags", "/v1/models", "http://127.0.0.1:11434/v1/models"},
		// Non-Ollama localhost port must NOT get the special treatment.
		{"http://localhost:8080/api", "/v1/chat/completions", "http://localhost:8080/api/v1/chat/completions"},
	}
	for _, tt := range tests {
		got := BuildUpstreamURL(tt.baseURL, tt.path)
		if got != tt.want {
			t.Errorf("BuildUpstreamURL(%q, %q) = %q, want %q", tt.baseURL, tt.path, got, tt.want)
		}
	}
}

func TestNormalizeBaseURL_TrimsSuffixes(t *testing.T) {
	tests := []struct{ input, want string }{
		// New behavior: strips the full endpoint path including /v1 prefix
		{"https://api.example.com/v1/chat/completions", "https://api.example.com"},
		{"https://api.example.com/v1/completions", "https://api.example.com"},
		{"https://api.example.com/v1/models", "https://api.example.com"},
		// Trailing /v1 is not a suffix in the list, so it stays
		{"https://api.example.com/v1/", "https://api.example.com/v1"},
		// No path to strip
		{"https://api.example.com", "https://api.example.com"},
		// /v1 alone is not a strip target
		{"https://api.example.com/v1", "https://api.example.com/v1"},
	}
	for _, tt := range tests {
		got := normalizeBaseURL(tt.input)
		if got != tt.want {
			t.Errorf("normalizeBaseURL(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}
