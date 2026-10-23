package jethub

// Raccoon 身份（IAM）接口的回归：扫码票据、二维码内容、短信登录。
//
// 背景见 raccoon_identity.go 的文件头（用户报障 2026-10-23：手机扫码后显示
// 「二维码过期或已被使用」—— 旧流程的自造码不被现网扫码页接受）。

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// raccoonTestJWT 造一个只带 exp 的假 JWT（jwtExpiresAtMs 不校验签名）。
func raccoonTestJWT(exp int64) string {
	payload := fmt.Sprintf(`{"exp":%d}`, exp)
	return "h." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".s"
}

// --- 二维码内容 ---

func TestRaccoonQRURLUsesScanPathAndSource(t *testing.T) {
	got := RaccoonQRURL(&RaccoonQRTicket{Code: "qr-01a167e3", ScanPath: "/login/mp"})
	for _, want := range []string{"/login/mp", "code=qr-01a167e3", "appname=", "source=platform"} {
		if !strings.Contains(got, want) {
			t.Fatalf("QR url %q must contain %q", got, want)
		}
	}
	// scan_path 缺失时回落旧路径（同值），但仍然要带 source。
	if got := RaccoonQRURL(&RaccoonQRTicket{Code: "x"}); !strings.Contains(got, raccoonQRLegacyScanPath) {
		t.Fatalf("empty scan_path must fall back to %s: %s", raccoonQRLegacyScanPath, got)
	}
	if got := RaccoonQRURL(nil); got != "" {
		t.Fatalf("nil ticket must yield empty URL, got %q", got)
	}
}

// --- 票据 ---

func TestRaccoonCreateQRTicketParsesServerTicket(t *testing.T) {
	var gotPath, gotBody string
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		buf := make([]byte, 64)
		n, _ := r.Body.Read(buf)
		gotBody = string(buf[:n])
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{"qrcode_code":"qr-01a1","scan_path":"/login/mp","expires_in":300,"poll_interval":2}}`))
	})
	restoreRaccoonAPIBase(t, srv.URL)

	ticket, err := newTestManager(t).m.CreateRaccoonQRTicket(ctxBackground())
	if err != nil {
		t.Fatalf("create ticket: %v", err)
	}
	if gotPath != "/api/iam/v1/auth/mp/qrcode" {
		t.Fatalf("path = %s", gotPath)
	}
	if strings.TrimSpace(gotBody) != "{}" {
		t.Fatalf("body = %q (want empty object)", gotBody)
	}
	if ticket.Code != "qr-01a1" || ticket.ScanPath != "/login/mp" {
		t.Fatalf("ticket = %+v", ticket)
	}
	if ticket.ExpiresIn != 300*time.Second || ticket.PollInterval != 2*time.Second {
		t.Fatalf("ttl = %v / %v（必须照抄服务端）", ticket.ExpiresIn, ticket.PollInterval)
	}
}

// ⚠️ IAM 的失败码是**字符串**（`"AUTH_QRCODE_EXPIRED"`）：共用信封的 bodyCode
// 只认数字 ⇒ 字符串码会被读成 0 = 成功。这条用例守的就是这个坑。
func TestRaccoonCreateQRTicketRejectsStringErrorCode(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":"AUTH_QRCODE_EXPIRED","message":"二维码已过期","data":{}}`))
	})
	restoreRaccoonAPIBase(t, srv.URL)

	if _, err := newTestManager(t).m.CreateRaccoonQRTicket(ctxBackground()); err == nil {
		t.Fatal("string error code must not be treated as success")
	} else if !strings.Contains(err.Error(), "过期") {
		t.Fatalf("error should surface the server message, got %v", err)
	}
}

func TestRaccoonCreateQRTicketMissingCode(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"code":"OK","data":{"scan_path":"/login/mp"}}`))
	})
	restoreRaccoonAPIBase(t, srv.URL)
	if _, err := newTestManager(t).m.CreateRaccoonQRTicket(ctxBackground()); err == nil {
		t.Fatal("ticket without qrcode_code must fail")
	}
}

func TestRaccoonPollQRTicketSuccessBuildsCredential(t *testing.T) {
	exp := time.Now().Add(2 * time.Hour).Unix()
	token := raccoonTestJWT(exp)
	var gotPath, gotBody string
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		buf := make([]byte, 128)
		n, _ := r.Body.Read(buf)
		gotBody = string(buf[:n])
		_, _ = w.Write([]byte(`{"code":"OK","data":{"status":"success","access_token":"` + token + `","token_type":"bearer"}}`))
	})
	restoreRaccoonAPIBase(t, srv.URL)

	status, cred := newTestManager(t).m.PollRaccoonQRTicket(ctxBackground(), "qr-01a1")
	if gotPath != "/api/iam/v1/auth/mp/qrcode/login" {
		t.Fatalf("path = %s", gotPath)
	}
	if !strings.Contains(gotBody, `"qrcode_code":"qr-01a1"`) {
		t.Fatalf("body = %s", gotBody)
	}
	if status != raccoonQRStatusSuccess || cred == nil {
		t.Fatalf("status = %s cred = %+v", status, cred)
	}
	if cred.AccessToken != token {
		t.Fatalf("access_token = %q", cred.AccessToken)
	}
	if cred.ExpiresAt == "" {
		t.Fatal("expires_at must be derived from the JWT exp")
	}
	// IAM 不给 refresh_token ⇒ 明确不可续期（不能假装能刷）。
	if RaccoonRefreshable(cred) {
		t.Fatal("identity credential has no refresh_token ⇒ must not be refreshable")
	}
}

func TestRaccoonPollQRTicketDegradesAnomaliesToPending(t *testing.T) {
	cases := []string{
		`{"code":"OK","data":{"status":"success"}}`,              // token 缺失
		`{"code":"SOME_ERROR","data":{"status":"success"}}`,      // 业务失败
		`{"code":"OK","data":{}}`,                                // 未知状态
		`not-json`,                                               // 畸形
		`{"code":"OK","data":{"status":"weird-unknown-status"}}`, // 未知枚举
	}
	for _, body := range cases {
		srv := newMockServer(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(body))
		})
		restoreRaccoonAPIBase(t, srv.URL)
		status, cred := newTestManager(t).m.PollRaccoonQRTicket(ctxBackground(), "qr-x")
		if status != raccoonQRStatusPending || cred != nil {
			t.Fatalf("body %s ⇒ status=%s cred=%v（异常必须降级 pending）", body, status, cred)
		}
	}
}

// --- StartRaccoonQRLogin：新流程优先、旧流程兜底 ---

func TestRaccoonStartUsesServerTicket(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/iam/v1/auth/mp/qrcode" {
			_, _ = w.Write([]byte(`{"code":"OK","data":{"qrcode_code":"qr-777","scan_path":"/login/mp","expires_in":300,"poll_interval":2}}`))
			return
		}
		_, _ = w.Write([]byte(`{"code":"OK","data":{"status":"pending"}}`))
	})
	restoreRaccoonAPIBase(t, srv.URL)

	started, err := newTestManager(t).m.StartRaccoonQRLogin(ctxBackground(), "acc-1", "http://127.0.0.1/free-hub-login.html?loginId=x")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if !strings.Contains(started.QRContent, "qr-777") || !strings.Contains(started.QRContent, "source=platform") {
		t.Fatalf("QR must carry the server ticket: %s", started.QRContent)
	}
	flow, ok := started.Extra.(*RaccoonQRFlow)
	if !ok || flow == nil {
		t.Fatalf("Extra must expose the live flow, got %T", started.Extra)
	}
	t.Cleanup(flow.stop) // 别让泵在测试结束后继续打 mock
	if flow.QRContent() != started.QRContent {
		t.Fatal("flow must hold the same QR content")
	}
}

func TestRaccoonStartFallsBackToLegacyCode(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`boom`))
	})
	restoreRaccoonAPIBase(t, srv.URL)

	started, err := newTestManager(t).m.StartRaccoonQRLogin(ctxBackground(), "acc-1", "page")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// 兜底：旧的 32 位 hex 自造码（`/login/mp?code=<hex>&appname=商汤小浣熊官网`）。
	if !strings.Contains(started.QRContent, raccoonQRLegacyScanPath) ||
		!strings.Contains(started.QRContent, "appname=") {
		t.Fatalf("fallback QR = %s", started.QRContent)
	}
	flow, _ := started.Extra.(*RaccoonQRFlow)
	if flow == nil {
		t.Fatal("flow missing")
	}
	t.Cleanup(flow.stop)
	code, interval, _, legacy := flow.snapshot()
	if !legacy {
		t.Fatal("fallback flow must be marked legacy")
	}
	if len(code) != 32 || interval != raccoonQRPollInterval {
		t.Fatalf("legacy code = %q interval = %v", code, interval)
	}
}

// 票据过期 ⇒ 换新码（页面下一轮 status 就能换图）；换码失败则保留旧码。
func TestRaccoonRenewQRSwapsTicket(t *testing.T) {
	var created int
	srv := newMockServer(t, func(w http.ResponseWriter, _ *http.Request) {
		created++
		_, _ = w.Write([]byte(fmt.Sprintf(`{"code":"OK","data":{"qrcode_code":"qr-%d","scan_path":"/login/mp","expires_in":300,"poll_interval":2}}`, created)))
	})
	restoreRaccoonAPIBase(t, srv.URL)

	m := newTestManager(t).m
	flow := newRaccoonQRFlow()
	ticket, err := m.CreateRaccoonQRTicket(ctxBackground())
	if err != nil {
		t.Fatal(err)
	}
	flow.update(RaccoonQRURL(ticket), ticket, false)
	first := flow.QRContent()

	m.raccoonRenewQR(flow, ctxBackground())
	if flow.QRContent() == first {
		t.Fatal("renew must swap in the new ticket's QR")
	}
	if got := flow.QRContent(); !strings.Contains(got, "qr-2") {
		t.Fatalf("QR after renew = %s", got)
	}

	// 换码失败：旧码保留（用户还能继续扫）。
	kept := flow.QRContent()
	srv.Close()
	m.raccoonRenewQR(flow, ctxBackground())
	if flow.QRContent() != kept {
		t.Fatal("failed renew must keep the previous QR")
	}
}

// --- 短信 ---

func TestRaccoonSMSSendAndLogin(t *testing.T) {
	exp := time.Now().Add(time.Hour).Unix()
	token := raccoonTestJWT(exp)
	var sendBody, loginBody string
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 512)
		n, _ := r.Body.Read(buf)
		switch r.URL.Path {
		case "/api/iam/v1/sms/send":
			sendBody = string(buf[:n])
			_, _ = w.Write([]byte(`{"code":"OK","data":{"verification_id":"ver-1","expires_in":300,"retry_after":60}}`))
		case "/api/iam/v1/auth/login/sms":
			loginBody = string(buf[:n])
			_, _ = w.Write([]byte(`{"code":"OK","data":{"access_token":"` + token + `","token_type":"bearer"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	restoreRaccoonAPIBase(t, srv.URL)

	m := newSeedRaccoonManager(t)
	accountID := firstRaccoonAccount(t, m)
	flow := newRaccoonQRFlow()
	started := NewStartedLoginWithChannel("page", make(chan LoginOutcome, 1))

	if err := m.SendRaccoonSmsForFlow(ctxBackground(), flow, "13011111111", "captcha-tok"); err != nil {
		t.Fatalf("send sms: %v", err)
	}
	for _, want := range []string{`"phone":"13011111111"`, `"captcha_token":"captcha-tok"`, `"nation_code":"86"`, `"scene":"login"`} {
		if !strings.Contains(sendBody, want) {
			t.Fatalf("send body %s must contain %s", sendBody, want)
		}
	}
	if phone, id := flow.SMSState(); phone != "13011111111" || id != "ver-1" {
		t.Fatalf("SMS state = %q / %q", phone, id)
	}

	if err := m.SubmitRaccoonSmsForFlow(ctxBackground(), started, flow, accountID, "123456"); err != nil {
		t.Fatalf("sms login: %v", err)
	}
	for _, want := range []string{`"verification_id":"ver-1"`, `"verification_code":"123456"`, `"phone":"13011111111"`} {
		if !strings.Contains(loginBody, want) {
			t.Fatalf("login body %s must contain %s", loginBody, want)
		}
	}
	// 结果送达页面流程（泵已停，不会再有第二个结果）。
	select {
	case outcome := <-started.Result:
		if outcome.Err != nil || outcome.CredentialJSON == nil {
			t.Fatalf("outcome = %+v", outcome)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SMS login must deliver an outcome to the page flow")
	}
	// 凭据真的落库了。
	acc, _ := m.FindAccount(accountID)
	raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
	if !ok {
		t.Fatal("credential must be persisted")
	}
	var cred RaccoonCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		t.Fatal(err)
	}
	if cred.AccessToken != token {
		t.Fatalf("persisted token = %q", cred.AccessToken)
	}
}

func TestRaccoonSMSLoginWithoutSendIsRejected(t *testing.T) {
	m := newSeedRaccoonManager(t)
	flow := newRaccoonQRFlow()
	started := NewStartedLoginWithChannel("page", make(chan LoginOutcome, 1))
	err := m.SubmitRaccoonSmsForFlow(ctxBackground(), started, flow, firstRaccoonAccount(t, m), "123456")
	if err == nil || !strings.Contains(err.Error(), "请先获取短信验证码") {
		t.Fatalf("err = %v", err)
	}
}
