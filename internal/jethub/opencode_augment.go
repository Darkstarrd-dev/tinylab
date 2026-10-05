package jethub

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// opencodeAugment implements the provider augment hook (ref
// opencode-adapter.ts streamVia):
//
//   - identity headers REPLACE the client header set (the official CLI sends
//     only its own headers; a client-supplied Authorization must never leak);
//   - Authorization: Bearer <api_key> (`public` for the anonymous channel);
//   - the body is shaped for the free-lane gate: stream:true + `bash`/`read`
//     tools (injected when missing; `tool_choice:"none"` only when the caller
//     had no tools at all — overriding a caller's tool_choice would silently
//     disable their tool calls).
func (m *Manager) opencodeAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	cred, accountID, err := m.opencodeCredentialFor(keyID)
	if err != nil {
		return nil, err
	}
	// Fingerprint identity: the anonymous channel's key is the same literal for
	// every entry, so it uses the account id instead (ref listIdentitySlots).
	identity := cred.APIKey
	if isAnonymousOpencodeKey(cred.APIKey) {
		identity = accountID
	}
	// ⚠️ **代次以账号条目为权威**，凭据里的 `fingerprint` 只作兜底
	// （ref 的接线约定：`max(本字段, 凭据内代次)` 重新派生，**不得**直接透传凭据里
	// 的 project id）—— 否则用户点了「轮换指纹」后代次涨了、project id 却纹丝不动，
	// 而且不报错，是最难排查的一类静默失效。
	generation := m.opencodeFingerprintGeneration(accountID, cred)
	projectID := deriveOpencodeProjectID(identity, generation)
	shaped, err := opencodeShapeBody(body)
	if err != nil {
		return nil, err
	}
	for k := range r.Header {
		r.Header.Del(k)
	}
	for k, v := range opencodeHeaders(projectID, opencodeSessionIDFor(keyID), newOpencodeRequestID()) {
		r.Header.Set(k, v)
	}
	r.Header.Set("Authorization", "Bearer "+cred.APIKey)
	r.Header.Set("Content-Type", "application/json")
	return shaped, nil
}

// opencodeShapeBody enforces the free-lane shape gate (ref
// opencode-messages.ts ensureFreeLaneShape + buildOpencodePayload):
// `stream: true` and the `bash`/`read` gate tools. Returns the original slice
// when nothing changes (byte-for-byte passthrough for already-shaped bodies).
func opencodeShapeBody(body []byte) ([]byte, error) {
	if len(body) == 0 {
		return body, nil
	}
	var obj map[string]any
	if err := json.Unmarshal(body, &obj); err != nil {
		return nil, fmt.Errorf("jethub: opencode 请求体不是 JSON: %w", err)
	}
	if _, ok := obj["messages"]; !ok {
		// Not a chat body (shouldn't happen for this provider): leave as-is.
		return body, nil
	}
	changed := false
	if v, _ := obj["stream"].(bool); !v {
		obj["stream"] = true
		changed = true
	}
	tools, _ := obj["tools"].([]any)
	names := map[string]bool{}
	for _, t := range tools {
		tm, ok := t.(map[string]any)
		if !ok {
			continue
		}
		fn, ok := tm["function"].(map[string]any)
		if !ok {
			continue
		}
		if n, ok := fn["name"].(string); ok {
			names[n] = true
		}
	}
	var missing []any
	for _, name := range opencodeGateTools {
		if !names[name] {
			missing = append(missing, opencodeGateTool(name))
		}
	}
	if len(missing) > 0 {
		obj["tools"] = append(tools, missing...)
		if len(tools) == 0 {
			// Only when the caller had NO tools: overriding an existing
			// tool_choice would disable their real tool calls.
			obj["tool_choice"] = "none"
		}
		changed = true
	}
	if !changed {
		return body, nil
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// opencodeGateTool is the stub tool the shape gate requires (description fixed
// by the reference; the model must not call it).
func opencodeGateTool(name string) map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        name,
			"description": "Reserved for the host runtime; do not call it.",
			"parameters":  map[string]any{"type": "object", "properties": map[string]any{}},
		},
	}
}

// opencodeInterceptResponse implements proxy.ResponseInterceptor for opencode:
//
//   - error responses are classified by BODY semantics first (quota errors
//     arrive as 401/403 too — judging by status would hide the only useful
//     action): free/go usage limits and 402 wallet exhaustion become a
//     BillingLockError (lock key+model, switch account — ref markLimited);
//     FreeTierError is a request-shape rejection (no retry can help) and
//     surfaces a precise message; everything else (429/401/403/5xx) is
//     restored and handed back to the proxy's standard classification;
//   - non-stream clients: the upstream only speaks SSE (stream:true is part of
//     the gate), so the stream is aggregated into one chat.completion object.
func (m *Manager) opencodeInterceptResponse(clientReq *http.Request, resp *http.Response, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
		retryAfterMs, hasRA := parseOpencodeRetryAfter(resp.Header.Get("Retry-After"))
		info := classifyOpencodeError(resp.StatusCode, string(raw), retryAfterMs, hasRA)
		switch info.kind {
		case opencodeErrFreeUsageLimit, opencodeErrGoUsageLimit, opencodeErrQuota:
			lockMs := opencodeRetryAfterMs(info.kind, retryAfterMs, hasRA, 1)
			return nil, 0, &upstreamerr.BillingLockError{
				Until:  time.Now().Add(time.Duration(lockMs) * time.Millisecond),
				Reason: fmt.Sprintf("opencode: %s — %s", info.kind, info.detail),
			}
		case opencodeErrFreeTier:
			return nil, 0, fmt.Errorf("opencode: 免费通道被上游拒绝（FreeTierError，请求形状门禁）：换 Key / 换出口都无效 — %s", info.detail)
		default:
			// rate_limit / auth / server / transport: restore the body and let
			// the proxy classify by status (429 has its own Retry-After path).
			resp.Body = io.NopCloser(bytes.NewReader(raw))
			return nil, 0, nil
		}
	}
	if isStream {
		// Standard OpenAI SSE: transparent passthrough.
		return nil, 0, nil
	}
	body, err := opencodeAggregateSSE(resp.Body, upstreamModel)
	if err != nil {
		return nil, 0, err
	}
	resp.Header.Set("Content-Type", "application/json; charset=utf-8")
	resp.Header.Del("Content-Length")
	resp.ContentLength = -1
	return bytes.NewReader(body), 0, nil
}

// opencodeAggregateSSE folds an OpenAI-style SSE stream into a single
// chat.completion JSON object (the non-stream path; upstream only streams).
// A non-SSE body (already JSON) is returned unchanged.
func opencodeAggregateSSE(src io.Reader, model string) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(src, 32<<20))
	if err != nil {
		return nil, err
	}
	if !bytes.Contains(raw, []byte("data:")) {
		return raw, nil
	}
	var content, reasoning strings.Builder
	toolCalls := map[int]map[string]any{}
	var toolOrder []int
	var finish any
	var usage map[string]any
	id := ""
	created := time.Now().Unix()

	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var frame map[string]any
		if json.Unmarshal([]byte(payload), &frame) != nil {
			continue
		}
		if v, ok := frame["id"].(string); ok && v != "" {
			id = v
		}
		if u, ok := frame["usage"].(map[string]any); ok && len(u) > 0 {
			usage = u
		}
		choices, _ := frame["choices"].([]any)
		if len(choices) == 0 {
			continue
		}
		choice, _ := choices[0].(map[string]any)
		if fr, ok := choice["finish_reason"].(string); ok && fr != "" {
			finish = fr
		}
		delta, _ := choice["delta"].(map[string]any)
		if s, ok := delta["content"].(string); ok {
			content.WriteString(s)
		}
		if s, ok := delta["reasoning_content"].(string); ok {
			reasoning.WriteString(s)
		}
		if tcs, ok := delta["tool_calls"].([]any); ok {
			for _, rawTC := range tcs {
				tc, ok := rawTC.(map[string]any)
				if !ok {
					continue
				}
				idx := len(toolOrder)
				if v, ok := tc["index"].(float64); ok {
					idx = int(v)
				}
				acc, ok := toolCalls[idx]
				if !ok {
					acc = map[string]any{"type": "function", "function": map[string]any{"name": "", "arguments": ""}}
					toolCalls[idx] = acc
					toolOrder = append(toolOrder, idx)
				}
				if s, ok := tc["id"].(string); ok && s != "" {
					acc["id"] = s
				}
				if s, ok := tc["type"].(string); ok && s != "" {
					acc["type"] = s
				}
				fn, _ := tc["function"].(map[string]any)
				accFn, _ := acc["function"].(map[string]any)
				if s, ok := fn["name"].(string); ok && s != "" {
					accFn["name"] = accFn["name"].(string) + s
				}
				if s, ok := fn["arguments"].(string); ok {
					accFn["arguments"] = accFn["arguments"].(string) + s
				}
			}
		}
	}
	if id == "" {
		id = "chatcmpl-opencode"
	}
	if finish == nil {
		finish = "stop"
	}
	message := map[string]any{"role": "assistant", "content": content.String()}
	if reasoning.Len() > 0 {
		message["reasoning_content"] = reasoning.String()
	}
	if len(toolOrder) > 0 {
		list := make([]any, 0, len(toolOrder))
		for _, idx := range toolOrder {
			list = append(list, toolCalls[idx])
		}
		message["tool_calls"] = list
	}
	out := map[string]any{
		"id":      id,
		"object":  "chat.completion",
		"created": created,
		"model":   model,
		"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}},
	}
	if usage != nil {
		out["usage"] = usage
	}
	return json.Marshal(out)
}
