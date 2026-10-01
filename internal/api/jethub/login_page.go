package jethub

import (
	"encoding/json"
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
	// loomy（微信扫码）专用：二维码图片代理 + 主动推进轮询 + 绑手机步骤。
	r.Get("/jethub/login-page/qr-image", h.loginPageQRImage)
	r.Get("/jethub/login-page/poll", h.loginPagePoll)
	r.Post("/jethub/login-page/complete", h.loginPageComplete)
}

// loginPageData GET ?loginId= — the QR payload + labels for the page.
//
// 两种二维码形态：
//   - `qr`      = 二维码**内容**（raccoon：页面用 raccoon-qr.js 现场画 SVG）；
//   - `qrImage` = 二维码**图片地址**（loomy：微信下发 JPEG，其 URL 本身不是可编码
//     的登录码，故由本服务代理图片，uuid 留在宿主侧 —— 与参考实现的边界一致）。
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
	payload := map[string]any{
		"ok":       true,
		"provider": provider,
		"title":    title,
		"hint":     hint,
	}
	if _, isLoomy := sess.Extra.(*corejethub.LoomyWechatFlow); isLoomy {
		// 微信二维码：图片由宿主代理（见 qr-image 端点）。
		payload["qrImage"] = "/api/jethub/login-page/qr-image?loginId=" + url.QueryEscape(sess.Key)
		payload["bindForm"] = true
	} else {
		payload["qr"] = sess.Started.QRContent
	}
	apibase.WriteJSON(w, http.StatusOK, payload)
}

// loginPageStatus GET ?loginId= — passive poll (the pump owns the channel).
func (h *Handler) loginPageStatus(w http.ResponseWriter, r *http.Request) {
	sess, ok := h.loginPageSession(w, r)
	if !ok {
		return
	}
	done, success, errMsg := corejethub.SessionStatus(sess)
	if !done {
		apibase.WriteJSON(w, http.StatusOK, map[string]any{"done": false})
		return
	}
	if !success {
		apibase.WriteJSON(w, http.StatusOK, map[string]any{"done": true, "success": false, "error": errMsg})
		return
	}
	// ⚠️ 不回 accountId（保护组外的响应只暴露登录是否完成）。
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"done": true, "success": true})
}

// loginPageSession resolves the loginId to a live session that has a QR page.
func (h *Handler) loginPageSession(w http.ResponseWriter, r *http.Request) (*corejethub.LoginSession, bool) {
	loginID := r.URL.Query().Get("loginId")
	if loginID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "loginId required")
		return nil, false
	}
	sess, ok := corejethub.PeekLoginSession(loginID)
	if !ok || sess.Started == nil {
		// 会话已结束（结算后 30s 宽限期一过就被回收）或 id 无效。
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown or settled loginId")
		return nil, false
	}
	// raccoon 靠 QRContent；loomy 靠 Extra 里的微信流程（二维码是图片，不是文本）。
	if _, isLoomy := sess.Extra.(*corejethub.LoomyWechatFlow); isLoomy {
		return sess, true
	}
	if sess.Started.QRContent == "" {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown or settled loginId")
		return nil, false
	}
	return sess, true
}

// loomyFlowOf extracts the WeChat flow (nil when this session is not loomy).
func loomyFlowOf(sess *corejethub.LoginSession) *corejethub.LoomyWechatFlow {
	flow, _ := sess.Extra.(*corejethub.LoomyWechatFlow)
	return flow
}

// loginPageQRImage GET ?loginId= — proxies the WeChat QR image.
//
// ⚠️ 为什么不让页面直接 `<img src="https://open.weixin.qq.com/connect/qrcode/{uuid}">`：
// 那会把 uuid 交给页面（参考实现刻意把它留在宿主侧），且浏览器要多一次直连微信
// （受浏览器代理影响）。这里由宿主拉取并以 image/* 回传。
func (h *Handler) loginPageQRImage(w http.ResponseWriter, r *http.Request) {
	sess, ok := h.loginPageSession(w, r)
	if !ok {
		return
	}
	flow := loomyFlowOf(sess)
	if flow == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "this login session has no QR image")
		return
	}
	img, mime, err := flow.QRImage(r.Context())
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(img)
}

// loginPagePoll GET ?loginId= — one upstream long-poll for the loomy WeChat flow.
//
// ⚠️ 与 raccoon 的 `status`（纯被动读宿主状态）不同：这里**推进**上游状态机
// （与参考实现同构：页面每轮一次，`last` 链与 bind/auth 触发点只有一处）。
func (h *Handler) loginPagePoll(w http.ResponseWriter, r *http.Request) {
	sess, ok := h.loginPageSession(w, r)
	if !ok {
		return
	}
	flow := loomyFlowOf(sess)
	if flow == nil {
		// 非 loomy（raccoon 等）没有主动轮询语义：让页面走 status。
		apibase.WriteAPIError(w, http.StatusBadRequest, "this login session does not use the poll endpoint")
		return
	}
	stage, errMsg := flow.Poll(r.Context())
	out := map[string]any{"ok": true, "stage": stage}
	if errMsg != "" {
		out["message"] = errMsg
	}
	apibase.WriteJSON(w, http.StatusOK, out)
}

// loginPageComplete POST {loginId, action, phone, code} — the loomy bind-phone
// steps (action = send_sms | verify_sms). Contract mirrors the reference page:
// `{ok:true}` / `{ok:false,message}` / `{ok:true,done:true}`, and a failing step
// must NOT terminate the flow (the page shows the reason and lets the user retry).
func (h *Handler) loginPageComplete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		LoginID string `json:"loginId"`
		Action  string `json:"action"`
		Phone   string `json:"phone"`
		Code    string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.LoginID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "loginId required")
		return
	}
	sess, ok := corejethub.PeekLoginSession(req.LoginID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown or settled loginId")
		return
	}
	flow := loomyFlowOf(sess)
	if flow == nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "this login session has no bind step")
		return
	}
	switch req.Action {
	case "send_sms":
		if err := flow.SendBindSms(r.Context(), req.Phone); err != nil {
			apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": false, "message": err.Error()})
			return
		}
		apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "verify_sms":
		if err := flow.VerifyBind(r.Context(), req.Phone, req.Code); err != nil {
			apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": false, "message": err.Error()})
			return
		}
		apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "done": true})
	default:
		apibase.WriteAPIError(w, http.StatusBadRequest, "unknown action: "+req.Action)
	}
}

// loginPageLabels returns the page title/hint for a provider.
func loginPageLabels(provider string) (title, hint string) {
	switch provider {
	case "raccoon":
		return "登录 Raccoon Work（商汤小浣熊）", "打开微信扫一扫，扫描上方二维码"
	case "loomy":
		return "使用微信扫码登录 Loomy", "打开微信扫一扫，扫描下方二维码"
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
	return localLoginPageURL(r, "/free-hub-login.html", loginID, "raccoon")
}

// loomyLoginPageURL is the loomy variant (WeChat QR image + bind-phone form —
// a separate page so raccoon's contract stays untouched).
func loomyLoginPageURL(r *http.Request, loginID string) string {
	return localLoginPageURL(r, "/free-hub-loomy-login.html", loginID, "loomy")
}

// localLoginPageURL builds `<scheme>://<host><page>?loginId=…&provider=…`.
func localLoginPageURL(r *http.Request, page, loginID, provider string) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if host == "" {
		host = "127.0.0.1"
	}
	return scheme + "://" + host + page + "?loginId=" +
		url.QueryEscape(loginID) + "&provider=" + url.QueryEscape(provider)
}
