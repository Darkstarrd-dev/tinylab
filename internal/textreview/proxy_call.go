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

// CleanBatch implements BatchCleaner. It resolves the node's provider prefix,
// builds one combined streaming request for all chapters in the batch, and
// routes the streamed result back per chapter key through onChunk. The whole
// batch shares one LLM call; the result is classified once from the recorded
// status code + body (same rules as a single Clean).
// CleanBatch implements BatchCleaner. It resolves the node's provider prefix,
// builds one combined streaming request for all chapters in the batch, and
// routes the streamed result back per chapter key through onChunk. The whole
// batch shares one LLM call; the result is classified once from the recorded
// status code + body (same rules as a single Clean).
func (c *ProxyCleaner) CleanBatch(ctx context.Context, node config.TextReviewNode, systemPrompt string, batch []BatchChapter, onChunk func(chapterKey string, delta string)) CleanResult {
	return c.CleanBatchWithRaw(ctx, node, systemPrompt, batch, onChunk, nil)
}

// CleanBatchWithRaw implements RawBatchCleaner.
func (c *ProxyCleaner) CleanBatchWithRaw(ctx context.Context, node config.TextReviewNode, systemPrompt string, batch []BatchChapter, onChunk func(chapterKey string, delta string), onRaw func(section, rawChunk string)) CleanResult {
	return c.CleanBatchProgressive(ctx, node, systemPrompt, batch, onChunk, onRaw, nil)
}

// CleanBatchProgressive implements ProgressiveBatchCleaner.
func (c *ProxyCleaner) CleanBatchProgressive(ctx context.Context, node config.TextReviewNode, systemPrompt string, batch []BatchChapter, onChunk func(chapterKey string, delta string), onRaw func(section, rawChunk string), onChapterDone func(chapterKey string)) CleanResult {
	caller := c.pc
	if caller == nil {
		caller = defaultProxyCaller{d: c.d}
	}
	return caller.callBatch(ctx, node, systemPrompt, batch, onChunk, onRaw, onChapterDone)
}

// proxyCaller abstracts the proxy invocation so the real ProxyCleaner can be
// tested without a live proxy. Both production and test paths build the
// request body and classify the result here, differing only in how the body
// is produced/consumed.
type proxyCaller interface {
	call(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string), onRaw func(section, delta string)) CleanResult
	// callBatch submits one merged streaming request for a batch of chapters,
	// routing streamed output per chapter key. See ProxyCleaner.CleanBatch.
	callBatch(ctx context.Context, node config.TextReviewNode, systemPrompt string, batch []BatchChapter, onChunk func(chapterKey string, delta string), onRaw func(section, rawChunk string), onChapterDone func(chapterKey string)) CleanResult
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

func (g defaultProxyCaller) call(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string), onRaw func(section, delta string)) CleanResult {
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

	// Bound each upstream request: 300s comfortably covers long reasoning models
	// (thinking phase can take 60s~120s+ before streaming content).
	ctx, cancel := context.WithTimeout(ctx, 300*time.Second)
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

// callBatch submits one merged streaming request for a batch of chapters and
// routes the streamed output back per chapter key via consumeSSEBatch. The
// single LLM call is classified once (OK/Exhausted/4xx) — the engine applies
// that result to every chapter in the batch.
func (g defaultProxyCaller) callBatch(ctx context.Context, node config.TextReviewNode, systemPrompt string, batch []BatchChapter, onChunk func(chapterKey string, delta string), onRaw func(section, rawChunk string), onChapterDone func(chapterKey string)) CleanResult {
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

	// Bound each upstream request: 300s for batch processing with reasoning.
	ctx, cancel := context.WithTimeout(ctx, 300*time.Second)
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

	res := g.consumeSSEBatch(srw, onChunk, onRaw, onChapterDone)
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

// consumeSSEBatch is the batch variant of consumeSSE: it parses the same SSE
// framing but routes each delta.content through a batchSplitter, which splits
// the combined model output by ChapterSep and emits onChunk(chapterKey, delta)
// per chapter as the text streams in.
func (g defaultProxyCaller) consumeSSEBatch(srw *streamingResponseWriter, onChunk func(chapterKey string, delta string), onRaw func(section, rawChunk string), onChapterDone func(chapterKey string)) CleanResult {
	var sawDone bool
	var lastFinishReason string
	sb := &strings.Builder{}
	sp := &batchSplitter{onChunk: onChunk, onChapterDone: onChapterDone}
	for {
		select {
		case p, ok := <-srw.chunks:
			if !ok {
				sp.finish()
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
				if g.processSSELineBatch(line, sp, onRaw, &sawDone, &lastFinishReason) {
					sp.finish()
					return g.classify(srw, sawDone, lastFinishReason)
				}
			}
		case <-srw.ctx.Done():
			sp.finish()
			return g.classify(srw, sawDone, lastFinishReason)
		}
	}
}

// processSSELineBatch handles one SSE line for a batch stream, feeding any
// delta.content into the splitter instead of calling onChunk directly.
// Returns true if the stream is terminal (saw [DONE]).
func (g defaultProxyCaller) processSSELineBatch(line string, sp *batchSplitter, onRaw func(section, rawChunk string), sawDone *bool, finishReason *string) bool {
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
		if delta.Content != "" {
			sp.push(delta.Content)
		}
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
	pending       string // buffered text not yet routed
	curKey        string // chapter currently streaming, "" while expecting a header
	nlConsumed    bool   // whether the single newline after the current header has been consumed
	onChunk       func(chapterKey string, delta string)
	onChapterDone func(chapterKey string)
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
		if s.onChapterDone != nil && s.curKey != "" {
			s.onChapterDone(s.curKey)
		}
		s.pending = s.pending[sj+len(ChapterSep):]
		s.curKey = ""
		// loop: look for the next header in the remainder
	}
}

// finish routes any buffered content of the final chapter (the one without a
// trailing separator) when the stream ends. All pending text is flushed since
// no more data will arrive.
func (s *batchSplitter) finish() {
	if s.curKey != "" && s.pending != "" {
		s.onChunk(s.curKey, s.pending)
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
