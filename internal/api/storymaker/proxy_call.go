package storymaker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/api/apibase"
)

// ChatMessage represents a chat completion message.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// chatChunk mirrors an OpenAI streaming chunk.
type chatChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason,omitempty"`
	} `json:"choices"`
}

// streamingResponseWriter captures streamed SSE output from ProxyHandler live.
type streamingResponseWriter struct {
	ctx        context.Context
	header     http.Header
	statusCode int
	mu         sync.Mutex
	body       strings.Builder
	chunks     chan []byte
	closeOnce  sync.Once
}

func newStreamingResponseWriter(ctx context.Context) *streamingResponseWriter {
	return &streamingResponseWriter{
		ctx:    ctx,
		header: http.Header{},
		chunks: make(chan []byte, 64),
	}
}

func (w *streamingResponseWriter) Header() http.Header {
	return w.header
}

func (w *streamingResponseWriter) WriteHeader(code int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.statusCode != 0 {
		return
	}
	w.statusCode = code
}

func (w *streamingResponseWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	w.mu.Lock()
	w.body.Write(p)
	w.mu.Unlock()
	cp := append([]byte(nil), p...)
	select {
	case w.chunks <- cp:
	case <-w.ctx.Done():
	}
	return len(p), nil
}

func (w *streamingResponseWriter) Flush() {}

func (w *streamingResponseWriter) closeChunks() {
	w.closeOnce.Do(func() { close(w.chunks) })
}

// resolveModel verifies that the model is recognizable or wire-ready.
func resolveModel(d *apibase.Deps, modelID string) (string, bool) {
	if d == nil || d.Reg == nil || modelID == "" {
		return "", false
	}
	// Check if this is a combo
	if _, ok := d.Reg.GetComboByName(modelID); ok {
		return modelID, true
	}
	if _, ok := d.Reg.GetComboByID(modelID); ok {
		return modelID, true
	}
	// Models from /api/models already have format "prefix/model"
	if strings.Contains(modelID, "/") {
		return modelID, true
	}
	return modelID, true
}

// callProxyStreaming invokes the in-process ProxyHandler via /v1/chat/completions and streams content deltas.
func callProxyStreaming(ctx context.Context, d *apibase.Deps, model string, messages []ChatMessage, provenance string, onChunk func(delta string)) error {
	if d == nil || d.ProxyHandler == nil {
		return fmt.Errorf("proxy handler unavailable")
	}
	wireModel, ok := resolveModel(d, model)
	if !ok {
		return fmt.Errorf("model %q could not be resolved", model)
	}

	reqBody := map[string]any{
		"model":    wireModel,
		"messages": messages,
		"stream":   true,
	}
	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, 300*time.Second)
	defer cancel()

	srw := newStreamingResponseWriter(ctx)
	req := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(bodyBytes))
	req = req.WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	if provenance != "" {
		req.Header.Set("X-TinyLab-Provenance", provenance)
	}

	proxyDone := make(chan struct{})
	go func() {
		d.ProxyHandler.ChatCompletions(srw, req)
		srw.closeChunks()
		close(proxyDone)
	}()

	var parseErr error
	sb := &strings.Builder{}
	for {
		select {
		case p, ok := <-srw.chunks:
			if !ok {
				<-proxyDone
				if srw.statusCode >= 400 {
					return fmt.Errorf("proxy upstream error status %d: %s", srw.statusCode, srw.body.String())
				}
				return parseErr
			}
			sb.Write(p)
			text := sb.String()
			lastNL := strings.LastIndexByte(text, '\n')
			var complete, rest string
			if lastNL >= 0 {
				complete = text[:lastNL+1]
				rest = text[lastNL+1:]
			} else {
				rest = text
			}
			sb.Reset()
			sb.WriteString(rest)
			for _, line := range strings.Split(complete, "\n") {
				trimmed := strings.TrimSpace(line)
				if trimmed == "" || strings.HasPrefix(trimmed, ":") {
					continue
				}
				if !strings.HasPrefix(trimmed, "data:") {
					continue
				}
				payload := strings.TrimSpace(trimmed[len("data:"):])
				if payload == "" {
					continue
				}
				if payload == "[DONE]" {
					continue
				}
				var ch chatChunk
				if err := json.Unmarshal([]byte(payload), &ch); err == nil {
					if len(ch.Choices) > 0 && ch.Choices[0].Delta.Content != "" {
						onChunk(ch.Choices[0].Delta.Content)
					}
				}
			}
		case <-srw.ctx.Done():
			<-proxyDone
			return srw.ctx.Err()
		}
	}
}

// callProxyComplete aggregates full streaming content into a single string.
func callProxyComplete(ctx context.Context, d *apibase.Deps, model string, messages []ChatMessage, provenance string) (string, error) {
	var full strings.Builder
	err := callProxyStreaming(ctx, d, model, messages, provenance, func(delta string) {
		full.WriteString(delta)
	})
	if err != nil {
		return "", err
	}
	return full.String(), nil
}

// stripMarkdownFence strips ```json ... ``` or ``` ... ``` wrappers.
func stripMarkdownFence(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		idx := strings.Index(s, "\n")
		if idx >= 0 {
			s = s[idx+1:]
		} else {
			s = strings.TrimPrefix(s, "```")
		}
		if strings.HasSuffix(s, "```") {
			lastIdx := strings.LastIndex(s, "```")
			if lastIdx >= 0 {
				s = s[:lastIdx]
			}
		}
	}
	return strings.TrimSpace(s)
}
