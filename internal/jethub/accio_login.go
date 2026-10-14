package jethub

// Accio 登录：标准 OAuth2 + PKCE，回调落**我们自己的 loopback**
// （Accio 服务端对 return_url 无白名单校验，ref accio-auth.ts）。
//
// 流程（ref startLoginFlow，两步式 —— handler 立即返回 loginUrl）：
//
//	① 监听 127.0.0.1 随机端口（必须先监听：return_url 要写实端口）
//	② 打开 {loginBase}/login?return_url=&state=&code_challenge=&
//	    code_challenge_method=S256&client_id=accio-work&ttid=&language=zh
//	③ 服务端回调 {loopback}/auth/callback?code=&state=
//	④ state 原样比对（任何能往 loopback 投递查询串的本地进程都能伪造回调）
//	⑤ POST /api/oauth/token 兑换 → 凭据落盘
//
// ⚠️ 与 codearts 的差别：PKCE 对**直接复用** GeneratePkcePair（同为 48 字节
// base64url verifier + S256 challenge，ref createAccioPkcePair 逐字一致）；
// code_challenge_method 恒 **S256**（RFC 名；codearts 的 portal 用 "SHA-256"
// 是它自家的方言，别照搬）。state 为 32 随机字节 hex。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// accioLoginFlow is one in-flight PKCE login (all in-memory intermediate state;
// nothing but the final credential is persisted).
type accioLoginFlow struct {
	State        string
	AuthorizeURL string
	CodeVerifier string
	Region       string
	// RedirectURI is the loopback callback URL the exchange must echo.
	RedirectURI string
}

// StartAccioLogin starts the PKCE callback server and returns the authorize
// URL immediately (two-step login). The result resolves on success/timeout;
// openURL (when non-nil) is invoked asynchronously with the login URL.
//
// ⚠️ region 只是**登录页域名**参数（gateway 与区域无关）；非法值已由调用方
// 归一到白名单（normalizeAccioRegion）。
func StartAccioLogin(openURL func(string), region string) (*StartedLogin, error) {
	pkce, err := GeneratePkcePair()
	if err != nil {
		return nil, err
	}
	state := randomHex(32)

	ctx, cancel := context.WithCancel(context.Background())
	ln, port, err := listenCallbackPort()
	if err != nil {
		cancel()
		return nil, err
	}
	redirectURI := fmt.Sprintf("http://127.0.0.1:%d%s", port, accioCallbackPath)

	result := make(chan LoginOutcome, 1)
	deliverCredential := func(cred *AccioCredential, err error) {
		if err != nil {
			deliver(result, LoginOutcome{Err: err})
			return
		}
		data, err := json.Marshal(cred)
		deliver(result, LoginOutcome{
			CredentialJSON: data,
			ExpiresAt:      accioCredentialExpiresAt(cred),
			Refreshable:    accioRefreshable(cred),
			Err:            err,
		})
	}

	mux := http.NewServeMux()
	mux.HandleFunc(accioCallbackPath, func(w http.ResponseWriter, r *http.Request) {
		// ⚠️ state 必须原样匹配：少了这一层，任何能往 loopback 投递查询串的
		// 本地进程都能把一份攻击者的授权码写进用户账号（ref 同款注释）。
		if r.URL.Query().Get("state") != state {
			http.Error(w, "accio: state 校验失败，请回到面板重新发起登录", http.StatusBadRequest)
			deliverCredential(nil, fmt.Errorf("accio: 登录回调 state 不匹配（可能是伪造的回调）"))
			return
		}
		if errParam := r.URL.Query().Get("error"); errParam != "" {
			http.Error(w, "accio: 授权被拒绝："+errParam, http.StatusBadRequest)
			deliverCredential(nil, fmt.Errorf("accio: 授权被拒绝（%s）", errParam))
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			http.Error(w, "accio: 回调里没有授权码", http.StatusBadRequest)
			deliverCredential(nil, fmt.Errorf("accio: 登录回调缺少授权码"))
			return
		}
		// 先回提示页、再在后台兑换：用户不必盯着转圈的标签页等 token（ref 同款）。
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><body style=\"font-family:system-ui;padding:2rem\"><p>Accio 授权已收到，可以关闭此页面并返回面板。</p></body></html>")
		go func() {
			token, err := exchangeAccioCode(ctx, code, pkce.CodeVerifier, redirectURI)
			if err != nil {
				deliverCredential(nil, err)
				return
			}
			cred := &AccioCredential{
				AccessToken:  token.AccessToken,
				RefreshToken: token.RefreshToken,
				ExpiresAtMs:  token.ExpiresAtMs,
				Sgcookie:     token.Sgcookie,
				Region:       normalizeAccioRegion(region),
			}
			// best-effort 身份回填（userinfo 只读；失败不影响登录本身）。
			accioFillIdentity(ctx, cred)
			deliverCredential(cred, nil)
		}()
	})

	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(ln) }()
	go func() {
		<-ctx.Done()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Second)
		defer shutdownCancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	go func() {
		select {
		case <-time.After(accioLoginBudget):
			deliver(result, LoginOutcome{Err: ErrLoginTimeout})
			cancel()
		case <-ctx.Done():
		}
	}()

	authorizeURL := accioBuildAuthURL(region, redirectURI, state, pkce.CodeChallenge)
	if openURL != nil {
		go openURL(authorizeURL)
	}
	return &StartedLogin{LoginURL: authorizeURL, Result: result, cancel: cancel}, nil
}

// accioBuildAuthURL assembles the login-page authorize URL. ⚠️ 参数缺一不可：
// 少了 code_challenge 会被登录页判成 legacy 客户端而弹「请升级客户端」
// （ref buildAccioAuthUrl 文件头的整段事故说明）。
func accioBuildAuthURL(region, redirectURI, state, codeChallenge string) string {
	params := url.Values{
		"return_url":            {redirectURI},
		"state":                 {state},
		"code_challenge":        {codeChallenge},
		"code_challenge_method": {"S256"},
		"client_id":             {accioClientID},
		"ttid":                  {"ttid_" + randomHex(16)},
		"language":              {"zh"},
	}
	return accioLoginBaseOf(normalizeAccioRegion(region)) + "/login?" + params.Encode()
}

// StartAccioLoginWithBrowser starts the accio PKCE flow and opens the login
// page through the manager's registered browser opener (opt = the browser /
// session picked in the +新建账号 dialog; zero value = remembered preference).
func (m *Manager) StartAccioLoginWithBrowser(opt OpenOptions, region string) (*StartedLogin, error) {
	return StartAccioLogin(func(u string) { m.openURLWithBrowser(u, opt) }, region)
}

// accioFillIdentity best-effort fills user_id / accio_id / nickname from
// POST /api/auth/userinfo（只读端点；失败静默 —— 身份是附加信息，取不到不该
// 让登录失败）。客户端用 callbackClient：与 token 兑换同一条出站路径。
func accioFillIdentity(ctx context.Context, cred *AccioCredential) {
	info, err := accioFetchUserInfo(ctx, callbackClient, cred)
	if err != nil || info == nil {
		return
	}
	cred.UserID = info.UserID
	cred.AccioID = info.UserID
	if info.UserName != "" {
		cred.Nickname = info.UserName
	}
}
