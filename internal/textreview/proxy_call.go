package textreview

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"strings"
	"time"

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

// CleanBatch implements BatchCleaner. It resolves the node's provider prefix,
// builds one combined streaming request for all chapters in the batch, and
// routes the streamed result back per chapter key through onChunk. The whole
// batch shares one LLM call; the result is classified once from the recorded
// status code + body (same rules as a single Clean).
func (c *ProxyCleaner) CleanBatch(ctx context.Context, node config.TextReviewNode, systemPrompt string, batch []BatchChapter, onChunk func(chapterKey string, delta string)) CleanResult {
	caller := c.pc
	if caller == nil {
		caller = defaultProxyCaller{d: c.d}
	}
	return caller.callBatch(ctx, node, systemPrompt, batch, onChunk)
}

// proxyCaller abstracts the proxy invocation so the real ProxyCleaner can be
// tested without a live proxy. Both production and test paths build the
// request body and classify the result here, differing only in how the body
// is produced/consumed.
type proxyCaller interface {
	call(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string)) CleanResult
	// callBatch submits one merged streaming request for a batch of chapters,
	// routing streamed output per chapter key. See ProxyCleaner.CleanBatch.
	callBatch(ctx context.Context, node config.TextReviewNode, systemPrompt string, batch []BatchChapter, onChunk func(chapterKey string, delta string)) CleanResult
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

// batchInstruction is the user-message preamble that tells the model how the
// multi-chapter batch is laid out and how to format its cleaned output.
const batchInstruction = "以下是多个章节，每个章节以 ===CHAPTER_ID:章节序号=== 开头，章节之间以分隔符 " + ChapterSep + " 分隔。请逐章执行清理，并按完全相同的格式输出：每章清理后的正文以 ===CHAPTER_ID:章节序号=== 开头，章节之间用相同的分隔符 " + ChapterSep + " 分隔。仅输出清理后的正文，不要输出任何其它内容或解释。"

// buildBatchContent assembles the user message for a batch clean request:
// the format instruction, then each chapter prefixed by ChapterSep and an
// ===CHAPTER_ID:Key=== header. The model is expected to echo the same structure
// in its reply, which consumeSSEBatch splits back per chapter.
func buildBatchContent(batch []BatchChapter) string {
	var sb strings.Builder
	sb.WriteString(batchInstruction)
	for _, bc := range batch {
		sb.WriteString(ChapterSep)
		sb.WriteString("\n===CHAPTER_ID:")
		sb.WriteString(bc.Key)
		sb.WriteString("===\n")
		sb.WriteString(bc.Content)
	}
	return sb.String()
}

// buildBatchRequestBody marshals the OpenAI-format streaming chat request for
// a batch of chapters merged into one user message.
func buildBatchRequestBody(model, systemPrompt string, batch []BatchChapter) ([]byte, error) {
	body := map[string]any{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": buildBatchContent(batch)},
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

	// Bound each upstream request: a stalled LLM stream must not hang the
	// session forever. 90s covers even slow reasoning models comfortably.
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()

	srw := newStreamingResponseWriter(ctx)
	req := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(bodyBytes))
	req = req.WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-TinyRouter-Provenance", "textreview:clean:node="+node.ID)

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

// callBatch submits one merged streaming request for a batch of chapters and
// routes the streamed output back per chapter key via consumeSSEBatch. The
// single LLM call is classified once (OK/Exhausted/4xx) — the engine applies
// that result to every chapter in the batch.
func (g defaultProxyCaller) callBatch(ctx context.Context, node config.TextReviewNode, systemPrompt string, batch []BatchChapter, onChunk func(chapterKey string, delta string)) CleanResult {
	if g.d == nil || g.d.ProxyHandler == nil {
		return CleanResult{ErrMsg: "proxy handler unavailable"}
	}
	if len(batch) == 0 {
		return CleanResult{ErrMsg: "empty batch"}
	}
	model, ok := resolveModel(g.d, node)
	if !ok {
		return CleanResult{ErrMsg: "provider not found for node " + node.ID}
	}
	bodyBytes, err := buildBatchRequestBody(model, systemPrompt, batch)
	if err != nil {
		return CleanResult{ErrMsg: "marshal request: " + err.Error()}
	}

	// Bound each upstream request: a stalled LLM stream must not hang the
	// session forever (see call).
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()

	srw := newStreamingResponseWriter(ctx)
	req := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(bodyBytes))
	req = req.WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-TinyRouter-Provenance", "textreview:cleanbatch:node="+node.ID+":chapters="+strconv.Itoa(len(batch)))

	proxyDone := make(chan struct{})
	go func() {
		g.d.ProxyHandler.ChatCompletions(srw, req)
		srw.closeChunks()
		close(proxyDone)
	}()

	res := g.consumeSSEBatch(srw, onChunk)
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

// consumeSSEBatch is the batch variant of consumeSSE: it parses the same SSE
// framing but routes each delta.content through a batchSplitter, which splits
// the combined model output by ChapterSep and emits onChunk(chapterKey, delta)
// per chapter as the text streams in.
func (g defaultProxyCaller) consumeSSEBatch(srw *streamingResponseWriter, onChunk func(chapterKey string, delta string)) CleanResult {
	var sawDone bool
	sb := &strings.Builder{}
	sp := &batchSplitter{onChunk: onChunk}
	for {
		select {
		case p, ok := <-srw.chunks:
			if !ok {
				sp.finish()
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
				if g.processSSELineBatch(line, sp, &sawDone) {
					sp.finish()
					return g.classify(srw, sawDone)
				}
			}
		case <-srw.ctx.Done():
			sp.finish()
			return g.classify(srw, sawDone)
		}
	}
}

// processSSELineBatch handles one SSE line for a batch stream, feeding any
// delta.content into the splitter instead of calling onChunk directly.
// Returns true if the stream is terminal (saw [DONE]).
func (g defaultProxyCaller) processSSELineBatch(line string, sp *batchSplitter, sawDone *bool) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, ":") {
		return false
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
	if len(ch.Choices) > 0 && ch.Choices[0].Delta.Content != "" {
		sp.push(ch.Choices[0].Delta.Content)
	}
	return false
}

// batchSplitter incrementally parses the model's combined batch output and
// routes per-chapter content to onChunk. The expected layout is:
//
//	===CHAPTER_ID:K===\n<cleaned text for K>
//	ChapterSep
//	===CHAPTER_ID:J===\n<cleaned text for J>
//	...
//
// Text before the first header is treated as preamble and dropped. The
// splitter routes each chapter's content as it streams, holding back any
// trailing suffix that could be the start of a separator (or header) so a
// partial delimiter is never emitted as chapter text.
type batchSplitter struct {
	pending    string // buffered text not yet routed
	curKey     string // chapter currently streaming, "" while expecting a header
	nlConsumed bool   // whether the single newline after the current header has been consumed
	onChunk    func(chapterKey string, delta string)
}

// push feeds one delta into the splitter, routing any now-complete chapter
func (s *batchSplitter) push(text string) {
	s.pending += text
	for {
		if s.curKey == "" {
			hi := strings.Index(s.pending, chapterIDHeader)
			if hi < 0 {
				// No header yet: drop the safe preamble, keep any suffix that
				// could be the start of a header.
				_, hold := holdPrefix(s.pending, chapterIDHeader)
				s.pending = hold
				return
			}
			rest := s.pending[hi+len(chapterIDHeader):]
			ej := strings.Index(rest, "===")
			if ej < 0 {
				// Header incomplete: keep from the header start, drop preamble.
				s.pending = s.pending[hi:]
				return
			}
			s.curKey = strings.TrimSpace(rest[:ej])
			s.pending = rest[ej+3:]
			s.nlConsumed = false
			// fall through: route the new chapter's content start
			continue
		}
		// Consume exactly one leading newline after the header. It may arrive
		// in a later push, so wait until pending is non-empty to decide: if the
		// first byte is a newline, drop it; otherwise the model omitted it.
		if !s.nlConsumed {
			if s.pending == "" {
				return
			}
			if strings.HasPrefix(s.pending, "\n") {
				s.pending = s.pending[1:]
			}
			s.nlConsumed = true
			continue
		}
		sj := strings.Index(s.pending, ChapterSep)
		if sj < 0 {
			safe, hold := holdPrefix(s.pending, ChapterSep)
			if safe != "" {
				s.onChunk(s.curKey, safe)
			}
			s.pending = hold
			return
		}
		if sj > 0 {
			s.onChunk(s.curKey, s.pending[:sj])
		}
		s.pending = s.pending[sj+len(ChapterSep):]
		s.curKey = ""
		// loop: look for the next header in the remainder
	}
}

// finish routes any buffered content of the final chapter (the one without a
// trailing separator) when the stream ends.
func (s *batchSplitter) finish() {
	if s.curKey != "" && s.pending != "" {
		safe, _ := holdPrefix(s.pending, ChapterSep)
		if safe != "" {
			s.onChunk(s.curKey, safe)
		}
	}
	s.pending = ""
}

// holdPrefix splits s into (safe, hold) where hold is the longest non-empty
// suffix of s that is also a proper prefix of sep. The held suffix might be
// the beginning of an incoming delimiter, so it is not routed yet; it is
// revisited once more text arrives. If no suffix is a delimiter prefix, hold
// is empty and safe is the whole string.
func holdPrefix(s, sep string) (safe, hold string) {
	maxN := len(sep) - 1
	if maxN > len(s) {
		maxN = len(s)
	}
	for n := maxN; n > 0; n-- {
		if strings.HasPrefix(sep, s[len(s)-n:]) {
			return s[:len(s)-n], s[len(s)-n:]
		}
	}
	return s, ""
}

// classify maps the recorded proxy status + captured body into a CleanResult.
// body/statusCode are read under srw.mu: classify may run while the proxy
// goroutine is still writing (ctx-cancel path), so the reads must be atomic
// with respect to Write/WriteHeader.
func (g defaultProxyCaller) classify(srw *streamingResponseWriter, sawDone bool) CleanResult {
	srw.mu.Lock()
	body := srw.body.String()
	status := srw.statusCode
	srw.mu.Unlock()
	switch {
	case status == 0:
		// Proxy never wrote a header (e.g. ctx canceled before any output).
		return CleanResult{OK: false, ErrMsg: "stream interrupted"}
	case status == 200:
		if sawDone {
			return CleanResult{OK: true}
		}
		// 200 but no [DONE] and the stream ended — mid-stream disconnect.
		return CleanResult{OK: false, ErrMsg: "stream interrupted"}
	case status == 502:
		if strings.Contains(body, "all keys exhausted") || strings.Contains(body, "no available keys") {
			return CleanResult{Exhausted: true, ErrMsg: body}
		}
		return CleanResult{ErrMsg: body}
	case status >= 400 && status < 500:
		return CleanResult{Passed4xx: true, ErrMsg: body}
	default:
		return CleanResult{ErrMsg: body}
	}
}
