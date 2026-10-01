package jethub

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// --- CAccount 签名（HMAC-SHA1，拼串格式锁死） ---

func TestLoomySigningStringFormat(t *testing.T) {
	// 9 段 \n 连接；末两段恒空 ⇒ 字符串以两个换行结尾（去掉即签名失效）。
	got := BuildLoomySigningString("AK", "POST", "/login/phone/sendMsgCode", nil,
		`{"base":{}}`, "application/json", "Mon, 02 Jan 2006 15:04:05 GMT", "nonce-1")
	parts := strings.Split(got, "\n")
	if len(parts) != 9 {
		t.Fatalf("9 segments required: %d", len(parts))
	}
	if parts[0] != "POST" || parts[1] != "/login/phone/sendMsgCode" {
		t.Fatalf("head wrong: %q", parts[0:2])
	}
	// Content-MD5 of `{"base":{}}` 非空。
	if parts[3] == "" {
		t.Fatal("body md5 segment missing")
	}
	if parts[5] != "Mon, 02 Jan 2006 15:04:05 GMT" || parts[6] != "nonce-1" {
		t.Fatalf("date/nonce wrong: %q %q", parts[5], parts[6])
	}
	// ⚠️ 尾随两个空段（join 产出以 \n\n 结尾）。
	if !strings.HasSuffix(got, "\n\n") {
		t.Fatal("⚠️ 签名串必须以两个换行结尾（signedHeaders/canonicalizedHeaders 恒空段）")
	}
}

func TestLoomyContentMd5EmptyBody(t *testing.T) {
	// ⚠️ 空 body → 空串（不是空串的 md5）。
	if got := loomyContentMd5(""); got != "" {
		t.Fatalf("empty body md5 must be empty: %q", got)
	}
	if got := loomyContentMd5("{}"); got == "" {
		t.Fatal("non-empty body must produce md5")
	}
}

func TestEscapeRFC3986(t *testing.T) {
	// !'()* 五字符必须补转（encodeURIComponent 不覆盖）。
	if got := escapeRFC3986("a!b'c(d)e*f"); got != "a%21b%27c%28d%29e%2Af" {
		t.Fatalf("rfc3986 wrong: %q", got)
	}
}

func TestBuildEscapedPath(t *testing.T) {
	if got := buildEscapedPath("login/phone/sendMsgCode"); got != "/login/phone/sendMsgCode" {
		t.Fatalf("leading slash: %q", got)
	}
	if got := buildEscapedPath("/a/b/"); got != "/a/b" {
		t.Fatalf("trailing slash stripped (len>1): %q", got)
	}
	if got := buildEscapedPath("/"); got != "/" {
		t.Fatalf("root stays: %q", got)
	}
}

// --- 信封：业务失败恒 HTTP 200，只认 body code（字符串 '000000'） ---

func TestParseLoomyEnvelope(t *testing.T) {
	data, _, _, ok := parseLoomyEnvelope(map[string]any{"code": "000000", "data": map[string]any{"x": 1}})
	if !ok || data == nil {
		t.Fatalf("ok envelope wrong: %v %v", ok, data)
	}
	if _, _, msg2, ok2 := parseLoomyEnvelope(map[string]any{"code": "100002", "desc": "登录失效"}); ok2 || !strings.Contains(msg2, "登录失效") {
		t.Fatalf("failure envelope wrong: %v %q", ok2, msg2)
	}
	// desc 字段优先于 message（loomy 用 desc）。
	if _, _, msg3, _ := parseLoomyEnvelope(map[string]any{"code": "100001", "desc": "参数错误", "message": "ignored"}); !strings.Contains(msg3, "参数错误") {
		t.Fatalf("desc must win: %q", msg3)
	}
}

// --- 短信登录流 mock（msgid 回传 + expires_at 本地 14 天推算） ---

func TestLoomySmsLoginMock(t *testing.T) {
	m := newTestManager(t).m
	id, _ := NewAccountID("loomy")
	_ = m.AddAccount(Account{ID: id, Provider: "loomy", Enabled: true, CredentialRef: "X"})

	var sendBody, checkBody map[string]any
	var dailyQuotaInitialized bool
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/sendMsgCode"):
			_ = json.NewDecoder(r.Body).Decode(&sendBody)
			w.Write([]byte(`{"code":"000000","data":{"msgid":"msg-1"}}`))
		case strings.HasSuffix(r.URL.Path, "/checkCode"):
			_ = json.NewDecoder(r.Body).Decode(&checkBody)
			// msgid 必须与下发时一致（原样带回）。
			if checkBody["param"] != nil {
				if p, ok := checkBody["param"].(map[string]any); ok && p["msgid"] != "msg-1" {
					t.Errorf("msgid must echo: %v", p["msgid"])
				}
			}
			w.Write([]byte(`{"code":"000000","data":{"session":"` + strings.Repeat("ab", 16) + `","userid":"123456789012345678"}}`))
		case strings.HasSuffix(r.URL.Path, "/first-login"):
			dailyQuotaInitialized = true
			w.Write([]byte(`{"code":"000000","data":{"dailyQuota":5000,"dailyBalance":5000,"alreadyProcessed":false}}`))
		default:
			w.WriteHeader(404)
		}
	})
	restoreLoomyAccountBase(t, srv.URL)
	// first-login 挂业务基址——同样指到 mock。
	restoreLoomyAPIBase(t, srv.URL)

	// 1. 下发验证码。
	msgid, err := m.SendLoomySmsCode(context.Background(), "13011111100")
	if err != nil {
		t.Fatal(err)
	}
	if msgid != "msg-1" {
		t.Fatalf("msgid = %q", msgid)
	}
	// base 信封形态：appid/modelid/ua 硬编码 macOS。
	base, _ := sendBody["base"].(map[string]any)
	if base["appid"] != "GM3LOOMY" || base["ua"] != "Loomy|Desktop|Electron|macOS" {
		t.Fatalf("account base envelope wrong: %v", base)
	}

	// 2. 用验证码登录。
	if err := m.SubmitLoomySmsLogin(context.Background(), id, "13011111100", "4321", msgid); err != nil {
		t.Fatal(err)
	}
	acc, ok := m.FindAccount(id)
	if !ok {
		t.Fatal("account gone")
	}
	// refreshable 恒 false（诚实标记：无续期机制）。
	if acc.Refreshable {
		t.Fatal("⚠️ loomy 无续期端点，refreshable 必须恒 false")
	}
	// 昵称 = 手机号（Loomy 无昵称接口）。
	if acc.Nickname != "13011111100" {
		t.Fatalf("nickname = phone expected: %q", acc.Nickname)
	}
	// expires_at = 登录 + 14 天（服务端不回传）。
	cred, ok2 := m.Credential("loomy", refOf(t, m, "loomy", id))
	if !ok2 {
		t.Fatal("credential missing")
	}
	var parsed LoomyCredential
	_ = json.Unmarshal(cred, &parsed)
	if got := LoomyExpiresAtMs(&parsed); got < nowMillis()+12*24*3600*1000 {
		t.Fatalf("expires_at must be ~14 days out: %d", got)
	}
	// 3. 登录后尽力初始化每日额度（官方行为一致）。
	if !dailyQuotaInitialized {
		t.Fatal("first-login quota initialization expected after login")
	}
	// checkCode 的 expire 参数 = 1209600。
	if p, ok3 := checkBody["param"].(map[string]any); ok3 && p["expire"].(float64) != 1209600 {
		t.Fatalf("expire param wrong: %v", p["expire"])
	}
}

// --- 每日额度：语义是重置不是 +5000；幂等判据 alreadyProcessed ---

func TestClaimLoomyDailyIdempotent(t *testing.T) {
	m := newSeedLoomyManager(t)
	id := firstLoomyAccount(t, m)

	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		// 重复调用同样 HTTP 200（幂等）。
		w.Write([]byte(`{"code":"000000","data":{"alreadyProcessed":true,"dailyQuota":5000,"dailyBalance":4992}}`))
	})
	restoreLoomyAPIBase(t, srv.URL)

	outcome, err := m.ClaimLoomyDaily(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "already-claimed" {
		t.Fatalf("⚠️ alreadyProcessed → already-claimed（claimed 会让用户以为每天真加了额度）: %+v", outcome)
	}
}

func TestClaimLoomyDailyFirstTime(t *testing.T) {
	m := newSeedLoomyManager(t)
	id := firstLoomyAccount(t, m)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":"000000","data":{"dailyQuota":5000,"dailyConsumed":8,"alreadyProcessed":false}}`))
	})
	restoreLoomyAPIBase(t, srv.URL)
	outcome, err := m.ClaimLoomyDaily(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "claimed" || outcome.Credit != 4992 {
		t.Fatalf("credit = quota - consumed: %+v", outcome)
	}
}

// --- 余额：两池分开显示 + 用只读端点（first-login 是写端点！） ---

func TestLoomyBalanceTwoPools(t *testing.T) {
	var gotPath string
	m := newSeedLoomyManager(t)
	id := firstLoomyAccount(t, m)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path + "?" + r.URL.RawQuery
		w.Write([]byte(`{"code":"000000","data":{"balance":15000,"dailyBalance":4992,"availableBalance":19992}}`))
	})
	restoreLoomyAPIBase(t, srv.URL)

	bal, err := m.LoomyCreditBalance(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	// ⚠️ 必须用只读 points/records（打开面板高频路径调写端点会意外签到）。
	if !strings.Contains(gotPath, "points/records") {
		t.Fatalf("balance must read points/records: %s", gotPath)
	}
	if bal.Total != 19992 {
		t.Fatalf("total = availableBalance: %v", bal.Total)
	}
	if len(bal.Packages) != 2 {
		t.Fatalf("two pools expected: %v", bal.Packages)
	}
	if bal.Packages[0].Name != "永久积分" || bal.Packages[1].Name != "每日赠送" {
		t.Fatalf("pool names: %v %v", bal.Packages[0].Name, bal.Packages[1].Name)
	}
}

// --- 探测（不续期）：100002 = 终态；网络失败非终态 ---

func TestProbeLoomyCredential(t *testing.T) {
	m := newSeedLoomyManager(t)
	id := firstLoomyAccount(t, m)

	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":"100002","desc":"登录已失效"}`))
	})
	restoreLoomyAPIBase(t, srv.URL)
	if err := m.ProbeLoomyAccount(context.Background(), id); err != ErrRefreshTokenExpired {
		t.Fatalf("100002 must be terminal re-login: %v", err)
	}

	srv2 := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":"000000"}`))
	})
	restoreLoomyAPIBase(t, srv2.URL)
	if err := m.ProbeLoomyAccount(context.Background(), id); err != nil {
		t.Fatalf("ok probe: %v", err)
	}
}

// --- 新手任务（一次性，与每日签到独立） ---

func TestLoomyOnboarding(t *testing.T) {
	m := newSeedLoomyManager(t)
	id := firstLoomyAccount(t, m)
	var completed []string
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/onboarding/tasks") && r.Method == http.MethodGet:
			w.Write([]byte(`{"code":"000000","data":{"tasks":{"first_message":true,"pick_skill":true},"earned":1000,"total":10000}}`))
		case strings.HasSuffix(r.URL.Path, "/tasks/complete"):
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			completed = append(completed, body["key"])
			w.Write([]byte(`{"code":"000000","data":{"alreadyCompleted":false,"balance":1000}}`))
		default:
			w.WriteHeader(404)
		}
	})
	restoreLoomyAPIBase(t, srv.URL)

	tasks, earned, total, err := m.LoomyOnboardingStatus(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if !tasks["first_message"] || !tasks["pick_skill"] {
		t.Fatalf("task states wrong: %v", tasks)
	}
	if tasks["generate_ppt"] {
		t.Fatal("generate_ppt should be pending")
	}
	// earned = 本地现算（500 + 1000 = 1500），不采信服务端。
	if earned != 1500 {
		t.Fatalf("earned = %v (500+1000)", earned)
	}
	if total != 10000 {
		t.Fatalf("total = %v", total)
	}

	claimed, skipped, _, _, err := m.ClaimLoomyOnboarding(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 6 || len(skipped) != 2 {
		t.Fatalf("claimed=%d skipped=%d", len(claimed), len(skipped))
	}
}

// --- augment：双头（Authorization Bearer 必须带前缀 + token 头） ---

func TestLoomyAugment(t *testing.T) {
	m := newSeedLoomyManager(t)
	id := firstLoomyAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://loomyad.xunfei.cn/api/v1/chat/completions", nil)
	out, err := m.loomyAugment(req, []byte(`{"m":1}`), "jethub-loomy", id, "spark-x")
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != `{"m":1}` {
		t.Fatal("standard OpenAI body passes through")
	}
	// ⚠️ 两个头都发（官方客户端 session 模式同形）。
	if req.Header.Get("Authorization") != "Bearer "+strings.Repeat("ab", 16) {
		t.Fatalf("Bearer required: %q", req.Header.Get("Authorization"))
	}
	if req.Header.Get("token") != strings.Repeat("ab", 16) {
		t.Fatal("token header required")
	}
	if req.Header.Get("Accept") != "text/event-stream" {
		t.Fatal("SSE accept expected")
	}
}

// --- 测试基建 ---

func restoreLoomyAPIBase(t *testing.T, mockURL string) {
	t.Helper()
	old := loomyProduct.APIBase
	loomyProduct.APIBase = mockURL
	t.Cleanup(func() { loomyProduct.APIBase = old })
}

func restoreLoomyAccountBase(t *testing.T, mockURL string) {
	t.Helper()
	old := loomyProduct.AccountBase
	loomyProduct.AccountBase = mockURL
	t.Cleanup(func() { loomyProduct.AccountBase = old })
}

func newSeedLoomyManager(t *testing.T) *Manager {
	t.Helper()
	m := newTestManager(t).m
	id, ref := NewAccountID("loomy")
	if err := m.AddAccount(Account{ID: id, Provider: "loomy", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	cred := BuildLoomyCredential(strings.Repeat("ab", 16), "123456789012345678", "13011111100", "")
	data, _ := json.Marshal(cred)
	if err := m.SetCredential("loomy", ref, data, LoomyExpiresAtMs(cred), LoomyRefreshable()); err != nil {
		t.Fatal(err)
	}
	return m
}

func firstLoomyAccount(t *testing.T, m *Manager) string {
	t.Helper()
	accounts := m.Accounts("loomy")
	if len(accounts) == 0 {
		t.Fatal("no seeded loomy account")
	}
	return accounts[0].ID
}

func refOf(t *testing.T, m *Manager, provider, accountID string) string {
	t.Helper()
	acc, ok := m.FindAccount(accountID)
	if !ok {
		t.Fatal("account missing")
	}
	return acc.CredentialRef
}
