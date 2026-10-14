package jethub

// OfficeAce（R6：华为 ModelArts MaaS 云直连）管理端点。
//
// 登录走 zcode 同款的「后台泵」形态：handler 立刻返回 loginUrl，轮询/换
// token/取 MaaS 凭据全部在后台 goroutine 完成（核心 RunOfficeaceLogin）。
// ⚠️ 泵必须跑在 context.Background() 上 —— 请求 context 在响应写完即取消，
// 绑上去的登录流永远走不到换 token（sessions.go 头注释的 defect-1 纪律；
// web/jethub.test.js 有守卫锁死本文件的这两处调用）。

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// RegisterOfficeace mounts the officeace-specific routes under /api/jethub.
func (h *Handler) RegisterOfficeace(r chi.Router) {
	r.Post("/officeace/login", h.officeaceLogin)
	r.Get("/officeace/status", h.officeaceStatus)
	r.Post("/officeace/refresh", h.officeaceRefresh)
	r.Get("/officeace/balance", h.officeaceBalance)
	// 显式领取每日奖励。⚠️ ref 在**每次余额查询前**都会顺手签到 —— 那是
	// mutating POST，挂在 GET balance 上会被 Monitor 的聚合每分钟触发一次，
	// 故本端拆成显式端点（docs/jethub-architecture.md 的既定差异记录）。
	r.Post("/officeace/claim", h.officeaceClaim)
}

// officeaceLogin POST /api/jethub/officeace/login — starts the cloud-direct
// flow: register the state cloud-side, return the Huawei SSO authorize URL,
// open it in the chosen browser/session and pump the anonymous code poll in
// the background.
func (h *Handler) officeaceLogin(w http.ResponseWriter, r *http.Request) {
	sel := decodeLoginOpen(r)
	id, credentialRef := corejethub.NewAccountID("officeace")
	// 选择校验在建号之前：不可用的浏览器/会话必须是 400，而不是「弹窗一直
	// 等待、浏览器什么都没开」（codearts 同序）。
	opt, err := h.prepareLoginOpen(sel, id)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	// ⚠️ 后台 context：state 注册虽是单次同步调用，但与泵同源 —— 不给未来
	// 的改动留「顺手把 request ctx 传进来」的口子。
	flow, err := h.d.Manager.StartOfficeaceLogin(context.Background())
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: "officeace", Nickname: id,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	resultCh := make(chan corejethub.LoginOutcome, 1)
	started := corejethub.NewStartedLoginWithChannel(flow.AuthorizeURL, resultCh)
	sess := &corejethub.LoginSession{Started: started, Account: id, Manager: h.d.Manager}
	corejethub.RegisterLoginSession(loginID, sess)
	// 自动打开授权页（对话框里的链接是兜底）。
	h.d.Manager.OpenURLWithBrowser(flow.AuthorizeURL, opt)
	// ⚠️ 后台 context：轮询必须活过这个 handler（zcode 的同款注释）。
	go func() {
		cred, err := h.d.Manager.RunOfficeaceLogin(context.Background(), flow, 0)
		if err != nil {
			corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{Err: err})
			return
		}
		credJSON, err := json.Marshal(cred)
		if err != nil {
			corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{Err: err})
			return
		}
		expiresAt, refreshable := corejethub.OfficeaceOutcomeMeta(cred)
		corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{
			CredentialJSON: credJSON,
			ExpiresAt:      expiresAt,
			Refreshable:    refreshable,
		})
	}()
	// SettleAndCleanup: 失败删占位账号；成功经 CompleteOfficeaceLogin 持久化
	// （写凭据 + 回填昵称 + 触发桥接同步）。
	go corejethub.SettleAndCleanup(sess, func(o corejethub.LoginOutcome) error {
		return h.d.Manager.CompleteOfficeaceLogin(id, o.CredentialJSON, o.ExpiresAt, o.Refreshable)
	})
	apibase.WriteJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  started.LoginURL,
		"loginMode": "url",
	})
}

// officeaceStatus GET /api/jethub/officeace/status — flow poll via loginId,
// or the account snapshot without one.
func (h *Handler) officeaceStatus(w http.ResponseWriter, r *http.Request) {
	if loginID := r.URL.Query().Get("loginId"); loginID != "" {
		h.pollLogin(loginID, w, r)
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts("officeace")})
}

// officeaceRefresh POST /api/jethub/officeace/refresh {accountId} — silent
// STS renewal for one account (account card "refresh" button).
func (h *Handler) officeaceRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.RefreshOfficeaceAccount(r.Context(), req.AccountID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// officeaceBalance GET /api/jethub/officeace/balance?accountId= — V11-signed
// subscription snapshot (token buckets for the UI).
func (h *Handler) officeaceBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	balance, err := h.d.Manager.OfficeaceBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"balance": balance})
}

// officeaceClaim POST /api/jethub/officeace/claim {accountId} — explicit daily
// bonus claim (decoupled from the GET balance path on purpose).
func (h *Handler) officeaceClaim(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	outcome, err := h.d.Manager.OfficeaceClaimDaily(r.Context(), req.AccountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"outcome": outcome})
}
