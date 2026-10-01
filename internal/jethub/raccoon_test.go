package jethub

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// --- AES-128-CFB 手机号加密（100003 params_encryted_error 的防线） ---

func TestEncryptRaccoonPhone(t *testing.T) {
	fixedIV := make([]byte, 16)
	for i := range fixedIV {
		fixedIV[i] = byte(i)
	}
	enc, err := EncryptRaccoonPhone("13011111100", fixedIV)
	if err != nil {
		t.Fatal(err)
	}
	// 输出 = base64(iv ‖ ciphertext)：16+11=27 字节 → base64 36 字符（27 整除 3，无 padding）。
	if len(enc) != 36 {
		t.Fatalf("expected 36-char base64 (27 bytes, no padding), got %d: %s", len(enc), enc)
	}
	// 相同 iv + 相同明文 → 相同密文（确定性，供服务端解密）。
	enc2, _ := EncryptRaccoonPhone("13011111100", fixedIV)
	if enc != enc2 {
		t.Fatal("encryption must be deterministic with a fixed iv")
	}
	// 随机 iv → 不同密文（前 16 字节不同）。
	enc3, _ := EncryptRaccoonPhone("13011111100", nil)
	if enc3[:10] == enc[:10] {
		t.Fatal("random iv must change the output")
	}
}

// --- QR URL 构造 ---

func TestBuildRaccoonQrURL(t *testing.T) {
	urlStr := BuildRaccoonQrURL("abc123")
	if !strings.HasPrefix(urlStr, "https://xiaohuanxiong.com/login/mp?code=abc123") {
		t.Fatalf("url wrong: %s", urlStr)
	}
	if !strings.Contains(urlStr, "appname=") {
		t.Fatal("appname param required")
	}
}

// --- QR 轮询状态机（任何异常降级 pending） ---

func TestPollRaccoonQrLoginStates(t *testing.T) {
	m := newTestManager(t).m
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/login_with_qrcode_code") {
			t.Errorf("path wrong: %s", r.URL.Path)
		}
		w.Write([]byte(`{"code":0,"message":"","details":"","data":{"status":"logging","expired_at":"2099-01-01T00:00:00"}}`))
	})
	restoreRaccoonAPIBase(t, srv.URL)
	status, cred, expiredAt := m.PollRaccoonQrLogin(context.Background(), "c1")
	if status != "logging" || cred != nil {
		t.Fatalf("logging state wrong: %q %v", status, cred)
	}
	if expiredAt == "" {
		t.Fatal("expiredAt expected on logging")
	}
}

func TestPollRaccoonQrLoginSuccess(t *testing.T) {
	m := newTestManager(t).m
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":0,"data":{"status":"success","access_token":"` + mustJWT(t, map[string]any{"exp": 2000000000.0}) + `","refresh_token":"rt"}}`))
	})
	restoreRaccoonAPIBase(t, srv.URL)
	status, cred, _ := m.PollRaccoonQrLogin(context.Background(), "c1")
	if status != "success" || cred == nil || cred.AccessToken == "" || cred.RefreshToken != "rt" {
		t.Fatalf("success wrong: %q %v", status, cred)
	}
	if cred.ExpiresAt == "" {
		t.Fatal("expires_at derived from JWT exp")
	}
}

func TestPollRaccoonQrLoginAnomalyDegradesToPending(t *testing.T) {
	cases := []http.HandlerFunc{
		func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadGateway) },           // 网络/网关错误
		func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"code":1001,"message":"x"}`)) }, // 业务码非 0
		func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"code":0,"data":{"status":"success"}}`)) }, // 无 token 的 success
		func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{invalid`)) },                    // 非 JSON
		func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"code":0,"data":{"status":"weird"}}`)) }, // 未知 status
	}
	for i, h := range cases {
		m := newTestManager(t).m
		srv := newMockServer(t, h)
		restoreRaccoonAPIBase(t, srv.URL)
		status, cred, _ := m.PollRaccoonQrLogin(context.Background(), "c1")
		if status != "pending" || cred != nil {
			t.Fatalf("case %d must degrade to pending: %q %v", i, status, cred)
		}
	}
}

// --- refresh：refresh_token 缺失沿用旧值 / 终态 ---

func TestRaccoonRefreshKeepsRefreshToken(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		// 服务端只返回新 access_token（不带新 refresh_token）。
		w.Write([]byte(`{"code":0,"data":{"access_token":"` + mustJWT(t, map[string]any{"exp": 2000000000.0}) + `"}}`))
	})
	restoreRaccoonAPIBase(t, srv.URL)

	prev := &RaccoonCredential{AccessToken: "old", RefreshToken: "rt-keep", ExpiresAt: "1"}
	refreshed, err := newTestManager(t).m.RefreshRaccoonCredential(context.Background(), prev)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.RefreshToken != "rt-keep" {
		t.Fatalf("⚠️ 无新 refresh_token 必须沿用旧值（否则一次续期=账号不可续期）: %q", refreshed.RefreshToken)
	}
	if refreshed.AccessToken == "old" {
		t.Fatal("access token must update")
	}
}

func TestRaccoonRefreshTerminal200003(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":200003,"message":"登录态已过期"}`))
	})
	restoreRaccoonAPIBase(t, srv.URL)
	m := newTestManager(t).m
	id, ref := NewAccountID("raccoon")
	_ = m.AddAccount(Account{ID: id, Provider: "raccoon", Enabled: true, CredentialRef: ref})
	data, _ := json.Marshal(&RaccoonCredential{AccessToken: "t", RefreshToken: "r"})
	_ = m.SetCredential("raccoon", ref, data, 1, true)

	if err := m.RefreshRaccoonAccount(context.Background(), id); err == nil {
		t.Fatal("terminal refresh must error")
	}
	acc, _ := m.FindAccount(id)
	if acc.Refreshable {
		t.Fatal("terminal must mark refreshable:false")
	}
}

// --- 登录奖励：幂等一次性（granted:false ≠ 失败） ---

func TestRaccoonClaimLoginRewardIdempotent(t *testing.T) {
	m := newSeedRaccoonManager(t)
	id := firstRaccoonAccount(t, m)

	// 第一次领取。
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":0,"data":{"granted":true,"points":3000}}`))
	})
	restoreRaccoonAPIBase(t, srv.URL)
	outcome, err := m.ClaimRaccoonLoginReward(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "claimed" || outcome.Credit != 3000 {
		t.Fatalf("first claim wrong: %+v", outcome)
	}

	// 重复领取（HTTP 200 + granted:false）→ already-claimed 而非 failed。
	srv2 := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":0,"data":{"granted":false}}`))
	})
	restoreRaccoonAPIBase(t, srv2.URL)
	outcome2, err := m.ClaimRaccoonLoginReward(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome2.Kind != "already-claimed" {
		t.Fatalf("⚠️ granted:false 幂等判据（重复领取同样 200）: %+v", outcome2)
	}
}

// --- 新手礼包判定：必须同时认 biz_type 与 event_name ---

func TestRaccoonOnboardingClaimed(t *testing.T) {
	m := newSeedRaccoonManager(t)
	id := firstRaccoonAccount(t, m)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		// 新人注册礼包也是 reward_grant —— 不能只按 biz_type 判定。
		w.Write([]byte(`{"code":0,"data":{"items":[{"biz_type":"reward_grant","event_name":"新人注册礼包"}]}}`))
	})
	restoreRaccoonAPIBase(t, srv.URL)
	claimed, err := m.RaccoonOnboardingClaimed(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if claimed {
		t.Fatal("⚠️ 新人礼包也是 reward_grant，误判会让新用户一开始就显示已领取")
	}
	srv2 := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":0,"data":{"items":[{"biz_type":"reward_grant","event_name":"桌面端登录奖励"}]}}`))
	})
	restoreRaccoonAPIBase(t, srv2.URL)
	claimed2, err := m.RaccoonOnboardingClaimed(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if !claimed2 {
		t.Fatal("exact login-reward record must be found")
	}
}

// --- 思考映射：extra_body.thinking 是唯一有效通道 ---

func TestRaccoonThinkingExtraBody(t *testing.T) {
	off := RaccoonThinkingExtraBody("off")
	if t2, _ := off["thinking"].(map[string]any); t2 == nil || t2["type"] != "disabled" {
		t.Fatalf("off → disabled: %v", off)
	}
	on := RaccoonThinkingExtraBody("on")
	if t2, _ := on["thinking"].(map[string]any); t2 == nil || t2["type"] != "enabled" {
		t.Fatalf("on → enabled: %v", on)
	}
	if RaccoonThinkingExtraBody("") != nil {
		t.Fatal("empty effort → no field")
	}
}

// --- augment：extra_body.thinking 注入 + 头族 ---

func TestRaccoonAugment(t *testing.T) {
	m := newSeedRaccoonManager(t)
	id := firstRaccoonAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://xiaohuanxiong.com/api/web/llm/v2/chat/completions", nil)
	body := []byte(`{"model":"sn-glm-5-3","messages":[],"reasoning_effort":"off"}`)
	out, err := m.raccoonAugment(req, body, "jethub-raccoon", id, "sn-glm-5-3")
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatal(err)
	}
	// reasoning_effort（raccoon 不认）转为 extra_body.thinking。
	if _, has := parsed["reasoning_effort"]; has {
		t.Fatal("reasoning_effort must be consumed")
	}
	eb, _ := parsed["extra_body"].(map[string]any)
	th, _ := eb["thinking"].(map[string]any)
	if th == nil || th["type"] != "disabled" {
		t.Fatalf("extra_body.thinking wrong: %v", parsed["extra_body"])
	}
	if req.Header.Get("Authorization") != "Bearer rtok" {
		t.Fatalf("bearer wrong: %q", req.Header.Get("Authorization"))
	}
	if req.Header.Get("X-Raccoon-Language") != "zh" || req.Header.Get("X-Client-Platform") != "desktop-windows" {
		t.Fatal("platform headers missing")
	}
}

// --- 倍率展示（1 倍也要显示；0=免费；促销 x原→x折） ---

func TestRaccoonDisplayName(t *testing.T) {
	if got := RaccoonDisplayName("GLM-5-3", 0.75, 0.75); got != "GLM-5-3 · x0.75" {
		t.Fatalf("x0.75: %q", got)
	}
	if got := RaccoonDisplayName("Kimi-K3", 1, 1); got != "Kimi-K3 · x1" {
		t.Fatalf("⚠️ 1 倍也要显示（用户报障）: %q", got)
	}
	if got := RaccoonDisplayName("SenseNova-6.8-Flash", 0, 0.5); got != "SenseNova-6.8-Flash · 免费" {
		t.Fatalf("0 → 免费: %q", got)
	}
	if got := RaccoonDisplayName("GLM-5-3-Flash", 0.1, 0.2); got != "GLM-5-3-Flash · x0.2→x0.1" {
		t.Fatalf("promo arrow: %q", got)
	}
}

// --- 短信登录 mock（AES 加密体） ---

func TestRaccoonSmsLoginMock(t *testing.T) {
	m := newTestManager(t).m
	id, _ := NewAccountID("raccoon")
	_ = m.AddAccount(Account{ID: id, Provider: "raccoon", Enabled: true, CredentialRef: "X"})

	var smsBody map[string]any
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/send_sms"):
			_ = json.NewDecoder(r.Body).Decode(&smsBody)
			w.Write([]byte(`{"code":0}`))
		case strings.HasSuffix(r.URL.Path, "/login_with_sms"):
			w.Write([]byte(`{"code":0,"data":{"access_token":"` + mustJWT(t, map[string]any{"exp": 2000000000.0}) + `","refresh_token":"rt"}}`))
		case strings.HasSuffix(r.URL.Path, "/user_info"):
			w.Write([]byte(`{"code":0,"data":{"id":"u1","name":"RaccoonAva","phone":"130******00"}}`))
		default:
			w.WriteHeader(404)
		}
	})
	restoreRaccoonAPIBase(t, srv.URL)

	// 下发验证码：phone 必须 AES 加密（服务端解密失败回 100003）。
	if err := m.SendRaccoonSmsCode(context.Background(), "13011111100", "cap"); err != nil {
		t.Fatal(err)
	}
	encPhone, _ := smsBody["phone"].(string)
	if encPhone == "" || encPhone == "13011111100" {
		t.Fatalf("phone must be AES-128-CFB encrypted: %q", encPhone)
	}
	if smsBody["captcha_param"] != "cap" || smsBody["nation_code"] != "86" {
		t.Fatalf("sms body wrong: %v", smsBody)
	}

	// 用验证码登录 + 展示名手机号优先（name=RaccoonAva 不可区分）。
	if err := m.SubmitRaccoonSmsLogin(context.Background(), id, "13011111100", "4321"); err != nil {
		t.Fatal(err)
	}
	acc, ok := m.FindAccount(id)
	if !ok {
		t.Fatal("account gone")
	}
	if acc.Nickname != "130******00" {
		t.Fatalf("nickname must prefer phone over RaccoonAva: %q", acc.Nickname)
	}
	if !acc.Refreshable {
		t.Fatal("refreshable expected")
	}
}

// --- 测试基建 ---

func restoreRaccoonAPIBase(t *testing.T, mockURL string) {
	t.Helper()
	old := raccoonAPIBase
	raccoonAPIBase = mockURL
	t.Cleanup(func() { raccoonAPIBase = old })
}

func newSeedRaccoonManager(t *testing.T) *Manager {
	t.Helper()
	m := newTestManager(t).m
	id, ref := NewAccountID("raccoon")
	if err := m.AddAccount(Account{ID: id, Provider: "raccoon", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	cred := &RaccoonCredential{AccessToken: "rtok", RefreshToken: "rrt", DeviceID: strings.Repeat("ff", 16)}
	data, _ := json.Marshal(cred)
	if err := m.SetCredential("raccoon", ref, data, 1, true); err != nil {
		t.Fatal(err)
	}
	return m
}

func firstRaccoonAccount(t *testing.T, m *Manager) string {
	t.Helper()
	accounts := m.Accounts("raccoon")
	if len(accounts) == 0 {
		t.Fatal("no seeded raccoon account")
	}
	return accounts[0].ID
}
