package jethub

// Accio（R6：阿里 Accio Work）管理端点。
//
// 登录走标准 OAuth2 + PKCE，回调落本端自己的 loopback（StartAccioLogin 内部
// 起回调服务并往 StartedLogin.Result 投递结果）—— 与 officeace 同款「后台泵」
// 形态：handler 立刻返回 loginUrl，兑换/身份回填全部在后台完成。
// ⚠️ 泵必须跑在 context.Background() 上 —— 请求 context 在响应写完即取消
// （sessions.go 的 defect-1 纪律）。
//
// region（cn|global）只是**登录页域名**参数（网关与区域无关）；白名单归一在
// corejethub（normalizeAccioRegion：未登记的值一律回落 cn，不报错）。

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// RegisterAccio mounts the accio-specific routes under /api/jethub.
// ⚠️ 无 claim 端点：Accio 没有每日签到（上游三个只读积分端点 + 服务端按日
// 发放），ProviderMeta.HasCredits=false 与这里保持一致。
func (h *Handler) RegisterAccio(r chi.Router) {
	r.Post("/accio/login", h.accioLogin)
	r.Get("/accio/status", h.accioStatus)
	r.Post("/accio/refresh", h.accioRefresh)
	r.Get("/accio/balance", h.accioBalance)
}

// accioLogin POST /api/jethub/accio/login {region?, browser?, session?} —
// starts the PKCE flow: return the authorize URL, open it in the chosen
// browser/session and settle the loopback callback in the background.
func (h *Handler) accioLogin(w http.ResponseWriter, r *http.Request) {
	sel := decodeLoginOpen(r)
	// region 是可选体字段：缺省/非法值由 corejethub 归一到 cn。
	var req struct {
		Region string `json:"region"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	id, credentialRef := corejethub.NewAccountID("accio")
	// 选择校验在建号之前：不可用的浏览器/会话必须是 400，而不是「弹窗一直
	// 等待、浏览器什么都没开」（officeace 同序）。
	opt, err := h.prepareLoginOpen(sel, id)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	// 先起流（回调端口决定 return_url，必须先监听）再建占位账号：登录失败的
	// 占位账号由 SettleAndCleanup 删除（qoder 同款兜底）。
	started, err := corejethub.StartAccioLogin(nil, req.Region)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: "accio", Nickname: id,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 自动打开授权页（对话框里的链接是兜底）。浏览器开页在建号之后（与
	// officeace/qoder 同序）：账号都没建成就弹页是纯粹的噪声。
	h.d.Manager.OpenURLWithBrowser(started.LoginURL, opt)
	loginID := corejethub.NewLoginSessionID()
	sess := &corejethub.LoginSession{Started: started, Account: id, Manager: h.d.Manager}
	corejethub.RegisterLoginSession(loginID, sess)
	// SettleAndCleanup: 失败删占位账号；成功经 CompleteAccioLogin 持久化
	// （写凭据 + 回填昵称 + 触发桥接同步）。⚠️ 独立 goroutine + Started 自带的
	// Result 通道（StartAccioLogin 已把兑换/身份回填接进去了）。
	go corejethub.SettleAndCleanup(sess, func(o corejethub.LoginOutcome) error {
		return h.d.Manager.CompleteAccioLogin(id, o.CredentialJSON, o.ExpiresAt, o.Refreshable)
	})
	apibase.WriteJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  started.LoginURL,
		"loginMode": "url",
	})
}

// accioStatus GET /api/jethub/accio/status — flow poll via loginId, or the
// account snapshot without one.
func (h *Handler) accioStatus(w http.ResponseWriter, r *http.Request) {
	if loginID := r.URL.Query().Get("loginId"); loginID != "" {
		h.pollLogin(loginID, w, r)
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts("accio")})
}

// accioRefresh POST /api/jethub/accio/refresh {accountId} — silent renewal
// (rotating refresh_token; account card "refresh" button).
func (h *Handler) accioRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.RefreshAccioAccount(r.Context(), req.AccountID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// accioBalance GET /api/jethub/accio/balance?accountId= — read-only credit
// snapshot (userinfo + currentSubscription + quota 三端点聚合，credit 计).
func (h *Handler) accioBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	balance, err := h.d.Manager.AccioBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"balance": balance})
}
