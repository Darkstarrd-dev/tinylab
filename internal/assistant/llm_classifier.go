package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// LLMTool is one tool exposed to the model for tool_choice: a name + a
// human-readable description. The caller (the assistant API handler) builds
// these from the contract's wired rules.
type LLMTool struct {
	Name string
	Desc string
}

// LLMClassifier classifies a user intent into tool names by asking the
// project's own model-routing layer — POST /v1/chat/completions, which
// transparently forwards tool_calls (the proxy passes tool_calls through
// unchanged) — to pick from the assistant's tool schema. It is the
// smart-assistant reply path (item 3) that replaces the keyword brain
// (Assistant.Classify) when a routable model is configured; the keyword
// classifier remains the fallback when no model is set or the upstream is
// unavailable or returns no resolvable tools.
//
// The no-network benchmark cannot exercise this path (it needs a real
// provider/key); it is measured structurally (llm_dispatch_wired) and verified
// via smoke test against a configured provider.
type LLMClassifier struct {
	Client *http.Client // injected; nil → a default 30s client
	Addr   string       // e.g. "http://127.0.0.1:20128"
	Model  string       // model id (provider-prefix/model or combo name)
	Tools  []LLMTool
}

// Classify asks the configured model to select tools for the intent. It
// returns the chosen tool names (deduped, order-stable) or an error when not
// configured, when there are no tools to offer, when the upstream is
// unreachable, or when the response carries no tool_calls.
func (c *LLMClassifier) Classify(ctx context.Context, intent string) ([]string, error) {
	if c == nil || c.Model == "" || c.Addr == "" {
		return nil, fmt.Errorf("llm classifier not configured")
	}
	if len(c.Tools) == 0 {
		return nil, fmt.Errorf("llm classifier has no tools to offer")
	}
	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	tools := make([]map[string]any, 0, len(c.Tools))
	for _, t := range c.Tools {
		tools = append(tools, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        t.Name,
				"description": t.Desc,
				"parameters":  map[string]any{"type": "object", "properties": map[string]any{}},
			},
		})
	}
	body := map[string]any{
		"model":       c.Model,
		"tool_choice": "auto",
		"tools":       tools,
		"messages": []map[string]any{
			{"role": "system", "content": "You are TinyRouter's routing assistant. Pick the tool(s) that best fulfill the user's intent from the provided tools. If none fit, respond with no tool_calls."},
			{"role": "user", "content": intent},
		},
	}
	buf, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Addr+"/v1/chat/completions", bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("upstream returned %d", resp.StatusCode)
	}
	var cr struct {
		Choices []struct {
			Message struct {
				ToolCalls []struct {
					Function struct {
						Name string `json:"name"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		return nil, err
	}
	var names []string
	seen := map[string]bool{}
	for _, ch := range cr.Choices {
		for _, tc := range ch.Message.ToolCalls {
			n := tc.Function.Name
			if n != "" && !seen[n] {
				seen[n] = true
				names = append(names, n)
			}
		}
	}
	return names, nil
}
