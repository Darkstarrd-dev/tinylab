package jethub

// ZCode 请求构造：进站（OpenAI chat-completions 家族或 Anthropic Messages）→
// 出站 Anthropic Messages（`/api/v1/zcode-plan/anthropic/v1/messages`）。
//
// 与 minimax 的差异（ref src/zcode-anthropic.ts + zcode-identity.ts 实测）：
//  1. `system` 必须是**块数组**且前两块是官方身份块（缺 → 3012）；
//  2. 首轮 user 消息的 content 数组最前面必须插 `<system-reminder>` 日期块；
//  3. 思考档位只发 `output_config.effort`（**不是** reasoning_effort，也不发
//     thinking 对象），且只在模型声明的档位内；
//  4. 不发 `tool_choice`（ref 从不发）；tools 最后一个打 prompt-cache 断点；
//  5. **Anthropic 进站也要改写 body**（身份块 + 日期块是准入硬需求）——
//     与 minimax 的"原生透传"不同，这里不存在纯透传路径。
//
// 消息/工具的形状转换复用 minimax_convert.go 的共享实现（同一套 Anthropic
// 协议事实，且那边的孤儿工具块剔除比 ref 更严 —— Anthropic 会硬拒孤儿块）。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// zcodeDefaultMaxTokens is the wire default when the client sends none
// (ref zcode-adapter.ts:715 — 注意不是目录里的 128000，是 8192).
const zcodeDefaultMaxTokens = 8192

// zcodeAugment implements RequestAugmenterFunc for the zcode provider: replace
// the whole header family with the official one, then rewrite the body.
func (m *Manager) zcodeAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	cred, err := m.zcodeCredentialFor(keyID)
	if err != nil {
		return nil, err
	}
	for k, v := range zcodeHeaders(cred, true, nil) {
		r.Header.Set(k, v)
	}
	return zcodeBuildRequest(minimaxIsAnthropicEntry(clientEntryPathOf(r)), body, upstreamModel, time.Now())
}

// zcodeBuildRequest rewrites the client body for the zcode inference endpoint.
// anthropicEntry = the client already speaks Anthropic Messages (still rewritten:
// the identity/date blocks are the admission gate, not an optional extra).
func zcodeBuildRequest(anthropicEntry bool, body []byte, upstreamModel string, now time.Time) ([]byte, error) {
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("jethub: zcode body not JSON: %w", err)
	}
	if parsed == nil {
		return nil, fmt.Errorf("jethub: zcode body is not an object")
	}
	model := upstreamModel
	if model == "" {
		model, _ = parsed["model"].(string)
	}
	if model == "" {
		return nil, fmt.Errorf("jethub: zcode 请求缺少 model")
	}

	out := map[string]any{"model": model, "stream": true}

	// max_tokens：Anthropic 必填。缺省 8192（ref 口径）。
	maxTokens := zcodeDefaultMaxTokens
	if v, ok := minimaxPositiveInt(parsed["max_tokens"]); ok {
		maxTokens = v
	} else if v, ok := minimaxPositiveInt(parsed["max_completion_tokens"]); ok {
		maxTokens = v
	}
	out["max_tokens"] = maxTokens
	if v, ok := parsed["temperature"].(float64); ok {
		out["temperature"] = v
	}

	var callerSystem string
	var messages []any
	if anthropicEntry {
		callerSystem = zcodeSystemTextOf(parsed["system"])
		if stop, ok := parsed["stop_sequences"].([]any); ok && len(stop) > 0 {
			out["stop_sequences"] = stop
		} else if stop := minimaxStopSequences(parsed["stop"]); len(stop) > 0 {
			out["stop_sequences"] = stop
		}
		list, _ := parsed["messages"].([]any)
		if len(list) == 0 {
			return nil, fmt.Errorf("jethub: zcode 请求没有可转换的消息")
		}
		messages = list
		if tools, ok := parsed["tools"].([]any); ok && len(tools) > 0 {
			out["tools"] = zcodeWithToolCacheBreakpoint(tools)
		}
	} else {
		callerSystem = minimaxSystemText(parsed["messages"])
		if stop := minimaxStopSequences(parsed["stop"]); len(stop) > 0 {
			out["stop_sequences"] = stop
		}
		converted, err := minimaxConvertMessages(parsed["messages"])
		if err != nil {
			return nil, err
		}
		if len(converted) == 0 {
			return nil, fmt.Errorf("jethub: zcode 请求没有可转换的消息")
		}
		messages = converted
		if tools := minimaxConvertTools(parsed["tools"]); len(tools) > 0 {
			out["tools"] = zcodeWithToolCacheBreakpoint(tools)
		}
		// ⚠️ 不发 tool_choice（ref 从不发；Anthropic 的 auto/any 语义与 OpenAI
		// 不完全对齐，上游实测只认工具表本身）。
	}

	out["system"] = zcodeSystemBlocks(callerSystem, zcodeCwd(), model)
	out["messages"] = zcodeWithContextPrefix(messages, now)

	// 思考档位：只在模型声明的档位内下发 `output_config.effort`
	// （ref zcode-adapter.ts:750-757；未知档位/未声明模型一律丢弃 —— 下发未知
	// 档位可能被上游拒，而档位只是锦上添花）。
	if effort := zcodeRequestedEffort(parsed, anthropicEntry); zcodeModelDeclaresEffort(model, effort) {
		out["output_config"] = map[string]any{"effort": effort}
	}

	encoded, err := json.Marshal(out)
	if err != nil {
		return nil, fmt.Errorf("jethub: zcode body marshal: %w", err)
	}
	return encoded, nil
}

// zcodeRequestedEffort extracts the requested reasoning level from either wire
// shape: OpenAI `reasoning_effort` / `thinking.effort`, or Anthropic
// `output_config.effort` / `thinking.effort`.
func zcodeRequestedEffort(parsed map[string]any, anthropicEntry bool) string {
	if v, ok := parsed["reasoning_effort"].(string); ok && v != "" {
		return strings.ToLower(strings.TrimSpace(v))
	}
	if cfg, ok := parsed["output_config"].(map[string]any); ok {
		if v, ok := cfg["effort"].(string); ok && v != "" {
			return strings.ToLower(strings.TrimSpace(v))
		}
	}
	if th, ok := parsed["thinking"].(map[string]any); ok {
		if v, ok := th["effort"].(string); ok && v != "" {
			return strings.ToLower(strings.TrimSpace(v))
		}
	}
	_ = anthropicEntry
	return ""
}

// zcodeSystemTextOf flattens an Anthropic `system` value (string or block
// array) into plain text for the caller-system block.
func zcodeSystemTextOf(raw any) string {
	switch t := raw.(type) {
	case string:
		return t
	case []any:
		var sb strings.Builder
		for _, item := range t {
			block, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := block["text"].(string); ok && text != "" {
				if sb.Len() > 0 {
					sb.WriteString("\n\n")
				}
				sb.WriteString(text)
			}
		}
		return sb.String()
	}
	return ""
}

// zcodeWithToolCacheBreakpoint copies the tools and puts a single
// prompt-caching breakpoint on the LAST tool (ref withToolCacheBreakpoint:
// Anthropic's cache is prefix-based, so one trailing breakpoint covers
// "system + all tools" — and the 4-breakpoint budget stays available).
func zcodeWithToolCacheBreakpoint(tools []any) []any {
	out := make([]any, len(tools))
	copy(out, tools)
	last, ok := out[len(out)-1].(map[string]any)
	if !ok {
		return out
	}
	clone := make(map[string]any, len(last)+1)
	for k, v := range last {
		clone[k] = v
	}
	clone["cache_control"] = map[string]any{"type": "ephemeral"}
	out[len(out)-1] = clone
	return out
}

// zcodeCwd is the working directory reported in the environment block
// (ref uses process.cwd(); 官方声明 cwd is never "unknown" in real traffic).
func zcodeCwd() string {
	wd, err := os.Getwd()
	if err != nil || strings.TrimSpace(wd) == "" {
		return "."
	}
	return wd
}
