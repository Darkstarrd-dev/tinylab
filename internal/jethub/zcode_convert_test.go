package jethub

// ZCode 请求构造与 augment 测试（Anthropic 协议桥 + 3012 身份块注入）。

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func newSeedZcodeManager(t *testing.T) *Manager {
	t.Helper()
	m := newTestManager(t).m
	id, ref := NewAccountID("zcode")
	if err := m.AddAccount(Account{ID: id, Provider: "zcode", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	cred := &ZcodeCredential{ZcodeJWT: "zcode-jwt-1", DeviceMid: "11111111-2222-4333-8444-555555555555", AppVersion: "3.14.9"}
	data, _ := json.Marshal(cred)
	if err := m.SetCredential("zcode", ref, data, 0, false); err != nil {
		t.Fatal(err)
	}
	return m
}

func firstZcodeAccount(t *testing.T, m *Manager) string {
	t.Helper()
	accounts := m.Accounts("zcode")
	if len(accounts) == 0 {
		t.Fatal("no seeded zcode account")
	}
	return accounts[0].ID
}

func decodeZcodeBody(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	return parsed
}

func TestZcodeBuildRequestOpenAIEntry(t *testing.T) {
	body := `{"model":"GLM-5.3","messages":[{"role":"system","content":"SYS-PROMPT"},` +
		`{"role":"user","content":"你好"}],` +
		`"max_tokens":123,"temperature":0.3,"stop":["END"],` +
		`"tools":[{"type":"function","function":{"name":"get_weather","description":"d",` +
		`"parameters":{"type":"object","properties":{"city":{"type":"string"}}}}},` +
		`{"type":"function","function":{"name":"second","parameters":{"type":"object"}}}],` +
		`"tool_choice":"auto","reasoning_effort":"high"}`
	out, err := zcodeBuildRequest(false, []byte(body), "GLM-5.3", fixedZcodeDate())
	if err != nil {
		t.Fatal(err)
	}
	parsed := decodeZcodeBody(t, out)
	if parsed["model"] != "GLM-5.3" || parsed["stream"] != true {
		t.Fatalf("model/stream wrong: %#v", parsed)
	}
	if parsed["max_tokens"] != float64(123) {
		t.Fatalf("max_tokens = %v", parsed["max_tokens"])
	}
	if parsed["temperature"] != 0.3 {
		t.Fatalf("temperature = %v", parsed["temperature"])
	}
	stops, _ := parsed["stop_sequences"].([]any)
	if len(stops) != 1 || stops[0] != "END" {
		t.Fatalf("stop_sequences = %#v", parsed["stop_sequences"])
	}
	if _, ok := parsed["tool_choice"]; ok {
		t.Fatal("zcode must never send tool_choice (ref 从不发)")
	}
	// system：4 块（cli/stable/env/caller），caller 在最后。
	system, _ := parsed["system"].([]any)
	if len(system) != 4 {
		t.Fatalf("system blocks = %d, want 4", len(system))
	}
	caller := system[3].(map[string]any)["text"].(string)
	if caller != "SYS-PROMPT" {
		t.Fatalf("caller system = %q", caller)
	}
	// 首轮 user 消息带日期块（数组插入，不是文本拼接）。
	messages, _ := parsed["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("messages = %d, want 1 (system 已提到顶层)", len(messages))
	}
	first := messages[0].(map[string]any)
	content, _ := first["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("first user content = %#v", first["content"])
	}
	if !strings.HasPrefix(content[0].(map[string]any)["text"].(string), "<system-reminder>") {
		t.Fatal("date block must be content[0]")
	}
	if content[1].(map[string]any)["text"] != "你好" {
		t.Fatalf("user text = %#v", content[1])
	}
	// tools：扁平 input_schema + 只有最后一个打断点。
	tools, _ := parsed["tools"].([]any)
	if len(tools) != 2 {
		t.Fatalf("tools = %d", len(tools))
	}
	firstTool := tools[0].(map[string]any)
	if _, hasFn := firstTool["function"]; hasFn {
		t.Fatal("tools must be flat (input_schema, not function.parameters)")
	}
	if firstTool["name"] != "get_weather" || firstTool["input_schema"] == nil {
		t.Fatalf("tool shape wrong: %#v", firstTool)
	}
	if _, hasCache := firstTool["cache_control"]; hasCache {
		t.Fatal("only the last tool may carry the cache breakpoint")
	}
	lastTool := tools[1].(map[string]any)
	if cc, ok := lastTool["cache_control"].(map[string]any); !ok || cc["type"] != "ephemeral" {
		t.Fatalf("last tool must carry the breakpoint: %#v", lastTool)
	}
	// 档位：declared → output_config.effort（不是 reasoning_effort）。
	cfg, ok := parsed["output_config"].(map[string]any)
	if !ok || cfg["effort"] != "high" {
		t.Fatalf("output_config = %#v", parsed["output_config"])
	}
	if _, ok := parsed["reasoning_effort"]; ok {
		t.Fatal("reasoning_effort must never be forwarded (协议名是 output_config.effort)")
	}
}

func TestZcodeBuildRequestDefaultsAndGates(t *testing.T) {
	// 缺 max_tokens → 8192（ref 口径，不是目录里的 128000）。
	out, err := zcodeBuildRequest(false, []byte(`{"model":"GLM-5.3","messages":[{"role":"user","content":"hi"}]}`), "GLM-5.3", fixedZcodeDate())
	if err != nil {
		t.Fatal(err)
	}
	if got := decodeZcodeBody(t, out)["max_tokens"]; got != float64(zcodeDefaultMaxTokens) {
		t.Fatalf("default max_tokens = %v, want %d", got, zcodeDefaultMaxTokens)
	}
	// 未声明的档位（xhigh）→ 不下发。
	out, err = zcodeBuildRequest(false, []byte(`{"model":"GLM-5.3","messages":[{"role":"user","content":"hi"}],"reasoning_effort":"xhigh"}`), "GLM-5.3", fixedZcodeDate())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := decodeZcodeBody(t, out)["output_config"]; ok {
		t.Fatal("undeclared effort must be dropped")
	}
	// 目录外的模型 → 不下发档位，但请求仍然成立。
	out, err = zcodeBuildRequest(false, []byte(`{"model":"GLM-5-Turbo","messages":[{"role":"user","content":"hi"}],"reasoning_effort":"low"}`), "GLM-5-Turbo", fixedZcodeDate())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := decodeZcodeBody(t, out)["output_config"]; ok {
		t.Fatal("models outside the catalog must not receive output_config")
	}
}

func TestZcodeBuildRequestAnthropicEntryStillRewritten(t *testing.T) {
	// 进站就是 Anthropic Messages：仍然必须重写 body —— 身份块 + 日期块是准入
	// 硬需求（与 minimax 的"原生透传"不同）。
	body := `{"model":"GLM-5.3-Flash","max_tokens":64,"stream":false,` +
		`"system":[{"type":"text","text":"CALLER-A"},{"type":"text","text":"CALLER-B"}],` +
		`"messages":[{"role":"user","content":[{"type":"text","text":"看图"}]}],` +
		`"output_config":{"effort":"max"},` +
		`"tools":[{"name":"t","input_schema":{"type":"object"}}]}`
	out, err := zcodeBuildRequest(true, []byte(body), "GLM-5.3-Flash", fixedZcodeDate())
	if err != nil {
		t.Fatal(err)
	}
	parsed := decodeZcodeBody(t, out)
	if parsed["stream"] != true {
		t.Fatal("upstream only implements the streaming branch — stream must be forced true")
	}
	system, _ := parsed["system"].([]any)
	if len(system) != 4 {
		t.Fatalf("system blocks = %d, want 4", len(system))
	}
	if got := system[3].(map[string]any)["text"]; got != "CALLER-A\n\nCALLER-B" {
		t.Fatalf("caller system flattening wrong: %q", got)
	}
	messages, _ := parsed["messages"].([]any)
	content, _ := messages[0].(map[string]any)["content"].([]any)
	if len(content) != 2 || !strings.HasPrefix(content[0].(map[string]any)["text"].(string), "<system-reminder>") {
		t.Fatalf("date block must be prepended on the Anthropic entry too: %#v", content)
	}
	if cfg, _ := parsed["output_config"].(map[string]any); cfg["effort"] != "max" {
		t.Fatalf("output_config = %#v", parsed["output_config"])
	}
	tools, _ := parsed["tools"].([]any)
	if _, ok := tools[0].(map[string]any)["cache_control"]; !ok {
		t.Fatal("Anthropic-entry tools must get the breakpoint too")
	}
}

func TestZcodeBuildRequestRejectsGarbage(t *testing.T) {
	if _, err := zcodeBuildRequest(false, []byte("not json"), "GLM-5.3", fixedZcodeDate()); err == nil {
		t.Fatal("non-JSON body must error")
	}
	if _, err := zcodeBuildRequest(false, []byte(`{"messages":[]}`), "", fixedZcodeDate()); err == nil {
		t.Fatal("missing model must error")
	}
	if _, err := zcodeBuildRequest(false, []byte(`{"model":"GLM-5.3","messages":[]}`), "GLM-5.3", fixedZcodeDate()); err == nil {
		t.Fatal("empty message list must error")
	}
}

func TestZcodeWithToolCacheBreakpointDoesNotMutate(t *testing.T) {
	original := []any{map[string]any{"name": "a"}, map[string]any{"name": "b"}}
	out := zcodeWithToolCacheBreakpoint(original)
	if _, ok := original[1].(map[string]any)["cache_control"]; ok {
		t.Fatal("input tools must not be mutated")
	}
	if _, ok := out[1].(map[string]any)["cache_control"]; !ok {
		t.Fatal("last tool must carry the breakpoint")
	}
}

func TestZcodeAugmentReplacesHeadersAndBody(t *testing.T) {
	m := newSeedZcodeManager(t)
	accountID := firstZcodeAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", nil)
	req.Header.Set("Authorization", "Bearer client-key")
	req.Header.Set("X-Junk", "1")
	body := `{"model":"GLM-5.3","messages":[{"role":"user","content":"hi"}]}`
	out, err := m.zcodeAugment(req, []byte(body), "jethub-zcode", accountID, "GLM-5.3")
	if err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("X-Junk") != "" {
		t.Fatal("client headers must be replaced wholesale")
	}
	if got := req.Header.Get("Authorization"); got != "Bearer zcode-jwt-1" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := req.Header.Get("X-Device-Mid"); got != "11111111-2222-4333-8444-555555555555" {
		t.Fatalf("X-Device-Mid = %q", got)
	}
	if got := req.Header.Get("anthropic-version"); got != "2023-06-01" {
		t.Fatalf("anthropic-version = %q", got)
	}
	parsed := decodeZcodeBody(t, out)
	if _, ok := parsed["system"].([]any); !ok {
		t.Fatal("augment must inject the identity block array")
	}
}

func TestZcodeAugmentFailsWithoutCredential(t *testing.T) {
	m := newSeedZcodeManager(t)
	req, _ := http.NewRequest(http.MethodPost, "https://zcode.z.ai/x", nil)
	if _, err := m.zcodeAugment(req, []byte(`{"model":"GLM-5.3","messages":[{"role":"user","content":"hi"}]}`), "jethub-zcode", "ZCODE_ACCOUNT_MISSING", "GLM-5.3"); err == nil {
		t.Fatal("missing account must error")
	}
}

func TestZcodeCustomizeUsesDeclaredInferURL(t *testing.T) {
	m := newSeedZcodeManager(t)
	RegisterDefaultProducts(NewBridge(m, newFakeRegistry()))
	m.SetAugmenter("zcode", m.zcodeAugment)
	accountID := firstZcodeAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://zcode.z.ai/v1/chat/completions", nil)
	body := `{"model":"GLM-5.3","messages":[{"role":"user","content":"hi"}]}`
	outURL, _, err := m.Customize(req, []byte(body), "jethub-zcode", accountID, "GLM-5.3")
	if err != nil {
		t.Fatal(err)
	}
	if outURL != zcodePlanMessagesURL {
		t.Fatalf("customize URL = %q, want %q", outURL, zcodePlanMessagesURL)
	}
}

func TestZcodeEntryPathDetection(t *testing.T) {
	if !minimaxIsAnthropicEntry("/v1/messages") || !minimaxIsAnthropicEntry("/v1/messages/") {
		t.Fatal("Anthropic entry detection broken")
	}
	if minimaxIsAnthropicEntry("/v1/chat/completions") {
		t.Fatal("chat-completions must not be treated as the Anthropic entry")
	}
}

func TestZcodeDateBlockUsesLocalTime(t *testing.T) {
	now := time.Date(2026, 1, 5, 23, 30, 0, 0, time.Local)
	block := zcodeContextPrefixBlock(now)
	text := block["text"].(string)
	if !strings.Contains(text, "Today's date is 2026-01-05.") {
		t.Fatalf("local date wrong: %q", text)
	}
}
