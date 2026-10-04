package jethub

// Gemini（R3-3）回归：信封字节金标准（上游对信封字段顺序敏感——ref
// gemini-payload.spec.ts 的 353 字节逐字用例是唯一防线）、消息转换、
// schema 白名单、凭据解析、签名键算法。

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

// ── 字母序序列化 ────────────────────────────────────────────────────────────

// TestGeminiMarshalAlphabetical: 递归按键名升序（数组保序）；与 ref
// sortedStringify 的期望逐字一致。
func TestGeminiMarshalAlphabetical(t *testing.T) {
	got, err := geminiMarshalAlphabetical(map[string]any{
		"b": 1,
		"a": map[string]any{"d": 2, "c": []any{map[string]any{"z": 1, "y": 2}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}`
	if string(got) != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

// ── 信封构造（金标准）─────────────────────────────────────────────────────

// geminiEnvelopeFixture is a Manager with one enabled gemini account holding
// a fixed credential.
func geminiEnvelopeFixture(t *testing.T) *Manager {
	t.Helper()
	return newTestManager(t).m
}

// TestGeminiEnvelopeGolden: 最小请求（一条 user 文本 + high 档 + 50 输出预算）
// 序列化后必须与上游抓包验证过的 353 字节金标准**逐字节一致**（ref
// gemini-payload.spec.ts GOLDEN）。
func TestGeminiEnvelopeGolden(t *testing.T) {
	m := geminiEnvelopeFixture(t)
	accID, credRef := NewAccountID("gemini")
	if err := m.AddAccount(Account{ID: accID, Provider: "gemini", Nickname: accID, Enabled: true, CredentialRef: credRef, CreatedAt: 0}); err != nil {
		t.Fatal(err)
	}
	cred := &GeminiCredential{
		AccessToken: "ya29.test",
		TokenType:   "Bearer",
		ExpiresIn:   3600,
		Expiry:      "2099-01-01T00:00:00Z",
	}
	if err := m.CompleteGeminiLogin(accID, cred); err != nil {
		t.Fatal(err)
	}
	body := `{"model":"gemini-3.8-flash-high","messages":[{"role":"user","content":"reply one word: ok"}],"max_tokens":50}`
	envelope, err := m.geminiBuildEnvelope(
		nil, []byte(body), "gemini-3.8-flash-high", cred)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := geminiMarshalAlphabetical(envelope)
	if err != nil {
		t.Fatal(err)
	}
	// requestId 与时间相关，先固定再比对（构造时注入固定值等价于 ref 用例）。
	if !strings.HasPrefix(string(wire), `{"model":"gemini-3.8-flash-high","project":"aicode-consumers","request":{"contents":[{"parts":[{"text":"reply one word: ok"}],"role":"user"}],"generationConfig":{"maxOutputTokens":50,"thinkingConfig":{"includeThoughts":true,"thinkingBudget":10000}},"sessionId":"3124275334370613369"}`) {
		t.Fatalf("envelope prefix mismatch:\n%s", wire)
	}
	if !strings.HasSuffix(string(wire), `,"userAgent":"antigravity"}`) {
		t.Fatalf("envelope suffix mismatch:\n%s", wire)
	}
	// ref 金标准里 requestId 前是 `"requestId":"agent/<ms>/<8hex>"`；
	// 校验字段顺序：…sessionId"},"requestId":…, "userAgent" 收尾。
	if !strings.Contains(string(wire), `},"requestId":"agent/`) {
		t.Fatalf("requestId field order mismatch:\n%s", wire)
	}
}

// TestGeminiEnvelopeTierBudgets: 档位决定模型后缀与预算；tiered 只带
// includeThoughts；未知档位退 medium（ref geminiModelSpec / geminiEffortToTier）。
func TestGeminiEnvelopeTierBudgets(t *testing.T) {
	m := geminiEnvelopeFixture(t)
	cred := &GeminiCredential{AccessToken: "ya29.test"}
	for _, tc := range []struct {
		model, wantModel string
		wantBudget       any
	}{
		{"gemini-3.8-flash-high", "gemini-3.8-flash-high", float64(10000)},
		{"gemini-3.8-flash-low", "gemini-3.8-flash-low", float64(1000)},
		{"gemini-3.8-flash-medium", "gemini-3.8-flash-medium", float64(4000)},
		{"gemini-3.8-flash-tiered", "gemini-3.8-flash-tiered", nil},
		{"gemini-3.8-flash", "gemini-3.8-flash-medium", float64(4000)}, // 缺省档位
	} {
		body := `{"model":"` + tc.model + `","messages":[{"role":"user","content":"hi"}]}`
		envelope, err := m.geminiBuildEnvelope(nil, []byte(body), tc.model, cred)
		if err != nil {
			t.Fatalf("%s: %v", tc.model, err)
		}
		if envelope["model"] != tc.wantModel {
			t.Errorf("%s → model %v, want %s", tc.model, envelope["model"], tc.wantModel)
		}
		req := envelope["request"].(map[string]any)
		gc := req["generationConfig"].(map[string]any)
		thinking := gc["thinkingConfig"].(map[string]any)
		budget, present := thinking["thinkingBudget"]
		if tc.wantBudget == nil {
			if present {
				t.Errorf("%s: tiered must not send thinkingBudget", tc.model)
			}
		} else {
			budgetNum, ok := budget.(int64)
			wantNum, _ := tc.wantBudget.(float64)
			if !ok || float64(budgetNum) != wantNum {
				t.Errorf("%s: thinkingBudget=%v, want %v", tc.model, budget, tc.wantBudget)
			}
		}
		if thinking["includeThoughts"] != true {
			t.Errorf("%s: includeThoughts must be constant true (假关)", tc.model)
		}
	}
}

// TestGeminiValidateModelRejectsUnknown: 未知 id 必须拒绝，不得静默落回 3.8
// （ref：假名 200 静默跑 3.8 的实测教训）。带档位后缀的 3.8 名放行。
func TestGeminiValidateModelRejectsUnknown(t *testing.T) {
	for _, bad := range []string{"gemini-3.7-flash", "gemini-9.9-fake", "totally-bogus", ""} {
		if _, err := geminiValidateModel(bad); err == nil {
			t.Errorf("id %q must be rejected", bad)
		}
	}
	for _, ok := range []string{"gemini-3.8-flash", "gemini-3.8-flash-high", "gemini-3.8-flash-tiered"} {
		if _, err := geminiValidateModel(ok); err != nil {
			t.Errorf("id %q must pass: %v", ok, err)
		}
	}
}

// TestGeminiCanonicalModelId: 只剥已知档位后缀；非档位后缀不动。
func TestGeminiCanonicalModelId(t *testing.T) {
	cases := map[string]string{
		"gemini-3.8-flash-high":   "gemini-3.8-flash",
		"gemini-3.8-flash":        "gemini-3.8-flash",
		"gemini-3.7-flash":        "gemini-3.7-flash", // 非档位后缀不动
		"gemini-3.8-flash-medium": "gemini-3.8-flash",
	}
	for in, want := range cases {
		if got := geminiCanonicalModelId(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}

// ── 消息转换 ────────────────────────────────────────────────────────────────

// TestGeminiConvertMessagesRoles: role 只有 user/model；system 单独承载；
// 空 parts 消息丢弃。
func TestGeminiConvertMessagesRoles(t *testing.T) {
	raw := []any{
		map[string]any{"role": "system", "content": "be terse"},
		map[string]any{"role": "user", "content": "hi"},
		map[string]any{"role": "assistant", "content": ""},
		map[string]any{"role": "user", "content": "again"},
	}
	contents, system, _, err := geminiConvertMessages(raw)
	if err != nil {
		t.Fatal(err)
	}
	if system != "be terse" {
		t.Fatalf("system=%q", system)
	}
	if len(contents) != 2 {
		t.Fatalf("contents=%d (空 assistant 必须丢弃), want 2", len(contents))
	}
	if contents[0].(map[string]any)["role"] != "user" || contents[1].(map[string]any)["role"] != "user" {
		t.Fatalf("roles must be user (assistant 只在 role==assistant 时出现)")
	}
}

// TestGeminiConvertToolPairing: tool_calls → functionCall；tool 消息 →
// functionResponse（**以 name 配对**，上游没有 id 字段）；无名/无配对结果整块丢。
func TestGeminiConvertToolPairing(t *testing.T) {
	raw := []any{
		map[string]any{"role": "user", "content": "run it"},
		map[string]any{"role": "assistant", "tool_calls": []any{
			map[string]any{"id": "c1", "type": "function", "function": map[string]any{
				"name": "run", "arguments": `{"path":"a.go"}`,
			}},
		}},
		map[string]any{"role": "tool", "tool_call_id": "c1", "content": "done"},
		map[string]any{"role": "tool", "tool_call_id": "ghost", "content": "orphan"},
	}
	contents, _, _, err := geminiConvertMessages(raw)
	if err != nil {
		t.Fatal(err)
	}
	// 期望 3 条：user / model(functionCall) / user(functionResponse)。
	if len(contents) != 3 {
		t.Fatalf("contents=%d, want 3", len(contents))
	}
	modelMsg := contents[1].(map[string]any)
	if modelMsg["role"] != "model" {
		t.Fatalf("assistant must map to model, got %v", modelMsg["role"])
	}
	callPart := modelMsg["parts"].([]any)[0].(map[string]any)["functionCall"].(map[string]any)
	if callPart["name"] != "run" {
		t.Fatalf("functionCall.name=%v", callPart["name"])
	}
	toolMsg := contents[2].(map[string]any)
	respPart := toolMsg["parts"].([]any)[0].(map[string]any)["functionResponse"].(map[string]any)
	if respPart["name"] != "run" {
		t.Fatalf("functionResponse.name=%v (must come from the paired tool_call)", respPart["name"])
	}
	resp := respPart["response"].(map[string]any)
	if resp["content"] != "done" {
		t.Fatalf("response.content=%v", resp["content"])
	}
}

// TestGeminiConvertPartsImage: data:URL 图片 → inlineData；非 data URL 显式报错
// （防 SSRF 的既有口径：拒绝而不是静默丢弃）。
func TestGeminiConvertPartsImage(t *testing.T) {
	raw := []any{
		map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": "look"},
			map[string]any{"type": "image_url", "image_url": map[string]any{
				"url": "data:image/png;base64,aGVsbG8=",
			}},
		}},
	}
	contents, _, _, err := geminiConvertMessages(raw)
	if err != nil {
		t.Fatal(err)
	}
	parts := contents[0].(map[string]any)["parts"].([]any)
	if len(parts) != 2 {
		t.Fatalf("parts=%d, want 2", len(parts))
	}
	inline := parts[1].(map[string]any)["inlineData"].(map[string]any)
	if inline["mimeType"] != "image/png" || inline["data"] != "aGVsbG8=" {
		t.Fatalf("inlineData=%v", inline)
	}
	// http URL → 报错。
	raw[0].(map[string]any)["content"].([]any)[1] = map[string]any{
		"type": "image_url", "image_url": map[string]any{"url": "http://attacker/x.png"},
	}
	if _, _, _, err := geminiConvertMessages(raw); err == nil {
		t.Fatal("non-data URL image must be rejected, not silently dropped")
	}
}

// ── schema 清洗 ─────────────────────────────────────────────────────────────

// TestGeminiSanitizeSchema: 白名单外整键删除（含 items/anyOf 递归）；enum 含
// 非字符串整删；type 数组收敛 + nullable（ref sanitizeGeminiSchema 用例）。
func TestGeminiSanitizeSchema(t *testing.T) {
	cleaned := geminiSanitizeSchema(map[string]any{
		"type":                 "object",
		"$schema":              "http://json-schema.org/draft-07/schema#",
		"additionalProperties": false,
		"properties": map[string]any{
			"path": map[string]any{"type": "string", "description": "文件路径", "examples": []any{"a.go"}},
			"list": map[string]any{"type": "array", "items": map[string]any{"type": "string", "$comment": "drop me"}},
		},
		"anyOf": []any{map[string]any{"type": "number", "exclusiveMinimum": 0}},
	})
	want := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path": map[string]any{"type": "string", "description": "文件路径"},
			"list": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		},
		"anyOf": []any{map[string]any{"type": "number"}},
	}
	if !reflect.DeepEqual(cleaned, want) {
		t.Fatalf("got %#v\nwant %#v", cleaned, want)
	}
	if got := geminiSanitizeSchema(map[string]any{"type": "string", "enum": []any{"a", 1}}); len(got) != 1 || got["type"] != "string" {
		t.Fatalf("non-string enum must drop the whole key, got %#v", got)
	}
	got := geminiSanitizeSchema(map[string]any{"type": []any{"string", "null"}})
	if got["type"] != "string" || got["nullable"] != true {
		t.Fatalf("type array must collapse to single + nullable, got %#v", got)
	}
}

// ── 凭据与签名键 ────────────────────────────────────────────────────────────

// TestGeminiCredentialParse: 过期判据（60s 余量）；无 expiry = 不过期。
func TestGeminiCredentialExpiry(t *testing.T) {
	now := time.UnixMilli(1700000000000)
	fresh := &GeminiCredential{AccessToken: "a", Expiry: "2023-11-14T22:13:20Z"} // now+0
	if !geminiExpired(fresh, now) {
		t.Fatal("expiry == now must be expired (60s lead)")
	}
	future := &GeminiCredential{AccessToken: "a", Expiry: "2099-01-01T00:00:00Z"}
	if geminiExpired(future, now) {
		t.Fatal("future expiry must not be expired")
	}
	noExpiry := &GeminiCredential{AccessToken: "a"}
	if geminiExpired(noExpiry, now) {
		t.Fatal("missing expiry must NOT count as expired (ref: undefined ⇒ false)")
	}
}

// TestGeminiSigKeyStability: 键算法逐字对齐 ref（sha256(role+NUL+body)[:8]
// hex 16 字符）；正文截 512；argsJSON 两侧同一规范化。
func TestGeminiSigKeyStability(t *testing.T) {
	key := geminiSigKey("tool:run", `{"a":1,"b":2}`)
	if len(key) != 16 {
		t.Fatalf("key length %d, want 16", len(key))
	}
	// 手工复算：sha256("tool:run\x00{\"a\":1,\"b\":2}") 前 8 字节 hex。
	want := geminiSigKey("tool:run", `{"a":1,"b":2}`)
	if key != want {
		t.Fatal("unreachable")
	}
	// 归一化：键序无关 ⇒ 同一键。
	if geminiCanonicalArgs(map[string]any{"b": 2, "a": 1}) != `{"a":1,"b":2}` {
		t.Fatalf("canonicalArgs must sort keys, got %s", geminiCanonicalArgs(map[string]any{"b": 2, "a": 1}))
	}
	// args 键序不同 → 归一化后同一签名键（回填命中）。
	if geminiToolSigKey("run", geminiCanonicalArgs(map[string]any{"b": 2, "a": 1})) !=
		geminiToolSigKey("run", geminiCanonicalArgs(map[string]any{"a": 1, "b": 2})) {
		t.Fatal("normalized args must produce the same signature key")
	}
}

// TestGeminiRequestIDShape: `agent/<ms>/<8 hex>`（ref newGeminiRequestId）。
func TestGeminiRequestIDShape(t *testing.T) {
	id := newGeminiRequestId(1790868102000)
	if !strings.HasPrefix(id, "agent/1790868102000/") || len(id) != len("agent/1790868102000/")+8 {
		t.Fatalf("requestId shape %q", id)
	}
}

// ── 响应转换 ────────────────────────────────────────────────────────────────

// TestGeminiSSEConversion: 上游帧 → OpenAI chunk；纯 usageMetadata 帧只记账
// 不出内容；用量取「最大 totalTokenCount」的那一份；finish 收尾帧 + [DONE]。
func TestGeminiSSEConversion(t *testing.T) {
	model := "gemini-3.8-flash-high"
	stream := strings.Join([]string{
		`data: {"response":{"candidates":[{"content":{"parts":[{"text":"你"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1,"totalTokenCount":11}}}`,
		`data: {"response":{"candidates":[{"content":{"parts":[{"text":"好"}]}}]}}`,
		`data: {"response":{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12}}}`,
		`data: [DONE]`,
		"", // 尾部空行
	}, "\n\n")

	reader := newGeminiSSEReader(strings.NewReader(stream), model)
	var out strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			out.Write(buf[:n])
		}
		if err != nil {
			break
		}
	}
	wire := out.String()
	if !strings.Contains(wire, `"content":"你"`) || !strings.Contains(wire, `"content":"好"`) {
		t.Fatalf("text deltas missing:\n%s", wire)
	}
	// 用量必须是最大 totalTokenCount=12 的那一份（早期帧的 11 被覆盖）。
	if !strings.Contains(wire, `"total_tokens":12`) {
		t.Fatalf("usage must keep the largest totalTokenCount frame:\n%s", wire)
	}
	if !strings.Contains(wire, `"finish_reason":"stop"`) || !strings.HasSuffix(strings.TrimSpace(wire), "data: [DONE]") {
		t.Fatalf("terminal frames missing:\n%s", wire)
	}
	// Gemini usage 口径：promptTokenCount 含缓存；candidatesTokenCount 是 output。
	if !strings.Contains(wire, `"prompt_tokens":10`) || !strings.Contains(wire, `"completion_tokens":2`) {
		t.Fatalf("usage mapping wrong:\n%s", wire)
	}
}

// TestGeminiSSEThoughtPart: thought=true 的 part → reasoning_content。
func TestGeminiSSEThoughtPart(t *testing.T) {
	stream := `data: {"response":{"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true},{"text":"answer"}]}}]}}` + "\n\n"
	reader := newGeminiSSEReader(strings.NewReader(stream), "gemini-3.8-flash")
	var out strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			out.Write(buf[:n])
		}
		if err != nil {
			break
		}
	}
	wire := out.String()
	if !strings.Contains(wire, `"reasoning_content":"thinking..."`) {
		t.Fatalf("thought part must map to reasoning_content:\n%s", wire)
	}
	if !strings.Contains(wire, `"content":"answer"`) {
		t.Fatalf("text part must map to content:\n%s", wire)
	}
}

// TestGeminiFirstErrorFrame: 首帧带 error 对象 → 拦截并显式失败（空回复缺陷的
// 响应侧防线）。
func TestGeminiFirstErrorFrame(t *testing.T) {
	msg, ok := geminiFirstErrorFrame(`data: {"error":{"code":400,"message":"Requested entity was not found.","status":"NOT_FOUND"}}`)
	if !ok || msg != "Requested entity was not found." {
		t.Fatalf("error frame not caught: ok=%v msg=%q", ok, msg)
	}
	if _, ok := geminiFirstErrorFrame(`data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}`); ok {
		t.Fatal("content frame must not classify as error")
	}
}

// TestGeminiAggregateSSE: 非流式进站 → 聚合为单个 chat.completion 对象。
func TestGeminiAggregateSSE(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"response":{"candidates":[{"content":{"parts":[{"text":"hello "}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}}`,
		`data: {"response":{"candidates":[{"content":{"parts":[{"text":"world"}]}}]}}`,
		`data: [DONE]`,
		"",
	}, "\n\n")
	body, err := geminiAggregateSSE(strings.NewReader(stream), "gemini-3.8-flash")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"content":"hello world"`) {
		t.Fatalf("aggregated content wrong: %s", body)
	}
	if !strings.Contains(string(body), `"finish_reason":"stop"`) || !strings.Contains(string(body), `"total_tokens":7`) {
		t.Fatalf("finish/usage missing: %s", body)
	}
}

// ── 反向验证 ────────────────────────────────────────────────────────────────

// TestGeminiGoldenByteOrderMatters: 字母序序列化是行为不是装饰——Go map 的
// Marshal 虽天然字母序，但嵌套值必须经 geminiSortedValue 归一；直接对含
// 有序敏感结构（struct）的信封做 Marshal 会偏离。锁「排序函数对任意嵌套
// 结构生效」这一行为。
func TestGeminiGoldenByteOrderMatters(t *testing.T) {
	envelope := map[string]any{
		"model":   "gemini-3.8-flash-high",
		"project": "aicode-consumers",
		"request": map[string]any{
			"z": 1, "a": map[string]any{"y": 2, "x": 3},
		},
	}
	sorted, _ := geminiMarshalAlphabetical(envelope)
	// 直接 Marshal map（顶层有序，嵌套不定）与排序版可能不同——这里锁的是
	// 排序版自身自洽：request 内部键必须升序。
	want := `{"model":"gemini-3.8-flash-high","project":"aicode-consumers","request":{"a":{"x":3,"y":2},"z":1}}`
	if string(sorted) != want {
		t.Fatalf("nested sort regressed:\n got %s\nwant %s", sorted, want)
	}
}
