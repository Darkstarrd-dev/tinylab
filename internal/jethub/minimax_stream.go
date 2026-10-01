package jethub

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// MiniMax Code 响应侧转换：Anthropic Messages SSE → OpenAI chat chunk。
//
// ⚠️ 上游**只有流式分支**（ref 恒发 `stream:true`；非流式分支在参考实现里
// 从未被实现或实测）。故本项目对上游一律发 stream:true，再按**进站协议**
// 决定对客户端呈现什么：
//
//	进站 /v1/messages + stream:true   → 原生透传（不动字节）
//	进站 /v1/messages + 非流式         → 聚合成 Anthropic message 对象
//	进站 /v1/chat/completions + 流式   → 逐帧转 OpenAI chat.completion.chunk
//	进站 /v1/chat/completions + 非流式 → 聚合成 OpenAI chat.completion 对象
//
// 事件/字段依据 ref minimax-messages.ts（2026-09-29 真机实测）。

// minimaxStopReasonToFinish maps the Anthropic stop_reason to the OpenAI
// finish_reason. ⚠️ 未知/缺失一律 "stop" —— 编成 error 会让客户端重试一个
// 其实成功的响应（ref 同款判据）。
func minimaxStopReasonToFinish(stop string) string {
	switch stop {
	case "tool_use":
		return "tool_calls"
	case "max_tokens":
		return "length"
	case "refusal":
		return "stop"
	default:
		return "stop"
	}
}

// minimaxOpenAIUsage is the OpenAI usage object (include_usage shape).
type minimaxOpenAIUsage struct {
	PromptTokens            int                        `json:"prompt_tokens"`
	CompletionTokens        int                        `json:"completion_tokens"`
	TotalTokens             int                        `json:"total_tokens"`
	CompletionTokensDetails *minimaxReasoningTokenInfo `json:"completion_tokens_details,omitempty"`
}

type minimaxReasoningTokenInfo struct {
	ReasoningTokens int `json:"reasoning_tokens"`
}

// minimaxOpenAIChunk is one streamed OpenAI chat.completion.chunk.
type minimaxOpenAIChunk struct {
	ID      string                `json:"id"`
	Object  string                `json:"object"`
	Created int64                 `json:"created"`
	Model   string                `json:"model"`
	Choices []minimaxOpenAIChoice `json:"choices"`
	Usage   *minimaxOpenAIUsage   `json:"usage,omitempty"`
}

type minimaxOpenAIChoice struct {
	Index        int            `json:"index"`
	Delta        map[string]any `json:"delta"`
	FinishReason any            `json:"finish_reason"`
}

// minimaxBlock accumulates one Anthropic content block.
type minimaxBlock struct {
	kind string // "text" / "thinking" / "tool_use"
	id   string
	name string
	text strings.Builder
	args strings.Builder
}

// minimaxStreamConverter turns Anthropic SSE frames into OpenAI chunks (or
// aggregates them into a chat.completion / Anthropic message object).
type minimaxStreamConverter struct {
	model   string
	id      string
	created int64
	roleOut bool

	inputTokens     int
	cacheReadTokens int
	cacheWriteToks  int
	outputTokens    int
	reasoningTokens int

	stopReason string
	blocks     map[int]*minimaxBlock
	order      []int
	toolIndex  map[int]int
	toolCount  int

	sawAnyBlock bool
	streamError string
}

func newMinimaxStreamConverter(model string) *minimaxStreamConverter {
	return &minimaxStreamConverter{
		model:     model,
		created:   nowMillis() / 1000,
		blocks:    map[int]*minimaxBlock{},
		toolIndex: map[int]int{},
	}
}

// promptTokens folds the cache counters into the OpenAI prompt total (the
// Anthropic input side reports them separately; OpenAI has no cache columns).
func (c *minimaxStreamConverter) promptTokens() int {
	return c.inputTokens + c.cacheReadTokens + c.cacheWriteToks
}

func (c *minimaxStreamConverter) usage() *minimaxOpenAIUsage {
	u := &minimaxOpenAIUsage{
		PromptTokens:     c.promptTokens(),
		CompletionTokens: c.outputTokens,
	}
	u.TotalTokens = u.PromptTokens + u.CompletionTokens
	if c.reasoningTokens > 0 {
		u.CompletionTokensDetails = &minimaxReasoningTokenInfo{ReasoningTokens: c.reasoningTokens}
	}
	return u
}

// feedLine consumes one raw SSE line and returns the OpenAI chunks to emit.
// openai=false → the Anthropic shape was requested (aggregation only; the
// streaming Anthropic path is passed through untouched).
func (c *minimaxStreamConverter) feedLine(line string, openai bool) []string {
	trimmed := strings.TrimSuffix(line, "\r")
	if trimmed == "" || strings.HasPrefix(trimmed, "event:") || strings.HasPrefix(trimmed, ":") {
		return nil
	}
	// SSE 允许多行 data:，本项目只处理单行（上游实测为单行）。
	if !strings.HasPrefix(strings.TrimSpace(trimmed), "data:") {
		return nil
	}
	payload := strings.TrimSpace(strings.TrimSpace(trimmed)[5:])
	if payload == "" || payload == "[DONE]" {
		return nil
	}
	var frame map[string]any
	if err := json.Unmarshal([]byte(payload), &frame); err != nil {
		return nil // 静默跳过畸形帧（ref 同款；一轮里偶发坏帧不该中断流）
	}
	if frame == nil {
		return nil
	}
	ftype, _ := frame["type"].(string)
	switch ftype {
	case "message_start":
		msg, _ := frame["message"].(map[string]any)
		if msg != nil {
			if id, ok := msg["id"].(string); ok && id != "" {
				c.id = id
			}
			if m, ok := msg["model"].(string); ok && m != "" {
				c.model = m
			}
			if usage, ok := msg["usage"].(map[string]any); ok {
				c.absorbUsage(usage)
			}
		}
		if !openai || c.roleOut {
			return nil
		}
		c.roleOut = true
		return []string{c.chunkJSON(map[string]any{"role": "assistant"}, nil)}
	case "content_block_start":
		block, _ := frame["content_block"].(map[string]any)
		if block == nil {
			return nil
		}
		idx := minimaxFrameIndex(frame)
		kind, _ := block["type"].(string)
		state := &minimaxBlock{kind: kind}
		switch kind {
		case "text", "thinking":
			// 文本/思考块没有 id/name。
		case "tool_use":
			state.id, _ = block["id"].(string)
			state.name, _ = block["name"].(string)
			c.toolIndex[idx] = c.toolCount
			c.toolCount++
		default:
			return nil // 未知块类型：忽略（ref 同款）
		}
		c.blocks[idx] = state
		c.order = append(c.order, idx)
		c.sawAnyBlock = true
		if !openai || kind != "tool_use" {
			return nil
		}
		// OpenAI 的工具调用首帧带 id + name，后续帧只带参数片段。
		return []string{c.chunkJSON(map[string]any{
			"tool_calls": []any{map[string]any{
				"index": c.toolIndex[idx], "id": state.id, "type": "function",
				"function": map[string]any{"name": state.name, "arguments": ""},
			}},
		}, nil)}
	case "content_block_delta":
		delta, _ := frame["delta"].(map[string]any)
		if delta == nil {
			return nil
		}
		idx := minimaxFrameIndex(frame)
		state := c.blocks[idx]
		dtype, _ := delta["type"].(string)
		switch dtype {
		case "text_delta":
			text, _ := delta["text"].(string)
			if state != nil {
				state.text.WriteString(text)
			}
			if !openai || text == "" {
				return nil
			}
			return []string{c.chunkJSON(map[string]any{"content": text}, nil)}
		case "thinking_delta":
			thinking, _ := delta["thinking"].(string)
			if state != nil {
				state.text.WriteString(thinking)
			}
			if !openai || thinking == "" {
				return nil
			}
			// reasoning_content 是事实上的 OpenAI 扩展字段（DeepSeek/Cline
			// 等都认），DSH 侧对应 reasoning 块。
			return []string{c.chunkJSON(map[string]any{"reasoning_content": thinking}, nil)}
		case "input_json_delta":
			partial, _ := delta["partial_json"].(string)
			if state != nil {
				state.args.WriteString(partial)
			}
			if !openai || partial == "" {
				return nil
			}
			ti := c.toolIndex[idx]
			return []string{c.chunkJSON(map[string]any{
				"tool_calls": []any{map[string]any{
					"index":    ti,
					"function": map[string]any{"arguments": partial},
				}},
			}, nil)}
		case "signature_delta":
			// ⚠️ 必须忽略：那是 thinking 块的签名，当正文注入会让回答里
			// 出现一串十六进制（ref 明确忽略）。
			return nil
		}
		return nil
	case "content_block_stop":
		return nil
	case "message_delta":
		if delta, ok := frame["delta"].(map[string]any); ok {
			if stop, ok := delta["stop_reason"].(string); ok && stop != "" {
				c.stopReason = stop
			}
		}
		if usage, ok := frame["usage"].(map[string]any); ok {
			c.absorbUsage(usage)
		}
		return nil
	case "error":
		c.streamError = minimaxErrorText(frame)
		if !openai {
			return nil
		}
		body, _ := json.Marshal(map[string]any{"error": map[string]any{
			"message": "minimax: 流内错误：" + c.streamError,
			"type":    "upstream_error",
		}})
		return []string{"data: " + string(body) + "\n\n"}
	}
	return nil
}

// absorbUsage merges a usage object (message_start carries input+cache,
// message_delta carries output+thinking; ⚠️ thinking_tokens 是 output 的子集，
// 只映射不累加).
func (c *minimaxStreamConverter) absorbUsage(usage map[string]any) {
	if v, ok := minimaxUsageInt(usage["input_tokens"]); ok {
		c.inputTokens = v
	}
	if v, ok := minimaxUsageInt(usage["cache_read_input_tokens"]); ok {
		c.cacheReadTokens = v
	}
	if v, ok := minimaxUsageInt(usage["cache_creation_input_tokens"]); ok {
		c.cacheWriteToks = v
	}
	if v, ok := minimaxUsageInt(usage["output_tokens"]); ok {
		c.outputTokens = v
	}
	if details, ok := usage["output_tokens_details"].(map[string]any); ok {
		if v, ok := minimaxUsageInt(details["thinking_tokens"]); ok {
			c.reasoningTokens = v
		}
	}
}

// minimaxUsageInt accepts the non-negative integers Anthropic reports.
func minimaxUsageInt(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		if t >= 0 {
			return int(t), true
		}
	case string:
		if s := strings.TrimSpace(t); isAllDigits(s) {
			return int(parsePositiveInt(s)), true
		}
	}
	return 0, false
}

// minimaxFrameIndex reads the frame's block index (0 when absent/invalid).
func minimaxFrameIndex(frame map[string]any) int {
	if v, ok := frame["index"]; ok {
		if n, ok := minimaxUsageInt(v); ok {
			return n
		}
	}
	return 0
}

// minimaxErrorText extracts a human-readable message from an error frame.
func minimaxErrorText(frame map[string]any) string {
	if errObj, ok := frame["error"].(map[string]any); ok {
		if msg, ok := errObj["message"].(string); ok && msg != "" {
			return msg
		}
		if t, ok := errObj["type"].(string); ok && t != "" {
			return t
		}
	}
	if msg, ok := frame["message"].(string); ok && msg != "" {
		return msg
	}
	return "未知错误"
}

// chunkJSON serialises one OpenAI chunk frame ("data: {...}\n\n").
func (c *minimaxStreamConverter) chunkJSON(delta map[string]any, finish any) string {
	id := c.id
	if id == "" {
		id = "chatcmpl-minimax"
	}
	chunk := minimaxOpenAIChunk{
		ID: id, Object: "chat.completion.chunk", Created: c.created, Model: c.model,
		Choices: []minimaxOpenAIChoice{{Index: 0, Delta: delta, FinishReason: finish}},
	}
	body, err := json.Marshal(chunk)
	if err != nil {
		return ""
	}
	return "data: " + string(body) + "\n\n"
}

// terminalFrames is the OpenAI terminator sequence: finish_reason chunk, the
// usage-only chunk (TinyLab 的用量统计读它；OpenAI 的 include_usage 惯例是
// choices:[]）, then [DONE].
func (c *minimaxStreamConverter) terminalFrames() []string {
	if c.id == "" {
		c.id = "chatcmpl-minimax"
	}
	finish := c.chunkJSON(map[string]any{}, minimaxStopReasonToFinish(c.stopReason))
	usage := minimaxOpenAIChunk{
		ID: c.id, Object: "chat.completion.chunk", Created: c.created, Model: c.model,
		Choices: []minimaxOpenAIChoice{}, Usage: c.usage(),
	}
	body, err := json.Marshal(usage)
	if err != nil {
		return []string{finish, "data: [DONE]\n\n"}
	}
	return []string{finish, "data: " + string(body) + "\n\n", "data: [DONE]\n\n"}
}

// aggregateMessage builds the non-streaming OpenAI chat.completion body.
func (c *minimaxStreamConverter) aggregateMessage() ([]byte, error) {
	content := ""
	var reasoning strings.Builder
	toolCalls := []any{}
	for _, idx := range c.order {
		block := c.blocks[idx]
		if block == nil {
			continue
		}
		switch block.kind {
		case "text":
			content += block.text.String()
		case "thinking":
			reasoning.WriteString(block.text.String())
		case "tool_use":
			toolCalls = append(toolCalls, map[string]any{
				"id": block.id, "type": "function",
				"function": map[string]any{
					"name":      block.name,
					"arguments": minimaxArgumentsString(block.args.String()),
				},
			})
		}
	}
	message := map[string]any{"role": "assistant"}
	if content != "" {
		message["content"] = content
	} else if len(toolCalls) == 0 {
		message["content"] = ""
	} else {
		message["content"] = nil // 只有工具调用时 OpenAI 的 content 是 null
	}
	if r := reasoning.String(); r != "" {
		message["reasoning_content"] = r
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
	}
	id := c.id
	if id == "" {
		id = "chatcmpl-minimax"
	}
	payload := map[string]any{
		"id": id, "object": "chat.completion", "created": c.created, "model": c.model,
		"choices": []any{map[string]any{
			"index": 0, "message": message,
			"finish_reason": minimaxStopReasonToFinish(c.stopReason),
		}},
		"usage": c.usage(),
	}
	return json.Marshal(payload)
}

// aggregateAnthropicMessage builds the non-streaming Anthropic message body
// (an /v1/messages client that did not ask for streaming).
//
// ⚠️ thinking 块**不输出**：Anthropic 要求 thinking 块带 signature，而我们
// 按参考实现刻意不保存签名（`signature_delta` 被丢弃）—— 回传无签名 thinking
// 会被上游拒绝。需要思考过程的客户端请用流式。
func (c *minimaxStreamConverter) aggregateAnthropicMessage() ([]byte, error) {
	content := []any{}
	for _, idx := range c.order {
		block := c.blocks[idx]
		if block == nil {
			continue
		}
		switch block.kind {
		case "text":
			if text := block.text.String(); text != "" {
				content = append(content, map[string]any{"type": "text", "text": text})
			}
		case "tool_use":
			content = append(content, map[string]any{
				"type": "tool_use", "id": block.id, "name": block.name,
				"input": minimaxToolInput(block.args.String()),
			})
		}
	}
	stop := c.stopReason
	if stop == "" {
		stop = "end_turn"
	}
	id := c.id
	if id == "" {
		id = "msg_minimax"
	}
	payload := map[string]any{
		"id": id, "type": "message", "role": "assistant", "model": c.model,
		"content": content, "stop_reason": stop, "stop_sequence": nil,
		"usage": map[string]any{
			"input_tokens":  c.promptTokens(),
			"output_tokens": c.outputTokens,
		},
	}
	return json.Marshal(payload)
}

// minimaxArgumentsString keeps the raw argument JSON; an empty accumulation
// becomes "{}" (OpenAI clients parse it as an object).
func minimaxArgumentsString(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return "{}"
	}
	return raw
}

// minimaxSSEReader streams the converted OpenAI frames. It flushes the tail
// line and emits the terminal frames at EOF — ⚠️ 截断流里携带 stop_reason /
// usage 的收尾帧就在最后一行，不冲刷就会丢掉它们（ref 修过的真实缺陷）。
type minimaxSSEReader struct {
	src    io.Reader
	conv   *minimaxStreamConverter
	openai bool
	out    bytes.Buffer
	buf    []byte
	chunk  []byte
	srcEnd bool
	done   bool
}

func newMinimaxSSEReader(src io.Reader, openai bool, model string) *minimaxSSEReader {
	return &minimaxSSEReader{
		src: src, conv: newMinimaxStreamConverter(model), openai: openai,
		chunk: make([]byte, 32*1024),
	}
}

func (r *minimaxSSEReader) Read(p []byte) (int, error) {
	for r.out.Len() == 0 {
		if r.done {
			return 0, io.EOF
		}
		if r.srcEnd {
			r.fireTerminal()
			r.done = true
			continue
		}
		n, err := r.src.Read(r.chunk)
		if n > 0 {
			r.buf = append(r.buf, r.chunk[:n]...)
			r.emitCompleteLines()
		}
		if err != nil {
			// 读错误一律按 EOF 处理：尾部残留 + 终止帧仍要发出（ref 纪律）。
			r.srcEnd = true
			if tail := strings.TrimSpace(string(r.buf)); tail != "" {
				r.emit(r.conv.feedLine(string(r.buf), r.openai)...)
			}
			r.buf = nil
			r.fireTerminal()
			r.done = true
		}
	}
	n := copy(p, r.out.Bytes())
	r.out.Next(n)
	return n, nil
}

// emitCompleteLines consumes every complete line, keeping the partial tail.
func (r *minimaxSSEReader) emitCompleteLines() {
	for {
		idx := bytes.IndexByte(r.buf, '\n')
		if idx < 0 {
			return
		}
		line := string(r.buf[:idx])
		r.buf = r.buf[idx+1:]
		r.emit(r.conv.feedLine(line, r.openai)...)
	}
}

func (r *minimaxSSEReader) emit(frames ...string) {
	for _, f := range frames {
		if f != "" {
			r.out.WriteString(f)
		}
	}
}

func (r *minimaxSSEReader) fireTerminal() {
	if r.openai {
		r.emit(r.conv.terminalFrames()...)
		return
	}
	// Anthropic 流式路径不会走到这里（那条路径原生透传）。
	r.emit("data: [DONE]\n\n")
}

// minimaxAggregateSSE consumes the whole Anthropic SSE stream and returns the
// non-streaming body in the requested shape.
func minimaxAggregateSSE(src io.Reader, openai bool, model string) ([]byte, error) {
	conv := newMinimaxStreamConverter(model)
	raw, err := io.ReadAll(io.LimitReader(src, 32<<20))
	if err != nil {
		return nil, fmt.Errorf("jethub: minimax 读取上游响应失败：%w", err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		conv.feedLine(line, false)
	}
	if !conv.sawAnyBlock {
		snippet := strings.TrimSpace(string(raw))
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		if conv.streamError != "" {
			return nil, fmt.Errorf("jethub: minimax 流内错误：%s", conv.streamError)
		}
		return nil, fmt.Errorf("jethub: minimax 上游未返回任何内容块（非流式响应或空响应）：%s", snippet)
	}
	if openai {
		return conv.aggregateMessage()
	}
	return conv.aggregateAnthropicMessage()
}

// minimaxErrorMessage extracts the message/type from an Anthropic error body
// ({"type":"error","error":{"type","message"}} or a bare {"error":...}).
func minimaxErrorMessage(raw []byte) (message, errType string) {
	var payload struct {
		Type  string `json:"type"`
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return strings.TrimSpace(string(raw)), ""
	}
	message = payload.Error.Message
	if message == "" {
		message = payload.Error.Type
	}
	errType = payload.Error.Type
	if errType == "" {
		errType = payload.Type
	}
	if message == "" {
		message = strings.TrimSpace(string(raw))
	}
	return message, errType
}

// minimaxRewriteErrorBody rewrites an upstream error body into the OpenAI
// error shape while PRESERVING the original error type string — the proxy's
// balance-exhaustion detector matches "insufficient_balance" in the body text
// (rotation.IsBalanceExhausted), so dropping it would lose the 402 key lock.
func minimaxRewriteErrorBody(resp *http.Response) (io.Reader, int64, error) {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	message, errType := minimaxErrorMessage(raw)
	if errType == "" || errType == "error" {
		errType = "upstream_error"
	}
	body, err := json.Marshal(map[string]any{"error": map[string]any{
		"message": message, "type": errType, "code": resp.StatusCode,
	}})
	if err != nil {
		return nil, 0, nil // 无法改写 → 原样透传（resp.Body 尚未被消耗语义上无关紧要）
	}
	resp.Header.Set("Content-Type", "application/json; charset=utf-8")
	resp.Header.Del("Content-Length")
	resp.ContentLength = -1
	return bytes.NewReader(body), 0, nil
}

// minimaxPeekFirstDataLine reads src until the first `data:` line, returning
// every consumed byte (to be replayed into the converter) and the line itself.
//
// ⚠️ 不能直接复用 qoderPeekFirstDataLine：它只取**第一行**，而 Anthropic 的
// 错误帧是 `event: error` + `data: {...}` 两行 —— 只看第一行会漏掉错误，
// 于是「HTTP 200 + 流内错误」被当成正常流（Qoder 那条「干净地停止、无任何
// 报错」的同型陷阱）。
func minimaxPeekFirstDataLine(src io.Reader) (peeked []byte, dataLine string, err error) {
	var acc []byte
	buf := make([]byte, 16_384)
	for {
		for {
			idx := bytes.IndexByte(acc, '\n')
			if idx < 0 {
				break
			}
			line := strings.TrimSuffix(string(acc[:idx]), "\r")
			if strings.HasPrefix(strings.TrimSpace(line), "data:") {
				return acc, line, nil
			}
			// 非 data 行（event: / ping / 注释 / 空行）：丢弃该行以免重复扫描。
			acc = acc[idx+1:]
		}
		n, readErr := src.Read(buf)
		if n > 0 {
			acc = append(acc, buf[:n]...)
			// ⚠️ Read 允许同时返回 (n>0, io.EOF)：必须先用新数据重查换行。
			continue
		}
		if readErr != nil {
			return acc, "", readErr
		}
		if len(acc) > 1<<20 {
			return acc, "", nil // 防御：超长无换行，停止 peek
		}
	}
}

// minimaxInterceptResponse implements the response-side hook for minimax
// (error-body rewriting, Anthropic→OpenAI conversion, non-stream aggregation).
func (m *Manager) minimaxInterceptResponse(clientReq *http.Request, resp *http.Response, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	if resp.StatusCode >= 400 {
		return minimaxRewriteErrorBody(resp)
	}
	anthropicEntry := minimaxIsAnthropicEntry(minimaxEntryPathOf(clientReq))
	// 原生 Anthropic 流式：字节级透传（架构文档 §6 的「原生透传」）。
	if anthropicEntry && isStream {
		return nil, 0, nil
	}
	// 错误帧恒在第一帧：在内容到达客户端之前截住，重试才干净。
	peeked, firstLine, _ := minimaxPeekFirstDataLine(resp.Body)
	if msg, ok := minimaxFirstErrorFrame(firstLine); ok {
		_ = resp.Body.Close()
		return nil, 0, fmt.Errorf("minimax: 流内错误：%s", msg)
	}
	src := io.MultiReader(bytes.NewReader(peeked), resp.Body)
	model := upstreamModel
	if model == "" {
		model = "minimax"
	}
	if isStream {
		return newMinimaxSSEReader(src, !anthropicEntry, model), 0, nil
	}
	body, err := minimaxAggregateSSE(src, !anthropicEntry, model)
	if err != nil {
		return nil, 0, err
	}
	resp.Header.Set("Content-Type", "application/json; charset=utf-8")
	resp.Header.Del("Content-Length")
	resp.ContentLength = -1
	return bytes.NewReader(body), 0, nil
}
