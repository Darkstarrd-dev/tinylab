package jethub

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// --- R1-7: OpenCode Zen（ref branch feat/opencode-provider @ 7dd3422） ---

func TestOpencodeFingerprintShapes(t *testing.T) {
	// project id：40 位小写 hex（官方 CLI 同形），identity/generation 变化即变。
	proj := deriveOpencodeProjectID("sk-test", 0)
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(proj) {
		t.Fatalf("project id shape wrong: %q", proj)
	}
	if deriveOpencodeProjectID("sk-test", 0) != proj {
		t.Fatal("project id must be deterministic")
	}
	if deriveOpencodeProjectID("sk-other", 0) == proj || deriveOpencodeProjectID("sk-test", 1) == proj {
		t.Fatal("identity/generation change must change the project id")
	}

	// session id：ses_ + 12 位小写 hex + **14** 位 base62（总尾 26）。
	// ⚠️ 写成 12hex+26base62（38 字符）会让匿名通道一律 403 FreeTierError（ref 实测）。
	sess := opencodeSessionIDFor("acct-1")
	if !regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`).MatchString(sess) {
		t.Fatalf("session id shape wrong (want ses_+12hex+14base62): %q", sess)
	}
	if opencodeSessionIDFor("acct-1") != sess {
		t.Fatal("session id must be stable per account (retries reuse it)")
	}
	if opencodeSessionIDFor("acct-2") == sess {
		t.Fatal("different accounts must get different session ids")
	}

	// request id：req_ + 32 hex，每请求不同。
	reqID := newOpencodeRequestID()
	if !regexp.MustCompile(`^req_[0-9a-f]{32}$`).MatchString(reqID) {
		t.Fatalf("request id shape wrong: %q", reqID)
	}
	if newOpencodeRequestID() == reqID {
		t.Fatal("request ids must be unique")
	}
}

func TestOpencodeShapeBodyGate(t *testing.T) {
	// ① 无 tools：强制 stream + 注入 bash/read + tool_choice none。
	out, err := opencodeShapeBody([]byte(`{"model":"big-pickle","messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	var obj map[string]any
	if err := json.Unmarshal(out, &obj); err != nil {
		t.Fatal(err)
	}
	if obj["stream"] != true {
		t.Fatal("stream must be forced true (gate requirement)")
	}
	if obj["tool_choice"] != "none" {
		t.Fatalf("tool_choice must be none when the caller had no tools, got %v", obj["tool_choice"])
	}
	names := map[string]bool{}
	for _, raw := range obj["tools"].([]any) {
		fn := raw.(map[string]any)["function"].(map[string]any)
		names[fn["name"].(string)] = true
		if fn["description"] != "Reserved for the host runtime; do not call it." {
			t.Fatalf("gate tool description must match the reference: %v", fn["description"])
		}
	}
	if !names["bash"] || !names["read"] {
		t.Fatalf("gate tools missing: %v", names)
	}

	// ② 有真实工具：只补缺失的门禁工具，tool_choice 保持不动。
	out, err = opencodeShapeBody([]byte(`{"messages":[],"stream":true,"tool_choice":"auto","tools":[{"type":"function","function":{"name":"grep"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	obj = map[string]any{}
	if err := json.Unmarshal(out, &obj); err != nil {
		t.Fatal(err)
	}
	if obj["tool_choice"] != "auto" {
		t.Fatalf("existing tool_choice must be preserved, got %v", obj["tool_choice"])
	}
	if len(obj["tools"].([]any)) != 3 {
		t.Fatalf("expected grep + bash + read, got %d tools", len(obj["tools"].([]any)))
	}

	// ③ 已满足门禁：字节级不变（同一引用）。
	in := []byte(`{"messages":[],"stream":true,"tools":[{"type":"function","function":{"name":"bash"}},{"type":"function","function":{"name":"read"}}]}`)
	out, err = opencodeShapeBody(in)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != string(in) {
		t.Fatalf("already-shaped body must pass through unchanged:\n got %s\nwant %s", out, in)
	}
}

func TestOpencodeClassifyError(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   string
	}{
		// ⚠️ 额度错误带 401/403 是常态：体里的类型名必须先于状态码判定。
		{"free usage limit on 403", 403, `{"error":{"type":"FreeUsageLimitError","message":"limit reached"}}`, opencodeErrFreeUsageLimit},
		{"go usage limit on 429", 429, `{"type":"GoUsageLimitError","message":"quota"}`, opencodeErrGoUsageLimit},
		{"free tier shape gate", 403, `{"error":{"type":"FreeTierError","message":"free tier can only be used from within OpenCode"}}`, opencodeErrFreeTier},
		{"plain 429", 429, `{"message":"too many requests"}`, opencodeErrRateLimit},
		{"insufficient funds", 402, `{"error":{"type":"server_error","message":"Insufficient account funds"}}`, opencodeErrQuota},
		{"plain 401", 401, `{"message":"invalid key"}`, opencodeErrAuth},
		{"server error", 500, `oops`, opencodeErrServer},
	}
	for _, tc := range cases {
		info := classifyOpencodeError(tc.status, tc.body, 0, false)
		if info.kind != tc.want {
			t.Errorf("%s: kind = %q, want %q", tc.name, info.kind, tc.want)
		}
		if info.detail == "" || strings.HasPrefix(strings.TrimSpace(info.detail), "{") {
			t.Errorf("%s: detail must be human-readable, got %q", tc.name, info.detail)
		}
	}
}

func TestOpencodeRetryAfterParsingAndPolicy(t *testing.T) {
	// 秒数、0（合法值！）、HTTP 日期。
	if ms, ok := parseOpencodeRetryAfter("600"); !ok || ms != 600_000 {
		t.Fatalf("600 → %d,%v", ms, ok)
	}
	if ms, ok := parseOpencodeRetryAfter("0"); !ok || ms != 0 {
		t.Fatalf("0 must parse as an immediate lift (valid value), got %d,%v", ms, ok)
	}
	if _, ok := parseOpencodeRetryAfter(""); ok {
		t.Fatal("empty header must report absent")
	}
	if ms, ok := parseOpencodeRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT"); !ok || ms != 0 {
		t.Fatalf("past HTTP date must clamp to 0, got %d,%v", ms, ok)
	}

	// 服务端值优先且封顶 30min；0 保持 0（不得被 falsy 判据换成默认值）。
	if got := opencodeRetryAfterMs(opencodeErrRateLimit, 3600_000, true, 1); got != 1800_000 {
		t.Fatalf("server delay must win (clamped to 30min), got %d", got)
	}
	if got := opencodeRetryAfterMs(opencodeErrRateLimit, 0, true, 1); got != 0 {
		t.Fatalf("0 must stay 0 (immediate lift), got %d", got)
	}
	// 无服务端值：free/go 限额与余额不足按当日；auth 一分钟；其余指数退避封顶。
	if got := opencodeRetryAfterMs(opencodeErrFreeUsageLimit, 0, false, 1); got != 24*60*60_000 {
		t.Fatalf("free usage limit default = 24h, got %d", got)
	}
	if got := opencodeRetryAfterMs(opencodeErrQuota, 0, false, 1); got != 24*60*60_000 {
		t.Fatalf("quota default = 24h, got %d", got)
	}
	if got := opencodeRetryAfterMs(opencodeErrAuth, 0, false, 1); got != 60_000 {
		t.Fatalf("auth default = 60s, got %d", got)
	}
	if got := opencodeRetryAfterMs(opencodeErrRateLimit, 0, false, 3); got != 240_000 {
		t.Fatalf("rate limit attempt 3 = 240s, got %d", got)
	}
	if got := opencodeRetryAfterMs(opencodeErrServer, 0, false, 30); got != 1800_000 {
		t.Fatalf("exponential must cap at 30min, got %d", got)
	}
}

func TestOpencodeModelTable(t *testing.T) {
	if len(opencodeModels) != 14 {
		t.Fatalf("opencode table has %d models, want 14 (7 free + 7 paid)", len(opencodeModels))
	}
	ids := map[string]bool{}
	free := 0
	for _, md := range opencodeModels {
		if ids[md.ID] {
			t.Fatalf("duplicate model id %s", md.ID)
		}
		ids[md.ID] = true
		if isFreeOpencodeModel(md.ID) {
			free++
			if !strings.Contains(md.Alias, "免费") {
				t.Errorf("%s is free but carries no 免费 marker: %q", md.ID, md.Alias)
			}
		}
	}
	if free != 7 {
		t.Fatalf("free models = %d, want 7", free)
	}
	// 未实测可达的模型不得出现（ref 移除 ling-3.0-flash-fin-free）。
	if ids["ling-3.0-flash-fin-free"] {
		t.Fatal("ling-3.0-flash-fin-free is unreachable on both channels and must not be listed")
	}
}

func TestOpencodeAddAccountDedupAndExtractor(t *testing.T) {
	m := newTestManager(t).m
	id, reused, err := m.AddOpencodeAccount("sk-test-1234", "", false)
	if err != nil || reused {
		t.Fatalf("add: id=%q reused=%v err=%v", id, reused, err)
	}
	acc, ok := m.FindAccount(id)
	if !ok || acc.Provider != "opencode" {
		t.Fatal("account not stored")
	}
	raw, ok := m.Credential("opencode", acc.CredentialRef)
	if !ok {
		t.Fatal("credential not stored")
	}
	// Key extractor: the API key itself is the rotation key.
	token, err := accessTokenOf("opencode", raw)
	if err != nil || token != "sk-test-1234" {
		t.Fatalf("extractor = %q, %v", token, err)
	}
	// Duplicate add = reuse (no new account).
	id2, reused2, err := m.AddOpencodeAccount("sk-test-1234", "ignored", false)
	if err != nil || !reused2 || id2 != id {
		t.Fatalf("duplicate add must reuse: id=%q reused=%v err=%v", id2, reused2, err)
	}
	if got := len(m.Accounts("opencode")); got != 1 {
		t.Fatalf("duplicate add created an extra account (%d)", got)
	}

	// Anonymous channel: literal `public`, honest refreshable=false, idempotent.
	anonID, _, err := m.AddOpencodeAccount("", "", true)
	if err != nil {
		t.Fatal(err)
	}
	anonAcc, _ := m.FindAccount(anonID)
	if anonAcc.Nickname != "匿名通道" || anonAcc.Refreshable {
		t.Fatalf("anonymous account wrong: %+v", anonAcc)
	}
	anonRaw, _ := m.Credential("opencode", anonAcc.CredentialRef)
	var cred OpencodeCredential
	if err := json.Unmarshal(anonRaw, &cred); err != nil {
		t.Fatal(err)
	}
	if cred.APIKey != opencodeAnonymousKey {
		t.Fatalf("anonymous api_key = %q, want %q", cred.APIKey, opencodeAnonymousKey)
	}
	if _, reused3, _ := m.AddOpencodeAccount("", "", true); !reused3 {
		t.Fatal("anonymous add must be idempotent")
	}
	if got := len(m.Accounts("opencode")); got != 2 {
		t.Fatalf("expected 2 accounts (key + anon), got %d", got)
	}
}

func TestOpencodeAugmentHeadersReplaceClient(t *testing.T) {
	m := newTestManager(t).m
	id, _, err := m.AddOpencodeAccount("sk-test-9999", "", false)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "https://tinylab.local/v1/chat/completions", nil)

	out, err := m.opencodeAugment(req, []byte(`{"model":"big-pickle","messages":[]}`), "jethub-opencode", id, "big-pickle")
	if err != nil {
		t.Fatal(err)
	}
	if got := req.Header.Get("Authorization"); got != "Bearer sk-test-9999" {
		t.Fatalf("Authorization = %q", got)
	}
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(req.Header.Get("x-opencode-project")) {
		t.Fatalf("x-opencode-project shape wrong: %q", req.Header.Get("x-opencode-project"))
	}
	if !regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`).MatchString(req.Header.Get("x-opencode-session")) {
		t.Fatalf("x-opencode-session shape wrong: %q", req.Header.Get("x-opencode-session"))
	}
	if req.Header.Get("x-opencode-client") != "cli" {
		t.Fatalf("x-opencode-client = %q, want cli", req.Header.Get("x-opencode-client"))
	}
	if req.Header.Get("User-Agent") != opencodeDefaultUA {
		t.Fatalf("UA = %q, want %q", req.Header.Get("User-Agent"), opencodeDefaultUA)
	}
	var obj map[string]any
	if err := json.Unmarshal(out, &obj); err != nil {
		t.Fatal(err)
	}
	if obj["stream"] != true {
		t.Fatal("augmented body must carry stream:true")
	}
}

func TestOpencodeInterceptErrorMapping(t *testing.T) {
	m := newTestManager(t).m

	// 403 + FreeUsageLimitError（额度类错误带 403 是常态）⇒ BillingLockError：
	// 锁 key+model、换账号；无 retry-after 时按当日 24h。
	resp := &http.Response{StatusCode: 403, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":{"type":"FreeUsageLimitError","message":"free usage limit reached"}}`))}
	_, _, err := m.opencodeInterceptResponse(nil, resp, "big-pickle", true)
	var ble *upstreamerr.BillingLockError
	if !errors.As(err, &ble) {
		t.Fatalf("free usage limit must become a billing lock, got %v", err)
	}
	if d := time.Until(ble.Until); d < 23*time.Hour || d > 25*time.Hour {
		t.Fatalf("default lock should be ~24h, got %v", d)
	}

	// retry-after 优先：600s ⇒ 锁 ~10min（不是 24h）。
	resp = &http.Response{StatusCode: 403, Header: http.Header{"Retry-After": []string{"600"}}, Body: io.NopCloser(strings.NewReader(`GoUsageLimitError`))}
	_, _, err = m.opencodeInterceptResponse(nil, resp, "glm-5.2", true)
	if !errors.As(err, &ble) {
		t.Fatalf("go usage limit must become a billing lock, got %v", err)
	}
	if d := time.Until(ble.Until); d < 9*time.Minute || d > 11*time.Minute {
		t.Fatalf("retry-after 600s must win, got %v", d)
	}

	// FreeTierError：形状门禁，换 key/换出口无效 ⇒ 显式报错（不是 billing lock）。
	resp = &http.Response{StatusCode: 403, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`FreeTierError`))}
	_, _, err = m.opencodeInterceptResponse(nil, resp, "big-pickle", true)
	if err == nil || errors.As(err, &ble) || !strings.Contains(err.Error(), "FreeTierError") {
		t.Fatalf("FreeTierError must surface explicitly, got %v", err)
	}

	// 401（无类型名）：交回代理按状态码分类，且 body 必须完整还回去。
	resp = &http.Response{StatusCode: 401, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"message":"invalid key"}`))}
	_, retryMs, err := m.opencodeInterceptResponse(nil, resp, "glm-5.2", true)
	if err != nil || retryMs != 0 {
		t.Fatalf("plain 401 must pass through, got retry=%d err=%v", retryMs, err)
	}
	raw, _ := io.ReadAll(resp.Body)
	if string(raw) != `{"message":"invalid key"}` {
		t.Fatalf("body must stay readable for the proxy, got %q", raw)
	}
}

func TestOpencodeInterceptNonStreamAggregation(t *testing.T) {
	m := newTestManager(t).m
	sse := "data:{\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello\"}}]}\n\n" +
		"data:{\"choices\":[{\"index\":0,\"delta\":{\"content\":\" world\"}}]}\n\n" +
		"data:{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"get_\",\"arguments\":\"{\\\"a\\\":\"}}]}}]}\n\n" +
		"data:{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"weather\",\"arguments\":\"1}\"}}]}}]}\n\n" +
		"data:{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":5,\"total_tokens\":8}}\n\n" +
		"data:[DONE]\n\n"
	resp := &http.Response{StatusCode: 200, Header: http.Header{"Content-Length": []string{"999"}}, Body: io.NopCloser(strings.NewReader(sse))}
	out, _, err := m.opencodeInterceptResponse(nil, resp, "big-pickle", false)
	if err != nil {
		t.Fatal(err)
	}
	if resp.ContentLength != -1 || resp.Header.Get("Content-Length") != "" {
		t.Fatal("aggregated body must clear Content-Length")
	}
	var obj map[string]any
	if err := json.Unmarshal(mustReadAll(t, out), &obj); err != nil {
		t.Fatal(err)
	}
	if obj["object"] != "chat.completion" || obj["id"] != "chatcmpl-1" || obj["model"] != "big-pickle" {
		t.Fatalf("aggregate envelope wrong: %v", obj)
	}
	choice := obj["choices"].([]any)[0].(map[string]any)
	if choice["finish_reason"] != "tool_calls" {
		t.Fatalf("finish_reason = %v", choice["finish_reason"])
	}
	msg := choice["message"].(map[string]any)
	if msg["content"] != "Hello world" {
		t.Fatalf("content = %q", msg["content"])
	}
	tc := msg["tool_calls"].([]any)[0].(map[string]any)
	fn := tc["function"].(map[string]any)
	if fn["name"] != "get_weather" || fn["arguments"] != `{"a":1}` {
		t.Fatalf("tool call merge wrong: %v", fn)
	}
	usage := obj["usage"].(map[string]any)
	if usage["total_tokens"] != float64(8) {
		t.Fatalf("usage lost: %v", usage)
	}

	// 流式客户端：透传（不聚合）。
	resp2 := &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(sse))}
	if r, _, err := m.opencodeInterceptResponse(nil, resp2, "big-pickle", true); err != nil || r != nil {
		t.Fatalf("stream clients must pass through, got r=%v err=%v", r, err)
	}
}

func TestOpencodeBridgeAnonymousLastAndPaidVisibility(t *testing.T) {
	m := newTestManager(t).m
	reg := newFakeRegistry()
	b := NewBridge(m, reg)
	RegisterDefaultProducts(b)

	anonID, _, err := m.AddOpencodeAccount("", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.SetPrefix("opencode", "oc"); err != nil {
		t.Fatal(err)
	}
	p, ok := reg.GetProvider("jethub-opencode")
	if !ok {
		t.Fatal("bridged provider not registered")
	}
	// 只有匿名通道 ⇒ 只暴露免费模型（收费模型对匿名通道必然 401/403）。
	if len(p.Models) != 7 {
		t.Fatalf("anonymous-only visibility must list 7 free models, got %d", len(p.Models))
	}
	if len(p.Keys) != 1 || p.Keys[0].Key != opencodeAnonymousKey || p.Keys[0].Priority != 100 {
		t.Fatalf("anonymous key must be registered last (priority 100): %+v", p.Keys)
	}

	// 加一个 keyed 账号 ⇒ 全表可见，账号槽优先级 0（fill-first 先试账号）。
	keyID, _, err := m.AddOpencodeAccount("sk-test-0001", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.SyncKeys("opencode"); err != nil {
		t.Fatal(err)
	}
	p, _ = reg.GetProvider("jethub-opencode")
	if len(p.Models) != 14 {
		t.Fatalf("keyed account must restore the full table, got %d models", len(p.Models))
	}
	prio := map[string]int{}
	for _, k := range p.Keys {
		prio[k.ID] = k.Priority
	}
	if prio[anonID] != 100 || prio[keyID] != 0 {
		t.Fatalf("key priorities wrong: %v", prio)
	}
}

// TestOpencodeFingerprintRotation: 「轮换指纹」必须真的换掉 project id。
//
// ⚠️ 判据链是「账号条目的代次是权威，凭据里的代次只是下限」
// （ref：`max(本字段, 凭据内代次)` 重新派生，**不得**直接透传凭据里的 project id）
// —— 否则代次涨了而 project id 不变，且不报错，是最难排查的一类静默失效。
//
// 反向验证：把 opencodeAugment 里改回 `deriveOpencodeProjectID(identity, 0)` 并透传
// `cred.Fingerprint.ProjectID`，本用例第二条断言立刻变红。
func TestOpencodeFingerprintRotation(t *testing.T) {
	m := newTestManager(t).m
	id, _, err := m.AddOpencodeAccount("sk-fp-0001", "", false)
	if err != nil {
		t.Fatal(err)
	}
	// 抓取一次请求头里的 project id（同一条凭证、同一代次必须稳定）。
	projectIDAfter := func() string {
		req := httptest.NewRequest(http.MethodPost, "https://tinylab.local/v1/chat/completions", nil)
		if _, err := m.opencodeAugment(req, []byte(`{"model":"big-pickle","messages":[]}`), "jethub-opencode", id, "big-pickle"); err != nil {
			t.Fatal(err)
		}
		return req.Header.Get("X-Opencode-Project")
	}
	before := projectIDAfter()
	if before == "" {
		t.Fatal("project id header missing")
	}
	if again := projectIDAfter(); again != before {
		t.Fatalf("project id must be stable within a generation: %q vs %q", before, again)
	}
	// 轮换代次 ⇒ 新 project id。
	generation, err := m.RotateOpencodeFingerprint(id)
	if err != nil {
		t.Fatal(err)
	}
	if generation != 1 {
		t.Fatalf("generation = %d, want 1", generation)
	}
	after := projectIDAfter()
	if after == before {
		t.Fatal("rotating the fingerprint MUST produce a new project id (代次涨了而 id 不变 = 静默失效)")
	}
	// 代次落盘（重启后不会退回 0）。
	m2, err := NewManager(m.dir, m.key, nil)
	if err != nil {
		t.Fatal(err)
	}
	if acc, ok := m2.FindAccount(id); !ok || acc.OpencodeFingerprintGeneration != 1 {
		t.Fatalf("generation must persist: %+v", acc)
	}
	// 凭据里的代次是**下限**：凭据写 5 时以 5 为准（即使条目里是 1）。
	acc, _ := m.FindAccount(id)
	cred, _ := m.Credential("opencode", acc.CredentialRef)
	var parsed OpencodeCredential
	if err := json.Unmarshal(cred, &parsed); err != nil {
		t.Fatal(err)
	}
	parsed.Fingerprint = &OpencodeFingerprint{ProjectID: "stale-from-credential", Generation: 5}
	raw, _ := json.Marshal(parsed)
	if err := m.SetCredential("opencode", acc.CredentialRef, raw, 0, false); err != nil {
		t.Fatal(err)
	}
	fromCredential := projectIDAfter()
	if fromCredential == after {
		t.Fatal("the credential generation is a FLOOR: a higher value must win")
	}
	// 但凭据里那个**过期的 projectID 字符串**绝不能被直接透传。
	if fromCredential == "stale-from-credential" {
		t.Fatal("the stored projectID must never be passed through verbatim (代次才是权威)")
	}
	// 未知账号 ⇒ 显式报错。
	if _, err := m.RotateOpencodeFingerprint("nope"); err == nil {
		t.Fatal("unknown account must error")
	}
}

// mustReadAll reads an interceptor-returned reader (test helper).
func mustReadAll(t *testing.T, r io.Reader) []byte {
	t.Helper()
	raw, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// TestOpencodeChannelBalanceIsLocalState: opencode 的「余额」是**通道可用性**，
// 全部来自本地状态、零网络请求。
//
// 覆盖三种形态（判据与 ref jet-hub-rpc.ts 的 OPENCODE 分支逐条对齐）：
//  1. 启用且无未到期标记 ⇒ 可用通道 1、无 error；
//  2. 有未到期标记 ⇒ 通道 0、expiredTotal 1、error 带**恢复时刻**；
//  3. 已停用 ⇒ 通道 0、error「已停用」。
//
// ⚠️ 反向验证：把 available 的判据改成只看 enabled（丢掉限额分支），第 2 条
// 会变红 —— 那正是「限额中的通道被当成可用」的原始缺陷。
func TestOpencodeChannelBalanceIsLocalState(t *testing.T) {
	env := newTestManager(t)
	m := env.m
	id, _, err := m.AddOpencodeAccount("sk-chan-0001", "", false)
	if err != nil {
		t.Fatal(err)
	}

	// ① 干净状态。
	bal, notice, err := m.OpencodeChannelBalance(id)
	if err != nil {
		t.Fatal(err)
	}
	if notice != "" {
		t.Fatalf("a healthy channel must carry no notice, got %q", notice)
	}
	if bal.Total != 1 || len(bal.Packages) != 1 || bal.Packages[0].Unit != "通道" {
		t.Fatalf("unexpected balance: %+v", bal)
	}
	if bal.Packages[0].Name != "可用通道" || bal.ExpiredTotal != 0 {
		t.Fatalf("unexpected package/no expired: %+v", bal)
	}

	// ② 未到期的限流标记 ⇒ 不可用 + 恢复时刻写进 error。
	future := nowMillis() + 3600_000
	if err := m.UpdateModelRateLimit(id, "big-pickle", future); err != nil {
		t.Fatal(err)
	}
	bal, notice, err = m.OpencodeChannelBalance(id)
	if err != nil {
		t.Fatal(err)
	}
	if bal.Total != 0 || bal.ExpiredTotal != 1 {
		t.Fatalf("a limited channel must read total=0 expiredTotal=1: %+v", bal)
	}
	if bal.Packages[0].Name != "1 个模型限额中" {
		t.Fatalf("package name must name the limited count: %+v", bal.Packages[0])
	}
	if !strings.Contains(notice, "限额中") || !strings.Contains(notice, "恢复") {
		t.Fatalf("notice must say 限额中 + 恢复时刻, got %q", notice)
	}

	// ③ 过期的标记不算「限额中」（仍可用）。
	// ⚠️ 必须先清掉②的标记：`UpdateModelRateLimit` 只延长不缩短（同一次限流会在
	// 多条路径上重复上报），直接把时刻改到过去会被正确忽略。
	if err := m.ClearAccountModelRateLimit(id, "big-pickle"); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateModelRateLimit(id, "big-pickle", nowMillis()-1000); err != nil {
		t.Fatal(err)
	}
	bal, notice, err = m.OpencodeChannelBalance(id)
	if err != nil {
		t.Fatal(err)
	}
	if bal.Total != 1 || notice != "" {
		t.Fatalf("an expired marker must not keep the channel unavailable: %+v %q", bal, notice)
	}

	// ④ 停用 ⇒ 不可用，且理由是「已停用」而不是「限额中」。
	if err := m.UpdateAccount(id, func(a *Account) { a.Enabled = false }); err != nil {
		t.Fatal(err)
	}
	bal, notice, err = m.OpencodeChannelBalance(id)
	if err != nil {
		t.Fatal(err)
	}
	if bal.Total != 0 || notice != "已停用" {
		t.Fatalf("disabled channel: total=%v notice=%q, want 0/已停用", bal.Total, notice)
	}

	// ⑤ 未知账号 ⇒ 显式报错（不是静默返回 0）。
	if _, _, err := m.OpencodeChannelBalance("nope"); err == nil {
		t.Fatal("unknown account must error")
	}
}
