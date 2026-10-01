package jethub

import (
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// Free Hub 本地登录页（扫码类 provider）的数据源。
//
// ## 为什么需要它
//
// 参考插件为扫码登录起了一个本地 HTTP 服务承载弹窗页；本项目已有 HTTP 服务，
// 故页面做成**静态页** `web/static/free-hub-login.html`（二维码由浏览器端
// `raccoon-qr.js` 渲染），这里只提供两个数据端点：
//
//	GET /api/jethub/login-page?loginId=…         页面数据（二维码内容 + 文案）
//	GET /api/jethub/login-page/status?loginId=…  登录状态（done/success/error）
//
// ## ⚠️ 必须挂在鉴权中间件**之外**
//
// 页面是给**系统默认浏览器**打开的，而管理 UI 可能开了密码保护
// （Security.PasswordEnabled）——那个浏览器里没有管理 UI 的 cookie，挂进保护组
// 会让页面直接 401/跳登录页，「无法鉴权」会以另一种形式复发。访问控制交给
// `loginId`：128 位随机、一次性、随会话一起过期；响应里**不含**任何 token、
// 凭据或账号标识（只有二维码内容与状态），与插件的本地页面同一安全口径。
//
// 注册点见 internal/api/router.go：紧跟 `authHandler.Register(r)` 之后。

// RegisterPublicLoginPage mounts the scan-login page endpoints (see the file
// comment for why they live outside the auth middleware).
func (h *Handler) RegisterPublicLoginPage(r chi.Router) {
	r.Get("/jethub/login-page", h.loginPageData)
	r.Get("/jethub/login-page/status", h.loginPageStatus)
}

// loginPageData GET ?loginId= — the QR payload + labels for the page.
func (h *Handler) loginPageData(w http.ResponseWriter, r *http.Request) {
	sess, ok := h.loginPageSession(w, r)
	if !ok {
		return
	}
	provider := ""
	if acc, found := h.d.Manager.FindAccount(sess.Account); found {
		provider = acc.Provider
	}
	title, hint := loginPageLabels(provider)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"provider": provider,
		"title":    title,
		"hint":     hint,
		"qr":       sess.Started.QRContent,
	})
}

// loginPageStatus GET ?loginId= — passive poll (the pump owns the channel).
func (h *Handler) loginPageStatus(w http.ResponseWriter, r *http.Request) {
	sess, ok := h.loginPageSession(w, r)
	if !ok {
		return
	}
	done, success, errMsg := corejethub.SessionStatus(sess)
	if !done {
		writeJSON(w, http.StatusOK, map[string]any{"done": false})
		return
	}
	if !success {
		writeJSON(w, http.StatusOK, map[string]any{"done": true, "success": false, "error": errMsg})
		return
	}
	// ⚠️ 不回 accountId（保护组外的响应只暴露登录是否完成）。
	writeJSON(w, http.StatusOK, map[string]any{"done": true, "success": true})
}

// loginPageSession resolves the loginId to a live session that has a QR page.
func (h *Handler) loginPageSession(w http.ResponseWriter, r *http.Request) (*corejethub.LoginSession, bool) {
	loginID := r.URL.Query().Get("loginId")
	if loginID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "loginId required")
		return nil, false
	}
	sess, ok := corejethub.PeekLoginSession(loginID)
	if !ok || sess.Started == nil || sess.Started.QRContent == "" {
		// 会话已结束（结算后 30s 宽限期一过就被回收）或 id 无效。
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown or settled loginId")
		return nil, false
	}
	return sess, true
}

// loginPageLabels returns the page title/hint for a provider.
func loginPageLabels(provider string) (title, hint string) {
	switch provider {
	case "raccoon":
		return "登录 Raccoon Work（商汤小浣熊）", "打开微信扫一扫，扫描上方二维码"
	default:
		if provider == "" {
			return "扫码登录", "用对应的手机应用扫描上方二维码"
		}
		return "登录 " + provider, "用对应的手机应用扫描上方二维码"
	}
}

// raccoonLoginPageURL builds the local scan-login page URL the browser opens.
// It is a page URL (LoginURL) — the QR content travels separately through
// Started.QRContent.
func raccoonLoginPageURL(r *http.Request, loginID string) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if host == "" {
		host = "127.0.0.1"
	}
	return scheme + "://" + host + "/free-hub-login.html?loginId=" +
		url.QueryEscape(loginID) + "&provider=raccoon"
}
