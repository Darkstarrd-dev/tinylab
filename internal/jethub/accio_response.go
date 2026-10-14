package jethub

// Accio 响应侧：顶层帧 SSE → OpenAI chunk / Anthropic event 双向输出。
//
// ## 上游帧形状（ref accio-messages.ts normalizeAccioFrame + 2026-10-13 实测）
//
// 响应帧是**顶层** `{content:{role,parts}, partial, usage_metadata,
// finish_reason, turn_complete}` —— **不是** candidates[]；上游**不发** [DONE]。
// parts 三种：`{text}` / `{thought:true,text}`（思考）/ `{function_call:{id,
// name, args_json?}}`（snake，参数是**字符串**）。错误帧
// `{"turn_complete":true,"error_code":"402","error_message":"unauthorized"}`
// 走 HTTP 200 —— `error_code:"200"` 是**成功哨兵**（正常帧也会带），绝不能当
// 错误抛。
//
// ## 工具调用分片合并（ref accioToolCallMergeTransform，四条纪律照搬）
//
// 上游把一次调用拆成多帧：首帧 `{id,name}`（无参数）、后续帧重复完整
// `args_json`（也可能是真增量）。合并规则：
//
//	累积式（后一份以前一份为前缀）⇒ 取最后一；否则依次拼接。
//	空串不算片段（首帧无参数 ≠ 参数为空对象 —— 永不泄漏首帧 {}）。
//
// 四条纪律：① 只缓冲工具 part，同帧非工具 part（正文/思考）**原样先发**；
// ② flush 排在当前行之前（工具调用仍出现在其后帧之前，保流序）；③ 按 id
// 分组（不同 id 绝不误合并）；④ 与错误帧判据同一处 —— 错误帧原样透传不吸收。
//
// ## 终帧元数据与分片同帧（ref pendingMeta 的定罪结论）
//
// 上游会把最后一个 function_call 分片与 turn_complete/usage_metadata/
// finish_reason 放在**同一帧** —— 吸收工具 part 时必须把这些键暂存，flush 时
// 一并处理，否则 usage 恒归零、finish 恒兜底 stop（「思考一下就中断」的根因）。
//
// ## usage 取最大 total（ref noteUsage 的语义）
//
// 上游多帧重复播报 usage 且早期帧偏小 —— 取 total_token_count 最大的那份
// （相等时后者胜）。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// accioQuotaErrorCode is the in-stream quota/auth error code (额度/认证失败
// 走 HTTP 200 + 本码下发).
const accioQuotaErrorCode = "402"

// accioFrameError extracts the in-stream error of one frame.
// ⚠️ 判据三条（ref isAccioErrorFrame）：对象且带非空 error_code/error_message；
// `error_code:"200"` 是成功哨兵必须**先于**错误判据返回 false；其余非 200
// ⇒ 错误。ok=false 表示不是错误帧。
func accioFrameError(frame map[string]any) (code, message string, ok bool) {
	code = accioScalarString(accioFirstNonEmpty(frame["error_code"], frame["errorCode"]))
	message = accioScalarString(accioFirstNonEmpty(frame["error_message"], frame["errorMessage"]))
	if code == "" && message == "" {
		return "", "", false
	}
	if code == "200" {
		// ⚠️ 成功哨兵：实测正常帧会带 error_code:"200"。
		return "", "", false
	}
	return code, message, true
}

// accioFirstNonEmpty returns the first non-nil value.
func accioFirstNonEmpty(vals ...any) any {
	for _, v := range vals {
		if v != nil {
			return v
		}
	}
	return nil
}

// accioFrameParts simplifies one top-level frame into (parts, meta). 顶层
// function_call（无 content 信封）包成 parts —— 绝不丢（ref normalizeAccioFrame
// 的核心修正：无 content ≠ 无用帧，工具调用/usage/finish 都可能单独成帧）。
func accioFrameParts(frame map[string]any) (parts []any, meta map[string]any) {
	meta = map[string]any{}
	if v, ok := frame["turn_complete"]; ok {
		meta["turn_complete"] = v
	}
	if v, ok := frame["finish_reason"].(string); ok && v != "" {
		meta["finish_reason"] = v
	} else if v, ok := frame["finishReason"].(string); ok && v != "" {
		meta["finish_reason"] = v
	}
	if u, ok := frame["usage_metadata"].(map[string]any); ok {
		meta["usage_metadata"] = u
	} else if u, ok := frame["usageMetadata"].(map[string]any); ok {
		meta["usage_metadata"] = u
	}
	if content, ok := frame["content"].(map[string]any); ok {
		if ps, ok := content["parts"].([]any); ok {
			parts = ps
		}
		return parts, meta
	}
	// 顶层 function_call（snake 实测 / camel 容忍）。
	call, ok := firstObj(frame["function_call"], frame["functionCall"])
	if ok {
		parts = append(parts, map[string]any{"function_call": call})
	}
	return parts, meta
}

// firstObj returns the first map-typed value.
func firstObj(vals ...any) (map[string]any, bool) {
	for _, v := range vals {
		if m, ok := v.(map[string]any); ok {
			return m, true
		}
	}
	return nil, false
}

// accioToolPending is one buffered tool call (id-grouped; fragments kept in
// arrival order).
type accioToolPending struct {
	id        string
	name      string
	fragments []string
}

// accioUsageTotal extracts the comparable total of one usage_metadata object
// (snake 实测 / camel 容忍；读不到时回退 prompt+candidates).
func accioUsageTotal(u map[string]any) float64 {
	if u == nil {
		return -1
	}
	if v, ok := accioNumber(accioFirstNonEmpty(u["total_token_count"], u["totalTokenCount"])); ok {
		return v
	}
	prompt, _ := accioNumber(accioFirstNonEmpty(u["prompt_token_count"], u["promptTokenCount"]))
	cand, _ := accioNumber(accioFirstNonEmpty(u["candidates_token_count"], u["candidatesTokenCount"]))
	return prompt + cand
}

// accioStreamConverter turns Accio top-level SSE frames into OpenAI chunks
// (openai=true) or Anthropic SSE events (openai=false), and accumulates the
// same content for non-streaming aggregation.
type accioStreamConverter struct {
	model   string
	id      string
	created int64
	openai  bool

	// tool shard buffer
	pending      map[string]*accioToolPending
	pendingOrder []string
	pendingMeta  map[string]any
	// toolCount is the running tool-call index for OpenAI chunk deltas.
	toolCount int

	usage   map[string]any // usage winner (largest total)
	finish  string
	sawAny  bool
	hadTool bool

	// aggregation (both modes accumulate)
	text      strings.Builder
	reasoning strings.Builder
	tools     []accioAggTool

	// mid-stream error (after content started): emit an error frame and stop.
	streamErr    string
	streamErr402 bool

	// anthropic streaming block state
	antStarted bool
	antIndex   int
	antOpen    string // "" | "text" | "thinking" | "tool"
}

type accioAggTool struct {
	id   string
	name string
	args string
}

func newAccioStreamConverter(model string, openai bool) *accioStreamConverter {
	return &accioStreamConverter{
		model: model, created: nowMillis() / 1000, openai: openai,
		pending: map[string]*accioToolPending{},
		id:      "chatcmpl-accio",
	}
}

// feedLine consumes one raw SSE line and returns the frames to emit.
func (c *accioStreamConverter) feedLine(line string) []string {
	trimmed := strings.TrimSuffix(line, "\r")
	if trimmed == "" || strings.HasPrefix(trimmed, "event:") || strings.HasPrefix(trimmed, ":") {
		return nil
	}
	if !strings.HasPrefix(strings.TrimSpace(trimmed), "data:") {
		return nil
	}
	payload := strings.TrimSpace(strings.TrimSpace(trimmed)[5:])
	if payload == "" || payload == "[DONE]" {
		// 上游不发 [DONE]；见到也忽略（终止帧由本端统一产出）。
		return nil
	}
	var frame map[string]any
	if err := json.Unmarshal([]byte(payload), &frame); err != nil {
		return nil // 静默跳过畸形帧（一轮里偶发坏帧不该中断流）
	}
	if frame == nil {
		return nil
	}
	// ⚠️ 错误判据必须在吸收/归一化**之前**（ref 同序）：错误帧没有 content，
	// 且若与工具 part 同帧被吸收进缓冲，error_code 会被吞 ⇒ 额度失败被反转成
	// 「工具调用成功」。错误帧不 flush、不改写、不吸收。
	if code, message, isErr := accioFrameError(frame); isErr {
		detail := message
		if code != "" {
			detail = fmt.Sprintf("error_code=%s %s", code, message)
		}
		if c.sawAny {
			// 已有内容在流上：只能以流内错误帧收场（内容保留、错误可见），
			// 之后不再产出任何内容帧。
			c.streamErr = detail
			c.streamErr402 = code == accioQuotaErrorCode
			return c.errorFrames(detail)
		}
		// 尚无内容：交给拦截器整体失败（可分类、可重试/换路）。
		c.streamErr = detail
		c.streamErr402 = code == accioQuotaErrorCode
		return nil
	}

	parts, meta := accioFrameParts(frame)
	c.absorbMeta(meta)

	// 分帧处理：非工具 part 立即发（flush 缓冲在前 —— 保流序）；工具 part 收进
	// 缓冲（按 id 分组）。
	var out []string
	callParts := make([]any, 0, len(parts))
	otherParts := make([]any, 0, len(parts))
	for _, part := range parts {
		if pm, ok := part.(map[string]any); ok {
			if _, isCall := firstObj(pm["function_call"], pm["functionCall"]); isCall {
				callParts = append(callParts, pm)
				continue
			}
		}
		otherParts = append(otherParts, part)
	}
	if len(callParts) == 0 {
		out = append(out, c.flushPending()...)
		for _, part := range otherParts {
			out = append(out, c.emitPart(part)...)
		}
		return out
	}
	// ⚠️ 顺序不可颠倒：先发本帧的非工具 part，再把工具 part 收进缓冲 ——
	// 反过来会把同一个调用拆成两个（首帧 flush 出的那个还没有参数）。
	for _, part := range otherParts {
		out = append(out, c.emitPart(part)...)
	}
	c.absorbCallParts(callParts)
	return out
}

// absorbMeta merges one frame's terminal metadata (usage 取最大 total；其余
// 后者覆盖前者 —— 终帧的就是最终值).
func (c *accioStreamConverter) absorbMeta(meta map[string]any) {
	if len(meta) == 0 {
		return
	}
	if c.pending != nil && len(c.pending) > 0 {
		// 工具缓冲在途：元数据暂存到 pendingMeta（与分片同帧到达的场景）。
		if c.pendingMeta == nil {
			c.pendingMeta = map[string]any{}
		}
	}
	if u, ok := meta["usage_metadata"].(map[string]any); ok {
		if c.usage == nil || accioUsageTotal(u) >= accioUsageTotal(c.usage) {
			c.usage = u
		}
	}
	if f, ok := meta["finish_reason"].(string); ok && f != "" {
		c.finish = f
	}
}

// emitPart converts one non-tool part into output frames (and accumulates).
func (c *accioStreamConverter) emitPart(part any) []string {
	pm, ok := part.(map[string]any)
	if !ok {
		return nil
	}
	text, _ := pm["text"].(string)
	if text == "" {
		return nil
	}
	c.sawAny = true
	if thought, _ := pm["thought"].(bool); thought {
		c.reasoning.WriteString(text)
		if c.openai {
			return []string{c.chunkJSON(map[string]any{"reasoning_content": text}, nil)}
		}
		return c.anthropicThinkingDelta(text)
	}
	c.text.WriteString(text)
	if c.openai {
		return []string{c.chunkJSON(map[string]any{"content": text}, nil)}
	}
	return c.anthropicTextDelta(text)
}

// absorbCallParts buffers one frame's tool-call parts (按 id 分组、保持首见顺序;
// 参数三种形态与 normalizeAccioPart 同口径：args_json 字符串实测 / argsJson
// camel / 对象 args).
func (c *accioStreamConverter) absorbCallParts(callParts []any) {
	for _, part := range callParts {
		pm, ok := part.(map[string]any)
		if !ok {
			continue // 畸形 part 只跳过、绝不抛（整条流不能被一个坏帧打断）
		}
		call, ok := firstObj(pm["function_call"], pm["functionCall"])
		if !ok {
			continue
		}
		id, _ := call["id"].(string)
		if id == "" {
			id = fmt.Sprintf("anon-%d", len(c.pendingOrder))
		}
		name, _ := call["name"].(string)
		args := accioArgsTextOf(call)
		entry := c.pending[id]
		if entry == nil {
			fragments := []string(nil)
			if args != "" {
				fragments = []string{args}
			}
			c.pending[id] = &accioToolPending{id: id, name: name, fragments: fragments}
			c.pendingOrder = append(c.pendingOrder, id)
		} else {
			if name != "" {
				entry.name = name
			}
			if args != "" {
				entry.fragments = append(entry.fragments, args)
			}
		}
	}
}

// accioArgsTextOf extracts the args string from one function_call（空串必须
// 回退对象 args —— 同一帧「合并层得 {}、归一化层得真实参数」的两层判据漂移
// 正是「静默空参数」的来源，ref accioArgsTextOf）.
func accioArgsTextOf(call map[string]any) string {
	if s, ok := call["args_json"].(string); ok && s != "" {
		return s
	}
	if s, ok := call["argsJson"].(string); ok && s != "" {
		return s
	}
	if obj, ok := call["args"].(map[string]any); ok {
		if b, err := json.Marshal(obj); err == nil {
			return string(b)
		}
	}
	return ""
}

// mergeAccioToolArgs merges one call's argument fragments (ref
// mergeAccioToolArgs：前缀链 ⇒ 取最后；否则依次拼接；空 ⇒ 空串).
func mergeAccioToolArgs(fragments []string) string {
	nonEmpty := make([]string, 0, len(fragments))
	for _, f := range fragments {
		if f != "" {
			nonEmpty = append(nonEmpty, f)
		}
	}
	if len(nonEmpty) == 0 {
		return ""
	}
	cumulative := true
	for i := 1; i < len(nonEmpty); i++ {
		if !strings.HasPrefix(nonEmpty[i], nonEmpty[i-1]) {
			cumulative = false
			break
		}
	}
	if cumulative {
		return nonEmpty[len(nonEmpty)-1]
	}
	merged := ""
	for _, fragment := range nonEmpty {
		if strings.HasPrefix(fragment, merged) {
			merged = fragment // 已包含在累积值里（同一份全量重复）⇒ 替换
			continue
		}
		merged += fragment
	}
	return merged
}

// flushPending emits the buffered tool calls (one merged call each) and the
// absorbed terminal metadata.
func (c *accioStreamConverter) flushPending() []string {
	var out []string
	if len(c.pending) > 0 {
		for _, id := range c.pendingOrder {
			entry := c.pending[id]
			if entry == nil {
				continue
			}
			args := mergeAccioToolArgs(entry.fragments)
			c.sawAny = true
			c.hadTool = true
			c.tools = append(c.tools, accioAggTool{id: entry.id, name: entry.name, args: args})
			if c.openai {
				if args == "" {
					// ⚠️ 参数为空时 OpenAI 客户端按对象解析 arguments —— "{}"
					// 是「无参数」的合法表达；省略键反而会让部分客户端崩。
					args = "{}"
				}
				out = append(out, c.chunkJSON(map[string]any{
					"tool_calls": []any{map[string]any{
						"index": c.toolCount, "id": entry.id, "type": "function",
						"function": map[string]any{"name": entry.name, "arguments": args},
					}},
				}, nil))
			} else {
				out = append(out, c.anthropicToolBlock(entry.id, entry.name, args)...)
			}
			c.toolCount++
		}
		c.pending = map[string]*accioToolPending{}
		c.pendingOrder = nil
	}
	// ⚠️ 与分片同帧到达的终帧元数据已在 absorbMeta 里落账（usage/finish），
	// 这里无需再补发 —— 转换器的输出形态（OpenAI/Anthropic）由 terminalFrames
	// 统一收尾。
	return out
}

// accioFinishToOpenAI maps the upstream finish_reason onto OpenAI's.
// ⚠️ 未知/缺失一律 "stop" —— 编成 error 会让客户端重试一个其实成功的响应。
func accioFinishToOpenAI(finish string, hadTool bool) string {
	switch strings.ToUpper(finish) {
	case "MAX_TOKENS", "LENGTH":
		return "length"
	case "STOP":
		return "stop"
	default:
		if finish == "" && hadTool {
			return "tool_calls"
		}
		return "stop"
	}
}

// accioFinishToAnthropic maps the upstream finish_reason onto Anthropic's
// stop_reason.
func accioFinishToAnthropic(finish string, hadTool bool) string {
	if strings.EqualFold(finish, "MAX_TOKENS") {
		return "max_tokens"
	}
	if hadTool {
		return "tool_use"
	}
	return "end_turn"
}

// usage builds the OpenAI usage object (prompt 含缓存命中 —— OpenAI 没有独立的
// 缓存列，minimax 转换器的同款折叠口径).
func (c *accioStreamConverter) usageTokens() (prompt, completion, total, reasoning int) {
	if c.usage != nil {
		if v, ok := accioNumber(accioFirstNonEmpty(c.usage["prompt_token_count"], c.usage["promptTokenCount"])); ok {
			prompt = int(v)
		}
		if v, ok := accioNumber(accioFirstNonEmpty(c.usage["candidates_token_count"], c.usage["candidatesTokenCount"])); ok {
			completion = int(v)
		}
		if v, ok := accioNumber(accioFirstNonEmpty(c.usage["thoughts_token_count"], c.usage["thoughtsTokenCount"])); ok {
			reasoning = int(v)
		}
	}
	total = prompt + completion
	return prompt, completion, total, reasoning
}

// terminalFrames is the output terminator sequence.
func (c *accioStreamConverter) terminalFrames() []string {
	out := c.flushPending()
	prompt, completion, total, reasoning := c.usageTokens()
	if c.openai {
		finishReason := accioFinishToOpenAI(c.finish, c.hadTool)
		out = append(out, c.chunkJSON(map[string]any{}, finishReason))
		usageObj := map[string]any{
			"prompt_tokens":     prompt,
			"completion_tokens": completion,
			"total_tokens":      total,
		}
		if reasoning > 0 {
			usageObj["completion_tokens_details"] = map[string]any{"reasoning_tokens": reasoning}
		}
		body, err := json.Marshal(map[string]any{
			"id": c.id, "object": "chat.completion.chunk", "created": c.created,
			"model": c.model, "choices": []any{}, "usage": usageObj,
		})
		if err == nil {
			out = append(out, "data: "+string(body)+"\n\n")
		}
		out = append(out, "data: [DONE]\n\n")
		return out
	}
	// Anthropic：message_delta（stop_reason + output_tokens）+ message_stop。
	stop := accioFinishToAnthropic(c.finish, c.hadTool)
	body, err := json.Marshal(map[string]any{
		"type":  "message_delta",
		"delta": map[string]any{"stop_reason": stop, "stop_sequence": nil},
		"usage": map[string]any{"output_tokens": completion},
	})
	if err == nil {
		out = append(out, "event: message_delta\ndata: "+string(body)+"\n\n")
	}
	out = append(out, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	return out
}

// errorFrames renders a mid-stream error (after content started) in the
// requested shape; the stream then terminates.
func (c *accioStreamConverter) errorFrames(detail string) []string {
	if !c.openai {
		return nil // Anthropic 流式：错误由拦截层在 peek 阶段整体失败（见文件头）
	}
	body, err := json.Marshal(map[string]any{"error": map[string]any{
		"message": "accio: 流内错误：" + detail,
		"type":    "upstream_error",
	}})
	if err != nil {
		return nil
	}
	return []string{"data: " + string(body) + "\n\n"}
}

// ── OpenAI chunk 产出 ────────────────────────────────────────────────────

// chunkJSON serialises one OpenAI chunk frame ("data: {...}\n\n").
func (c *accioStreamConverter) chunkJSON(delta map[string]any, finish any) string {
	chunk := map[string]any{
		"id": c.id, "object": "chat.completion.chunk", "created": c.created,
		"model": c.model,
		"choices": []any{map[string]any{
			"index": 0, "delta": delta, "finish_reason": finish,
		}},
	}
	body, err := json.Marshal(chunk)
	if err != nil {
		return ""
	}
	return "data: " + string(body) + "\n\n"
}

// ── Anthropic 流式事件产出（message_start → blocks → message_delta → stop）──

func (c *accioStreamConverter) anthropicEnsureStart() []string {
	if c.antStarted {
		return nil
	}
	c.antStarted = true
	prompt, _, _, _ := c.usageTokens()
	body, err := json.Marshal(map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"id": "msg_accio", "type": "message", "role": "assistant", "model": c.model,
			"content": []any{}, "stop_reason": nil, "stop_sequence": nil,
			"usage": map[string]any{"input_tokens": prompt, "output_tokens": 0},
		},
	})
	if err != nil {
		return nil
	}
	return []string{"event: message_start\ndata: " + string(body) + "\n\n"}
}

// anthropicBlockEvent opens/keeps one content block and emits a delta.
func (c *accioStreamConverter) anthropicDelta(kind string, delta map[string]any) []string {
	out := c.anthropicEnsureStart()
	if c.antOpen != kind {
		// 关上一个块，再开新块（Anthropic 的块必须显式 start/stop）。
		if c.antOpen != "" {
			body, err := json.Marshal(map[string]any{"type": "content_block_stop", "index": c.antIndex})
			if err == nil {
				out = append(out, "event: content_block_stop\ndata: "+string(body)+"\n\n")
			}
			c.antIndex++
		}
		startContent := map[string]any{"type": kind}
		if kind == "tool_use" {
			// tool 块的 start 由 anthropicToolBlock 自己发（带 id/name）。
			c.antOpen = kind
			return out
		}
		body, err := json.Marshal(map[string]any{
			"type": "content_block_start", "index": c.antIndex,
			"content_block": startContent,
		})
		if err == nil {
			out = append(out, "event: content_block_start\ndata: "+string(body)+"\n\n")
		}
		c.antOpen = kind
	}
	body, err := json.Marshal(map[string]any{
		"type": "content_block_delta", "index": c.antIndex, "delta": delta,
	})
	if err == nil {
		out = append(out, "event: content_block_delta\ndata: "+string(body)+"\n\n")
	}
	return out
}

func (c *accioStreamConverter) anthropicTextDelta(text string) []string {
	return c.anthropicDelta("text", map[string]any{"type": "text_delta", "text": text})
}

func (c *accioStreamConverter) anthropicThinkingDelta(text string) []string {
	return c.anthropicDelta("thinking", map[string]any{"type": "thinking_delta", "thinking": text})
}

// anthropicToolBlock emits a complete tool_use block (start + full args delta
// + stop —— 合并后的参数一次性发完).
func (c *accioStreamConverter) anthropicToolBlock(id, name, args string) []string {
	out := c.anthropicEnsureStart()
	if c.antOpen != "" {
		body, err := json.Marshal(map[string]any{"type": "content_block_stop", "index": c.antIndex})
		if err == nil {
			out = append(out, "event: content_block_stop\ndata: "+string(body)+"\n\n")
		}
		c.antIndex++
	}
	if args == "" {
		args = "{}"
	}
	startBody, err := json.Marshal(map[string]any{
		"type": "content_block_start", "index": c.antIndex,
		"content_block": map[string]any{"type": "tool_use", "id": id, "name": name, "input": map[string]any{}},
	})
	if err == nil {
		out = append(out, "event: content_block_start\ndata: "+string(startBody)+"\n\n")
	}
	deltaBody, err := json.Marshal(map[string]any{
		"type": "content_block_delta", "index": c.antIndex,
		"delta": map[string]any{"type": "input_json_delta", "partial_json": args},
	})
	if err == nil {
		out = append(out, "event: content_block_delta\ndata: "+string(deltaBody)+"\n\n")
	}
	stopBody, err := json.Marshal(map[string]any{"type": "content_block_stop", "index": c.antIndex})
	if err == nil {
		out = append(out, "event: content_block_stop\ndata: "+string(stopBody)+"\n\n")
	}
	c.antIndex++
	c.antOpen = ""
	return out
}

// ── 聚合（非流式客户端） ─────────────────────────────────────────────────

// aggregateOpenAI builds the non-streaming chat.completion object.
func (c *accioStreamConverter) aggregateOpenAI() []byte {
	message := map[string]any{"role": "assistant", "content": c.text.String()}
	if r := c.reasoning.String(); r != "" {
		message["reasoning_content"] = r
	}
	if c.text.String() == "" && len(c.tools) > 0 {
		message["content"] = nil // 只有工具调用时 OpenAI 的 content 是 null
	}
	if len(c.tools) > 0 {
		calls := []any{}
		for _, t := range c.tools {
			args := t.args
			if strings.TrimSpace(args) == "" {
				args = "{}"
			}
			calls = append(calls, map[string]any{
				"id": t.id, "type": "function",
				"function": map[string]any{"name": t.name, "arguments": args},
			})
		}
		message["tool_calls"] = calls
	}
	prompt, completion, total, reasoning := c.usageTokens()
	usage := map[string]any{
		"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": total,
	}
	if reasoning > 0 {
		usage["completion_tokens_details"] = map[string]any{"reasoning_tokens": reasoning}
	}
	payload := map[string]any{
		"id": c.id, "object": "chat.completion", "created": c.created, "model": c.model,
		"choices": []any{map[string]any{
			"index": 0, "message": message,
			"finish_reason": accioFinishToOpenAI(c.finish, c.hadTool),
		}},
		"usage": usage,
	}
	body, _ := json.Marshal(payload)
	return body
}

// aggregateAnthropic builds the non-streaming Anthropic message object.
// ⚠️ thinking 块**不输出**（Anthropic 要求 thinking 块带 signature，上游未实测
// 下发 —— 回传无签名 thinking 会被上游拒绝；minimax 转换器的同款取舍）。
func (c *accioStreamConverter) aggregateAnthropic() []byte {
	content := []any{}
	if r := c.reasoning.String(); r != "" {
		content = append(content, map[string]any{"type": "thinking", "thinking": r, "signature": ""})
	}
	if t := c.text.String(); t != "" {
		content = append(content, map[string]any{"type": "text", "text": t})
	}
	for _, tool := range c.tools {
		input := map[string]any{}
		if strings.TrimSpace(tool.args) != "" {
			_ = json.Unmarshal([]byte(tool.args), &input)
		}
		content = append(content, map[string]any{
			"type": "tool_use", "id": tool.id, "name": tool.name, "input": input,
		})
	}
	_, completion, _, _ := c.usageTokens()
	stop := accioFinishToAnthropic(c.finish, c.hadTool)
	payload := map[string]any{
		"id": "msg_accio", "type": "message", "role": "assistant", "model": c.model,
		"content": content, "stop_reason": stop, "stop_sequence": nil,
		"usage": map[string]any{"input_tokens": 0, "output_tokens": completion},
	}
	body, _ := json.Marshal(payload)
	return body
}

// accioSawAny reports whether the stream produced any content.
func (c *accioStreamConverter) accioSawAny() bool { return c.sawAny }

// ── 流式 reader / 聚合入口（minimaxSSEReader 的同款结构） ────────────────

// accioSSEReader streams the converted frames. It flushes the tail line and
// emits the terminal frames at EOF —— 截断流里携带 stop_reason/usage 的收尾帧
// 就在最后一行，不冲刷就会丢掉它们（minimax 修过的同款真实缺陷）。
type accioSSEReader struct {
	src    io.Reader
	conv   *accioStreamConverter
	out    bytes.Buffer
	buf    []byte
	chunk  []byte
	srcEnd bool
	done   bool
}

func newAccioSSEReader(src io.Reader, openai bool, model string) *accioSSEReader {
	return &accioSSEReader{
		src: src, conv: newAccioStreamConverter(model, openai),
		chunk: make([]byte, 32*1024),
	}
}

func (r *accioSSEReader) Read(p []byte) (int, error) {
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
			// 读错误一律按 EOF 处理：尾部残留 + 终止帧仍要发出。
			r.srcEnd = true
			if tail := strings.TrimSpace(string(r.buf)); tail != "" {
				r.emit(r.conv.feedLine(string(r.buf))...)
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
func (r *accioSSEReader) emitCompleteLines() {
	for {
		idx := bytes.IndexByte(r.buf, '\n')
		if idx < 0 {
			return
		}
		line := string(r.buf[:idx])
		r.buf = r.buf[idx+1:]
		r.emit(r.conv.feedLine(line)...)
	}
}

func (r *accioSSEReader) emit(frames ...string) {
	for _, f := range frames {
		if f != "" {
			r.out.WriteString(f)
		}
	}
}

func (r *accioSSEReader) fireTerminal() {
	r.emit(r.conv.terminalFrames()...)
}

// accioAggregateSSE consumes the whole stream and returns the non-streaming
// body in the requested shape.
func accioAggregateSSE(src io.Reader, openai bool, model string) ([]byte, error) {
	conv := newAccioStreamConverter(model, openai)
	raw, err := io.ReadAll(io.LimitReader(src, 32<<20))
	if err != nil {
		return nil, fmt.Errorf("jethub: accio 读取上游响应失败：%w", err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		conv.feedLine(line)
	}
	if conv.streamErr != "" {
		return nil, fmt.Errorf("accio: 流内错误（%s）", conv.streamErr)
	}
	if !conv.accioSawAny() {
		snippet := strings.TrimSpace(string(raw))
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		return nil, fmt.Errorf("jethub: accio 上游未返回任何内容块（非流式响应或空响应）：%s", snippet)
	}
	if openai {
		return conv.aggregateOpenAI(), nil
	}
	return conv.aggregateAnthropic(), nil
}

// accioInterceptResponse implements the response-side hook: risk-control page
// detection, in-stream error classification (402 → billing lock) and the
// Accio→OpenAI/Anthropic conversion.
//
// ⚠️ 错误帧恒在第一帧（qoder/minimax 的同款纪律）：在内容到达客户端之前截住，
// 重试才干净 —— peek 首帧失败是唯一能把「流内错误」变成**整体失败**的时机。
func (m *Manager) accioInterceptResponse(clientReq *http.Request, resp *http.Response, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	if resp.StatusCode == http.StatusPaymentRequired {
		// ref httpErrorCode(402) = QUOTA_EXCEEDED：额度耗尽必须按计费锁处理
		// （不得落进通用重试 —— 那会原样重发 5 次必然同败）。锁到次日 UTC+8
		// 00:05：与 rotation 的日配额锁同一口径（每日桶跨零点重置）。
		return nil, 0, &upstreamerr.BillingLockError{
			Until:  time.UnixMilli(NextUtc8DayStartMs(nowMillis())),
			Reason: "accio: 额度耗尽（HTTP 402）",
		}
	}
	if resp.StatusCode >= 400 {
		return nil, 0, nil // 其他错误原样透传（代理统一处理）
	}
	// 200 但不是 text/event-stream：上游代理可能回风控 HTML 页（实测形态：
	// 200 + text/html + `bixi-intl.alicdn.com/punish`，缺 utdid 时触发）或
	// JSON 错误体 —— 都不是成功流，必须显式报错（不重试）。
	if ct := resp.Header.Get("Content-Type"); ct != "" && !strings.Contains(ct, "text/event-stream") {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		text := strings.TrimSpace(string(raw))
		hint := ""
		if strings.Contains(text, "punish") || strings.Contains(text, "bixi") {
			hint = "（命中上游风控页，常见于缺 utdid/sgcookie 的请求）"
		}
		return nil, 0, fmt.Errorf("accio: 上游返回非流式响应（HTTP 200 %s）%s：%.300s",
			resp.Header.Get("Content-Type"), hint, text)
	}
	// 流内错误帧分类（peek 首帧）：402 → 计费锁；其余 → 显式失败。
	peeked, firstLine, _ := peekFirstSSEDataLine(resp.Body)
	if payload := accioPayloadOf(firstLine); payload != "" {
		var frame map[string]any
		if json.Unmarshal([]byte(payload), &frame) == nil {
			if code, message, isErr := accioFrameError(frame); isErr {
				_ = resp.Body.Close()
				detail := message
				if code != "" {
					detail = fmt.Sprintf("error_code=%s %s", code, message)
				}
				if code == accioQuotaErrorCode {
					return nil, 0, &upstreamerr.BillingLockError{
						Until:  time.UnixMilli(NextUtc8DayStartMs(nowMillis())),
						Reason: fmt.Sprintf("accio: 额度或认证失败（%s）", detail),
					}
				}
				return nil, 0, fmt.Errorf("accio: 上游返回错误帧（%s）", detail)
			}
		}
	}
	openai := !accioIsAnthropicEntry(clientEntryPathOf(clientReq))
	src := io.MultiReader(bytes.NewReader(peeked), resp.Body)
	model := upstreamModel
	if model == "" {
		model = "accio"
	}
	if isStream {
		return newAccioSSEReader(src, openai, model), 0, nil
	}
	body, err := accioAggregateSSE(src, openai, model)
	if err != nil {
		return nil, 0, err
	}
	resp.Header.Set("Content-Type", "application/json; charset=utf-8")
	resp.Header.Del("Content-Length")
	resp.ContentLength = -1
	return bytes.NewReader(body), 0, nil
}

// accioPayloadOf extracts the JSON payload of one SSE data line.
func accioPayloadOf(line string) string {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "data:") {
		return ""
	}
	payload := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
	if payload == "" || payload == "[DONE]" {
		return ""
	}
	return payload
}
