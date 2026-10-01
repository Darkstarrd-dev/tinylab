package jethub

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// RegisterQoder mounts the qoder/qodercn routes (P3.4): PKCE device-code
// login (no local port; 404-on-poll = "not ready yet") + refresh + daily
// claim + balance. Both products share ONE implementation (同族产品不复制实现
// —— 差异只在 provider id 与产品配置)。
func (h *Handler) RegisterQoder(r chi.Router) {
	for _, p := range []string{"qoder", "qodercn"} {
		provider := p
		r.Post("/"+provider+"/login", func(w http.ResponseWriter, r *http.Request) { h.qoderLogin(provider, w, r) })
		r.Get("/"+provider+"/status", h.qoderStatus(provider))
		r.Post("/"+provider+"/refresh", h.qoderRefresh(provider))
		r.Post("/"+provider+"/claim", h.qoderClaim(provider))
		r.Get("/"+provider+"/balance", h.qoderBalance(provider))
	}
}

// qoderLogin POST — device flow start + background poll; loginId tracks it.
// ⚠️ machine_id 是插件生成的持久化随机 UUID（非硬件指纹）。
func (h *Handler) qoderLogin(provider string, w http.ResponseWriter, r *http.Request) {
	id, credentialRef := corejethub.NewAccountID(provider)
	machineID := corejethub.QoderRandomMachineID()
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: provider, Nickname: id,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	flow, err := h.d.Manager.StartQoderLogin(provider, machineID)
	if err != nil {
		_ = h.d.Manager.DeleteAccount(id)
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	resultCh := make(chan corejethub.LoginOutcome, 1)
	started := corejethub.NewStartedLoginWithChannel(flow.LoginURL, resultCh)
	sess := &corejethub.LoginSession{Started: started, Account: id, Manager: h.d.Manager}
	corejethub.RegisterLoginSession(loginID, sess)
	// ⚠️ 后台轮询用独立 context：handler 返回后 r.Context() 即被取消，
	// 设备码轮询要等用户在浏览器里完成授权（数十秒到数分钟）。
	go func() {
		payload, err := h.d.Manager.PollQoderDeviceToken(context.Background(), flow.Session, flow.Product)
		if err != nil {
			corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{Err: err})
			return
		}
		cred := corejethub.BuildQoderCredential(payload, machineID, "")
		// 轮询响应从不带 user_name —— 补一次 userinfo 拿真实名字。
		if nickname := h.d.Manager.FetchQoderUserNickname(context.Background(), cred); nickname != "" {
			cred.Nickname = nickname
		}
		if err := h.d.Manager.CompleteQoderLogin(provider, id, cred); err != nil {
			corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{Err: err})
			return
		}
		credJSON, _ := json.Marshal(cred)
		corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{
			CredentialJSON: credJSON,
			ExpiresAt:      corejethub.QoderExpiresAtMs(cred),
			Refreshable:    corejethub.QoderRefreshable(cred),
		})
	}()
	// Single-winner pump: records the outcome for the status poll and deletes
	// the placeholder account when the flow failed (no credential-less entry).
	go corejethub.SettleAndCleanup(sess, nil)
	writeJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  started.LoginURL,
		"loginMode": "url",
	})
}

// qoderStatus GET — flow poll via loginId, or account snapshot.
func (h *Handler) qoderStatus(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if loginID := r.URL.Query().Get("loginId"); loginID != "" {
			h.pollLogin(loginID, w, r)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts(provider)})
	}
}

// qoderRefresh POST — silent renewal (refresh_token + machine_id body).
func (h *Handler) qoderRefresh(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			AccountID string `json:"accountId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
			apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
			return
		}
		if err := h.d.Manager.RefreshQoderAccount(r.Context(), provider, req.AccountID); err != nil {
			apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// qoderClaim POST — daily check-in (claim needs the machine header PAIR;
// replay idempotence is response-body `replayed:true`, NOT the status code).
func (h *Handler) qoderClaim(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			AccountID string `json:"accountId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
			apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
			return
		}
		outcome, err := h.d.Manager.ClaimQoderDailyCheckin(r.Context(), provider, req.AccountID)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"outcome": outcome})
	}
}

// qoderBalance GET — userQuota + addOnQuota + dedicatedResourcePackages.
func (h *Handler) qoderBalance(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID := r.URL.Query().Get("accountId")
		balance, err := h.d.Manager.QoderBalance(r.Context(), provider, accountID)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"balance": balance})
	}
}
