package jethub

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
)

// Qoder 加密推理请求体的纯构造层 —— 1:1 复刻 ref qoder-wasm.ts 的
// buildQoderInferPayload()（官方客户端 G4A() 的字段结构）。抽成纯函数与 ref
// 同因：请求体经 WASM 加密后本地不可解，无法靠抓包验证 —— 只能靠单测锁死。
//
// ⚠️ 三个已踩过的坑（改动前先读）：
//  1. `business` 必填：缺失时 qfmodel 恒被路由到故障节点
//     `oa_qwen-plus-2025-04-28`（`[FAIL]node:... msg:Execution failed`）；
//  2. 顶层 `tools` 必须真的下发：缺了模型只能用正文 XML 臆造工具调用；
//  3. 带图消息的 `content` 是多模态数组（`image_url` 形态），
//     `chat_context.imageUrls` 恒为 null —— 那是忠实复刻不是缺陷。

// qoderInferMessage 是单条待发送消息（OpenAI 风格）。content 保留原形态
// （字符串或多模态数组）；带工具调用的 assistant 消息 content 为 null。
type qoderInferMessage struct {
	Role       string `json:"role"`
	Content    any    `json:"content"`
	ToolCalls  []any  `json:"tool_calls,omitempty"`
	ToolCallID string `json:"tool_call_id,omitempty"`
}

// qoderInferAsk 是构造请求体的全部输入（ref QoderInferAsk 的 Go 形态）。
type qoderInferAsk struct {
	ModelKey        string // ⚠️ 目录 key —— 加密端点只认它
	UserText        string
	SystemText      string
	IsReasoning     bool
	History         []qoderInferMessage
	MaxTokens       *int
	ReasoningEffort string
	Source          string
	IsVl            bool
	ContextWindow   int
	DisplayName     string
	Format          string
	MaxInputTokens  int
	SessionType     string
	Business        map[string]any
	Tools           []any
	RequestID       string
	SessionID       string
}

// buildQoderInferPayload 构造加密端点 `agent_chat_generation` 的明文请求体。
func buildQoderInferPayload(ask *qoderInferAsk) map[string]any {
	isReasoning := ask.IsReasoning
	text := ask.UserText

	parameters := map[string]any{}
	if ask.MaxTokens != nil {
		parameters["max_tokens"] = *ask.MaxTokens
	}
	if ask.ReasoningEffort != "" {
		parameters["reasoning_effort"] = ask.ReasoningEffort
		// enable_thinking 只有给出档位时才写（与 ref 一致：不发档位时
		// 两个字段都不出现）。
		parameters["enable_thinking"] = ask.ReasoningEffort != "none"
	}
	if ask.ContextWindow > 0 {
		parameters["context_length"] = ask.ContextWindow
	}

	messages := make([]qoderInferMessage, 0, len(ask.History))
	messages = append(messages, ask.History...)
	if len(messages) == 0 {
		messages = append(messages, qoderInferMessage{Role: "user", Content: text})
	}

	maxInput := ask.MaxInputTokens
	if maxInput <= 0 {
		if ask.ContextWindow > 0 {
			maxInput = ask.ContextWindow
		} else {
			maxInput = 200_000
		}
	}
	format := ask.Format
	if format == "" {
		format = "openai"
	}
	source := ask.Source
	if source == "" {
		source = "system"
	}
	sessionType := ask.SessionType
	if sessionType == "" {
		// ⚠️ 国际版 qodercli；CN 实测也接受默认值（qoder_work 是 IDE 的
		// integrationMode，与推理载荷无关 —— 不要改）。
		sessionType = "qodercli"
	}

	system := []any{}
	if ask.SystemText != "" {
		system = append(system, map[string]any{"type": "text", "text": ask.SystemText})
	}

	tools := ask.Tools
	if tools == nil {
		tools = []any{} // 键恒在、值为空数组（与客户端一致）
	}

	payload := map[string]any{
		"request_id":       ask.RequestID,
		"request_set_id":   ask.RequestID,
		"chat_record_id":   ask.RequestID,
		"session_id":       ask.SessionID,
		"stream":           true,
		"chat_task":        "FREE_INPUT",
		"chat_context": map[string]any{
			"text":       text,
			"features":   []any{},
			"extra": map[string]any{
				"context":         []any{},
				"modelConfig":     map[string]any{"key": ask.ModelKey, "is_reasoning": isReasoning},
				"originalContent": text,
			},
			"chatPrompt": "",
			// ⚠️ 官方 Hyc() 恒置 null —— 图片走 messages[].content 数组。
			"imageUrls": nil,
		},
		"is_reply":         true,
		"is_retry":         false,
		"source":           1,
		"version":          "3",
		"agent_id":         "agent_common",
		"task_id":          "common",
		"session_type":     sessionType,
		"aliyun_user_type": "",
		"model_config": map[string]any{
			"key":              ask.ModelKey,
			"display_name":     ask.DisplayName, // 官方 Uyc() 的 10 字段之一
			"model":            "",
			"format":           format,
			"is_vl":            ask.IsVl,
			"is_reasoning":     isReasoning,
			"api_key":          "",
			"url":              "",
			"source":           source,
			"max_input_tokens": maxInput,
		},
		"custom_model": nil,
		"system":       system,
		"messages":     messages,
		"tools":        tools,
		"parameters":   parameters,
	}
	if ask.Business != nil {
		payload["business"] = ask.Business // ⚠️ 决定服务端路由池，必填
	}
	return payload
}

// qoderInferInputs 是从客户端 OpenAI 请求体抽取出的载荷原料。
type qoderInferInputs struct {
	SystemText      string
	History         []qoderInferMessage
	UserText        string
	Tools           []any
	MaxTokens       *int
	ReasoningEffort string
}

// qoderExtractInferInputs parses the client OpenAI body. ⚠️ 序列化层只保留
// 协议认识的键（role/content/tool_calls/tool_call_id）—— 早期「整体透传」
// 会把调用方内部字段发给上游（ref buildQoderHistory 教训）；同样地，含图
// 消息的 content 数组必须原样保留（压缩成纯文本 = 图片丢失，真实缺陷）。
func qoderExtractInferInputs(body []byte) *qoderInferInputs {
	var parsed struct {
		Messages        []map[string]any `json:"messages"`
		Tools           []any            `json:"tools"`
		MaxTokens       any              `json:"max_tokens"`
		ReasoningEffort string           `json:"reasoning_effort"`
	}
	_ = json.Unmarshal(body, &parsed)

	out := &qoderInferInputs{}
	var systemParts []string
	var lastUserText string
	for _, msg := range parsed.Messages {
		role, _ := msg["role"].(string)
		if role == "system" || role == "developer" {
			if t := qoderContentText(msg["content"]); t != "" {
				systemParts = append(systemParts, t)
			}
			continue
		}
		out.History = append(out.History, qoderSanitizeMessage(msg))
		if role == "user" {
			lastUserText = qoderContentText(msg["content"])
		}
	}
	out.SystemText = joinNonEmpty(systemParts, "\n")
	out.UserText = lastUserText

	// tools：OpenAI 形态原样保留三键（type/function.name/description/parameters），
	// description/parameters 缺省时该键不出现（ref $Hc 约定）。
	for _, tool := range parsed.Tools {
		tm, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		fn, _ := tm["function"].(map[string]any)
		if fn == nil {
			continue
		}
		sanitizedFn := map[string]any{"name": fn["name"]}
		if d, ok := fn["description"].(string); ok && d != "" {
			sanitizedFn["description"] = d
		}
		if p, ok := fn["parameters"]; ok && p != nil {
			sanitizedFn["parameters"] = p
		}
		toolType, _ := tm["type"].(string)
		if toolType == "" {
			toolType = "function"
		}
		out.Tools = append(out.Tools, map[string]any{"type": toolType, "function": sanitizedFn})
	}

	if f, ok := parsed.MaxTokens.(float64); ok && f > 0 {
		v := int(f)
		out.MaxTokens = &v
	}
	out.ReasoningEffort = parsed.ReasoningEffort
	return out
}

// qoderSanitizeMessage copies ONLY the protocol keys (ref: 逐字段搬运).
func qoderSanitizeMessage(msg map[string]any) qoderInferMessage {
	out := qoderInferMessage{}
	out.Role, _ = msg["role"].(string)
	out.Content = msg["content"] // 原形态（string / 数组 / null）
	if tcs, ok := msg["tool_calls"].([]any); ok {
		for _, tc := range tcs {
			tcm, ok := tc.(map[string]any)
			if !ok {
				continue
			}
			fn, _ := tcm["function"].(map[string]any)
			if fn == nil {
				continue
			}
			entry := map[string]any{
				"id": tcm["id"], "type": tcm["type"],
				"function": map[string]any{"name": fn["name"], "arguments": fn["arguments"]},
			}
			if idx, ok := tcm["index"].(float64); ok {
				entry["index"] = idx
			}
			out.ToolCalls = append(out.ToolCalls, entry)
		}
	}
	if id, ok := msg["tool_call_id"].(string); ok {
		out.ToolCallID = id
	}
	return out
}

// qoderContentText extracts the text of a content value: string → itself;
// multimodal array → the text parts joined '' (image parts contribute
// nothing but stay in the message content).
func qoderContentText(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var b []byte
		for _, part := range v {
			pm, ok := part.(map[string]any)
			if !ok {
				continue
			}
			if t, _ := pm["type"].(string); t == "text" {
				if s, ok := pm["text"].(string); ok {
					b = append(b, s...)
				}
			}
		}
		return string(b)
	default:
		return ""
	}
}

func joinNonEmpty(parts []string, sep string) string {
	out := ""
	for _, p := range parts {
		if p == "" {
			continue
		}
		if out != "" {
			out += sep
		}
		out += p
	}
	return out
}

// qoderModelMeta carries the per-model payload fields the directory knows
// (ref QoderProductFallbackModel: contextWindow / supportsThinking /
// supportsImage). Only what buildQoderInferPayload consumes.
type qoderModelMeta struct {
	Ctx       int  // contextWindow（context_config 档位表最大档）
	Reasoning bool // supportsThinking（目录 is_reasoning）
	Vl        bool // supportsImage（目录 is_vl，实测全 true 除 CN mmodel）
}

// qoderModelMetas: per-product meta tables (ref qoder-product.ts
// QODER_FALLBACK_MODELS / QODER_CN_FALLBACK_MODELS). ⚠️ 两站同 key 的取值
// 不同（如 dfmodel CN 无 is_reasoning；mmodel CN 是 M2.7 + is_vl:false），
// 不能互相套用。
var qoderModelMetas = map[string]map[string]qoderModelMeta{
	"qoder": {
		"auto":          {Ctx: 200_000, Reasoning: false, Vl: true},
		"ultimate":      {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"performance":   {Ctx: 1_000_000, Reasoning: false, Vl: true},
		"efficient":     {Ctx: 1_000_000, Reasoning: false, Vl: true},
		"smodel":        {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"cmodel":        {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"qmodel_38max":  {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"qfmodel":       {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"qmodel_latest": {Ctx: 1_000_000, Reasoning: false, Vl: true},
		"qmodel":        {Ctx: 1_000_000, Reasoning: false, Vl: true},
		"kmodel_latest": {Ctx: 1_000_000, Reasoning: false, Vl: true},
		"kmodel":        {Ctx: 1_000_000, Reasoning: false, Vl: true},
		"gmodel":        {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"gfmodel":       {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"dmodel":        {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"dfmodel":       {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"mmodel":        {Ctx: 1_000_000, Reasoning: false, Vl: true},
	},
	"qodercn": {
		"auto":          {Ctx: 200_000, Reasoning: true, Vl: true},
		"qmodel_38max":  {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"qfmodel":       {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"qmodel_latest": {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"qmodel":        {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"q37fmodel":     {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"dmodel":        {Ctx: 1_000_000, Reasoning: true, Vl: true},
		// ⚠️ CN 的 is_reasoning 为 false（国际版为 true）。
		"dfmodel":   {Ctx: 1_000_000, Reasoning: false, Vl: true},
		"gmodel":    {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"gfmodel":   {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"gm51model": {Ctx: 1_000_000, Reasoning: true, Vl: true},
		"kmodel_latest": {Ctx: 1_000_000, Reasoning: false, Vl: true},
		"kmodel":    {Ctx: 1_000_000, Reasoning: true, Vl: true},
		// ⚠️ CN mmodel 是 MiniMax-M2.7（intl 是 M3）且 is_vl=false。
		"mmodel": {Ctx: 200_000, Reasoning: false, Vl: false},
	},
}

// qoderModelMetaFor looks up the meta for one model; unknown ids fall back to
// the ref defaults (200K window, no thinking, images on).
func qoderModelMetaFor(provider, id string) qoderModelMeta {
	if table, ok := qoderModelMetas[provider]; ok {
		if meta, ok := table[id]; ok {
			return meta
		}
	}
	return qoderModelMeta{Ctx: 200_000, Reasoning: false, Vl: true}
}

// qoderRandomID builds a UUID-v4-shaped id for request_id/session_id.
func qoderRandomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d-%d", nowMillis(), randIntn(1<<30))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
