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

// RegisterRaccoon mounts the raccoon routes (P3.3.3): WeChat QR login
// (client-side QR page) + SMS login + login reward + balance.
func (h *Handler) RegisterRaccoon(r chi.Router) {
	r.Post("/raccoon/login", h.raccoonLogin)
	r.Get("/raccoon/status", h.raccoonStatus)
	r.Post("/raccoon/sms/send", h.raccoonSmsSend)
	r.Post("/raccoon/sms/submit", h.raccoonSmsSubmit)
	r.Post("/raccoon/refresh", h.raccoonRefresh)
	r.Post("/raccoon/claim", h.raccoonClaim)
	r.Get("/raccoon/balance", h.raccoonBalance)
}

// raccoonLogin POST — QR flow (client-generated 32-hex code; UI renders the
// WeChat login page itself and polls status with loginId).
//
// ⚠️ The background poll MUST NOT hang off r.Context(): the handler returns
// right after this response, and net/http cancels the request context at that
// moment — a r.Context()-bound poll aborts before the user even opens the
// QR page (the "placeholder account, credential never lands" defect).
func (h *Handler) raccoonLogin(w http.ResponseWriter, r *http.Request) {
	id, credentialRef := corejethub.NewAccountID("raccoon")
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: "raccoon", Nickname: id,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	started, err := h.d.Manager.StartRaccoonQRLogin(context.Background(), id, nil)
	if err != nil {
		_ = h.d.Manager.DeleteAccount(id)
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	sess := &corejethub.LoginSession{Started: started, Account: id, Manager: h.d.Manager}
	corejethub.RegisterLoginSession(loginID, sess)
	// Fire-and-forget pump: settles the outcome, records it for the status
	// poll and deletes the placeholder on failure. The flow persists the
	// credential itself via CompleteRaccoonLogin, so nothing extra here.
	go corejethub.SettleAndCleanup(sess, nil)

	writeJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  started.LoginURL,
		"loginMode": "url",
	})
}

// raccoonStatus GET — flow poll via loginId, or account snapshot.
func (h *Handler) raccoonStatus(w http.ResponseWriter, r *http.Request) {
	if loginID := r.URL.Query().Get("loginId"); loginID != "" {
		h.pollLogin(loginID, w, r)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts("raccoon")})
}

// raccoonSmsSend POST {phone, captchaParam} — sends an AES-encrypted SMS.
func (h *Handler) raccoonSmsSend(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone        string `json:"phone"`
		CaptchaParam string `json:"captchaParam"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Phone == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "phone required")
		return
	}
	if err := h.d.Manager.SendRaccoonSmsCode(r.Context(), req.Phone, req.CaptchaParam); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// raccoonSmsSubmit POST {accountId, phone, code} — completes SMS login.
func (h *Handler) raccoonSmsSubmit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
		Phone     string `json:"phone"`
		Code      string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" || req.Code == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId and code required")
		return
	}
	if err := h.d.Manager.SubmitRaccoonSmsLogin(r.Context(), req.AccountID, req.Phone, req.Code); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "accountId": req.AccountID})
}

// raccoonRefresh POST — silent renewal.
func (h *Handler) raccoonRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.RefreshRaccoonAccount(r.Context(), req.AccountID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// raccoonClaim POST — desktop login reward (idempotent-once).
func (h *Handler) raccoonClaim(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	outcome, err := h.d.Manager.ClaimRaccoonLoginReward(r.Context(), req.AccountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"outcome": outcome})
}

// raccoonBalance GET — points/v1/balance.
func (h *Handler) raccoonBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	balance, err := h.d.Manager.RaccoonBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"balance": balance})
}
