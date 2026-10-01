package jethub

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// RegisterCline mounts the cline routes (P3.3.2). Login is device-code (no
// local callback server): the client polls status with loginId.
func (h *Handler) RegisterCline(r chi.Router) {
	r.Post("/cline/login", h.clineLogin)
	r.Get("/cline/status", h.clineStatus)
	r.Post("/cline/refresh", h.clineRefresh)
	r.Get("/cline/balance", h.clineBalance)
}

// clineLogin POST — device grant + background poll; loginId tracks the flow.
func (h *Handler) clineLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Nickname string `json:"nickname"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	id, credentialRef := corejethub.NewAccountID("cline")
	nickname := firstNonEmptyStr(req.Nickname, id)
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: "cline", Nickname: nickname,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	started, err := h.d.Manager.StartClineLogin(r.Context(), id, nil)
	if err != nil {
		_ = h.d.Manager.DeleteAccount(id)
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	corejethub.RegisterLoginSession(loginID, &corejethub.LoginSession{Started: started, Account: id})
	writeJSON(w, http.StatusCreated, map[string]any{
		"accountId":    id,
		"loginId":      loginID,
		"loginUrl":     started.LoginURL,
		"loginMode":    "url",
	})
}

// clineStatus GET — flow poll via loginId, or account snapshot.
func (h *Handler) clineStatus(w http.ResponseWriter, r *http.Request) {
	if loginID := r.URL.Query().Get("loginId"); loginID != "" {
		h.pollLogin(loginID, w, r)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts("cline")})
}

// clineRefresh POST — silent renewal.
func (h *Handler) clineRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.RefreshClineAccount(r.Context(), req.AccountID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// clineBalance GET — raw micro-USD-ish balance + scaled credits.
func (h *Handler) clineBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	balance, raw, err := h.d.Manager.ClineBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"balance": balance, "rawBalance": raw})
}
