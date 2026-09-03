package imagebatch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	domain "github.com/tinylab/tinylab/internal/imagebatch"
)

const helperSystemPrompt = "Return raw JSON only. No code blocks, no backticks, no explanations. Start with { and end with }. Preserve the user's subject and intent."

type helperChatRequest struct {
	Model    string              `json:"model"`
	Messages []map[string]string `json:"messages"`
}
type helperChatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

func (h *Handler) plan(w http.ResponseWriter, r *http.Request) {
	var in domain.PlanInput
	if err := decodeJSON(r, &in); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if err := in.Validate(); err != nil {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if h.d == nil || h.d.ProxyHandler == nil {
		errJSON(w, http.StatusServiceUnavailable, "helper model unavailable")
		return
	}
	prompt := fmt.Sprintf("Create a JSON image plan for these requirements: %s\nUse this as the default negative prompt unless an item specifies otherwise: %s\nDefault quantity: %d\nReturn {\"title\":string,\"items\":[{\"id\":unique alphanumeric string (max 128 chars)\",\"title\":string,\"naturalPrompt\":string,\"negativePrompt\":string,\"quantity\":integer 1-100}]}", in.Requirements, in.DefaultNegativePrompt, in.DefaultQuantity)
	if strings.TrimSpace(in.CustomUserPrompt) != "" {
		prompt = strings.TrimSpace(in.CustomUserPrompt)
	}
	sys := helperSystemPrompt
	if strings.TrimSpace(in.CustomSystemPrompt) != "" {
		sys = strings.TrimSpace(in.CustomSystemPrompt)
	}
	content, err := h.callHelper(r.Context(), in.HelperModel, sys, prompt)
	if err != nil {
		errJSON(w, http.StatusBadGateway, "helper model request failed: "+err.Error())
		return
	}
	var out domain.PlanOutput
	if err := decodeStrictContent(content, &out); err != nil {
		errJSON(w, http.StatusBadGateway, "helper model returned invalid plan: "+err.Error())
		return
	}
	if err := out.Validate(); err != nil {
		errJSON(w, http.StatusBadGateway, "helper model returned invalid plan: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) callHelper(ctx context.Context, model, sysPrompt, prompt string) (string, error) {
	if sysPrompt == "" {
		sysPrompt = helperSystemPrompt
	}
	body, _ := json.Marshal(helperChatRequest{Model: model, Messages: []map[string]string{{"role": "system", "content": sysPrompt}, {"role": "user", "content": prompt}}})
	u, _ := url.Parse("http://in-process/v1/chat/completions")
	req := &http.Request{Method: http.MethodPost, URL: u, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(body))}
	req = req.WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-TinyLab-Source", "playground-batch")
	req.Header.Set("X-TinyLab-Provenance", "image-batch-helper")
	rec := newResponseRecorder()
	h.d.ProxyHandler.ChatCompletions(rec, req)
	if rec.code < 200 || rec.code >= 300 {
		detail := helperErrorDetail(rec.body)
		if detail != "" {
			return "", fmt.Errorf("status %d: %s", rec.code, detail)
		}
		return "", fmt.Errorf("status %d", rec.code)
	}
	var out helperChatResponse
	if err := json.Unmarshal(rec.body, &out); err != nil || len(out.Choices) == 0 {
		return "", errors.New("invalid helper response")
	}
	return out.Choices[0].Message.Content, nil
}

func decodeStrictContent(content string, dst any) error {
	content = strings.TrimSpace(content)
	if strings.HasPrefix(content, "```") {
		lines := strings.Split(content, "\n")
		if len(lines) >= 2 {
			if strings.HasPrefix(lines[0], "```") {
				lines = lines[1:]
			}
			if len(lines) > 0 && strings.HasPrefix(strings.TrimSpace(lines[len(lines)-1]), "```") {
				lines = lines[:len(lines)-1]
			}
			content = strings.TrimSpace(strings.Join(lines, "\n"))
		}
	}
	start := strings.Index(content, "{")
	end := strings.LastIndex(content, "}")
	if start >= 0 && end > start {
		content = content[start : end+1]
	}
	return json.Unmarshal([]byte(content), dst)
}

func helperErrorDetail(body []byte) string {
	var envelope struct {
		Error any `json:"error"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		return ""
	}
	switch v := envelope.Error.(type) {
	case string:
		return clipHelperError(v)
	case map[string]any:
		if msg, ok := v["message"].(string); ok {
			return clipHelperError(msg)
		}
		if code, ok := v["code"].(string); ok {
			return clipHelperError(code)
		}
	}
	return ""
}

func clipHelperError(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 512 {
		return s[:512] + "…"
	}
	return s
}

type responseRecorder struct {
	header http.Header
	code   int
	body   []byte
}

func newResponseRecorder() *responseRecorder    { return &responseRecorder{header: make(http.Header)} }
func (w *responseRecorder) Header() http.Header { return w.header }
func (w *responseRecorder) WriteHeader(c int) {
	if w.code == 0 {
		w.code = c
	}
}
func (w *responseRecorder) Write(b []byte) (int, error) {
	if w.code == 0 {
		w.code = 200
	}
	w.body = append(w.body, b...)
	return len(b), nil
}
