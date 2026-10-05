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

// RegisterTrae mounts the trae routes (P3.3).
func (h *Handler) RegisterTrae(r chi.Router) {
	r.Post("/trae/login", h.traeLogin)
	r.Get("/trae/status", h.traeStatus)
	r.Post("/trae/refresh", h.traeRefresh)
	r.Post("/trae/claim", h.traeClaim)
	r.Get("/trae/balance", h.traeBalance)
}

// traeLogin POST — two-step callback login (preferred port 18080 with random
// fallback; the login URL carries auth_callback_url with the actual port).
func (h *Handler) traeLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Nickname string `json:"nickname"`
		loginOpenFields
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	id, credentialRef := corejethub.NewAccountID("trae")
	opt, err := h.prepareLoginOpen(req.loginOpenFields, id)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	nickname := firstNonEmptyStr(req.Nickname, id)
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: "trae", Nickname: nickname,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	started, err := h.d.Manager.StartTraeLogin(context.Background(), id, func(u string) {
		h.d.Manager.OpenURLWithBrowser(u, opt)
	})
	if err != nil {
		_ = h.d.Manager.DeleteAccount(id)
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	sess := &corejethub.LoginSession{Started: started, Account: id, Manager: h.d.Manager}
	corejethub.RegisterLoginSession(loginID, sess)
	// Single-winner pump; the callback server + timeout goroutine run on the
	// background context (StartTraeLogin) so they outlive this handler.
	go corejethub.SettleAndCleanup(sess, nil) // flow persists via CompleteTraeLogin
	apibase.WriteJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  started.LoginURL,
		"loginMode": "url",
	})
}

// traeStatus GET — flow poll via loginId, or account snapshot.
func (h *Handler) traeStatus(w http.ResponseWriter, r *http.Request) {
	if loginID := r.URL.Query().Get("loginId"); loginID != "" {
		h.pollLogin(loginID, w, r)
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts("trae")})
}

// traeRefresh POST — ExchangeToken renewal.
func (h *Handler) traeRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.RefreshTraeAccount(r.Context(), req.AccountID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// traeClaim POST — daily check-in (9074 device rotation handled internally).
func (h *Handler) traeClaim(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	outcome, err := h.d.Manager.ClaimTraeDaily(r.Context(), req.AccountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"outcome": outcome})
}

// traeBalance GET — ent usage balance.
func (h *Handler) traeBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	balance, err := h.d.Manager.TraeBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{
		"balance": balance,
		// TRAE 的资源包带条目级 `expire_time`（秒 → 毫秒）⇒ 面板按「长期 / 临时」
		// 分桶显示（ref 同款：TRAE 与 buddy 系共用同一个窗口环境变量）。
		"windowDays": corejethub.ExpiringWindowDays(),
	})
}
