package jethub

// Codely（Unity 团结引擎）管理端点。
//
//	POST /api/jethub/codely/login   设备码登录（返回 loginId + 授权 URL，后台轮询）
//	GET  /api/jethub/codely/status  ?loginId= 轮询登录；否则账号快照
//	POST /api/jethub/codely/refresh 用 refresh_token 换新 access_token
//	GET  /api/jethub/codely/balance ?accountId= 积分钱包
//	POST /api/jethub/codely/claim   每日签到（init → check-in）

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// RegisterCodely mounts the Codely routes (protected group).
func (h *Handler) RegisterCodely(r chi.Router) {
	r.Post("/codely/login", h.codelyLogin)
	r.Get("/codely/status", h.codelyStatus)
	r.Post("/codely/refresh", h.codelyRefresh)
	r.Get("/codely/balance", h.codelyBalance)
	r.Post("/codely/claim", h.codelyClaim)
}

// codelyLogin POST — device flow: return the URL immediately, poll in the
// background (the poll must outlive this handler).
func (h *Handler) codelyLogin(w http.ResponseWriter, r *http.Request) {
	sel := decodeLoginOpen(r)
	id, credentialRef := corejethub.NewAccountID("codely")
	opt, err := h.prepareLoginOpen(sel, id)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	auth, err := h.d.Manager.RequestCodelyDeviceAuthorization(r.Context())
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: "codely", Nickname: id,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	resultCh := make(chan corejethub.LoginOutcome, 1)
	started := corejethub.NewStartedLoginWithChannel(auth.LoginURL, resultCh)
	sess := &corejethub.LoginSession{Started: started, Account: id, Manager: h.d.Manager}
	corejethub.RegisterLoginSession(loginID, sess)
	h.d.Manager.OpenURLWithBrowser(auth.LoginURL, opt)
	go func() {
		code, err := h.d.Manager.PollCodelyAuthorizationCode(context.Background(), auth)
		if err != nil {
			corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{Err: err})
			return
		}
		access, refresh, err := h.d.Manager.ExchangeCodelyAuthorizationCode(context.Background(), code)
		if err != nil {
			corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{Err: err})
			return
		}
		cred, err := h.d.Manager.CompleteCodelyLogin(id, access, refresh)
		if err != nil {
			corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{Err: err})
			return
		}
		credJSON, _ := json.Marshal(cred)
		corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{
			CredentialJSON: credJSON,
			ExpiresAt:      corejethub.CodelyExpiresAtMs(cred),
			Refreshable:    refresh != "",
		})
	}()
	go corejethub.SettleAndCleanup(sess, nil)
	apibase.WriteJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  auth.LoginURL,
		"userCode":  auth.UserCode,
		"loginMode": "url",
	})
}

// codelyStatus GET — flow poll via loginId, or account snapshot.
func (h *Handler) codelyStatus(w http.ResponseWriter, r *http.Request) {
	if loginID := r.URL.Query().Get("loginId"); loginID != "" {
		h.pollLogin(loginID, w, r)
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts("codely")})
}

// codelyRefresh POST — renew the access token with the refresh token.
func (h *Handler) codelyRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.RefreshCodelyAccount(r.Context(), req.AccountID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// codelyBalance GET — points wallet (credit).
func (h *Handler) codelyBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	if accountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	balance, err := h.d.Manager.FetchCodelyBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"balance": balance})
}

// codelyClaim POST — daily check-in.
func (h *Handler) codelyClaim(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	outcome, err := h.d.Manager.ClaimCodelyDailyCheckIn(r.Context(), req.AccountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"outcome": outcome})
}
