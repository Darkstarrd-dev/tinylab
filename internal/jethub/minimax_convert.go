package jethub

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// MiniMax Code 推理协议转换（进站 OpenAI → 出站 Anthropic Messages）。
//
// ⚠️ 背景（用户实测报障 2026-10-01）：MiniMax 推理**不是** OpenAI 兼容端点，
// 而是 Anthropic Messages（`POST {apiHost}/mavis/api/v1/llm/v1/messages`，见
// ref minimax-product.ts 的 MINIMAX_INFER_PATH 与 ref minimax-messages.ts 的
// 实测结论）。此前 BaseURL 填的是 host 根，代理按进站路径拼出
// `{apiHost}/v1/chat/completions` → 上游回 **404 + Next.js HTML**（用户 trace
// r28I4T2cXFlA-1 实录）。故本文件负责两件事：
//
//  1. 出站 URL 由 Customize 固定为完整推理端点（urlutil 对带 `/v1/messages`
//     结尾的 base 会剥后缀，不能靠 BaseURL 表达）；
//  2. 进站协议与出站协议不一致时做双向转换：请求体 OpenAI → Anthropic、
//     响应流 Anthropic SSE → OpenAI chunk（见 minimax_stream.go）。
//
// ⚠️ 进站是 `/v1/messages`（Anthropic 原生）时**不做转换**（原生透传）——
// 架构文档 §6 的「Anthropic Messages 原生透传」即指这条路径，用户可以用
// Anthropic 客户端直连 `{prefix}/{model}`。
//
// 参考实现：ref/deepseek-harness-codearts/src/minimax-messages.ts（请求体构造与
// SSE 消费）、src/minimax.ts（headers / 模型元数据）、src/minimax-adapter.ts
// （思考档位与错误归类）。协议事实均有 2026-09-29 真机实测依据（见 AGENTS.md
// 的 minimax 章节）。

// minimaxInferURL is the FULL inference endpoint. The host alone is not
// enough: urlutil.BuildUpstreamURL strips a trailing "/v1/messages" from a
// base URL and re-appends the ENTRY path suffix, so any path-bearing base
// would land on the wrong endpoint (that is exactly the reported 404).
func minimaxInferURL() string { return minimaxProduct.APIHost + minimaxInferPath }

// minimaxModelMeta is the per-model thinking/max-token metadata (ref
// minimax-product.ts 的 MINIMAX_FALLBACK_MODELS；窗口口径与 TinyLab 的
// minimaxFallbackModels 一致).
//
// ⚠️ Efforts 与 ThinkingMode 必须与远端目录镜像，凭空补档位会让 UI 给出
// 选项而请求侧被门禁丢弃（ref minimax-adapter.ts 的注释：两端判据必须同源）。
type minimaxModelMeta struct {
	// MaxTokens is the model's output limit (远端 limit.output；四个模型均
	// 128000)。进站没给 max_tokens 时用它补默认值 —— Anthropic 协议里
	// max_tokens 是必填，缺了上游直接 400。
	MaxTokens int
	// Efforts is 远端 effort_options 的键序（只有 M3.1 有）。
	Efforts []string
	// ThinkingMode is 远端 thinking_config.mode："forced_on" / "switchable" /
	// ""（未知，不声明任何开关）。
	ThinkingMode string
}

// minimaxModelMetas mirrors the four verified models.
var minimaxModelMetas = map[string]minimaxModelMeta{
	"MiniMax-M3.1-Flash-Preview": {
		MaxTokens:    128_000,
		Efforts:      []string{"default", "low", "medium", "high", "xhigh", "max"},
		ThinkingMode: "forced_on",
	},
	"MiniMax-M3": {
		MaxTokens: 128_000,
		// ⚠️ 实测可开关思考但**没有任何档位** —— 只有 on/none 两态，
		// 不要按别的模型猜档位（ref minimax-adapter.ts 同款判据）。
		ThinkingMode: "switchable",
	},
	"MiniMax-M2.7-highspeed": {MaxTokens: 128_000, ThinkingMode: "forced_on"},
	"MiniMax-M2.7":           {MaxTokens: 128_000, ThinkingMode: "forced_on"},
}

// minimaxUnknownMaxTokens is the fallback max_tokens for a model missing from
// the metadata table (user-added model ids). Deliberately modest: too large a
// value can be rejected by the gateway, too small only truncates.
const minimaxUnknownMaxTokens = 8192

// minimaxAdaptiveOnlyPrefix: 前缀判据（⚠️ 必须是 M3.1，不能放宽到 M3 ——
// M3 不需要 adaptive，实测 200；见 ref minimax-adapter.ts 的注释）。
const minimaxAdaptiveOnlyPrefix = "MiniMax-M3.1"

// minimaxIsAnthropicEntry reports whether the client request went through the
// Anthropic /v1/messages entry (native passthrough) rather than the OpenAI
// chat-completions family (converted).
func minimaxIsAnthropicEntry(path string) bool {
	trimmed := strings.TrimSuffix(path, "/")
	return strings.HasSuffix(trimmed, "/v1/messages")
}

// minimaxDeclaredEfforts returns the effort ids this model declares in the UI
// (ref minimaxReasoningInfo): remote effort_options, plus on/none for the
// switchable model. An empty result means "no reasoning declaration" — the
// request side must then drop whatever the client asked for.
func minimaxDeclaredEfforts(model string) []string {
	meta, ok := minimaxModelMetas[model]
	if !ok {
		return nil
	}
	if len(meta.Efforts) > 0 {
		return meta.Efforts
	}
	if meta.ThinkingMode == "switchable" {
		// 顺序照 ref：on 在 none 前。
		return []string{"on", "none"}
	}
	return nil
}

// minimaxNormalizeEffort maps OpenAI/client spellings onto the declared ids.
// Only aliases with an unambiguous meaning are accepted; anything else is
// dropped by the gate below (it would otherwise be a silently-ignored field).
func minimaxNormalizeEffort(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "disabled", "off", "false", "none":
		return "none"
	case "true", "enabled", "on":
		return "on"
	default:
		return strings.ToLower(strings.TrimSpace(raw))
	}
}

// minimaxThinkingPlan implements the three-state judgement of the reference
// implementation, in the SAME order (ref minimax-messages.ts:122-137):
//
//	effort == "none"  → thinking{disabled}      (switchable model only; the
//	                                             gate drops it for forced_on)
//	effort == "on"    → thinking{adaptive}      (switchable model)
//	adaptive-only     → thinking{adaptive} (+output_config.effort)
//	effort != ""      → thinking{adaptive} (+output_config.effort)
//	otherwise         → NO thinking key at all  (safe default: 实测 200)
//
// ⚠️ M3.1 传 thinking.type=disabled 会被服务端硬拒（400，2013），故 gate 必须
// 先于这里生效：`reasoning_effort: none` 对 M3.1 会被丢弃 → 仍然 adaptive。
func minimaxThinkingPlan(model, requestedEffort string) (thinking map[string]any, outputConfig map[string]any) {
	effort := minimaxNormalizeEffort(requestedEffort)
	if effort != "" {
		declared := minimaxDeclaredEfforts(model)
		keep := false
		for _, id := range declared {
			if id == effort {
				keep = true
				break
			}
		}
		if !keep {
			effort = ""
		}
	}

	if effort == "none" {
		return map[string]any{"type": "disabled"}, nil
	}
	if effort == "on" {
		return map[string]any{"type": "adaptive"}, nil
	}
	requiresAdaptive := strings.HasPrefix(model, minimaxAdaptiveOnlyPrefix)
	if requiresAdaptive {
		plan := map[string]any{"type": "adaptive"}
		if effort != "" {
			return plan, map[string]any{"effort": effort}
		}
		return plan, nil
	}
	if effort != "" {
		return map[string]any{"type": "adaptive"}, map[string]any{"effort": effort}
	}
	return nil, nil
}

// minimaxBuildRequest rewrites the client body for the MiniMax inference
// endpoint. anthropicEntry = the client already speaks Anthropic Messages
// (native passthrough, only `stream` is normalised).
func minimaxBuildRequest(anthropicEntry bool, body []byte, upstreamModel string) ([]byte, error) {
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("jethub: minimax body not JSON: %w", err)
	}
	if parsed == nil {
		return nil, fmt.Errorf("jethub: minimax body is not an object")
	}
	model := upstreamModel
	if model == "" {
		model, _ = parsed["model"].(string)
	}
	if anthropicEntry {
		// 原生透传：上游只实现了流式分支（ref 恒发 stream:true），而
		// Anthropic 的 stream 缺省是 false ⇒ 必须显式置 true，否则会拿到
		// 一个非流式响应（或 400）。非流式客户端由响应侧聚合成 message 对象。
		parsed["stream"] = true
		if _, ok := parsed["model"]; !ok {
			parsed["model"] = model
		}
		out, err := json.Marshal(parsed)
		if err != nil {
			return nil, fmt.Errorf("jethub: minimax body marshal: %w", err)
		}
		return out, nil
	}
	converted, err := minimaxOpenAIToAnthropic(parsed, model)
	if err != nil {
		return nil, err
	}
	out, err := json.Marshal(converted)
	if err != nil {
		return nil, fmt.Errorf("jethub: minimax body marshal: %w", err)
	}
	return out, nil
}

// minimaxOpenAIToAnthropic is the field-by-field OpenAI → Anthropic Messages
// conversion (target shape verified 2026-09-29, ref minimax-messages.ts).
func minimaxOpenAIToAnthropic(parsed map[string]any, model string) (map[string]any, error) {
	out := map[string]any{
		"model":  model,
		"stream": true, // 上游只有流式分支
	}

	// max_tokens：Anthropic 必填。缺省用模型上限补齐（未知模型用保守默认值）。
	maxTokens := minimaxModelMetas[model].MaxTokens
	if maxTokens <= 0 {
		maxTokens = minimaxUnknownMaxTokens
	}
	if v, ok := minimaxPositiveInt(parsed["max_tokens"]); ok {
		maxTokens = v
	} else if v, ok := minimaxPositiveInt(parsed["max_completion_tokens"]); ok {
		maxTokens = v
	}
	out["max_tokens"] = maxTokens
	if v, ok := parsed["temperature"].(float64); ok {
		out["temperature"] = v
	}
	if v, ok := parsed["top_p"].(float64); ok {
		out["top_p"] = v
	}
	if stop := minimaxStopSequences(parsed["stop"]); len(stop) > 0 {
		out["stop_sequences"] = stop
	}

	// system：顶层字符串字段（⚠️ 绝不发 role:"system" 的消息 —— 会被模型
	// 当作用户指令；ref serializeMinimaxMessages 显式跳过 system 角色）。
	system := minimaxSystemText(parsed["messages"])
	if system != "" {
		out["system"] = system
	}

	messages, err := minimaxConvertMessages(parsed["messages"])
	if err != nil {
		return nil, err
	}
	if len(messages) == 0 {
		return nil, fmt.Errorf("jethub: minimax 请求没有可转换的消息")
	}
	out["messages"] = messages

	if tools := minimaxConvertTools(parsed["tools"]); len(tools) > 0 {
		out["tools"] = tools
		if choice := minimaxConvertToolChoice(parsed["tool_choice"]); choice != nil {
			out["tool_choice"] = choice
		}
	}

	// 思考档位：OpenAI 的 reasoning_effort（部分客户端也用 thinking.effort）。
	effort, _ := parsed["reasoning_effort"].(string)
	if effort == "" {
		if th, ok := parsed["thinking"].(map[string]any); ok {
			if s, ok := th["effort"].(string); ok {
				effort = s
			}
		}
	}
	thinking, outputConfig := minimaxThinkingPlan(model, effort)
	if thinking != nil {
		out["thinking"] = thinking
	}
	if outputConfig != nil {
		out["output_config"] = outputConfig
	}
	return out, nil
}

// minimaxPositiveInt accepts JSON numbers/strings that denote a positive
// integer (ref 判据：Number.isSafeInteger && > 0；小数/0/负数/缺失一律不认).
func minimaxPositiveInt(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		if t > 0 && t == float64(int64(t)) {
			return int(t), true
		}
	case int:
		if t > 0 {
			return t, true
		}
	case string:
		if s := strings.TrimSpace(t); isAllDigits(s) {
			n := parsePositiveInt(s)
			if n > 0 {
				return int(n), true
			}
		}
	}
	return 0, false
}

// minimaxStopSequences normalises OpenAI `stop` (string or []string).
func minimaxStopSequences(v any) []any {
	out := []any{}
	switch t := v.(type) {
	case string:
		if t != "" {
			out = append(out, t)
		}
	case []any:
		for _, item := range t {
			if s, ok := item.(string); ok && s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}

// minimaxSystemText flattens every system/developer message into the
// top-level `system` string, in message order (multiple system messages are
// joined with a blank line — the reference implementation leaves the merge to
// its caller, so this is our own documented rule).
func minimaxSystemText(raw any) string {
	list, _ := raw.([]any)
	var parts []string
	for _, item := range list {
		msg, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		if role != "system" && role != "developer" {
			continue
		}
		if text := minimaxTextOf(msg["content"]); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n\n")
}

// minimaxTextOf extracts plain text from an OpenAI content value (string or
// array of parts).
func minimaxTextOf(content any) string {
	switch t := content.(type) {
	case string:
		return t
	case []any:
		var sb strings.Builder
		for _, part := range t {
			pm, ok := part.(map[string]any)
			if !ok {
				continue
			}
			if s, ok := pm["text"].(string); ok {
				sb.WriteString(s)
			}
		}
		return sb.String()
	}
	return ""
}

// minimaxConvertMessages maps the OpenAI message list onto Anthropic
// messages: one content-block array per message, tool results folded into the
// following user message (Anthropic has NO role:"tool"), consecutive
// same-role messages coalesced (the Anthropic protocol expects alternating
// roles; OpenAI histories routinely violate that).
func minimaxConvertMessages(raw any) ([]any, error) {
	list, _ := raw.([]any)
	var out []any
	for _, item := range list {
		msg, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		switch role {
		case "system", "developer":
			continue // 已提到顶层 system
		}
		anthropicRole := "user"
		if role == "assistant" {
			anthropicRole = "assistant"
		}
		blocks, err := minimaxMessageBlocks(msg, role)
		if err != nil {
			return nil, err
		}
		if len(blocks) == 0 {
			// 空消息整条丢弃（ref：content 块为空则丢弃）—— 回传空块会被拒。
			continue
		}
		out = minimaxAppendMessage(out, anthropicRole, blocks)
	}
	return out, nil
}

// minimaxAppendMessage coalesces consecutive same-role messages.
func minimaxAppendMessage(out []any, role string, blocks []any) []any {
	if n := len(out); n > 0 {
		if last, ok := out[n-1].(map[string]any); ok {
			if lastRole, _ := last["role"].(string); lastRole == role {
				existing, _ := last["content"].([]any)
				last["content"] = append(existing, blocks...)
				return out
			}
		}
	}
	return append(out, map[string]any{"role": role, "content": blocks})
}

// minimaxMessageBlocks converts one OpenAI message into Anthropic blocks.
func minimaxMessageBlocks(msg map[string]any, role string) ([]any, error) {
	blocks := []any{}
	content := msg["content"]

	if role == "tool" {
		// OpenAI 工具结果 → user 消息里的 tool_result 块。
		id, _ := msg["tool_call_id"].(string)
		if id == "" {
			return nil, fmt.Errorf("jethub: minimax 工具结果缺少 tool_call_id")
		}
		block := map[string]any{"type": "tool_result", "tool_use_id": id}
		if text := minimaxTextOf(content); text != "" {
			block["content"] = []any{map[string]any{"type": "text", "text": text}}
		} else {
			block["content"] = []any{}
		}
		if isErr, ok := msg["is_error"].(bool); ok && isErr {
			block["is_error"] = true
		}
		return append(blocks, block), nil
	}

	switch c := content.(type) {
	case string:
		if c != "" {
			blocks = append(blocks, map[string]any{"type": "text", "text": c})
		}
	case []any:
		for _, part := range c {
			pm, ok := part.(map[string]any)
			if !ok {
				continue
			}
			ptype, _ := pm["type"].(string)
			switch ptype {
			case "text", "input_text":
				if s, ok := pm["text"].(string); ok && s != "" {
					blocks = append(blocks, map[string]any{"type": "text", "text": s})
				}
			case "image_url", "input_image":
				block, err := minimaxImageBlock(pm)
				if err != nil {
					return nil, err
				}
				blocks = append(blocks, block)
			}
		}
	}

	// assistant 的 tool_calls → tool_use 块（⚠️ 必须保留：丢了会让后续
	// tool_result 变成孤儿块，上游 400）。
	if calls, ok := msg["tool_calls"].([]any); ok {
		for i, rawCall := range calls {
			call, ok := rawCall.(map[string]any)
			if !ok {
				continue
			}
			fn, _ := call["function"].(map[string]any)
			name, _ := fn["name"].(string)
			if name == "" {
				continue
			}
			id, _ := call["id"].(string)
			if id == "" {
				id = fmt.Sprintf("call_%d", i)
			}
			blocks = append(blocks, map[string]any{
				"type": "tool_use", "id": id, "name": name,
				"input": minimaxToolInput(fn["arguments"]),
			})
		}
	}
	return blocks, nil
}

// minimaxToolInput parses an OpenAI arguments string into the object Anthropic
// requires (空串/坏 JSON/非对象 → {}，但块必须保留；ref parseToolArguments).
func minimaxToolInput(raw any) map[string]any {
	empty := map[string]any{}
	switch t := raw.(type) {
	case map[string]any:
		return t
	case string:
		if strings.TrimSpace(t) == "" {
			return empty
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(t), &parsed); err != nil || parsed == nil {
			return empty
		}
		return parsed
	}
	return empty
}

// minimaxImageBlock converts an OpenAI image part into the Anthropic
// base64-inline shape. ⚠️ 上游明确拒绝 image_url（400 unsupported content
// type 'image_url'），所以只接受 data: URL；远程 URL 必须显式报错，不能
// 静默丢图（ref 同款纪律）。
func minimaxImageBlock(part map[string]any) (map[string]any, error) {
	url := ""
	if s, ok := part["image_url"].(string); ok {
		url = s
	} else if obj, ok := part["image_url"].(map[string]any); ok {
		url, _ = obj["url"].(string)
	}
	if url == "" {
		return nil, fmt.Errorf("jethub: minimax 图片块缺少 image_url")
	}
	mediaType, data, ok := minimaxParseDataURL(url)
	if !ok {
		return nil, fmt.Errorf("jethub: minimax 只支持 base64 内联图片（data: URL），收到远程地址；请先把图片转成 data URL")
	}
	return map[string]any{
		"type": "image",
		"source": map[string]any{
			"type": "base64", "media_type": mediaType, "data": data,
		},
	}, nil
}

// minimaxParseDataURL splits "data:<mime>;base64,<payload>".
func minimaxParseDataURL(url string) (mediaType, data string, ok bool) {
	if !strings.HasPrefix(url, "data:") {
		return "", "", false
	}
	rest := strings.TrimPrefix(url, "data:")
	comma := strings.IndexByte(rest, ',')
	if comma < 0 {
		return "", "", false
	}
	header := rest[:comma]
	payload := rest[comma+1:]
	if !strings.Contains(header, "base64") {
		return "", "", false
	}
	mediaType = strings.TrimSuffix(strings.SplitN(header, ";", 2)[0], " ")
	if mediaType == "" {
		mediaType = "image/png"
	}
	if payload == "" {
		return "", "", false
	}
	return mediaType, payload, true
}

// minimaxConvertTools maps OpenAI function tools onto Anthropic tools
// (input_schema, not function.parameters).
func minimaxConvertTools(raw any) []any {
	list, _ := raw.([]any)
	out := []any{}
	for _, item := range list {
		tool, ok := item.(map[string]any)
		if !ok {
			continue
		}
		fn, ok := tool["function"].(map[string]any)
		if !ok {
			continue
		}
		name, _ := fn["name"].(string)
		if name == "" {
			continue
		}
		entry := map[string]any{"name": name}
		if desc, ok := fn["description"].(string); ok && desc != "" {
			entry["description"] = desc
		}
		if params, ok := fn["parameters"].(map[string]any); ok {
			entry["input_schema"] = params
		} else {
			entry["input_schema"] = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, entry)
	}
	return out
}

// minimaxConvertToolChoice maps OpenAI tool_choice onto the Anthropic shape.
func minimaxConvertToolChoice(raw any) map[string]any {
	switch t := raw.(type) {
	case string:
		switch t {
		case "required", "any":
			return map[string]any{"type": "any"}
		case "none":
			// Anthropic 没有 none：不发 tool_choice 时模型自行决定；
			// 显式禁用工具只能靠不发 tools（调用方决定，这里保守返回 nil）。
			return nil
		case "auto":
			return map[string]any{"type": "auto"}
		}
	case map[string]any:
		if fn, ok := t["function"].(map[string]any); ok {
			if name, ok := fn["name"].(string); ok && name != "" {
				return map[string]any{"type": "tool", "name": name}
			}
		}
	}
	return nil
}

// minimaxFirstErrorFrame inspects the first SSE data line for an in-stream
// error frame. Errors are always the first frame (ref 与 qoder 同款纪律) —
// catching it before any content reaches the client keeps the retry clean.
func minimaxFirstErrorFrame(firstLine string) (message string, ok bool) {
	trimmed := strings.TrimSpace(firstLine)
	if !strings.HasPrefix(trimmed, "data:") {
		return "", false
	}
	payload := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
	if payload == "" || payload == "[DONE]" {
		return "", false
	}
	var frame struct {
		Type  string `json:"type"`
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(payload), &frame); err != nil {
		return "", false
	}
	if frame.Type != "error" {
		return "", false
	}
	msg := frame.Error.Message
	if msg == "" {
		msg = frame.Error.Type
	}
	if msg == "" {
		msg = "未知错误"
	}
	return msg, true
}

// minimaxEntryPathOf is a tiny helper so the augmenter and tests can read the
// client entry path without nil checks scattered around.
func minimaxEntryPathOf(r *http.Request) string {
	if r == nil || r.URL == nil {
		return ""
	}
	return r.URL.Path
}
