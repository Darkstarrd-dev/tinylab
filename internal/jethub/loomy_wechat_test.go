package jethub

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Loomy 微信扫码登录的协议回归 —— 1:1 对照 ref src/loomy-wechat.ts。
// ⚠️ 其中「404 与 405 的语义」是参考实现**踩过的真实缺陷**（读反 → 扫码后永远
// 等不到 code → 凭据永远为空），故这里逐条锁死。

func TestBuildLoomyWechatAuthURL(t *testing.T) {
	got := BuildLoomyWechatAuthURL("abc123")
	for _, needle := range []string{
		"https://open.weixin.qq.com/connect/qrconnect",
		"appid=wx18d60be432287cf8",
		// redirect_uri 必须官方白名单地址（本地地址会被微信拒）。
		"redirect_uri=https%3A%2F%2Floomy.xunfei.cn%2Foauth%2Fwechat%2Fcallback",
		"response_type=code",
		"scope=snsapi_login",
		"state=abc123",
		"#wechat_redirect",
	} {
		if !strings.Contains(got, needle) {
			t.Errorf("auth URL missing %q:\n%s", needle, got)
		}
	}
	if strings.Contains(got, "127.0.0.1") {
		t.Fatal("redirect_uri must stay the official whitelisted address")
	}
}

func TestExtractLoomyWechatUUID(t *testing.T) {
	// 主路径：img src 里的 /connect/qrcode/<uuid>
	if got := ExtractLoomyWechatUUID(`<img class="js_qrcode_img" src="/connect/qrcode/001ZDsw64Vu7ll2E"/>`); got != "001ZDsw64Vu7ll2E" {
		t.Fatalf("img path: %q", got)
	}
	// 兜底：长轮询 URL（实测 uuid 形态含 base64 补位 `=`）。
	if got := ExtractLoomyWechatUUID(`var fordevtool = "https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=4Y0N_jyVQg=="`); got != "4Y0N_jyVQg==" {
		t.Fatalf("poll fallback path: %q", got)
	}
	// 提取不到 → 空串（由调用方报错，绝不返回空 uuid 去轮询）。
	for _, html := range []string{"", "<html>no uuid here</html>", `<img src="/connect/qrcode/ab">`} {
		if got := ExtractLoomyWechatUUID(html); got != "" {
			t.Errorf("html %q must yield empty uuid, got %q", html, got)
		}
	}
}

func TestLoomyImageMime(t *testing.T) {
	jpeg := append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, make([]byte, 300)...)
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 300)...)
	gif := append([]byte("GIF89a"), make([]byte, 300)...)
	cases := []struct {
		name string
		data []byte
		want string
	}{
		{"jpeg (实测二维码就是这个格式)", jpeg, "image/jpeg"},
		{"png", png, "image/png"},
		{"gif", gif, "image/gif"},
		{"html 错误页", []byte("<html>error</html>"), ""},
		{"空", nil, ""},
	}
	for _, tc := range cases {
		if got := loomyImageMime(tc.data); got != tc.want {
			t.Errorf("%s: mime = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// TestPollLoomyWechatOnceStates: errcode → status 的完整映射（含 405 无 code 的
// 异常形态与网络异常降级）。
func TestPollLoomyWechatOnceStates(t *testing.T) {
	cases := []struct {
		name       string
		body       string
		status     int
		wantStatus string
		wantCode   string
	}{
		{"405 + code = 已确认", `window.wx_errcode=405;window.wx_code='CODE123';`, 200, loomyWechatStatusConfirmed, "CODE123"},
		{"405 无 code = 保守判已扫码", `window.wx_errcode=405;window.wx_code='';`, 200, loomyWechatStatusScanned, ""},
		{"404 = 已扫码待确认", `window.wx_errcode=404;`, 200, loomyWechatStatusScanned, ""},
		{"403 = 用户取消", `window.wx_errcode=403;`, 200, loomyWechatStatusCancelled, ""},
		{"402 = 二维码失效", `window.wx_errcode=402;`, 200, loomyWechatStatusExpired, ""},
		{"408 = 待扫码", `window.wx_errcode=408;`, 200, loomyWechatStatusWaiting, ""},
		{"未知 errcode = 待扫码", `window.wx_errcode=999;`, 200, loomyWechatStatusWaiting, ""},
	}
	for _, tc := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, tc.body)
		}))
		restoreLoomyWechatLongBase(t, srv.URL)
		m := newTestManager(t).m
		status, code, _ := m.PollLoomyWechatOnce(context.Background(), "uuid-1", "")
		srv.Close()
		if status != tc.wantStatus || code != tc.wantCode {
			t.Errorf("%s: got (%q,%q), want (%q,%q)", tc.name, status, code, tc.wantStatus, tc.wantCode)
		}
	}

	// 网络异常 → error 状态（**不抛错**：长轮询偶发失败不该终止流程）。
	m := newTestManager(t).m
	restoreLoomyWechatLongBase(t, "http://127.0.0.1:1") // 必然连不上
	status, _, errcode := m.PollLoomyWechatOnce(context.Background(), "uuid-1", "")
	if status != loomyWechatStatusError || errcode == "" {
		t.Fatalf("network failure must degrade to error status, got (%q,%q)", status, errcode)
	}
}

// TestFetchLoomyWechatUUIDErrors: 提取不到必须显式报错（不能返回空串）。
func TestFetchLoomyWechatUUIDErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "<html>nothing useful</html>")
	}))
	defer srv.Close()
	restoreLoomyWechatAuthBase(t, srv.URL)
	m := newTestManager(t).m
	if _, err := m.FetchLoomyWechatUUID(context.Background(), "state"); err == nil {
		t.Fatal("missing uuid must be an explicit error")
	} else if !strings.Contains(err.Error(), "uuid") {
		t.Fatalf("error should mention the uuid: %v", err)
	}
}

// TestFetchLoomyWechatQRImageRejectsNonImage: HTML 错误页不能被当二维码渲染。
func TestFetchLoomyWechatQRImageRejectsNonImage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "<html>not an image</html>")
	}))
	defer srv.Close()
	restoreLoomyWechatAuthBase(t, srv.URL)
	m := newTestManager(t).m
	if _, _, err := m.FetchLoomyWechatQRImage(context.Background(), "uuid"); err == nil {
		t.Fatal("non-image payload must fail (not render an error page as a QR)")
	}
}

// --- 完整流程：扫码 → bind/auth → 绑手机号 → 凭据落盘 ---

// loomyWechatMock wires: 微信授权页/图片/长轮询 + 讯飞账号端点 + 业务端点。
type loomyWechatMock struct {
	pollBody   string   // 长轮询响应体（测试可改）
	authBody   string   // bind/auth 响应
	sendBody   string   // bind/sendMsg 响应
	checkCode  []string // bind/checkCode 依次响应的 body（最后一个重复使用）
	skipBody   string
	checkCalls int
	firstLogin map[string]any
}

func newLoomyWechatMock(t *testing.T, mock *loomyWechatMock) {
	t.Helper()
	if mock.authBody == "" {
		mock.authBody = `{"code":"000000","data":{"rcode":"rc-1","bind":0}}`
	}
	if mock.sendBody == "" {
		mock.sendBody = `{"code":"000000","data":{"msgid":"msg-1"}}`
	}
	if mock.skipBody == "" {
		mock.skipBody = `{"code":"000000","data":{"session":"sess-skip","userid":"u-1"}}`
	}
	if mock.pollBody == "" {
		mock.pollBody = `window.wx_errcode=405;window.wx_code='wxcode1';`
	}
	// 微信三端点
	wechat := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/connect/qrconnect"):
			_, _ = io.WriteString(w, `<img src="/connect/qrcode/UUID123456"/>`)
		case strings.Contains(r.URL.Path, "/connect/qrcode/"):
			w.Header().Set("Content-Type", "image/jpeg")
			_, _ = w.Write(append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, make([]byte, 512)...))
		default:
			_, _ = io.WriteString(w, mock.pollBody)
		}
	}))
	t.Cleanup(wechat.Close)
	restoreLoomyWechatAuthBase(t, wechat.URL)
	restoreLoomyWechatLongBase(t, wechat.URL)

	// 讯飞 CAccount + 业务端点
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		text := string(body)
		switch {
		case strings.Contains(r.URL.Path, "/thirdAccount/bind/auth"):
			if !strings.Contains(text, `"type":"wx"`) || !strings.Contains(text, `"code":"wxcode1"`) {
				t.Errorf("bind/auth body wrong: %s", text)
			}
			_, _ = io.WriteString(w, mock.authBody)
		case strings.Contains(r.URL.Path, "/thirdAccount/bind/sendMsg"):
			if !strings.Contains(text, `"rcode":"rc-1"`) || !strings.Contains(text, `"ccode":"86"`) {
				t.Errorf("bind/sendMsg body wrong: %s", text)
			}
			_, _ = io.WriteString(w, mock.sendBody)
		case strings.Contains(r.URL.Path, "/thirdAccount/bind/checkCode"):
			idx := mock.checkCalls
			mock.checkCalls++
			if idx >= len(mock.checkCode) {
				idx = len(mock.checkCode) - 1
			}
			if !strings.Contains(text, `"msgid":"msg-1"`) {
				t.Errorf("bind/checkCode must echo the msgid: %s", text)
			}
			_, _ = io.WriteString(w, mock.checkCode[idx])
		case strings.Contains(r.URL.Path, "/thirdAccount/bind/skip"):
			_, _ = io.WriteString(w, mock.skipBody)
		default:
			t.Errorf("unexpected CAccount path %s", r.URL.Path)
			_, _ = io.WriteString(w, `{"code":"000000","data":{}}`)
		}
	}))
	t.Cleanup(account.Close)
	restoreLoomyAccountBase(t, account.URL)

	// 业务端点（每日额度初始化，best-effort）
	if mock.firstLogin == nil {
		mock.firstLogin = map[string]any{"alreadyProcessed": true}
	}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/points/first-login") {
			_ = json.NewEncoder(w).Encode(map[string]any{"code": "000000", "data": mock.firstLogin})
			return
		}
		_, _ = io.WriteString(w, `{"code":"000000","data":{}}`)
	}))
	t.Cleanup(api.Close)
	restoreLoomyAPIBase(t, api.URL)
}

// TestLoomyWechatFlowBindPhonePath: 扫码 → need_phone → 发码 → 验码 → 凭据落盘，
// 且账号昵称用手机号尾号。
func TestLoomyWechatFlowBindPhonePath(t *testing.T) {
	mock := &loomyWechatMock{checkCode: []string{`{"code":"000000","data":{"session":"sess-1","userid":"u-9","phone":"13011111100"}}`}}
	newLoomyWechatMock(t, mock)

	m := newTestManager(t).m
	id, ref := NewAccountID("loomy")
	if err := m.AddAccount(Account{ID: id, Provider: "loomy", Nickname: id, Enabled: true, CredentialRef: ref, CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	flow, err := m.StartLoomyWechatLogin(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	// 第一轮：拿到 confirmed → bind/auth（bind=0）⇒ need_phone
	stage, msg := flow.Poll(context.Background())
	if stage != loomyStageNeedPhone {
		t.Fatalf("stage = %q (%s), want need_phone", stage, msg)
	}
	if err := flow.SendBindSms(context.Background(), "13011111100"); err != nil {
		t.Fatal(err)
	}
	if err := flow.VerifyBind(context.Background(), "13011111100", "1234"); err != nil {
		t.Fatal(err)
	}
	// 凭据落盘 + 昵称
	acc, _ := m.FindAccount(id)
	if acc.Nickname != "Loomy 1100" {
		t.Fatalf("nickname = %q, want Loomy 1100", acc.Nickname)
	}
	raw, ok := m.Credential("loomy", ref)
	if !ok {
		t.Fatal("credential not persisted")
	}
	var cred LoomyCredential
	if err := json.Unmarshal(raw, &cred); err != nil {
		t.Fatal(err)
	}
	if cred.AccessToken != "sess-1" || cred.UserID != "u-9" || cred.Phone != "13011111100" {
		t.Fatalf("credential wrong: %+v", cred)
	}
	if cred.ExpiresAt == "" {
		t.Fatal("expires_at must be computed locally (server sends none)")
	}
	// 结果已 deliver（单赢家给 SettleAndCleanup）
	select {
	case out := <-flow.Result():
		if out.Err != nil || out.CredentialJSON == nil {
			t.Fatalf("outcome wrong: %+v", out)
		}
	default:
		t.Fatal("flow must deliver exactly one outcome")
	}
	if stage, _ := flow.Stage(); stage != loomyStageDone {
		t.Fatalf("final stage = %q, want done", stage)
	}
}

// TestLoomyWechatFlowSkipPath: 微信侧已绑手机号（bind=1）⇒ bind/skip 直接完成，
// 无手机号时昵称回退到 accountID（不能是字面「Loomy 」）。
func TestLoomyWechatFlowSkipPath(t *testing.T) {
	mock := &loomyWechatMock{authBody: `{"code":"000000","data":{"rcode":"rc-1","bind":1,"nickname":"阿飞"}}`}
	newLoomyWechatMock(t, mock)

	m := newTestManager(t).m
	id, ref := NewAccountID("loomy")
	_ = m.AddAccount(Account{ID: id, Provider: "loomy", Nickname: id, Enabled: true, CredentialRef: ref, CreatedAt: 1})
	flow, err := m.StartLoomyWechatLogin(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	stage, msg := flow.Poll(context.Background())
	if stage != loomyStageDone {
		t.Fatalf("stage = %q (%s), want done", stage, msg)
	}
	acc, _ := m.FindAccount(id)
	if acc.Nickname != "阿飞" {
		t.Fatalf("nickname must prefer the WeChat nickname, got %q", acc.Nickname)
	}
	var cred LoomyCredential
	raw, _ := m.Credential("loomy", ref)
	_ = json.Unmarshal(raw, &cred)
	if cred.AccessToken != "sess-skip" {
		t.Fatalf("credential wrong: %+v", cred)
	}
}

// TestLoomyWechatFlowVerifyRetry: 验证码输错**不终止**流程（就地重试），
// 第二次成功后仍能落定（参考实现有同款用例）。
func TestLoomyWechatFlowVerifyRetry(t *testing.T) {
	mock := &loomyWechatMock{checkCode: []string{
		`{"code":"020002","desc":"验证码错误"}`,
		`{"code":"000000","data":{"session":"sess-2","userid":"u-2","phone":"13022222222"}}`,
	}}
	newLoomyWechatMock(t, mock)

	m := newTestManager(t).m
	id, ref := NewAccountID("loomy")
	_ = m.AddAccount(Account{ID: id, Provider: "loomy", Nickname: id, Enabled: true, CredentialRef: ref, CreatedAt: 1})
	flow, err := m.StartLoomyWechatLogin(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if stage, _ := flow.Poll(context.Background()); stage != loomyStageNeedPhone {
		t.Fatalf("want need_phone, got %q", stage)
	}
	if err := flow.SendBindSms(context.Background(), "13022222222"); err != nil {
		t.Fatal(err)
	}
	if err := flow.VerifyBind(context.Background(), "13022222222", "0000"); err == nil {
		t.Fatal("wrong code must surface an error to the page")
	}
	// 流程未终止：还能继续轮询/重试
	if stage, _ := flow.Stage(); stage != loomyStageNeedPhone {
		t.Fatalf("stage after failure = %q, want need_phone (retry allowed)", stage)
	}
	if err := flow.VerifyBind(context.Background(), "13022222222", "1234"); err != nil {
		t.Fatalf("retry must succeed: %v", err)
	}
	if stage, _ := flow.Stage(); stage != loomyStageDone {
		t.Fatalf("final stage = %q, want done", stage)
	}
}

// TestLoomyWechatFlowCancelAndExpireSettle: cancelled/expired 必须**落定**（否则
// 占位账号会一直挂着；参考实现要等 5 分钟总超时才 reject）。
func TestLoomyWechatFlowCancelAndExpireSettle(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want string
	}{
		{"用户取消", `window.wx_errcode=403;`, loomyStageCancelled},
		{"二维码失效", `window.wx_errcode=402;`, loomyStageExpired},
	} {
		mock := &loomyWechatMock{pollBody: tc.body}
		newLoomyWechatMock(t, mock)
		m := newTestManager(t).m
		id, ref := NewAccountID("loomy")
		_ = m.AddAccount(Account{ID: id, Provider: "loomy", Nickname: id, Enabled: true, CredentialRef: ref, CreatedAt: 1})
		flow, err := m.StartLoomyWechatLogin(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		stage, msg := flow.Poll(context.Background())
		if stage != tc.want {
			t.Errorf("%s: stage = %q, want %q", tc.name, stage, tc.want)
		}
		if msg == "" {
			t.Errorf("%s: page needs a reason", tc.name)
		}
		select {
		case out := <-flow.Result():
			if out.Err == nil {
				t.Errorf("%s: must settle with an error (placeholder gets deleted)", tc.name)
			}
		default:
			t.Errorf("%s: must settle immediately (not wait for the 5min timeout)", tc.name)
		}
	}
}

// TestLoomyWechatFlowTimesOut: 扫码太慢必须失败（参考是 5 分钟总超时），否则占位
// 账号会无限挂着。
func TestLoomyWechatFlowTimesOut(t *testing.T) {
	mock := &loomyWechatMock{}
	newLoomyWechatMock(t, mock)
	m := newTestManager(t).m
	id, ref := NewAccountID("loomy")
	_ = m.AddAccount(Account{ID: id, Provider: "loomy", Nickname: id, Enabled: true, CredentialRef: ref, CreatedAt: 1})
	flow, err := m.StartLoomyWechatLogin(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	flow.mu.Lock()
	flow.deadline = time.Now().Add(-time.Second) // 已过期
	flow.mu.Unlock()
	stage, msg := flow.Poll(context.Background())
	if stage != loomyStageExpired || !strings.Contains(msg, "超时") {
		t.Fatalf("expired flow must report a timeout, got stage=%q msg=%q", stage, msg)
	}
	select {
	case out := <-flow.Result():
		if out.Err == nil {
			t.Fatal("timeout must settle with an error")
		}
	default:
		t.Fatal("timeout must settle the flow")
	}
}

func restoreLoomyWechatAuthBase(t *testing.T, mockURL string) {
	t.Helper()
	old := loomyWechatAuthBase
	loomyWechatAuthBase = mockURL
	t.Cleanup(func() { loomyWechatAuthBase = old })
}

func restoreLoomyWechatLongBase(t *testing.T, mockURL string) {
	t.Helper()
	old := loomyWechatLongBase
	loomyWechatLongBase = mockURL
	t.Cleanup(func() { loomyWechatLongBase = old })
}
