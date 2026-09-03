package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ChatMessage is one turn in the chat history or outbound request.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatClient calls the project's own /v1/chat/completions endpoint (loopback, same as LLMClassifier).
type ChatClient struct {
	Client *http.Client
	Addr   string
	Model  string
}

// Chat sends messages to the model with optional sampling params. Only enabled params are injected.
func (c *ChatClient) Chat(ctx context.Context, messages []ChatMessage, params map[string]ParamValue) (string, error) {
	if c.Model == "" || c.Addr == "" {
		return "", fmt.Errorf("chat not configured: missing model or addr")
	}
	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}
	msgs := make([]map[string]any, 0, len(messages))
	for _, m := range messages {
		msgs = append(msgs, map[string]any{"role": m.Role, "content": m.Content})
	}
	body := map[string]any{
		"model":    c.Model,
		"messages": msgs,
	}
	ApplyParams(body, params)
	buf, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Addr+"/v1/chat/completions", bytes.NewReader(buf))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("upstream returned %d", resp.StatusCode)
	}
	// Content may be string or array-of-parts.
	var cr struct {
		Choices []struct {
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		return "", err
	}
	if len(cr.Choices) == 0 {
		return "", fmt.Errorf("no choices in response")
	}
	raw := cr.Choices[0].Message.Content
	if len(raw) == 0 || string(raw) == "null" {
		return "", fmt.Errorf("empty content")
	}
	// Try string.
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if strings.TrimSpace(s) == "" {
			return "", fmt.Errorf("empty content")
		}
		return s, nil
	}
	// Try array of parts [{type:"text", text:"..."}].
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err == nil {
		var b strings.Builder
		for _, p := range parts {
			if p.Type == "text" || p.Type == "" {
				b.WriteString(p.Text)
			}
		}
		out := b.String()
		if strings.TrimSpace(out) == "" {
			return "", fmt.Errorf("empty content")
		}
		return out, nil
	}
	return "", fmt.Errorf("unrecognized content format")
}

// ChatSessions stores per-preset in-memory chat history (restart clears it).
type ChatSessions struct {
	mu       sync.Mutex
	sessions map[string][]ChatMessage
}

// MaxSessionMessages caps per-preset history length (FIFO truncation).
const MaxSessionMessages = 40

func NewChatSessions() *ChatSessions {
	return &ChatSessions{sessions: make(map[string][]ChatMessage)}
}

// Append adds messages to the preset's history, truncating to MaxSessionMessages.
func (s *ChatSessions) Append(preset string, msgs ...ChatMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	hist := append(s.sessions[preset], msgs...)
	if len(hist) > MaxSessionMessages {
		hist = hist[len(hist)-MaxSessionMessages:]
	}
	s.sessions[preset] = hist
}

// Get returns a copy of the preset's history.
func (s *ChatSessions) Get(preset string) []ChatMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	hist := s.sessions[preset]
	cp := make([]ChatMessage, len(hist))
	copy(cp, hist)
	return cp
}

// BuildSystemPrompt composes the system prompt for a chat request.
func BuildSystemPrompt(p ModelPreset, memory string) string {
	name := p.Name
	if strings.TrimSpace(name) == "" {
		if strings.TrimSpace(p.AssistantName) != "" {
			name = p.AssistantName
		} else {
			name = "小精灵"
		}
	}
	prompt := "You are " + name + ", a desktop-pet assistant living inside the TinyLab app. Reply concisely and in the user's language."
	if p.SystemPrompt != "" {
		prompt += "\n\n" + p.SystemPrompt
	}
	if memory != "" {
		if len(memory) > 6000 {
			memory = memory[:6000]
		}
		prompt += "\n\n## 用户记忆（参考信息；与当前对话冲突时以对话为准）\n" + memory
	}
	return prompt
}
