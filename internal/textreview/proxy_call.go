package textreview

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/config"
)

// chatChunk is one OpenAI-format streaming chunk: choices[0].delta.content,
// optional choices[0].delta.reasoning_content, and optional choices[0].finish_reason.
type chatChunk struct {
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content,omitempty"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason,omitempty"`
	} `json:"choices"`
}

// ProxyCleaner is the real Cleaner: it builds an OpenAI-compatible streaming
// chat request, submits it to the shared proxy handler, and parses the SSE
// chunks live as they flush through a streamingResponseWriter.
type ProxyCleaner struct {
	d  *apibase.Deps
	pc proxyCaller // seam for testing; nil uses the default proxy stack.
}

// NewProxyCleaner builds a ProxyCleaner backed by the given deps' ProxyHandler
// and Registry (for provider prefix resolution).
func NewProxyCleaner(d *apibase.Deps) *ProxyCleaner {
	return &ProxyCleaner{d: d}
}

// Clean implements Cleaner. It resolves the node's provider prefix, builds a
// streaming chat-completions request, drives the proxy through an in-process
// streamingResponseWriter, and parses SSE chunks into onChunk callbacks. The
// returned CleanResult is classified from the recorded status code + body.
func (c *ProxyCleaner) Clean(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string)) CleanResult {
	return c.CleanWithRaw(ctx, node, systemPrompt, content, onChunk, nil)
}

// CleanWithRaw implements RawCleaner.
func (c *ProxyCleaner) CleanWithRaw(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string), onRaw func(section, delta string)) CleanResult {
	caller := c.pc
	if caller == nil {
		caller = defaultProxyCaller{d: c.d}
	}
	return caller.call(ctx, node, systemPrompt, content, onChunk, onRaw)
}

// proxyCaller abstracts the proxy invocation so the real ProxyCleaner can be
// tested without a live proxy. Both production and test paths build the
// request body and classify the result here, differing only in how the body
// is produced/consumed.
type proxyCaller interface {
	call(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string), onRaw func(section, delta string)) CleanResult
}

// resolveModel builds the "provider/model" string the proxy's model resolver
// expects: the proxy splits on '/' and matches the FIRST segment against
// Provider.Prefix (forward_request.go:70-77), and /api/models emits IDs as
// p.Prefix + "/" + modelID (models/register.go:58). TextReviewNode stores the
// provider's internal ID, so we resolve it to its prefix here.
func resolveModel(d *apibase.Deps, node config.TextReviewNode) (string, bool) {
	if d == nil || d.Reg == nil {
		return "", false
	}
	if node.ModelID == "" {
		return "", false
	}
	// Check if this is a combo
	if node.ProviderID == "combo" || node.ProviderID == "" {
		if _, ok := d.Reg.GetComboByName(node.ModelID); ok {
			return node.ModelID, true
		}
		if _, ok := d.Reg.GetComboByID(node.ModelID); ok {
			return node.ModelID, true
		}
	}
	p, ok := d.Reg.GetProvider(node.ProviderID)
	if !ok {
		// Fallback: check if ModelID matches a combo name
		if _, ok := d.Reg.GetComboByName(node.ModelID); ok {
			return node.ModelID, true
		}
		if _, ok := d.Reg.GetComboByID(node.ModelID); ok {
			return node.ModelID, true
		}
		return "", false
	}
	return p.Prefix + "/" + node.ModelID, true
}

// buildRequestBody marshals the OpenAI-format streaming chat request.
// reasoning toggles the model's thinking capability explicitly on the wire:
// true → reasoning_effort "medium"; false → reasoning_effort "none". Omitting
// the field on false leaves llama.cpp-class servers on their template default
// (thinking ON for Qwen3-style templates), which is the reported toggle bug.
// enable_thinking / chat_template_kwargs are ignored by llama.cpp (verified
// 2026-08-26 against llama.cpp serve on 127.0.0.1:8080).
func buildRequestBody(model, systemPrompt, content string, reasoning bool) ([]byte, error) {
	body := map[string]any{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": content},
		},
		"stream": true,
	}
	if reasoning {
		body["reasoning_effort"] = "medium"
	} else {
		// llama.cpp 等 OpenAI-compat 服务在模型模板中默认开启思考：仅省略字段
		// 会继续思考（enable_thinking/chat_template_kwargs 实测无效）。显式发送
		// "none" 是唯一能强制关闭的 wire 值（对应 OMP reasoningDisableMode=none-effort）。
		body["reasoning_effort"] = "none"
	}
	return json.Marshal(body)
}

// defaultProxyCaller submits the request to the live proxy ProxyHandler and
// streams the SSE chunks out through a streamingResponseWriter.
type defaultProxyCaller struct {
	d *apibase.Deps
}

func (g defaultProxyCaller) call(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string), onRaw func(section, delta string)) CleanResult {
	if g.d == nil || g.d.ProxyHandler == nil {
		return CleanResult{ErrMsg: "proxy handler unavailable"}
	}
	model, ok := resolveModel(g.d, node)
	if !ok {
		return CleanResult{ErrMsg: "provider not found for node " + node.ID}
	}
	bodyBytes, err := buildRequestBody(model, systemPrompt, content, node.Reasoning)
	if err != nil {
		return CleanResult{ErrMsg: "marshal request: " + err.Error()}
	}
	// Bound each upstream request: 300s comfortably covers long reasoning models
	// (thinking phase can take 60s~120s+ before streaming content).
	ctx, cancel := context.WithTimeout(ctx, 300*time.Second)
	defer cancel()

	srw := newStreamingResponseWriter(ctx)
	req := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(bodyBytes))
	req = req.WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-TinyLab-Provenance", "textreview:clean:node="+node.ID)

	// Run the proxy call in its own goroutine: ChatCompletions blocks until
	// the upstream stream finishes (or ctx cancels), and we consume chunks
	// concurrently from srw. When the proxy returns we closeChunks to signal
	// end-of-stream to the consumer.
	proxyDone := make(chan struct{})
	go func() {
		g.d.ProxyHandler.ChatCompletions(srw, req)
		srw.closeChunks()
		close(proxyDone)
	}()

	res := g.consumeSSE(srw, onChunk, onRaw)
	<-proxyDone
	if res.ErrMsg == "" && !res.OK && !res.Exhausted && !res.Passed4xx && srw.statusCode == 0 {
		if ctx.Err() == context.DeadlineExceeded {
			res.ErrMsg = "stream timeout (exceeded 300s)"
		} else {
			res.ErrMsg = "stream interrupted"
		}
	}
	res.DebugRequest = string(bodyBytes)
	return res
}

// consumeSSE reads SSE chunks from srw.chunks as the proxy flushes them. For
// each complete "data: {...}" line it extracts delta.content (if any) and
// invokes onChunk. It returns once the proxy closes the writer (channel
// closed) or ctx is canceled. The final classification uses the complete
// captured body, not the in-flight partial line (which may be an incomplete
// SSE event on a mid-stream cut).
func (g defaultProxyCaller) consumeSSE(srw *streamingResponseWriter, onChunk func(delta string), onRaw func(section, delta string)) CleanResult {
	var sawDone bool
	var lastFinishReason string
	sb := &strings.Builder{}
	for {
		select {
		case p, ok := <-srw.chunks:
			if !ok {
				return g.classify(srw, sawDone, lastFinishReason)
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
				if g.processSSELine(line, onChunk, onRaw, &sawDone, &lastFinishReason) {
					return g.classify(srw, sawDone, lastFinishReason)
				}
			}
		case <-srw.ctx.Done():
			return g.classify(srw, sawDone, lastFinishReason)
		}
	}
}

// processSSELine handles one SSE line. Returns true if the stream is terminal
// (saw [DONE]).
func (g defaultProxyCaller) processSSELine(line string, onChunk func(delta string), onRaw func(section, delta string), sawDone *bool, finishReason *string) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return false
	}
	if strings.HasPrefix(trimmed, ":") {
		return false // SSE comment / keep-alive
	}
	if !strings.HasPrefix(trimmed, "data:") {
		return false
	}
	payload := strings.TrimSpace(trimmed[len("data:"):])
	if payload == "" {
		return false
	}
	if payload == "[DONE]" {
		*sawDone = true
		return true
	}
	var ch chatChunk
	if err := json.Unmarshal([]byte(payload), &ch); err != nil {
		return false
	}
	if len(ch.Choices) > 0 {
		choice := ch.Choices[0]
		if choice.FinishReason != nil && *choice.FinishReason != "" && finishReason != nil {
			*finishReason = *choice.FinishReason
		}
		delta := choice.Delta
		if onRaw != nil {
			if delta.ReasoningContent != "" {
				onRaw("thinking", delta.ReasoningContent)
			}
			if delta.Content != "" {
				onRaw("content", delta.Content)
			}
		}
		if delta.Content != "" && onChunk != nil {
			onChunk(delta.Content)
		}
	}
	return false
}

// classify maps the recorded proxy status + captured body into a CleanResult.
// body/statusCode are read under srw.mu: classify may run while the proxy
// goroutine is still writing (ctx-cancel path), so the reads must be atomic
// with respect to Write/WriteHeader.
func (g defaultProxyCaller) classify(srw *streamingResponseWriter, sawDone bool, finishReason string) CleanResult {
	srw.mu.Lock()
	body := srw.body.String()
	status := srw.statusCode
	srw.mu.Unlock()
	// 截断过长的原始响应（防止 debug 面板超大内存占用，上限 128KB）
	rawBody := body
	if len(rawBody) > 131072 {
		rawBody = rawBody[:131072] + "\n...[truncated at 128KB]"
	}
	base := CleanResult{DebugRawBody: rawBody, DebugStatusCode: status}
	switch {
	case status == 0:
		if srw.ctx.Err() == context.DeadlineExceeded {
			base.ErrMsg = "stream timeout (exceeded 300s)"
		} else {
			base.ErrMsg = "stream interrupted"
		}
		return base
	case status == 200:
		if sawDone {
			base.OK = true
			return base
		}
		if finishReason == "length" {
			base.ErrMsg = "output truncated (finish_reason: length) - token limit reached"
			return base
		}
		if srw.ctx.Err() == context.DeadlineExceeded {
			base.ErrMsg = "stream timeout (exceeded 300s)"
			return base
		}
		base.ErrMsg = "stream interrupted"
		return base
	case status == 502:
		if strings.Contains(body, "all keys exhausted") || strings.Contains(body, "no available keys") {
			base.Exhausted = true
			base.ErrMsg = body
			return base
		}
		base.ErrMsg = body
		return base
	case status >= 400 && status < 500:
		base.Passed4xx = true
		base.ErrMsg = body
		return base
	default:
		base.ErrMsg = body
		return base
	}
}
