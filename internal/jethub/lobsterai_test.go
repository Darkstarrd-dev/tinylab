package jethub

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// --- 手机号掩码归一化（用户要求：只露末 2 位，幂等） ---

func TestMaskLobsteraiPhoneTail(t *testing.T) {
	cases := []struct{ in, want string }{
		{"13011111100", "130******00"},     // 完整号码
		{"130****1100", "130******00"},     // 服务端脱敏（露 4 位）
		{"130******00", "130******00"},     // 已归一化（幂等）
		{"测试账号", "测试账号"},                   // 非手机号原样
		{"用户26815487395", "用户26815487395"}, // 真实昵称不误伤
	}
	for _, c := range cases {
		if got := MaskLobsteraiPhoneTail(c.in, 2); got != c.want {
			t.Fatalf("Mask(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestDisplayNicknameFallback(t *testing.T) {
	if got := LobsteraiDisplayNickname("", "acct-1"); got != "acct-1" {
		t.Fatalf("empty nickname must fall back to id: %q", got)
	}
	if got := LobsteraiDisplayNickname("13011111100", "acct-1"); got != "130******00" {
		t.Fatalf("phone nickname must be masked: %q", got)
	}
}

// --- UID 四级回退（user.id → user.userId → user.yid → sha256[:16]） ---

func TestResolveLobsteraiUidFallbacks(t *testing.T) {
	got := resolveLobsteraiUid(&lobsteraiTokenPayload{UserID: "id-1", AccountUser: "au", YID: "y"})
	if got != "id-1" {
		t.Fatalf("user.id must win: %q", got)
	}
	got = resolveLobsteraiUid(&lobsteraiTokenPayload{AccountUser: "au", YID: "y"})
	if got != "au" {
		t.Fatalf("user.userId must be second: %q", got)
	}
	got = resolveLobsteraiUid(&lobsteraiTokenPayload{YID: "y"})
	if got != "y" {
		t.Fatalf("yid must be third: %q", got)
	}
	got = resolveLobsteraiUid(&lobsteraiTokenPayload{AccessToken: "tok"})
	if len(got) != 16 {
		t.Fatalf("hash fallback must be 16 hex chars: %q", got)
	}
	for _, c := range got {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			t.Fatalf("uid must be lowercase hex: %q", got)
		}
	}
}

// --- buildLobsteraiCredential：expiresIn 相对秒（基准=当前时刻，非 JWT iat） ---

func TestBuildLobsteraiCredentialExpiryNow(t *testing.T) {
	before := nowMillis()
	cred := buildLobsteraiCredential(&lobsteraiTokenPayload{
		AccessToken: "tok-1", RefreshToken: "rt-1", ExpiresIn: 3600, UserID: "u-1", Nickname: "13011111100",
	}, "uuid-1", "fk-1", "lk-1")
	after := nowMillis()
	if cred == nil || cred.AccessToken != "tok-1" {
		t.Fatalf("assembly failed: %+v", cred)
	}
	expiry := lobsteraiCredentialExpiresAtMs(cred)
	if expiry < before+3600*1000 || expiry > after+3600*1000 {
		t.Fatalf("expiresIn must be based on NOW: %d not in [%d,%d]",
			expiry, before+3600*1000, after+3600*1000)
	}
	if cred.UID != "u-1" {
		t.Fatalf("uid wrong: %q", cred.UID)
	}
	if cred.Nickname != "130******00" {
		t.Fatalf("nickname must be masked: %q", cred.Nickname)
	}
	// 身份字段必须随凭据持久化（丢了就续期失败——两边最大差异点）。
	if cred.UUID != "uuid-1" || cred.FirstKeyfrom != "fk-1" || cred.LatestKeyfrom != "lk-1" {
		t.Fatalf("identity fields missing: %+v", cred)
	}
}

func TestBuildLobsteraiCredentialJWTExpiryFallback(t *testing.T) {
	tok := mustJWT(t, map[string]any{"exp": 2000000000.0})
	cred := buildLobsteraiCredential(&lobsteraiTokenPayload{AccessToken: tok}, "u", "f", "l")
	if got := lobsteraiCredentialExpiresAtMs(cred); got != int64(2000000000)*1000 {
		t.Fatalf("JWT exp fallback wrong: %d", got)
	}
}

// --- applyLobsteraiRefresh：身份字段一律沿用旧值（latest_keyfrom 刻意不更新） ---

func TestApplyLobsteraiRefreshKeepsIdentity(t *testing.T) {
	prev := &LobsteraiCredential{
		AccessToken: "old", RefreshToken: "old-rt", ExpiresAt: "1",
		UUID: "u1", FirstKeyfrom: "fk", LatestKeyfrom: "lk",
		UID: "uid-1", UserID: "user-1", Nickname: "nick",
	}
	now := nowMillis()
	next := applyLobsteraiRefresh(prev, &lobsteraiTokenPayload{
		AccessToken: "new", RefreshToken: "", ExpiresIn: 3600,
	}, now)
	if next == prev {
		t.Fatal("apply must return a copy")
	}
	if next.AccessToken != "new" {
		t.Fatal("token must update")
	}
	// refresh 响应可能不返回 refreshToken —— 沿用旧值，不能覆盖成空串。
	if next.RefreshToken != "old-rt" {
		t.Fatalf("refresh_token must be preserved when absent: %q", next.RefreshToken)
	}
	// 身份字段一律沿用。
	if next.UUID != "u1" || next.FirstKeyfrom != "fk" || next.LatestKeyfrom != "lk" ||
		next.UID != "uid-1" || next.UserID != "user-1" || next.Nickname != "nick" {
		t.Fatalf("identity fields must be kept verbatim: %+v", next)
	}
	// latest_keyfrom 刻意不更新为当前时刻（Go 参考实现约定）。
	if next.LatestKeyfrom != "lk" {
		t.Fatal("latest_keyfrom must NOT be bumped on refresh")
	}
	if got := lobsteraiCredentialExpiresAtMs(next); got != now+3600*1000 {
		t.Fatalf("expiry must be nowMs-based: got %d want %d", got, now+3600*1000)
	}
}

// --- 每日签到三步流（slot → context → check_in） ---

func TestClaimLobsteraiDailyFlow(t *testing.T) {
	m := newTestManager(t).m
	id, ref := NewAccountID("lobsterai")
	_ = m.AddAccount(Account{ID: id, Provider: "lobsterai", Enabled: true, CredentialRef: ref})
	cred := &LobsteraiCredential{AccessToken: "tok", RefreshToken: "rt"}
	data, _ := json.Marshal(cred)
	_ = m.SetCredential("lobsterai", ref, data, 1, true)

	var claimBody string
	_ = claimBody // 领取请求体由下面的 handler 校验
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/client-activities/slot"):
			// ref 的 requestJson 用四头版（不带能力头）——capability 头只在
			// chat/models 端点是必需的；这里验证 Authorization 存在即可。
			if r.Header.Get("Authorization") != "Bearer tok" {
				t.Errorf("Authorization missing on slot query")
			}
			w.Write([]byte(`{"code":0,"data":{"slotState":"available","activity":{"activityCode":"daily","configRevision":7}}}`))
		case strings.Contains(r.URL.Path, "/client-activities/daily/context"):
			w.Write([]byte(`{"code":0,"data":{"state":{"claimedToday":false},"actions":["check_in"]}}`))
		case strings.HasSuffix(r.URL.Path, "/actions/check_in"):
			// 领取请求必须带 configRevision + 幂等键。
			var req map[string]any
			_ = json.NewDecoder(r.Body).Decode(&req)
			if _, ok := req["idempotencyKey"]; !ok {
				t.Errorf("idempotencyKey missing on check_in")
			}
			w.Write([]byte(`{"code":0,"data":{"result":{"creditsGranted":100,"message":"ok"}}}`))
		default:
			w.WriteHeader(404)
		}
	})
	defer srv.Close()
	restoreLobsteraiEndpoint(t, srv.URL)

	outcome, err := m.ClaimLobsteraiDaily(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "claimed" || outcome.Credit != 100 {
		t.Fatalf("unexpected outcome: %+v", outcome)
	}
}

func TestClaimLobsteraiAlreadyClaimed(t *testing.T) {
	m := newSeedLobsteraiManager(t)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/client-activities/slot"):
			w.Write([]byte(`{"code":0,"data":{"slotState":"available","activity":{"activityCode":"d1","configRevision":3}}}`))
		case strings.Contains(r.URL.Path, "/context"):
			w.Write([]byte(`{"code":0,"data":{"state":{"claimedToday":true},"actions":[],"unused":1}}`))
		default:
			t.Errorf("unexpected request after claimedToday: %s", r.URL.Path)
			w.WriteHeader(400)
		}
	})
	defer srv.Close()
	restoreLobsteraiEndpoint(t, srv.URL)

	accID := firstLobsteraiAccount(t, m)
	outcome, err := m.ClaimLobsteraiDaily(context.Background(), accID)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "already-claimed" {
		t.Fatalf("claimedToday must be already-claimed, got %+v", outcome)
	}
}

func TestClaimLobsteraiSlotUnavailableIsInactive(t *testing.T) {
	m := newSeedLobsteraiManager(t)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":0,"data":{"slotState":"not_started","activity":{}}}`))
	})
	defer srv.Close()
	restoreLobsteraiEndpoint(t, srv.URL)

	outcome, err := m.ClaimLobsteraiDaily(context.Background(), firstLobsteraiAccount(t, m))
	if err != nil {
		t.Fatal(err)
	}
	// slotState != available 是正常业务状态（inactive），不是 failed。
	if outcome.Kind != "inactive" {
		t.Fatalf("expected inactive, got %+v", outcome)
	}
}

// --- 余额：profile-summary（非 /quota）+ 面值推断 + 负值 clamp ---

func TestLobsteraiBalanceFaceValueInference(t *testing.T) {
	m := newSeedLobsteraiManager(t)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/api/user/profile-summary") {
			t.Errorf("balance must use profile-summary, got %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		w.Write([]byte(`{"code":0,"data":{
			"totalCreditsRemaining":592.73,
			"creditItems":[
				{"label":"每日登录奖励","type":"campaign","creditsRemaining":100,"expiresAt":"2099-01-01T00:00:00"},
				{"label":"每日登录奖励","type":"campaign","creditsRemaining":92.73,"expiresAt":"2099-01-02T00:00:00"},
				{"label":"过期包","type":"campaign","creditsRemaining":50,"expiresAt":"2020-01-01T00:00:00"},
				{"label":"负数包","type":"campaign","creditsRemaining":-12.5}
			]}}`))
	})
	defer srv.Close()
	restoreLobsteraiEndpoint(t, srv.URL)

	bal, err := m.LobsteraiBalance(context.Background(), firstLobsteraiAccount(t, m))
	if err != nil {
		t.Fatal(err)
	}
	// total = 592.73（服务端值 clamp 后）；包含负数包也不下溢。
	if bal.Total != 592.73 {
		t.Fatalf("total = %v, want 592.73", bal.Total)
	}
	// 面值推断（ref）：faceValueByGroup = 同组**所有**有效包的剩余量 max
	// = max(100, 92.73) = 100 → 每个有效包 total=100、used=face-remaining。
	// 未用包（remaining=100）→ used=0；用过包（92.73）→ used=7.27。
	for i := range bal.Packages {
		if bal.Packages[i].Name == "每日登录奖励" && bal.Packages[i].Remaining == 92.73 {
			if bal.Packages[i].Total != 100 || bal.Packages[i].Used != 7.27 {
				t.Fatalf("face-value inference wrong: total=%v used=%v (want 100 / 7.27)",
					bal.Packages[i].Total, bal.Packages[i].Used)
			}
		}
		if bal.Packages[i].Name == "每日登录奖励" && bal.Packages[i].Remaining == 100 {
			if bal.Packages[i].Total != 100 || bal.Packages[i].Used != 0 {
				t.Fatalf("fresh package inference wrong: %+v", bal.Packages[i])
			}
		}
	}
	// label 优先于 type。
	for _, pkg := range bal.Packages {
		if pkg.Name == "campaign" {
			t.Fatalf("package name must use label, not type: %+v", bal.Packages)
		}
	}
	// 过期包必须标记非有效。
	for _, pkg := range bal.Packages {
		if pkg.Name == "过期包" && pkg.Active {
			t.Fatal("expired-time package must be inactive")
		}
	}
}

// --- 登录回调端到端：state 校验 + exchange + 凭据落库 ---

func TestLobsteraiLoginFlowMock(t *testing.T) {
	m := newTestManager(t).m
	id, _ := NewAccountID("lobsterai")
	_ = m.AddAccount(Account{ID: id, Provider: "lobsterai", Enabled: true, CredentialRef: "X"})

	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/api/auth/exchange") {
			// exchange 匿名请求（无 Authorization）+ 5 字段体。
			if r.Header.Get("Authorization") != "" {
				t.Errorf("exchange must be anonymous")
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			for _, key := range []string{"authCode", "firstKeyfrom", "latestKeyfrom", "uuid", "version"} {
				if _, ok := body[key]; !ok {
					t.Errorf("exchange body missing %q", key)
				}
			}
			w.Write([]byte(`{"code":0,"data":{"accessToken":"tok-9","refreshToken":"rt-9","expiresIn":3600,"user":{"id":"uid-9","nickname":"13011111100"}}}`))
			return
		}
		w.WriteHeader(404)
	})
	defer srv.Close()
	restoreLobsteraiEndpoint(t, srv.URL)

	started, err := m.StartLobsteraiLogin(context.Background(), id, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer started.Close()
	// 登录 URL 形态：portal#/login + source=electron + 编码的 redirect_uri + state。
	if !strings.Contains(started.LoginURL, "/portal#/login?") ||
		!strings.Contains(started.LoginURL, "source=electron") ||
		!strings.Contains(started.LoginURL, "redirect_uri=http%3A%2F%2F127.0.0.1") {
		t.Fatalf("login URL shape wrong: %s", started.LoginURL)
	}

	// 从 login URL 提取 state 参数，模拟带 code+state 的回调。
	stateStart := strings.Index(started.LoginURL, "state=")
	if stateStart < 0 {
		t.Fatalf("state missing in login URL")
	}
	state := started.LoginURL[stateStart+len("state="):]
	if amp := strings.IndexByte(state, '&'); amp >= 0 {
		state = state[:amp]
	}

	// 回调服务器监听在本机随机端口；从 redirect_uri 提取端口后直接打回调。
	// redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Fauth%2Fcallback
	dec, err := url.QueryUnescape(redirectURIFrom(started.LoginURL))
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	callbackURL := dec + "?code=ac-1&state=" + state
	resp, err := client.Get(callbackURL)
	if err != nil {
		t.Fatalf("callback request failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("callback should 200 with success page, got %d", resp.StatusCode)
	}
	// 结果通道：成功 outcome。
	select {
	case outcome := <-started.Result:
		if outcome.Err != nil {
			t.Fatalf("outcome error: %v", outcome.Err)
		}
		var cred LobsteraiCredential
		if err := json.Unmarshal(outcome.CredentialJSON, &cred); err != nil {
			t.Fatal(err)
		}
		if cred.AccessToken != "tok-9" || cred.RefreshToken != "rt-9" || cred.UID != "uid-9" {
			t.Fatalf("credential wrong: %+v", cred)
		}
		// 昵称已按手机号掩码写入账号。
		acc, ok := m.FindAccount(id)
		if !ok || acc.Nickname != "130******00" || !acc.Refreshable {
			t.Fatalf("account display fields wrong: %+v", acc)
		}
		if !ok || lobsteraiCredentialExpiresAtMs(&cred) == 0 {
			t.Fatal("expiresAt missing")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("login outcome not delivered")
	}
}

// redirectURIFrom digs the encoded redirect_uri value out of a login URL.
func redirectURIFrom(loginURL string) string {
	i := strings.Index(loginURL, "redirect_uri=")
	if i < 0 {
		return ""
	}
	rest := loginURL[i+len("redirect_uri="):]
	if amp := strings.IndexByte(rest, '&'); amp >= 0 {
		rest = rest[:amp]
	}
	return rest
}

// interface guard（保持 import 冗余提示不出现）。
var _ = time.Second

// --- refresh：终态判定 ---

func TestLobsteraiRefreshTerminalExpired(t *testing.T) {
	m := newSeedLobsteraiManager(t)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		// refresh 请求头不能带 Authorization（匿名端点，服务端只认 body）。
		if r.Header.Get("Authorization") != "" {
			t.Errorf("refresh must NOT carry Authorization")
		}
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"code":401,"message":"token expired"}`))
	})
	defer srv.Close()
	restoreLobsteraiEndpoint(t, srv.URL)

	accID := firstLobsteraiAccount(t, m)
	if err := m.RefreshLobsteraiAccount(context.Background(), accID); err != ErrRefreshTokenExpired {
		t.Fatalf("expected ErrRefreshTokenExpired, got %v", err)
	}
	acc, _ := m.FindAccount(accID)
	if acc.Refreshable {
		t.Fatal("terminal refresh failure must mark refreshable:false")
	}
}

// --- 测试基建 ---

// restoreLobsteraiEndpoint points the lobsterai product at the mock server
// for the current test and restores the original afterwards.
func restoreLobsteraiEndpoint(t *testing.T, srvURL string) {
	t.Helper()
	old := lobsteraiProduct.Endpoint
	lobsteraiProduct.Endpoint = srvURL
	t.Cleanup(func() { lobsteraiProduct.Endpoint = old })
}

// newSeedLobsteraiManager creates a manager with one credentialed account.
func newSeedLobsteraiManager(t *testing.T) *Manager {
	t.Helper()
	m := newTestManager(t).m
	id, ref := NewAccountID("lobsterai")
	if err := m.AddAccount(Account{ID: id, Provider: "lobsterai", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	cred := &LobsteraiCredential{AccessToken: "tok", RefreshToken: "rt"}
	data, _ := json.Marshal(cred)
	if err := m.SetCredential("lobsterai", ref, data, 1, true); err != nil {
		t.Fatal(err)
	}
	return m
}

func firstLobsteraiAccount(t *testing.T, m *Manager) string {
	t.Helper()
	accounts := m.Accounts("lobsterai")
	if len(accounts) == 0 {
		t.Fatal("no seeded lobsterai account")
	}
	return accounts[0].ID
}

// interface guard（保持 import 冗余提示不出现）。
var _ = time.Second
