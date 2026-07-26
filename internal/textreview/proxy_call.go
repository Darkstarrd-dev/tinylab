package textreview

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

// chatChunk is one OpenAI-format streaming chunk: choices[0].delta.content.
type chatChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
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
	caller := c.pc
	if caller == nil {
		caller = defaultProxyCaller{d: c.d}
	}
	return caller.call(ctx, node, systemPrompt, content, onChunk)
}

// proxyCaller abstracts the proxy invocation so the real ProxyCleaner can be
// tested without a live proxy. Both production and test paths build the
// request body and classify the result here, differing only in how the body
// is produced/consumed.
type proxyCaller interface {
	call(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string)) CleanResult
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
	p, ok := d.Reg.GetProvider(node.ProviderID)
	if !ok {
		return "", false
	}
	if node.ModelID == "" {
		return "", false
	}
	return p.Prefix + "/" + node.ModelID, true
}

// buildRequestBody marshals the OpenAI-format streaming chat request.
func buildRequestBody(model, systemPrompt, content string) ([]byte, error) {
	body := map[string]any{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": content},
		},
		"stream": true,
	}
	return json.Marshal(body)
}

// defaultProxyCaller submits the request to the live proxy ProxyHandler and
// streams the SSE chunks out through a streamingResponseWriter.
type defaultProxyCaller struct {
	d *apibase.Deps
}

func (g defaultProxyCaller) call(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string)) CleanResult {
	if g.d == nil || g.d.ProxyHandler == nil {
		return CleanResult{ErrMsg: "proxy handler unavailable"}
	}
	model, ok := resolveModel(g.d, node)
	if !ok {
		return CleanResult{ErrMsg: "provider not found for node " + node.ID}
	}
	bodyBytes, err := buildRequestBody(model, systemPrompt, content)
	if err != nil {
		return CleanResult{ErrMsg: "marshal request: " + err.Error()}
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	srw := newStreamingResponseWriter(ctx)
	req := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(bodyBytes))
	req = req.WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")

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

	res := g.consumeSSE(srw, onChunk)
	<-proxyDone
	if res.ErrMsg == "" && !res.OK && !res.Exhausted && !res.Passed4xx && srw.statusCode == 0 {
		res.ErrMsg = "stream interrupted"
	}
	return res
}

// consumeSSE reads SSE chunks from srw.chunks as the proxy flushes them. For
// each complete "data: {...}" line it extracts delta.content (if any) and
// invokes onChunk. It returns once the proxy closes the writer (channel
// closed) or ctx is canceled. The final classification uses the complete
// captured body, not the in-flight partial line (which may be an incomplete
// SSE event on a mid-stream cut).
func (g defaultProxyCaller) consumeSSE(srw *streamingResponseWriter, onChunk func(delta string)) CleanResult {
	var sawDone bool
	sb := &strings.Builder{}
	for {
		select {
		case p, ok := <-srw.chunks:
			if !ok {
				return g.classify(srw, sawDone)
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
				if g.processSSELine(line, onChunk, &sawDone) {
					return g.classify(srw, sawDone)
				}
			}
		case <-srw.ctx.Done():
			return g.classify(srw, sawDone)
		}
	}
}

// processSSELine handles one SSE line. Returns true if the stream is terminal
// (saw [DONE]).
func (g defaultProxyCaller) processSSELine(line string, onChunk func(delta string), sawDone *bool) bool {
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
	if len(ch.Choices) > 0 && ch.Choices[0].Delta.Content != "" && onChunk != nil {
		onChunk(ch.Choices[0].Delta.Content)
	}
	return false
}

// classify maps the recorded proxy status + captured body into a CleanResult.
func (g defaultProxyCaller) classify(srw *streamingResponseWriter, sawDone bool) CleanResult {
	body := srw.body.String()
	switch code := srw.statusCode; {
	case code == 0:
		// Proxy never wrote a header (e.g. ctx canceled before any output).
		return CleanResult{OK: false, ErrMsg: "stream interrupted"}
	case code == 200:
		if sawDone {
			return CleanResult{OK: true}
		}
		// 200 but no [DONE] and the stream ended — mid-stream disconnect.
		return CleanResult{OK: false, ErrMsg: "stream interrupted"}
	case code == 502:
		if strings.Contains(body, "all keys exhausted") || strings.Contains(body, "no available keys") {
			return CleanResult{Exhausted: true, ErrMsg: body}
		}
		return CleanResult{ErrMsg: body}
	case code >= 400 && code < 500:
		return CleanResult{Passed4xx: true, ErrMsg: body}
	default:
		return CleanResult{ErrMsg: body}
	}
}
