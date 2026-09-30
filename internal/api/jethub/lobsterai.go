package jethub

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// RegisterLobsterai mounts the lobsterai routes (P3.2).
func (h *Handler) RegisterLobsterai(r chi.Router) {
	r.Post("/lobsterai/login", h.lobsteraiLogin)
	r.Get("/lobsterai/status", h.lobsteraiStatus)
	r.Post("/lobsterai/refresh", h.lobsteraiRefresh)
	r.Post("/lobsterai/claim", h.lobsteraiClaim)
	r.Get("/lobsterai/balance", h.lobsteraiBalance)
}

// lobsteraiLogin POST — creates an account placeholder and starts the
// two-step callback login (portal URL returned immediately).
func (h *Handler) lobsteraiLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Nickname string `json:"nickname"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	id, credentialRef := corejethub.NewAccountID("lobsterai")
	nickname := firstNonEmptyStr(req.Nickname, id)
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: "lobsterai", Nickname: nickname,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	started, err := h.d.Manager.StartLobsteraiLogin(r.Context(), id, nil)
	if err != nil {
		_ = h.d.Manager.DeleteAccount(id)
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	corejethub.RegisterLoginSession(loginID, &corejethub.LoginSession{Started: started, Account: id})
	writeJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  started.LoginURL,
		"loginMode": "url",
	})
}

// lobsteraiStatus GET — flow poll via loginId, or account snapshot.
func (h *Handler) lobsteraiStatus(w http.ResponseWriter, r *http.Request) {
	if loginID := r.URL.Query().Get("loginId"); loginID != "" {
		h.pollLogin(loginID, w, r)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts("lobsterai")})
}

// lobsteraiRefresh POST — silent renewal.
func (h *Handler) lobsteraiRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.RefreshLobsteraiAccount(r.Context(), req.AccountID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// lobsteraiClaim POST — three-step daily check-in.
func (h *Handler) lobsteraiClaim(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	outcome, err := h.d.Manager.ClaimLobsteraiDaily(r.Context(), req.AccountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"outcome": outcome})
}

// lobsteraiBalance GET — profile-summary based balance.
func (h *Handler) lobsteraiBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	balance, err := h.d.Manager.LobsteraiBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"balance": balance})
}
