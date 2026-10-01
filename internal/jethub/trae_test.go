package jethub

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// --- SOLO body 转换（OpenAI → SOLO 协议改写） ---

func TestTransformToSOLOBodyBasics(t *testing.T) {
	body, err := transformToSOLOBody(map[string]any{
		"model":    "glm-5.2__dev",
		"stream":   false,
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}, "solo_work_lite")
	if err != nil {
		t.Fatal(err)
	}
	if body["stream"] != true {
		t.Fatal("SOLO forces stream:true (upstream 500s without it)")
	}
	if body["function"] != "solo_work_lite" {
		t.Fatalf("channel → function wrong: %v", body["function"])
	}
	if body["config_name"] != "glm-5.2" || body["model"] != "glm-5.2" {
		t.Fatalf("config_name/model wrong: %v / %v", body["config_name"], body["model"])
	}
}

func TestTransformToSOLOBodyContentParts(t *testing.T) {
	body, _ := transformToSOLOBody(map[string]any{
		"model": "glm-5.2",
		"messages": []any{
			map[string]any{"role": "user", "content": "hi"},
			map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "x"}}},
		},
	}, "solo_work_lite")
	msgs := body["messages"].([]any)
	first := msgs[0].(map[string]any)
	content, ok := first["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("string content must become text-parts array: %v", first["content"])
	}
	part := content[0].(map[string]any)
	if part["type"] != "text" || part["text"] != "hi" {
		t.Fatalf("text part wrong: %v", part)
	}
	if _, isArr := msgs[1].(map[string]any)["content"].([]any); !isArr {
		t.Fatal("array content must pass through")
	}
}

// ⚠️ TRAE 实测坑（AGENTS.md 反复强调）：assistant content=null 的 tool_calls
// 消息绝不能丢——丢了模型就看不到自己调用过什么。
func TestTransformToSOLOBodyKeepsToolMessages(t *testing.T) {
	body, err := transformToSOLOBody(map[string]any{
		"model": "glm-5.2",
		"messages": []any{
			map[string]any{
				"role": "assistant", "content": nil,
				"tool_calls": []any{map[string]any{
					"id": "c1", "type": "function",
					"function": map[string]any{"name": "bash", "arguments": `{"cmd":"ls"}`},
				}},
			},
			map[string]any{"role": "tool", "content": "out", "tool_call_id": "c1"},
		},
		"tools": []any{map[string]any{
			"type": "function",
			"function": map[string]any{"name": "bash", "parameters": map[string]any{"type": "object"}},
		}},
	}, "solo_work_lite")
	if err != nil {
		t.Fatal(err)
	}
	msgs := body["messages"].([]any)
	assistant := msgs[0].(map[string]any)
	if _, has := assistant["content"]; !has {
		t.Fatal("assistant message must be kept even with null content")
	}
	tcs, ok := assistant["tool_calls"].([]any)
	if !ok || len(tcs) != 1 {
		t.Fatalf("tool_calls must survive: %v", assistant["tool_calls"])
	}
	tc := tcs[0].(map[string]any)
	if _, hasFn := tc["function"]; hasFn {
		t.Fatal("function must be renamed to function_call")
	}
	if fc := tc["function_call"].(map[string]any); fc["name"] != "bash" {
		t.Fatalf("function_call wrong: %v", fc)
	}
	tool := msgs[1].(map[string]any)
	if tool["tool_call_id"] != "c1" {
		t.Fatalf("tool_result tool_call_id lost: %v", tool)
	}
	params := body["tools"].([]any)[0].(map[string]any)["function"].(map[string]any)["parameters"]
	if s, isStr := params.(string); !isStr || !strings.Contains(s, `"type":"object"`) {
		t.Fatalf("parameters must be serialized: %v", params)
	}
}

func TestTransformToSOLOBodyToolChoice(t *testing.T) {
	body, _ := transformToSOLOBody(map[string]any{
		"model":       "glm-5.2",
		"tool_choice": "none",
		"tools":       []any{map[string]any{"type": "function", "function": map[string]any{"name": "x"}}},
	}, "solo_work_lite")
	if _, has := body["tool_choice"]; has {
		t.Fatal("tool_choice none must be deleted")
	}
	if _, has := body["tools"]; has {
		t.Fatal("tools must be suppressed with none")
	}
	body2, _ := transformToSOLOBody(map[string]any{
		"model":       "glm-5.2",
		"tool_choice": map[string]any{"type": "function", "function": map[string]any{"name": "bash"}},
	}, "solo_work_lite")
	if body2["tool_choice"] != "bash" {
		t.Fatalf("function tool_choice extracts name: %v", body2["tool_choice"])
	}
}

// --- SOLO SSE 解析与聚合 ---

func TestParseTraeSSELine(t *testing.T) {
	out := parseTraeSSELine("output", `{"response":"hi","reasoning_content":"think"}`)
	if out.Response != "hi" || out.ReasoningContent != "think" {
		t.Fatalf("output wrong: %+v", out)
	}
	if ev := parseTraeSSELine("error", `{"code":4001,"message":"param is invalid"}`); ev.ErrorCode != 4001 {
		t.Fatalf("error wrong: %+v", ev)
	}
	if done := parseTraeSSELine("done", `{"finish_reason":"stop"}`); done.FinishReason != "stop" {
		t.Fatalf("done wrong: %+v", done)
	}
	// 空 data 行：只回事件名。
	if ev := parseTraeSSELine("metadata", ""); ev == nil || ev.Event != "metadata" {
		t.Fatal("bare event line must parse")
	}
}

func TestNormalizeTraeToolCallsWire(t *testing.T) {
	calls := normalizeTraeToolCallsWire([]any{
		map[string]any{"index": 0.0, "function_call": map[string]any{
			"name": "bash", "arguments": "{}", "namespace": "ns", "partial_arguments": "pa",
		}},
	})
	c0 := calls[0].(map[string]any)
	fn := c0["function"].(map[string]any)
	if fn["name"] != "bash" || fn["arguments"] != "{}" {
		t.Fatalf("function_call → function failed: %v", c0)
	}
	if _, has := fn["namespace"]; has {
		t.Fatal("SOLO namespace must be stripped")
	}
	if _, has := c0["function_call"]; has {
		t.Fatal("function_call key must be removed")
	}
}

func TestAggregateTraeSSE(t *testing.T) {
	lines := []string{
		"event: metadata", "data: {}", "",
		"event: output", `data: {"response":"你"}`, "",
		"event: output", `data: {"reasoning_content":"思考中"}`, "",
		"event: token_usage", `data: {"input_tokens":10,"output_tokens":5}`, "",
		"event: done", `data: {"finish_reason":"stop"}`, "",
	}
	got := aggregateTraeSSE(lines)
	if got.Content != "你" || got.ReasoningContent != "思考中" {
		t.Fatalf("aggregate wrong: %+v", got)
	}
	if got.Usage == nil || got.Usage["input_tokens"].(float64) != 10 {
		t.Fatalf("usage missing: %+v", got.Usage)
	}
	if got.FinishReason != "stop" {
		t.Fatalf("finish wrong: %q", got.FinishReason)
	}
	if got := aggregateTraeSSE([]string{"event: error", `data: {"code":4001,"message":"x"}`, ""}); !got.HasError || got.ErrCode != 4001 {
		t.Fatal("error frame must surface")
	}
}

// --- 回调解析（token 直传下无 code；PKCE 并行流程探测；乱码修复） ---

func TestParseTraeCallbackTokenDirect(t *testing.T) {
	raw := "/authorize?refreshToken=rt-1&userInfo=" + url.QueryEscape(`{"UserID":"u-1","ScreenName":"用户1234","TenantID":"t-1"}`) +
		"&userJwt=" + url.QueryEscape(`{"Token":"tok-1","RefreshToken":"rt-jwt"}`)
	info, reason, acFlow := parseTraeCallback(raw)
	if info == nil {
		t.Fatalf("parse failed: %s (pkce=%v)", reason, acFlow)
	}
	if info.UID != "u-1" || info.EnterpriseID != "t-1" {
		t.Fatalf("fields wrong: %+v", info)
	}
	if info.RefreshToken != "rt-1" {
		t.Fatalf("query.refreshToken wins: %q", info.RefreshToken)
	}
}

func TestParseTraeCallbackJWTRefreshFallback(t *testing.T) {
	raw := "/authorize?userInfo=" + url.QueryEscape(`{"UserID":"u-2"}`) +
		"&userJwt=" + url.QueryEscape(`{"Token":"tk","RefreshToken":"rt-j"}`)
	info, _, _ := parseTraeCallback(raw)
	if info == nil || info.RefreshToken != "rt-j" {
		t.Fatalf("query 缺 refreshToken 时回退 userJwt.RefreshToken: %+v", info)
	}
	if info.AccessToken != "" {
		t.Fatalf("accessToken 只在无 refreshToken 时才取 userJwt.Token: %+v", info)
	}
}

func TestParseTraeCallbackPKCEDetected(t *testing.T) {
	_, reason, acFlow := parseTraeCallback("/authorize?code=ac-9")
	if !acFlow {
		t.Fatalf("PKCE callback must be recognized as the parallel flow: %q", reason)
	}
	if !strings.Contains(reason, "PKCE") {
		t.Fatalf("must NAME the PKCE branch: %q", reason)
	}
}

func TestParseTraeCallbackNothingFails(t *testing.T) {
	_, reason, acFlow := parseTraeCallback("/authorize?x=1")
	if acFlow {
		t.Fatal("no code → not PKCE")
	}
	if !strings.Contains(reason, "refreshToken") {
		t.Fatalf("actionable reason expected: %q", reason)
	}
}

func TestFixNicknameMojibake(t *testing.T) {
	if got := fixNicknameMojibake("张三", "u1"); got != "张三" {
		t.Fatalf("clean CJK passes through: %q", got)
	}
	fixed := fixNicknameMojibake("Óû§8847309959", "40565642")
	if fixed == "Óû§8847309959" && !containsCJK(fixed) {
		t.Fatalf("unfixable non-CJK mojibake must fall back to 用户+uid末4: %q", fixed)
	}
}

// --- 设备派生（9074 设备级限流绕开的根基） ---

func TestDeriveCheckinDeviceID(t *testing.T) {
	base := strings.Repeat("ab", 16)
	if got := DeriveCheckinDeviceID(base, 0); got != base {
		t.Fatal("generation 0 → base verbatim")
	}
	g1 := DeriveCheckinDeviceID(base, 1)
	if len(g1) != 32 || g1 == base {
		t.Fatalf("derived must be 32 hex and differ: %q", g1)
	}
	if g1 != DeriveCheckinDeviceID(base, 1) {
		t.Fatal("derivation must be deterministic")
	}
	if g2 := DeriveCheckinDeviceID(base, 2); g2 == g1 {
		t.Fatal("generations must diverge")
	}
}

func TestTraeSeededStreamDeterministic(t *testing.T) {
	if string(traeSeededStream("user1", "devid", 32)) == string(traeSeededStream("user2", "devid", 32)) {
		t.Fatal("different seeds must diverge")
	}
	digits := traeSeededDigits(15, "user1", "devid")
	if len(digits) != 15 {
		t.Fatalf("digit length wrong: %q", digits)
	}
	for _, ch := range digits {
		if ch < '0' || ch > '9' {
			t.Fatalf("non-digit: %q", digits)
		}
	}
}

func TestTraeDisplayNickname(t *testing.T) {
	if got := TraeDisplayNickname("130******00", "", "用户8618", "u1", "fb"); got != "130******00" {
		t.Fatalf("phone wins: %q", got)
	}
	if got := TraeDisplayNickname("", "a@b.c", "用户x", "u1", "fb"); got != "a@b.c" {
		t.Fatalf("email second: %q", got)
	}
	if got := TraeDisplayNickname("", "", "", "", "fb"); got != "fb" {
		t.Fatalf("fallback last: %q", got)
	}
}

func TestBuildTraeCredentialExpiryOrdering(t *testing.T) {
	ex := &traeExchangeResult{AccessToken: "a", TokenExpireAt: 1786847930141}
	if got := traeExpiryString(ex, 1); got != "1786847930141" {
		t.Fatalf("ms value kept: %q", got)
	}
	ex.TokenExpireAt, ex.TokenExpireDur = 1786847930, 0
	if got := traeExpiryString(ex, 1); got != "1786847930000" {
		t.Fatalf("sec → ms: %q", got)
	}
	ex.TokenExpireAt, ex.TokenExpireDur = 0, 3600
	if got := traeExpiryString(ex, 1000); got != "3601000" {
		t.Fatalf("duration → now-based: %q", got)
	}
	tok := mustJWT(t, map[string]any{"exp": 2000000000.0})
	if got := traeExpiryString(&traeExchangeResult{AccessToken: tok}, 0); got != "2000000000000" {
		t.Fatalf("JWT fallback: %q", got)
	}
}

// --- ExchangeToken mock（轮换 + GetUserInfo 容错回填） ---

func TestTraeExchangeCallbackMock(t *testing.T) {
	var body map[string]any
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/ExchangeToken"):
			_ = json.NewDecoder(r.Body).Decode(&body)
			w.Write([]byte(`{"Result":{"Token":"tok-9","RefreshToken":"rt-9","TokenExpireDuration":3600}}`))
		case strings.HasSuffix(r.URL.Path, "/GetUserInfo"):
			if r.Header.Get("X-Cloudide-Token") != "tok-9" {
				t.Error("GetUserInfo must carry X-Cloudide-Token")
			}
			w.Write([]byte(`{"Result":{"UserID":"uid-9","ScreenName":"用户999","NonPlainTextMobile":"130******77"}}`))
		default:
			w.WriteHeader(404)
		}
	})
	restoreTraeOAuthHost(t, srv.URL)

	m := newTestManager(t).m
	info := &traeCallbackInfo{RefreshToken: "rt-callback", UID: "cb-uid", Nickname: "cb-name", EnterpriseID: "cb-t"}
	cred, err := m.exchangeTraeCallback(context.Background(), info, strings.Repeat("ab", 16), strings.Repeat("cd", 16), nowMillis())
	if err != nil {
		t.Fatal(err)
	}
	if cred.AccessToken != "tok-9" || cred.RefreshToken != "rt-9" {
		t.Fatalf("tokens wrong: %+v", cred)
	}
	if body["ClientID"] != traeProduct.ClientID || body["ClientSecret"] != "-" {
		t.Fatalf("exchange body wrong: %+v", body)
	}
	// uid/手机号以 GetUserInfo 为准（回调值仅兜底）。
	if cred.UID != "uid-9" || cred.Phone != "130******77" {
		t.Fatalf("GetUserInfo not applied: %+v", cred)
	}
	if TraeDisplayNickname(cred.Phone, cred.Email, cred.Nickname, cred.UID, "x") != "130******77" {
		t.Fatal("display nickname must prefer phone")
	}
	if cred.MachineID != strings.Repeat("ab", 16) || cred.DeviceID != strings.Repeat("cd", 16) {
		t.Fatalf("session ids not carried: %q %q", cred.MachineID, cred.DeviceID)
	}
}

func TestTraeExchangeNoRefreshTokenBranch(t *testing.T) {
	exchangeCalled := false
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/ExchangeToken") {
			exchangeCalled = true
			t.Error("ExchangeToken must NOT be called in the jwt-token branch")
			w.WriteHeader(500)
			return
		}
		// GetUserInfo 容错回填照常提供（分支 2 也调 GetUserInfo）。
		w.Write([]byte(`{"Result":{"UserID":"uid-nojwt","ScreenName":"n2"}}`))
	})
	restoreTraeOAuthHost(t, srv.URL)
	info := &traeCallbackInfo{AccessToken: "jwt-tok", UID: "u-9", Nickname: "n"}
	m := &Manager{}
	cred, err := m.exchangeTraeCallback(context.Background(), info, "m", "d", nowMillis())
	if err != nil {
		t.Fatal(err)
	}
	_ = exchangeCalled
	if cred.AccessToken != "jwt-tok" || cred.RefreshToken != "" {
		t.Fatalf("branch-2 credential wrong: %+v", cred)
	}
}

// restoreTraeOAuthHost swaps the OAuth host for the current test.
func restoreTraeOAuthHost(t *testing.T, mockURL string) {
	t.Helper()
	old := traeOAuthHost
	traeOAuthHost = mockURL
	t.Cleanup(func() { traeOAuthHost = old })
}
