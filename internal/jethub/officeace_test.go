package jethub

// OfficeAce 单元测试：签名形状（V11/SDK-HMAC）、登录链（state 注册 / 匿名
// code 轮询 / STS 换发 / permission-validate）、body 微调、per-account URL、
// 续期三规则、余额解析与领取。上游无公开测试向量，签名测试锁的是「ref 算法
// 的结构性事实」（尾斜杠 / 双 LF / hex 派生 key / RFC3986 编码集），任何一条
// 被无意识改动都会在这里断。

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// pinOfficeaceClock pins the signer clock and returns a restore func.
func pinOfficeaceClock(t *testing.T, at time.Time) func() {
	t.Helper()
	old := officeaceNow
	officeaceNow = func() time.Time { return at }
	return func() { officeaceNow = old }
}

// --- 签名器形状 ---

// TestOfficeaceURIEncode: RFC 3986 unreserved 集存活，其余全 percent 编码
// （JS encodeURIComponent + `!'()*` 补转 —— ref 的真实编码集）。
func TestOfficeaceURIEncode(t *testing.T) {
	cases := map[string]string{
		"abcXYZ019": "abcXYZ019",
		"a-b_c.d~e": "a-b_c.d~e",
		"a b":       "a%20b",
		"a+b":       "a%2Bb",
		"a/b":       "a%2Fb",
		"!:*'()":    "%21%3A%2A%27%28%29",
		"中":         "%E4%B8%AD",
		"a=b&c?d#e": "a%3Db%26c%3Fd%23e",
		"":          "",
		`a"b\c`:     "a%22b%5Cc",
	}
	for in, want := range cases {
		if got := officeaceURIEncode(in); got != want {
			t.Errorf("officeaceURIEncode(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestOfficeaceCanonicalURI: 尾斜杠强制（缺了就是 verify signature failed）+
// 逐段编码（decodeFirst 先解 path 里的已编码段再重编 —— V11 分支）。
func TestOfficeaceCanonicalURI(t *testing.T) {
	if got := officeaceCanonicalURI("/v1/subscription", true); got != "/v1/subscription/" {
		t.Errorf("trailing slash missing: %q", got)
	}
	if got := officeaceCanonicalURI("/v1/subscription/", true); got != "/v1/subscription/" {
		t.Errorf("double trailing slash: %q", got)
	}
	if got := officeaceCanonicalURI("/a b/c", false); got != "/a%20b/c/" {
		t.Errorf("per-segment encode: %q", got)
	}
	if got := officeaceCanonicalURI("/a%20b/c", true); got != "/a%20b/c/" {
		t.Errorf("decodeFirst must re-encode uniformly: %q", got)
	}
	if got := officeaceCanonicalURI("/a%20b/c", false); got != "/a%2520b/c/" {
		t.Errorf("decodeFirst=false must NOT pre-decode: %q", got)
	}
}

// TestOfficeaceSignV11Shape replays the exact ref algorithm against the
// signer's output (pinned clock ⇒ every input is deterministic) and asserts
// the structural rules: GET 不签 Content-Type、canonical 头块双 LF、派生 key
// 用 hex 字符串、Authorization 三段格式。
func TestOfficeaceSignV11Shape(t *testing.T) {
	restore := pinOfficeaceClock(t, time.Date(2026, 10, 15, 8, 30, 5, 0, time.UTC))
	defer restore()

	sign := func(method string) map[string]string {
		h, err := officeaceSignV11("AKTEST", "SKTEST", "ST-1  2", "proj-1", method,
			"https://officeace.example.com/v1/subscription", "")
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		return h
	}

	get := sign(http.MethodGet)
	if _, ok := get["Content-Type"]; ok {
		t.Error("rule 1: GET must not carry/send Content-Type")
	}
	post := sign(http.MethodPost)
	if got := post["Content-Type"]; got != "application/json;charset=utf8" {
		t.Errorf("POST Content-Type = %q, want application/json;charset=utf8", got)
	}

	for method, hdr := range map[string]map[string]string{"GET": get, "POST": post} {
		xdate := hdr["X-Sdk-Date"]
		if xdate != "20261015T083005Z" {
			t.Fatalf("%s: X-Sdk-Date = %q", method, xdate)
		}
		scope := xdate[:8] + "/cn-southwest-2/apic"

		// SignedHeaders 列表（排序、小写）—— GET/POST 的头集合不同。
		auth := hdr["Authorization"]
		const credPrefix = "V11-HMAC-SHA256 Credential="
		if !strings.HasPrefix(auth, credPrefix+"AKTEST/"+scope+", SignedHeaders=") {
			t.Fatalf("%s: Authorization prefix wrong: %q", method, auth)
		}
		mid := strings.TrimPrefix(auth, credPrefix+"AKTEST/"+scope+", SignedHeaders=")
		idx := strings.Index(mid, ", Signature=")
		if idx < 0 {
			t.Fatalf("%s: Authorization missing signature part: %q", method, auth)
		}
		signedList := mid[:idx]
		sig := strings.TrimPrefix(mid[idx:], ", Signature=")
		if len(sig) != 64 {
			t.Fatalf("%s: signature not 64 hex chars: %q", method, sig)
		}
		signed := strings.Split(signedList, ";")
		if !sort.StringsAreSorted(signed) {
			t.Fatalf("%s: SignedHeaders not sorted: %q", method, signedList)
		}

		// 重放 canonical request：逐条对应 ref B()/F() 的拼装（双 LF 来自
		// 「每行自带 \n + join 再插 \n」的叠加，即 canon.String() 已以 \n 结尾）。
		vals := map[string]string{
			"host":                "officeace.example.com",
			"x-sdk-date":          xdate,
			"x-security-token":    "ST-1 2", // trim 后折叠空白
			"x-subscription-type": "v2",
			"x-project-id":        "proj-1",
		}
		if method == "POST" {
			vals["content-type"] = "application/json;charset=utf8"
		}
		var canon strings.Builder
		for _, h := range signed {
			v, ok := vals[h]
			if !ok {
				t.Fatalf("%s: signed header %q not accounted for in replay", method, h)
			}
			canon.WriteString(h + ":" + v + "\n")
		}
		payloadHex := sha256Hex(nil)
		canonicalRequest := strings.Join([]string{
			method, "/v1/subscription/", "", canon.String(), signedList, payloadHex,
		}, "\n")
		canonicalHash := sha256Hex([]byte(canonicalRequest))
		stringToSign := strings.Join([]string{"V11-HMAC-SHA256", xdate, scope, canonicalHash}, "\n")

		// 规则 2（hex 字符串才是 key）：u1 = HMAC(ak,sk)；
		// derived = HMAC(u1, scope||0x01)[:32] → hex → 该 hex 的 UTF-8 字节为 key。
		u1 := hmacSHA256([]byte("AKTEST"), []byte("SKTEST"))
		derived := hmacSHA256(u1, append([]byte(scope), 0x01))
		if len(derived) > 32 {
			derived = derived[:32]
		}
		derivedHex := hex.EncodeToString(derived)
		want := hex.EncodeToString(hmacSHA256([]byte(derivedHex), []byte(stringToSign)))
		if sig != want {
			t.Fatalf("%s: signature mismatch\n got %s\nwant %s\n(stringToSign=%q)", method, sig, want, stringToSign)
		}
		// 反证：若误用 raw bytes 当 key，签名必不同（锁死规则 2）。
		wrongKey := hex.EncodeToString(hmacSHA256(derived, []byte(stringToSign)))
		if wrongKey == want {
			t.Fatal("derived raw-bytes key must NOT reproduce the signature")
		}
	}
}

// TestOfficeaceSignSDKHMACShape: 登录步 ⑤ 签名器 —— bare secret 作 key
// （无 scope 派生），值只 trim 不折叠，GET body 哈希为空串哈希。
func TestOfficeaceSignSDKHMACShape(t *testing.T) {
	restore := pinOfficeaceClock(t, time.Date(2026, 10, 15, 8, 30, 5, 0, time.UTC))
	defer restore()

	h, err := officeaceSignSDKHMAC("AKTEST", "SKTEST", http.MethodGet,
		"https://agentarts.example.com/v1/claw/client-permission-validate", map[string]string{
			"content-type":     "application/json",
			"x-security-token": "  ST  ",
		}, "")
	if err != nil {
		t.Fatal(err)
	}
	xdate := h["X-Sdk-Date"]
	auth := h["Authorization"]
	const prefix = "SDK-HMAC-SHA256 Access=AKTEST, SignedHeaders="
	if !strings.HasPrefix(auth, prefix) {
		t.Fatalf("Authorization prefix wrong: %q", auth)
	}
	mid := strings.TrimPrefix(auth, prefix)
	idx := strings.Index(mid, ", Signature=")
	if idx < 0 {
		t.Fatalf("missing signature: %q", auth)
	}
	signedList := mid[:idx]
	sig := strings.TrimPrefix(mid[idx:], ", Signature=")
	signed := strings.Split(signedList, ";")
	if !sort.StringsAreSorted(signed) {
		t.Fatalf("SignedHeaders not sorted: %q", signedList)
	}
	vals := map[string]string{
		"host":             "agentarts.example.com",
		"x-sdk-date":       xdate,
		"content-type":     "application/json",
		"x-security-token": "ST", // 只 trim
	}
	var canon strings.Builder
	for _, name := range signed {
		v, ok := vals[name]
		if !ok {
			t.Fatalf("signed header %q not accounted for", name)
		}
		canon.WriteString(name + ":" + v + "\n")
	}
	empty := sha256Hex(nil)
	canonicalRequest := strings.Join([]string{
		"GET", "/v1/claw/client-permission-validate/", "", canon.String(), signedList, empty,
	}, "\n")
	stringToSign := strings.Join([]string{"SDK-HMAC-SHA256", xdate, sha256Hex([]byte(canonicalRequest))}, "\n")
	want := hex.EncodeToString(hmacSHA256([]byte("SKTEST"), []byte(stringToSign)))
	if sig != want {
		t.Fatalf("signature mismatch (bare-secret key)\n got %s\nwant %s", sig, want)
	}
}

// --- 登录链 ---

// TestStartOfficeaceLoginStateShape: ① 匿名 state 注册 + 授权页拼装
// （authui 登录页包着 authorize URL，service= 参数）。
func TestStartOfficeaceLoginStateShape(t *testing.T) {
	var gotPath, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod = r.URL.Path, r.Method
		w.Write([]byte(`{"state":"cloud-state-1"}`))
	}))
	defer srv.Close()
	old := officeaceClawBase
	setClawBase(srv.URL)
	defer setClawBase(old)

	m := newTestManager(t).m
	flow, err := m.StartOfficeaceLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPost || gotPath != "/v1/claw/auth/state" {
		t.Fatalf("state endpoint = %s %s", gotMethod, gotPath)
	}
	if flow.State != "cloud-state-1" {
		t.Fatalf("state = %q, want the cloud-issued one", flow.State)
	}
	if flow.CodeVerifier == "" {
		t.Fatal("PKCE verifier missing")
	}
	// 授权 URL = authui 登录页包着 authorize URL（service= 参数）。
	if !strings.HasPrefix(flow.AuthorizeURL, "https://auth.huaweicloud.com/authui/login.html?service=") {
		t.Fatalf("authorize page wrapper missing: %q", flow.AuthorizeURL)
	}
	inner, err := url.QueryUnescape(strings.TrimPrefix(flow.AuthorizeURL, "https://auth.huaweicloud.com/authui/login.html?service="))
	if err != nil {
		t.Fatalf("service param unescape: %v", err)
	}
	parsed, err := url.Parse(inner)
	if err != nil || parsed.Path != "/authui/v1/oauth2/authorize" {
		t.Fatalf("inner authorize URL = %q (%v)", inner, err)
	}
	q := parsed.Query()
	if q.Get("client_id") != "pdp5_for_agentarts" || q.Get("code_challenge_method") != "SHA-256" ||
		q.Get("scope") != "openid" || q.Get("state") != "cloud-state-1" || q.Get("response_type") != "code" {
		t.Fatalf("authorize params wrong: %v", q)
	}
	// challenge 与 verifier 对得上（S256），verifier 长度合规。
	if len(flow.CodeVerifier) < 43 {
		t.Fatalf("PKCE verifier too short: %d", len(flow.CodeVerifier))
	}
	sum := sha256.Sum256([]byte(flow.CodeVerifier))
	if base64.RawURLEncoding.EncodeToString(sum[:]) != q.Get("code_challenge") {
		t.Fatal("code_challenge is not SHA-256(verifier)")
	}
}

// TestOfficeaceParseCodeResponse: ③ 匿名轮询的纯解析 —— 200 两种形状取 code，
// 其余一律 pending（202/404 是「未就绪」，不是错误）。
func TestOfficeaceParseCodeResponse(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		body    string
		code    string
		pending bool
	}{
		{"200 top-level", 200, `{"code":"C1"}`, "C1", false},
		{"200 nested data", 200, `{"data":{"code":"C2"}}`, "C2", false},
		{"202 pending", 202, `{}`, "", true},
		{"404 pending", 404, `not found`, "", true},
		{"non-string code", 200, `{"code":12345}`, "", true},
		{"null code", 200, `{"code":null}`, "", true},
		{"bad json", 200, `zzz`, "", true},
		{"empty code", 200, `{"code":""}`, "", true},
	}
	for _, c := range cases {
		out := officeaceParseCodeResponse(c.status, []byte(c.body))
		if out.Code != c.code || out.Pending != c.pending {
			t.Errorf("%s: got {code=%q pending=%v}, want {code=%q pending=%v}",
				c.name, out.Code, out.Pending, c.code, c.pending)
		}
	}
}

// TestOfficeaceRunLoginEndToEnd: ①③④⑤ 全链路打 mock —— state → 202 → code →
// STS → permission-validate（SDK-HMAC 签名头必须齐）→ 组装凭据。
func TestOfficeaceRunLoginEndToEnd(t *testing.T) {
	var codePolls atomic.Int32
	var gotDPoP, gotGrant, gotCode string
	claw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/claw/auth/state":
			w.Write([]byte(`{"state":"st-1"}`))
		case "/v1/claw/auth/code":
			if codePolls.Add(1) == 1 {
				w.WriteHeader(http.StatusAccepted)
				w.Write([]byte(`{}`))
				return
			}
			gotCode = r.URL.Query().Get("state")
			w.Write([]byte(`{"code":"AUTHCODE"}`))
		case "/v1/claw/client-permission-validate":
			if !strings.HasPrefix(r.Header.Get("Authorization"), "SDK-HMAC-SHA256 Access=AKIAM") {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Write([]byte(`{"account_id":"acc-123456789","subscription":{"model_info":{
				"model_auth_info":{"model_app_key":"maas-key","model_app_secret":"maas-secret"},
				"model_api_url_base":"modelgw-1.officeace.example.com"}}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer claw.Close()
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotDPoP = r.Header.Get("DPoP")
		gotGrant = r.FormValue("grant_type")
		if r.FormValue("code_verifier") == "" {
			t.Error("STS exchange must carry code_verifier")
		}
		w.Write([]byte(`{"credentials":{"access_key_id":"AKIAM","secret_access_key":"SKIAM",
			"security_token":"STIAM","expiration":"2030-01-01T00:00:00Z","project_id":"proj"},
			"refresh_token":"RT-NEW"}`))
	}))
	defer sts.Close()

	oldClaw, oldSTS := officeaceClawBase, officeaceSTSURL
	setClawBase(claw.URL)
	setOfficeaceSTSURL(sts.URL)
	defer func() { setClawBase(oldClaw); setOfficeaceSTSURL(oldSTS) }()

	m := newTestManager(t).m
	flow, err := m.StartOfficeaceLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cred, err := m.RunOfficeaceLogin(ctx, flow, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if gotCode != "st-1" {
		t.Fatalf("code poll state = %q", gotCode)
	}
	if gotGrant != GrantAuthorizationCode || gotDPoP == "" {
		t.Fatalf("STS request wrong: grant=%q dpop=%q", gotGrant, gotDPoP)
	}
	if cred.ModelAppKey != "maas-key" || cred.ModelAppSecret != "maas-secret" {
		t.Fatalf("MaaS pair missing: %+v", cred)
	}
	if cred.MaasBaseUrl != "https://modelgw-1.officeace.example.com" {
		t.Fatalf("maasBaseUrl normalization wrong: %q", cred.MaasBaseUrl)
	}
	if cred.Access != "AKIAM" || cred.Secret != "SKIAM" || cred.SecurityToken != "STIAM" ||
		cred.ExpiresAt != "2030-01-01T00:00:00Z" || cred.RefreshToken != "RT-NEW" ||
		cred.AccountID != "acc-123456789" {
		t.Fatalf("credential assembly wrong: %+v", cred)
	}
	if cred.DpopPrivateJwk == nil || cred.DpopPrivateJwk.D != flow.DpopJwk.D {
		t.Fatal("DPoP key must be the SAME key the flow generated (refresh 复用)")
	}
	if !officeaceRefreshable(cred) {
		t.Fatal("credential should be refreshable")
	}
	// STS 过期时间直接透传为展示到期（ISO 字符串，不做 ms/s 归一化）。
	if ms, ok := officeaceExpiryMs(cred); !ok || ms != time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("expiry parse wrong: %d %v", ms, ok)
	}
}

// --- body 微调 + augmenter ---

// TestOfficeaceAdjustBody: 下限 4096（低于直接丢弃）+ reasoning_effort 剥除 +
// 无改动时逐字节透传。
func TestOfficeaceAdjustBody(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string // "" = byte-identical passthrough
	}{
		{"drop small max_tokens", `{"model":"m","max_tokens":512,"messages":[]}`, `{"messages":[],"model":"m"}`},
		{"keep big max_tokens", `{"model":"m","max_tokens":8192,"messages":[]}`, ""},
		{"drop reasoning_effort", `{"model":"m","reasoning_effort":"off","messages":[]}`, `{"messages":[],"model":"m"}`},
		{"drop both", `{"max_tokens":16,"reasoning_effort":"low","model":"m"}`, `{"model":"m"}`},
		{"clean body untouched", `{"model":"m","messages":[{"role":"user","content":"hi"}]}`, ""},
		{"empty body", ``, ""},
		{"not json", `beep`, ""},
		{"floor boundary dropped", `{"max_tokens":4095,"model":"m"}`, `{"model":"m"}`},
		{"floor kept", `{"max_tokens":4096,"model":"m"}`, ""},
	}
	for _, c := range cases {
		got := officeaceAdjustBody([]byte(c.in))
		if c.want == "" {
			if string(got) != c.in {
				t.Errorf("%s: expected passthrough, got %q", c.name, got)
			}
			continue
		}
		if string(got) != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

// TestOfficeaceAugment: Basic 鉴权头（base64(appKey:secret)）+ MaaS 头 + body
// 微调；凭据缺失时报「凭据不完整」（URL 选择不得抢在它前面）。
func TestOfficeaceAugment(t *testing.T) {
	m := newTestManager(t).m
	id, ref := NewAccountID("officeace")
	if err := m.AddAccount(Account{ID: id, Provider: "officeace", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	credJSON := []byte(`{"modelAppKey":"k1","modelAppSecret":"s1","maasBaseUrl":"modelgw-9.example.com"}`)
	if err := m.SetCredential("officeace", ref, credJSON, 0, true); err != nil {
		t.Fatal(err)
	}

	req, _ := http.NewRequest(http.MethodPost, "https://x/v1/chat/completions", nil)
	out, err := m.officeaceAugment(req, []byte(`{"model":"m","max_tokens":32,"messages":[]}`), ProviderID("officeace"), id, "m")
	if err != nil {
		t.Fatal(err)
	}
	wantBasic := base64.StdEncoding.EncodeToString([]byte("k1:s1"))
	if got := req.Header.Get("Authorization"); got != "Basic "+wantBasic {
		t.Errorf("Authorization = %q, want Basic %s", got, wantBasic)
	}
	if req.Header.Get("Content-Type") != "application/json" || req.Header.Get("Accept") != "text/event-stream" {
		t.Fatalf("MaaS headers wrong: %v", req.Header)
	}
	if strings.Contains(string(out), "max_tokens") || strings.Contains(string(out), "reasoning_effort") {
		t.Errorf("body tweaks not applied: %s", out)
	}

	// 大预算逐字节透传。
	req2, _ := http.NewRequest(http.MethodPost, "https://x/v1/chat/completions", nil)
	clean := []byte(`{"model":"m","messages":[]}`)
	out2, err := m.officeaceAugment(req2, clean, ProviderID("officeace"), id, "m")
	if err != nil || string(out2) != string(clean) {
		t.Errorf("clean body must pass through byte-for-byte: %q %v", out2, err)
	}

	// 缺 modelAppKey/secret → augmenter 报错（最终病因的唯一出口）。
	_, ref2 := NewAccountID("officeace")
	if err := m.AddAccount(Account{ID: "acct-broken", Provider: "officeace", Enabled: true, CredentialRef: ref2}); err != nil {
		t.Fatal(err)
	}
	if err := m.SetCredential("officeace", ref2, []byte(`{"access":"a"}`), 0, false); err != nil {
		t.Fatal(err)
	}
	req3, _ := http.NewRequest(http.MethodPost, "https://x/v1/chat/completions", nil)
	if _, err := m.officeaceAugment(req3, clean, ProviderID("officeace"), "acct-broken", "m"); err == nil {
		t.Fatal("incomplete credential must error from the augmenter")
	}
}

// TestOfficeaceCustomizeURL: per-account maasBaseUrl 优先（华为按账号下发专属
// 网关），凭据缺失回落声明值/默认值 —— URL 选择不得报错。
func TestOfficeaceCustomizeURL(t *testing.T) {
	m := newTestManager(t).m
	m.SetAugmenter("officeace", m.OfficeaceAugmentHook())
	id, ref := NewAccountID("officeace")
	if err := m.AddAccount(Account{ID: id, Provider: "officeace", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	if err := m.SetCredential("officeace", ref,
		[]byte(`{"modelAppKey":"k","modelAppSecret":"s","maasBaseUrl":"modelgw-7.example.com"}`), 0, true); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodPost, "https://tinylab.local/v1/chat/completions", nil)
	outURL, _, err := m.Customize(req, []byte(`{"model":"m","messages":[]}`), ProviderID("officeace"), id, "m")
	if err != nil {
		t.Fatal(err)
	}
	if outURL != "https://modelgw-7.example.com"+officeaceChatPath {
		t.Fatalf("per-account gateway must win: %q", outURL)
	}
	// 客户端请求对象不被污染（minimax/codearts 同款复原纪律）。
	if req.URL.String() != "https://tinylab.local/v1/chat/completions" {
		t.Fatalf("client URL mutated: %q", req.URL)
	}

	// 凭据无 maasBaseUrl → 默认网关。
	_, ref2 := NewAccountID("officeace")
	if err := m.AddAccount(Account{ID: "acct-def", Provider: "officeace", Enabled: true, CredentialRef: ref2}); err != nil {
		t.Fatal(err)
	}
	if err := m.SetCredential("officeace", ref2, []byte(`{"modelAppKey":"k","modelAppSecret":"s"}`), 0, true); err != nil {
		t.Fatal(err)
	}
	outURL, _, err = m.Customize(req, []byte(`{"model":"m","messages":[]}`), ProviderID("officeace"), "acct-def", "m")
	if err != nil {
		t.Fatal(err)
	}
	if outURL != officeaceDefaultBaseURL+officeaceChatPath {
		t.Fatalf("default fallback wrong: %q", outURL)
	}

	// 凭据缺失 → 仍回落默认 URL（错误由 augmenter 报）。
	outURL, _, err = m.Customize(req, []byte(`{"model":"m","messages":[]}`), ProviderID("officeace"), "acct-missing", "m")
	if err == nil {
		t.Fatalf("missing credential must error from the augmenter, got URL %q", outURL)
	}
}

// TestOfficeaceMaasBase: 归一化（trim / 尾斜杠 / 补 https://）。
func TestOfficeaceMaasBase(t *testing.T) {
	cases := map[string]string{
		"":                    officeaceDefaultBaseURL,
		"  ":                  officeaceDefaultBaseURL,
		"modelgw.example.com": "https://modelgw.example.com",
		"https://gw.io/":      "https://gw.io",
		" http://gw.io/ ":     "http://gw.io",
	}
	for in, want := range cases {
		if got := officeaceMaasBase(in); got != want {
			t.Errorf("officeaceMaasBase(%q) = %q, want %q", in, got, want)
		}
	}
}

// --- 续期三规则 ---

// officeaceSeedCred writes a full credential for accountID (fresh refs each call).
func officeaceSeedCred(t *testing.T, m *Manager, accountID string, cred *OfficeAceCredential) {
	t.Helper()
	_, ref := NewAccountID("officeace")
	if err := m.AddAccount(Account{ID: accountID, Provider: "officeace", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(cred)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.SetCredential("officeace", ref, raw, officeaceCredentialExpiresAt(cred), officeaceRefreshable(cred)); err != nil {
		t.Fatal(err)
	}
}

// officeaceTestCred builds a complete, refreshable credential.
func officeaceTestCred(t *testing.T, expiresAt string) *OfficeAceCredential {
	t.Helper()
	jwk, err := GenerateDpopKeyPair()
	if err != nil {
		t.Fatalf("generate dpop key: %v", err)
	}
	return &OfficeAceCredential{
		ModelAppKey: "k", ModelAppSecret: "s", MaasBaseUrl: "https://gw.example.com",
		Access: "AK-OLD", Secret: "SK-OLD", SecurityToken: "ST-OLD", ProjectID: "proj",
		ExpiresAt: expiresAt, RefreshToken: "RT-OLD", DpopPrivateJwk: &jwk,
	}
}

// TestOfficeaceRefreshRenewal: 到期在 lead 窗口内 → 换新并立即落盘（MaaS 对与
// maasBaseUrl 保留，STS 字段全换）；fresh 凭据跳过 STS 请求（规则 2）。
func TestOfficeaceRefreshRenewal(t *testing.T) {
	var stsCalls atomic.Int32
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stsCalls.Add(1)
		if r.FormValue("refresh_token") != "RT-OLD" || r.FormValue("grant_type") != GrantRefreshToken {
			t.Errorf("STS request wrong: %v", r.Form)
		}
		if r.Header.Get("DPoP") == "" {
			t.Error("DPoP header missing")
		}
		w.Write([]byte(`{"credentials":{"access_key_id":"AK-NEW","secret_access_key":"SK-NEW",
			"security_token":"ST-NEW","expiration":"2031-01-01T00:00:00Z","project_id":"proj"},
			"refresh_token":"RT-NEW"}`))
	}))
	defer sts.Close()
	// permission-validate 失败不回滚 STS（modelInfo 非致命）。
	claw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer claw.Close()

	oldSTS, oldClaw := officeaceSTSURL, officeaceClawBase
	setOfficeaceSTSURL(sts.URL)
	setClawBase(claw.URL)
	defer func() { setOfficeaceSTSURL(oldSTS); setClawBase(oldClaw) }()

	m := newTestManager(t).m
	// 已过期 ⇒ 必须续。
	officeaceSeedCred(t, m, "acct-r", officeaceTestCred(t, "2020-01-01T00:00:00Z"))
	if err := m.RefreshOfficeaceAccount(context.Background(), "acct-r"); err != nil {
		t.Fatal(err)
	}
	acc, _ := m.FindAccount("acct-r")
	raw, _ := m.Credential("officeace", acc.CredentialRef)
	var cred OfficeAceCredential
	if err := json.Unmarshal(raw, &cred); err != nil {
		t.Fatal(err)
	}
	if cred.Access != "AK-NEW" || cred.Secret != "SK-NEW" || cred.SecurityToken != "ST-NEW" || cred.RefreshToken != "RT-NEW" {
		t.Fatalf("renewal not persisted: %+v", cred)
	}
	if cred.ModelAppKey != "k" || cred.ModelAppSecret != "s" || cred.MaasBaseUrl != "https://gw.example.com" {
		t.Fatalf("MaaS pair / maasBaseUrl must survive renewal: %+v", cred)
	}
	if cred.DpopPrivateJwk == nil {
		t.Fatal("DPoP key must survive renewal")
	}
	if !acc.Refreshable {
		t.Fatal("account should stay refreshable")
	}

	// 第二次：新凭据在 2031 年（远未到期）→ lead-time 跳过，不发请求。
	before := stsCalls.Load()
	if err := m.RefreshOfficeaceAccount(context.Background(), "acct-r"); err != nil {
		t.Fatal(err)
	}
	if stsCalls.Load() != before {
		t.Fatal("fresh credential must skip the STS request (rule 2)")
	}
}

// TestOfficeaceRefreshTerminalVsRenewedElsewhere: invalid_grant 时先重读 ——
// refresh_token 已换 ⇒ 他处续期成功（nil，不作废）；未变 ⇒ 终态（Refreshable=false）。
func TestOfficeaceRefreshTerminalVsRenewedElsewhere(t *testing.T) {
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid_grant","error_code":"ExpiredRefreshToken"}`))
	}))
	defer sts.Close()
	oldSTS := officeaceSTSURL
	setOfficeaceSTSURL(sts.URL)
	defer setOfficeaceSTSURL(oldSTS)

	t.Run("token unchanged → terminal", func(t *testing.T) {
		m := newTestManager(t).m
		officeaceSeedCred(t, m, "acct-t", officeaceTestCred(t, "2020-01-01T00:00:00Z"))
		err := m.RefreshOfficeaceAccount(context.Background(), "acct-t")
		if err == nil || err != ErrRefreshTokenExpired {
			t.Fatalf("want ErrRefreshTokenExpired, got %v", err)
		}
		acc, _ := m.FindAccount("acct-t")
		if acc.Refreshable {
			t.Fatal("terminal failure must clear Refreshable")
		}
	})

	t.Run("token renewed elsewhere → not terminal", func(t *testing.T) {
		m := newTestManager(t).m
		officeaceSeedCred(t, m, "acct-e", officeaceTestCred(t, "2020-01-01T00:00:00Z"))
		acc, _ := m.FindAccount("acct-e")
		// 模拟「另一个进程在本次交换期间完成续期」：STS 处理器先把磁盘
		// refresh_token 换新，再返回 invalid_grant —— 本进程拿着旧 token 被拒、
		// 判终态前重读看到新值 ⇒「别人已经续成功」，不作废。
		other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			raw, _ := m.Credential("officeace", acc.CredentialRef)
			var cred OfficeAceCredential
			if err := json.Unmarshal(raw, &cred); err != nil {
				t.Error(err)
			}
			cred.RefreshToken = "RT-BY-OTHER-PROCESS"
			cred.Access = "AK-ELSEWHERE"
			fresh, _ := json.Marshal(cred)
			_ = m.SetCredential("officeace", acc.CredentialRef, fresh, officeaceCredentialExpiresAt(&cred), true)
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"invalid_grant","error_code":"ExpiredRefreshToken"}`))
		}))
		defer other.Close()
		setOfficeaceSTSURL(other.URL)

		if err := m.RefreshOfficeaceAccount(context.Background(), "acct-e"); err != nil {
			t.Fatalf("renewed-elsewhere must be nil, got %v", err)
		}
		acc2, _ := m.FindAccount("acct-e")
		if !acc2.Refreshable {
			t.Fatal("renewed-elsewhere must NOT clear Refreshable")
		}
	})
}

// TestOfficeaceRefreshAllSelfHeal: Refreshable 镜像按凭据对账（误标 false 的
// 账号下一轮自愈）。
func TestOfficeaceRefreshAllSelfHeal(t *testing.T) {
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"credentials":{"access_key_id":"AK-NEW","secret_access_key":"SK-NEW",
			"security_token":"ST-NEW","expiration":"2031-01-01T00:00:00Z"},
			"refresh_token":"RT-NEW"}`))
	}))
	defer sts.Close()
	claw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer claw.Close()
	oldSTS, oldClaw := officeaceSTSURL, officeaceClawBase
	setOfficeaceSTSURL(sts.URL)
	setClawBase(claw.URL)
	defer func() { setOfficeaceSTSURL(oldSTS); setClawBase(oldClaw) }()

	m := newTestManager(t).m
	officeaceSeedCred(t, m, "acct-h", officeaceTestCred(t, "2020-01-01T00:00:00Z"))
	acc, _ := m.FindAccount("acct-h")
	if err := m.UpdateAccount(acc.ID, func(a *Account) { a.Refreshable = false }); err != nil {
		t.Fatal(err)
	}
	m.RefreshAllOfficeace(context.Background())
	acc, _ = m.FindAccount("acct-h")
	if !acc.Refreshable {
		t.Fatal("refreshable mirror must self-heal from the credential")
	}
}

// TestOfficeaceShouldRefreshNow: 未知到期立即续；lead 窗口外跳过。
func TestOfficeaceShouldRefreshNow(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC).UnixMilli()
	cases := []struct {
		expiresAt string
		want      bool
	}{
		{"", true},
		{"garbage", true},
		{"2026-10-15T12:29:00Z", true},  // < 1h lead
		{"2026-10-15T13:00:00Z", true},  // 恰在 1h lead 边界
		{"2026-10-15T13:00:01Z", false}, // 刚出 lead
		{"2030-01-01T00:00:00Z", false},
	}
	for _, c := range cases {
		cred := &OfficeAceCredential{ExpiresAt: c.expiresAt}
		if got := officeaceShouldRefreshNow(cred, now); got != c.want {
			t.Errorf("officeaceShouldRefreshNow(%q) = %v, want %v", c.expiresAt, got, c.want)
		}
	}
}

// --- 余额 / 领取 ---

// TestParseOfficeaceSubscription: 套餐桶（officeace_points）+ 活动桶 + 过期桶
// 归 ExpiredTotal + trial 无到期 + used 扣减；单位恒为 token。
func TestParseOfficeaceSubscription(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC).UnixMilli()
	raw := []byte(`{"skus":[
		{"sku_name":"旗舰档","sku_code":"pkg.main","quotas":[
			{"sku_attr_code":"officeace_points","sku_value":"1000000","current_value":250000,
			 "expired_time":"2030-01-01T00:00:00Z"},
			{"sku_attr_code":"officeace_points","sku_value":"50000","current_value":50000,
			 "expired_time":"2026-10-01T00:00:00Z"},
			{"sku_attr_code":"other_attr","sku_value":"1","current_value":"0"}]},
		{"sku_code":"pkg.trial","quotas":[
			{"sku_attr_code":"officeace_points","sku_value":300000,"current_value":100000}]},
		{"sku_name":"过期套餐","sku_code":"pkg.old","quotas":[
			{"sku_attr_code":"officeace_points","sku_value":8000,"current_value":3000,
			 "expired_time":"2026-10-10T00:00:00Z"}]}],
		"bonus_skus":[
			{"activity_id":"a1","activity_name":"每日奖励","points":"20000","current_value":5000,
			 "expired_time":"2026-10-15T23:59:59Z"},
			{"activity_name":"已过期活动","points":9999,"current_value":0,
			 "expired_time":"2026-10-01T00:00:00Z"}]}`)
	bal := parseOfficeaceSubscription(raw, now)
	if bal == nil {
		t.Fatal("usable buckets exist, parser returned nil")
	}
	if bal.Total != 750000+200000+15000 {
		t.Fatalf("Total = %v, want %v", bal.Total, 750000+200000+15000)
	}
	if bal.ExpiredTotal != 5000+9999 {
		t.Fatalf("ExpiredTotal = %v, want %v", bal.ExpiredTotal, 5000+9999)
	}
	if len(bal.Packages) != 3 {
		t.Fatalf("Packages = %d, want 3 (plan usable + trial + bonus)", len(bal.Packages))
	}
	for _, pkg := range bal.Packages {
		if pkg.Unit != "token" {
			t.Errorf("unit = %q, want token", pkg.Unit)
		}
	}
	// trial 桶不臆造到期时刻（DeductionEndTime == 0）。
	var trial *CreditPackage
	for i := range bal.Packages {
		if bal.Packages[i].Total == 300000 {
			trial = &bal.Packages[i]
		}
	}
	if trial == nil || trial.DeductionEndTime != 0 {
		t.Fatalf("trial bucket expiry must stay unset: %+v", trial)
	}
	// 过期桶不进 Packages。
	for _, pkg := range bal.Packages {
		if pkg.ExpiresAt == "2026-10-01T00:00:00Z" && pkg.Total == 50000 {
			t.Fatalf("expired plan bucket leaked into Packages: %+v", pkg)
		}
	}
	// 无可用桶 → nil。
	if parseOfficeaceSubscription([]byte(`{"skus":[]}`), now) != nil {
		t.Fatal("empty subscription must parse to nil")
	}
	if parseOfficeaceSubscription([]byte(`zzz`), now) != nil {
		t.Fatal("bad JSON must parse to nil")
	}
}

// TestOfficeaceBalanceFlow: GET /v1/subscription 打**默认域**（V11 管理面永不
// 跟随 maasBaseUrl）+ V11 头集合（GET 无 Content-Type）。
func TestOfficeaceBalanceFlow(t *testing.T) {
	var gotHost, gotCT, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		gotCT = r.Header.Get("Content-Type")
		gotAuth = r.Header.Get("Authorization")
		w.Write([]byte(`{"skus":[{"sku_name":"p","sku_code":"pkg","quotas":[
			{"sku_attr_code":"officeace_points","sku_value":1000,"current_value":100}]}]}`))
	}))
	defer srv.Close()
	old := officeaceDefaultBaseURL
	setOfficeaceBase(srv.URL)
	defer setOfficeaceBase(old)

	m := newTestManager(t).m
	seed := officeaceTestCred(t, "2020-01-01T00:00:00Z")
	seed.MaasBaseUrl = "https://per-account-gateway.example.com" // 故意不同域
	officeaceSeedCred(t, m, "acct-b", seed)
	bal, err := m.OfficeaceBalance(context.Background(), "acct-b")
	if err != nil {
		t.Fatal(err)
	}
	if bal.Total != 900 {
		t.Fatalf("Total = %v, want 900", bal.Total)
	}
	if !strings.Contains(gotHost, "127.0.0.1") {
		t.Fatalf("management face must hit the DEFAULT base (mock), got host %q", gotHost)
	}
	if gotCT != "" {
		t.Fatalf("V11 GET must not send Content-Type, got %q", gotCT)
	}
	if !strings.HasPrefix(gotAuth, "V11-HMAC-SHA256 Credential=AK-OLD/") {
		t.Fatalf("V11 Authorization wrong: %q", gotAuth)
	}
	// 凭据不可用 → 明确报错（静默空串会把病因藏起来）。
	_, ref := NewAccountID("officeace")
	_ = m.AddAccount(Account{ID: "acct-nocred", Provider: "officeace", Enabled: true, CredentialRef: ref})
	if _, err := m.OfficeaceBalance(context.Background(), "acct-nocred"); err == nil {
		t.Fatal("missing credential must error")
	}
}

// TestOfficeaceClaimDailyFlow: POST 必带 Content-Type；新桶 → claimed；
// 空桶 → already-claimed（200 无新领取）。
func TestOfficeaceClaimDailyFlow(t *testing.T) {
	var mu sync.Mutex
	var gotMethod, gotCT, gotPath string
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		gotMethod, gotPath = r.Method, r.URL.Path
		gotCT = r.Header.Get("Content-Type")
		calls++
		resp := `{"bonus_skus":[{"activity_name":"每日奖励","points":"3000"}]}`
		if calls > 1 {
			resp = `{"bonus_skus":[]}`
		}
		w.Write([]byte(resp))
	}))
	defer srv.Close()
	old := officeaceDefaultBaseURL
	setOfficeaceBase(srv.URL)
	defer setOfficeaceBase(old)

	m := newTestManager(t).m
	officeaceSeedCred(t, m, "acct-c", officeaceTestCred(t, "2020-01-01T00:00:00Z"))

	out, err := m.OfficeaceClaimDaily(context.Background(), "acct-c")
	if err != nil {
		t.Fatal(err)
	}
	if out.Kind != "claimed" || out.Credit != 3000 {
		t.Fatalf("claim outcome wrong: %+v", out)
	}
	mu.Lock()
	method, path, ct := gotMethod, gotPath, gotCT
	mu.Unlock()
	if method != http.MethodPost || path != officeaceClaimPath {
		t.Fatalf("claim endpoint = %s %s", method, path)
	}
	if ct == "" {
		t.Fatal("POST 必带 Content-Type（实测不带是 500 OfficeAce.11020001）")
	}

	out, err = m.OfficeaceClaimDaily(context.Background(), "acct-c")
	if err != nil {
		t.Fatal(err)
	}
	if out.Kind != "already-claimed" {
		t.Fatalf("second claim must be already-claimed, got %+v", out)
	}
}

// --- 产品表 / 元数据 ---

// TestOfficeaceModelTable: 8 个模型、ID 唯一、QuotaType 全 limited、多模态只在
// 实测通过的两个模型上标注；产品表登记与模型表一致。
func TestOfficeaceModelTable(t *testing.T) {
	names := officeaceDisplayNames()
	if len(names) != 8 {
		t.Fatalf("model table = %d entries, want 8", len(names))
	}
	seen := map[string]bool{}
	multimodal := 0
	for _, md := range officeaceModelTable {
		if seen[md.ID] {
			t.Errorf("duplicate model id %q", md.ID)
		}
		seen[md.ID] = true
		if md.Alias == "" {
			t.Errorf("model %q missing display name", md.ID)
		}
		if md.QuotaType != "limited" {
			t.Errorf("model %q quota type = %q, want limited", md.ID, md.QuotaType)
		}
		if !strings.Contains(md.Note, "ctx") {
			t.Errorf("model %q note missing ctx marker: %q", md.ID, md.Note)
		}
		if strings.Contains(md.Note, "image in") {
			multimodal++
			if md.ID != "deepseek-v4.1-flash" && md.ID != "kimi-k2.6" {
				t.Errorf("unexpected multimodal entry %q（只有实测通过的两个）", md.ID)
			}
		}
	}
	if multimodal != 2 {
		t.Fatalf("multimodal entries = %d, want 2", multimodal)
	}
	// 产品表已注册且模型表一致（RegisterDefaultProducts 的 officeace 行）。
	m := newTestManager(t).m
	b := NewBridge(m, newFakeRegistry())
	RegisterDefaultProducts(b)
	prod, ok := b.Product("officeace")
	if !ok {
		t.Fatal("officeace product not registered")
	}
	if len(prod.Models) != len(officeaceModelTable) {
		t.Fatal("product model table diverged from officeaceModelTable")
	}
	if prod.InferURL != officeaceDefaultBaseURL+officeaceChatPath {
		t.Fatalf("declared InferURL = %q", prod.InferURL)
	}
}

// TestOfficeaceCompleteLoginNickname: 登录完成回填昵称（"OfficeAce " + 前 8 位）
// 并持久化展示字段。
func TestOfficeaceCompleteLoginNickname(t *testing.T) {
	m := newTestManager(t).m
	id, ref := NewAccountID("officeace")
	if err := m.AddAccount(Account{ID: id, Provider: "officeace", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	cred := officeaceTestCred(t, "2030-01-01T00:00:00Z")
	cred.AccountID = "abcdefgh12345678"
	raw, _ := json.Marshal(cred)
	if err := m.CompleteOfficeaceLogin(id, raw, 12345, true); err != nil {
		t.Fatal(err)
	}
	acc, _ := m.FindAccount(id)
	if want := "OfficeAce " + "abcdefgh12345678"[:8]; acc.Nickname != want {
		t.Fatalf("nickname = %q, want %q", acc.Nickname, want)
	}
	if acc.ExpiresAt != 12345 || !acc.Refreshable {
		t.Fatalf("display fields not persisted: expires=%d refreshable=%v", acc.ExpiresAt, acc.Refreshable)
	}
}

// TestOfficeaceTokenExtractor: 无 access_token 字段的凭据必须能被桥接
// （modelAppKey 优先，codearts 缺陷 15 同款防线）。
func TestOfficeaceTokenExtractor(t *testing.T) {
	m := newTestManager(t).m
	reg := newFakeRegistry()
	b := NewBridge(m, reg)
	RegisterDefaultProducts(b)
	id, ref := NewAccountID("officeace")
	if err := m.AddAccount(Account{ID: id, Provider: "officeace", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	if err := m.SetCredential("officeace", ref, []byte(`{"modelAppKey":"maas-key-1","modelAppSecret":"s"}`), 0, true); err != nil {
		t.Fatal(err)
	}
	if err := b.SetPrefix("officeace", "officeace"); err != nil {
		t.Fatal(err)
	}
	p, ok := reg.GetProvider(ProviderID("officeace"))
	if !ok || len(p.Keys) != 1 || p.Keys[0].Key != "maas-key-1" {
		t.Fatalf("bridged key wrong: %+v ok=%v", p, ok)
	}
}

// TestOfficeaceProbeBody: 探针 body 流式（ref 只发流式请求）+ 无 max_tokens
// （低于下限会被 augmenter 丢弃，不如一开始就不发）。
func TestOfficeaceProbeBody(t *testing.T) {
	path, body := probeEntryPath("officeace", "glm-5.3")
	if path != "/v1/chat/completions" {
		t.Fatalf("probe path = %q", path)
	}
	var obj map[string]any
	if err := json.Unmarshal(body, &obj); err != nil {
		t.Fatal(err)
	}
	if obj["stream"] != true {
		t.Fatalf("officeace probe must stream, got %v", obj["stream"])
	}
	if _, ok := obj["max_tokens"]; ok {
		t.Fatal("probe body must not carry max_tokens (below the floor anyway)")
	}
	if obj["model"] != "glm-5.3" {
		t.Fatalf("probe model = %v", obj["model"])
	}
}
