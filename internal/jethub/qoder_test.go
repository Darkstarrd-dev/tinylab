package jethub

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// --- ParseQueueError：双形态 + 递归穿透（三次回归的判据核心） ---

func TestParseQueueErrorOuterEnvelope(t *testing.T) {
	// 形态 1：外层 {"code":"10605","message":"{内层 JSON 字符串}"}。
	body := `{"code":"10605","message":"{\"isQueued\":true,\"retryAfterSeconds\":30,\"modelKey\":\"qfmodel\"}"}`
	info := ParseQueueError(body)
	if info == nil {
		t.Fatal("outer envelope must parse")
	}
	if info.RetryAfterSeconds != 30 {
		t.Fatalf("retryAfterSeconds = %d", info.RetryAfterSeconds)
	}
	if info.ModelKey != "qfmodel" {
		t.Fatalf("modelKey = %q", info.ModelKey)
	}
}

func TestParseQueueErrorInnerMessageNoCode(t *testing.T) {
	// 形态 2：内层消息无 code —— 要求命中 code 会静默失效（第一版回归）。
	info := ParseQueueError(`{"isQueued":true,"retryAfterSeconds":2,"serviceAvailable":false}`)
	if info == nil {
		t.Fatal("inner message (no code) must parse")
	}
	if info.RetryAfterSeconds != 2 {
		t.Fatalf("delay = %d (want 2)", info.RetryAfterSeconds)
	}
}

func TestParseQueueErrorDoubleNested403(t *testing.T) {
	// ⚠️ 第三次回归：顶层 code 是 403，10605 在 message 里嵌两层。
	body := `{"code":403,"message":"{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":true,\\\"retryAfterSeconds\\\":30}\"}","type":"model_error"}`
	info := ParseQueueError(body)
	if info == nil {
		t.Fatal("nested 403 envelope must parse (parseQueueError 自行判定,不用 code 门禁)")
	}
	if info.RetryAfterSeconds != 30 {
		t.Fatalf("delay = %d", info.RetryAfterSeconds)
	}
}

func TestParseQueueErrorTransientQueueing(t *testing.T) {
	// ⚠️ 瞬时排队 isQueued:false（"一次重试就成功"形态）——判据不能要求 true。
	info := ParseQueueError(`{"isQueued":false,"serviceAvailable":true,"waitTime":0,"retryAfterSeconds":2}`)
	if info == nil || info.RetryAfterSeconds != 2 {
		t.Fatalf("transient queueing: %v", info)
	}
}

func TestParseQueueErrorNonQueue(t *testing.T) {
	if ParseQueueError(`{"code":105,"message":"auth error"}`) != nil {
		t.Fatal("auth error is not queueing")
	}
	if ParseQueueError(`not json`) != nil {
		t.Fatal("non-json is not queueing")
	}
}

// --- QueueDelayMS：优先序 + 封顶 + 非法值忽略 ---

func TestQueueDelayMS(t *testing.T) {
	cases := []struct {
		name string
		info *QueueInfo
		want int64
		ok   bool
	}{
		{"seconds", &QueueInfo{RetryAfterSeconds: 2, HasDelay: false}, 2000, true},
		{"ms priority", &QueueInfo{RetryAfterMs: 1500, RetryAfterSeconds: 30, HasDelay: true}, 1500, true},
		{"clamp 30s → 10s", &QueueInfo{RetryAfterSeconds: 30}, 10000, true},
		{"illegal ignored", &QueueInfo{RetryAfterSeconds: -5}, 0, false},
		{"nil", nil, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := QueueDelayMS(c.info)
			if got != c.want || ok != c.ok {
				t.Fatalf("got %d/%v want %d/%v", got, ok, c.want, c.ok)
			}
		})
	}
}

// --- 额度错误：码与文案双判据 + 窄关键词 ---

func TestBillingDetection(t *testing.T) {
	if !IsBillingBusinessCode("110") || !IsBillingBusinessCode(110.0) {
		t.Fatal("both encodings")
	}
	if IsBillingBusinessCode(10605.0) {
		t.Fatal("10605 is queueing, not billing")
	}
	if !LooksLikeBillingError("Billing daily count exceeded") {
		t.Fatal("text fallback")
	}
	if LooksLikeBillingError("your balance is low") {
		t.Fatal("⚠️ 泛词（balance/quota）会误伤模型正文——必须窄")
	}
	if LooksLikeBillingError("讨论一下 daily quota 的设计") {
		t.Fatal("泛词误伤检查")
	}
}

// --- UTC+8 日界（算术非 setHours） ---

func TestNextUtc8DayStartMs(t *testing.T) {
	// 2026-09-28 15:30 UTC = 23:30 UTC+8 → 次日 00:00 UTC+8 = 30 分钟后。
	now := parseISOTime("2026-09-28T15:30:00Z")
	got := NextUtc8DayStartMs(now)
	want := parseISOTime("2026-09-28T16:00:00Z")
	if got != want {
		t.Fatalf("23:30 CST → next midnight: got %d want %d", got, want)
	}
	// 严格大于 now。
	if got <= now {
		t.Fatal("must be strictly future")
	}
	// 任意时刻都在未来 24h 内。
	now2 := parseISOTime("2026-09-28T01:00:00Z") // 09:00 CST
	if g2 := NextUtc8DayStartMs(now2); g2 != parseISOTime("2026-09-28T16:00:00Z") {
		t.Fatalf("09:00 CST: %d", g2)
	}
}

// --- PKCE（43..128 长度、无 padding challenge） ---

func TestCreateQoderPKCE(t *testing.T) {
	v, c, err := CreateQoderPKCE()
	if err != nil {
		t.Fatal(err)
	}
	if len(v) < 43 || len(v) > 128 {
		t.Fatalf("verifier length %d out of [43,128]", len(v))
	}
	if strings.ContainsAny(c, "+/=") {
		t.Fatalf("challenge must be unpadded base64url: %q", c)
	}
	// challenge = sha256(verifier) base64url。
	decoded, _ := base64URLDecode(c)
	if len(decoded) != 32 {
		t.Fatalf("challenge must decode to 32 bytes: %d", len(decoded))
	}
}

func base64URLDecode(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(s)
}

// --- auth URL：client_id 必须是 J_a（prod） ---

func TestBuildQoderAuthURLClientID(t *testing.T) {
	session := &qoderDeviceSession{Verifier: "v", Challenge: "c", Nonce: "n", MachineID: "m"}
	urlStr := BuildQoderAuthURL(session, qoderProducts["qoder"])
	if !strings.Contains(urlStr, "client_id="+qoderProducts["qoder"].ClientID) {
		t.Fatalf("⚠️ client_id 必须是 prod 值 J_a（G_a 在授权回调阶段报参数无效）: %s", urlStr)
	}
	if !strings.Contains(urlStr, "challenge_method=S256") {
		t.Fatalf("S256 method required: %s", urlStr)
	}
	// CN 用自己的 client id。
	cnURL := BuildQoderAuthURL(session, qoderProducts["qodercn"])
	if !strings.Contains(cnURL, "client_id=732aef47") {
		t.Fatalf("CN client id: %s", cnURL)
	}
	if !strings.HasPrefix(cnURL, "https://qoder.cn/device/selectAccounts") {
		t.Fatalf("CN auth base: %s", cnURL)
	}
}

// --- poll URL：挂 openApiBase（qoder.com 同路径 401！） ---

func TestBuildQoderPollURLHost(t *testing.T) {
	session := &qoderDeviceSession{Verifier: "v", Nonce: "n", MachineID: "m"}
	urlStr := BuildQoderPollURL(session, qoderProducts["qoder"])
	if !strings.HasPrefix(urlStr, "https://openapi.qoder.sh/api/v1/deviceToken/poll") {
		t.Fatalf("⚠️ 轮询必须挂 openapi.qoder.sh（qoder.com 同路径 401）: %s", urlStr)
	}
	if !strings.Contains(urlStr, "verifier=v") {
		t.Fatalf("verifier param: %s", urlStr)
	}
}

// --- token 载荷：token/device_token 双名 + user_id/user_name 必读 ---

func TestParseQoderTokenPayload(t *testing.T) {
	payload := parseQoderTokenPayload(map[string]any{
		"token": "tok-1", "refresh_token": "rt-1",
		"expires_at": 3600.0, "user_id": "uid-9", "user_name": "名字",
	})
	if payload.AccessToken != "tok-1" || payload.RefreshToken != "rt-1" {
		t.Fatalf("tokens: %+v", payload)
	}
	if payload.ExpiresAt != 3600000 {
		t.Fatalf("expires_at (sec) → ms: %d", payload.ExpiresAt)
	}
	// ⚠️ user_id/user_name 是加密推理的必需字段（漏读=只能走公开端点）。
	if payload.UID != "uid-9" || payload.UserName != "名字" {
		t.Fatalf("uid/user_name: %+v", payload)
	}
	// 续期响应用 device_token 名。
	refresh := parseQoderTokenPayload(map[string]any{"device_token": "tok-2"})
	if refresh.AccessToken != "tok-2" {
		t.Fatalf("device_token name: %+v", refresh)
	}
}

// --- applyQoderRefresh：machine_id/uid/nickname 保留 + refresh_token 缺失沿用 ---

func TestApplyQoderRefreshKeepsIdentity(t *testing.T) {
	prev := &QoderCredential{
		SecurityOauthToken: "old", AccessToken: "old", RefreshToken: "rt-0",
		MachineID: "mid", UID: "uid-1", Nickname: "nick",
	}
	next := applyQoderRefresh(prev, &qoderTokenPayload{AccessToken: "new"})
	if next.AccessToken != "new" || next.SecurityOauthToken != "new" {
		t.Fatalf("tokens swapped: %+v", next)
	}
	// ⚠️ 双写同值。
	if next.SecurityOauthToken != next.AccessToken {
		t.Fatal("security_oauth_token must dual-write access_token")
	}
	if next.MachineID != "mid" || next.UID != "uid-1" || next.Nickname != "nick" {
		t.Fatalf("identity kept: %+v", next)
	}
	if next.RefreshToken != "rt-0" {
		t.Fatalf("refresh preserved: %q", next.RefreshToken)
	}
}

// --- 轮询：404 继续轮询（不是错误！） ---

func TestPollQoderDeviceToken404KeepsPolling(t *testing.T) {
	var calls int
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls <= 2 {
			w.WriteHeader(http.StatusNotFound) // ⚠️ = "not ready yet"
			w.Write([]byte(`{"errorCode":"NotFound"}`))
			return
		}
		w.Write([]byte(`{"token":"tok-9","refresh_token":"rt-9","user_id":"uid-9"}`))
	})
	restoreQoderOpenAPIBase(t, srv.URL)

	m := newTestManager(t).m
	session := createQoderDeviceSession("mid")
	payload, err := m.PollQoderDeviceToken(context.Background(), "qoder", session, qoderProducts["qoder"])
	if err != nil {
		t.Fatal(err)
	}
	if payload.AccessToken != "tok-9" || payload.UID != "uid-9" {
		t.Fatalf("payload wrong: %+v", payload)
	}
	if calls < 3 {
		t.Fatalf("404 must keep polling: %d", calls)
	}
}

func TestPollQoderDeviceToken5xxImmediate(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError) // 服务端故障≠等用户
	})
	restoreQoderOpenAPIBase(t, srv.URL)
	m := newTestManager(t).m
	session := createQoderDeviceSession("mid")
	if _, err := m.PollQoderDeviceToken(context.Background(), "qoder", session, qoderProducts["qoder"]); err == nil {
		t.Fatal("5xx must fail immediately (not poll forever)")
	}
}

// --- 积分：余额三包 + 未开通判定 + 幂等 replayed ---

func newSeedQoderManager(t *testing.T) *Manager {
	t.Helper()
	m := newTestManager(t).m
	id, ref := NewAccountID("qoder")
	if err := m.AddAccount(Account{ID: id, Provider: "qoder", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	cred := &QoderCredential{SecurityOauthToken: "qtok", AccessToken: "qtok", RefreshToken: "qrt", MachineID: "mid", UID: "u1"}
	data, _ := json.Marshal(cred)
	if err := m.SetCredential("qoder", ref, data, 1, true); err != nil {
		t.Fatal(err)
	}
	return m
}

func restoreQoderOpenAPIBase(t *testing.T, mockURL string) {
	t.Helper()
	old := qoderProducts["qoder"].OpenAPIBase
	qoderProducts["qoder"].OpenAPIBase = mockURL
	t.Cleanup(func() { qoderProducts["qoder"].OpenAPIBase = old })
}

func firstQoderAccount(t *testing.T, m *Manager) string {
	t.Helper()
	accounts := m.Accounts("qoder")
	if len(accounts) == 0 {
		t.Fatal("no seeded qoder account")
	}
	return accounts[0].ID
}

func TestQoderBalanceThreePackages(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		// 实测形态：userQuota.remaining=0 + addOnQuota.remaining=100。
		w.Write([]byte(`{"qoderUsage":{"userType":"personal_standard","userQuota":{"total":0,"used":0,"remaining":0,"unit":"credits"},"addOnQuota":{"total":100,"used":0,"remaining":100,"unit":"credits"},"dedicatedResourcePackages":[{"id":"dp1","name":"老包","total":50,"used":50,"remaining":0}]}}`))
	})
	restoreQoderOpenAPIBase(t, srv.URL)

	m := newSeedQoderManager(t)
	bal, err := m.QoderBalance(context.Background(), "qoder", firstQoderAccount(t, m))
	if err != nil {
		t.Fatal(err)
	}
	// ⚠️ 只读 userQuota 会显示 0 —— 必须累加 addOnQuota（资源包）。
	if bal.Total != 100 {
		t.Fatalf("total = %v (want 100: addOnQuota)", bal.Total)
	}
	if len(bal.Packages) != 3 {
		t.Fatalf("packages = %d", len(bal.Packages))
	}
}

func TestQoderBalanceEnterpriseNull(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"displayMode":"enterprise"}`))
	})
	restoreQoderOpenAPIBase(t, srv.URL)
	m := newSeedQoderManager(t)
	if _, err := m.QoderBalance(context.Background(), "qoder", firstQoderAccount(t, m)); err == nil {
		t.Fatal("enterprise accounts carry no numbers (null, not 0)")
	}
}

func TestQoderNotActivatedHint(t *testing.T) {
	// ① 无 CLAIM_BENEFIT 行 + ② usage 无 addOnQuota 字段（缺失≠0）→ 未开通。
	campaigns := parseQoderCampaigns(map[string]any{"showCampaign": false, "claimable": false, "campaigns": []any{
		map[string]any{"campaignId": "c1", "actionType": "VIEW_DETAILS"},
	}})
	usage := map[string]any{"qoderUsage": map[string]any{"userQuota": map[string]any{"total": 0}}}
	if !isQoderNotActivated(campaigns, usage) {
		t.Fatal("missing addOnQuota + no benefit ⇒ not activated")
	}
	// addOnQuota 存在（哪怕 0）→ 已开通。
	usage2 := map[string]any{"qoderUsage": map[string]any{"addOnQuota": map[string]any{"total": 100, "remaining": 0}}}
	if isQoderNotActivated(campaigns, usage2) {
		t.Fatal("⚠️ 字段缺失≠0：用光额度的老账号有该字段，不是未开通")
	}
}

func TestClaimQoderDailyReplayedIdempotent(t *testing.T) {
	m := newSeedQoderManager(t)
	id := firstQoderAccount(t, m)
	// 场景 1：有可领活动 → 领取成功。
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/campaigns") {
			w.Write([]byte(`{"showCampaign":true,"claimable":true,"campaigns":[{"campaignId":"c-1","actionType":"CLAIM_BENEFIT","claimStatus":"CLAIMABLE","benefit":{"amount":100}}]}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/claim") {
			// 幂等判据 = replayed:true（重复领取同样 200 且不含 benefit）。
			w.Write([]byte(`{"status":"CLAIMED","replayed":false,"benefit":{"amount":100}}`))
			return
		}
		w.WriteHeader(404)
	})
	restoreQoderOpenAPIBase(t, srv.URL)
	outcome, err := m.ClaimQoderDailyCheckin(context.Background(), "qoder", id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "claimed" || outcome.Credit != 100 {
		t.Fatalf("claimed +100: %+v", outcome)
	}

	// 场景 2：重复领取 → replayed:true → already-claimed。
	srv2 := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/campaigns") {
			w.Write([]byte(`{"showCampaign":true,"claimable":true,"campaigns":[{"campaignId":"c-1","actionType":"CLAIM_BENEFIT","claimStatus":"CLAIMABLE","benefit":{"amount":100}}]}`))
			return
		}
		w.Write([]byte(`{"status":"CLAIMED","replayed":true}`))
	})
	restoreQoderOpenAPIBase(t, srv2.URL)
	outcome2, err := m.ClaimQoderDailyCheckin(context.Background(), "qoder", id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome2.Kind != "already-claimed" {
		t.Fatalf("⚠️ replayed:true → already-claimed（只看状态码会误报 +100）: %+v", outcome2)
	}
}

func TestClaimQoderEmptyListIsInactive(t *testing.T) {
	m := newSeedQoderManager(t)
	id := firstQoderAccount(t, m)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		// 列表空 + 已有 CLAIMED 行 → 已领（抓包实证：领取后行变 CLAIMED）。
		w.Write([]byte(`{"showCampaign":false,"claimable":false,"campaigns":[{"campaignId":"c-1","actionType":"CLAIM_BENEFIT","claimStatus":"CLAIMED"}]}`))
	})
	restoreQoderOpenAPIBase(t, srv.URL)
	outcome, err := m.ClaimQoderDailyCheckin(context.Background(), "qoder", id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "already-claimed" {
		t.Fatalf("CLAIMED row = already: %+v", outcome)
	}

	// 空列表 + 无 CLAIMED 行 + 已开通（有 addOnQuota）→ inactive（不是已领！）。
	srv2 := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/usage") {
			w.Write([]byte(`{"qoderUsage":{"addOnQuota":{"total":100,"remaining":100}}}`))
			return
		}
		w.Write([]byte(`{"showCampaign":false,"claimable":false,"campaigns":[]}`))
	})
	restoreQoderOpenAPIBase(t, srv2.URL)
	outcome2, err := m.ClaimQoderDailyCheckin(context.Background(), "qoder", id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome2.Kind != "inactive" {
		t.Fatalf("⚠️ 「无可领」≠「已领」（否则请求头不全时误报已领）: %+v", outcome2)
	}
}

// --- machine_token.json 读取（token/type 成对必需） ---

func TestResolveQoderMachineIdentity(t *testing.T) {
	appData := t.TempDir()
	t.Setenv("APPDATA", appData)
	dir := filepath.Join(appData, "Qoder", "SharedClientCache", "cache")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	tokenFile := filepath.Join(dir, "machine_token.json")
	if err := os.WriteFile(tokenFile, []byte(`{"token":"mt-1","type":"3"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if got := resolveQoderMachineIdentity(); got == nil || got.Token != "mt-1" || got.Type != "3" {
		t.Fatalf("machine identity parse: %v", got)
	}
	// 半个身份（缺 type）→ 不采用（配对是服务端下发活动的必要条件）。
	if err := os.WriteFile(tokenFile, []byte(`{"token":"mt-2"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if got := resolveQoderMachineIdentity(); got != nil {
		t.Fatalf("half identity must be rejected: %v", got)
	}
}
