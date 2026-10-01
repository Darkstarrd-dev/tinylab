package jethub

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// RegisterCodeArts mounts the codearts-specific routes under /api/jethub.
// Called by Register on the /jethub subrouter.
func (h *Handler) RegisterCodeArts(r chi.Router) {
	r.Post("/codearts/login", h.codeartsLogin)
	r.Get("/codearts/status", h.codeartsStatus)
	r.Post("/codearts/refresh", h.codeartsRefresh)
	r.Post("/codearts/claim", h.codeartsClaim)
	r.Get("/codearts/balance", h.codeartsBalance)
}

// codeartsLogin POST /api/jethub/codearts/login {nickname} — creates an
// account placeholder, starts the OAuth flow and returns loginUrl + ids.
func (h *Handler) codeartsLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Nickname string `json:"nickname"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	id, credentialRef := corejethub.NewAccountID("codearts")
	nickname := req.Nickname
	if nickname == "" {
		nickname = id
	}
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: "codearts", Nickname: nickname,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	started, err := corejethub.StartCodeArtsLogin(nil)
	if err != nil {
		_ = h.d.Manager.DeleteAccount(id)
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	sess := &corejethub.LoginSession{Started: started, Account: id, Manager: h.d.Manager}
	corejethub.RegisterLoginSession(loginID, sess)
	// Single-winner pump: records the outcome for the status poll, deletes
	// the placeholder on failure. The flow itself persists via
	// CompleteCodeArtsLogin (already encoded into the delivered credential).
	go corejethub.SettleAndCleanup(sess, func(o corejethub.LoginOutcome) error {
		return h.d.Manager.CompleteCodeArtsLogin(id, o.CredentialJSON, o.ExpiresAt, o.Refreshable)
	})
	writeJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  started.LoginURL,
		"loginMode": "url",
	})
}

// codeartsStatus GET /api/jethub/codearts/status — polls a login flow by
// loginId, or lists account snapshots without one.
func (h *Handler) codeartsStatus(w http.ResponseWriter, r *http.Request) {
	if loginID := r.URL.Query().Get("loginId"); loginID != "" {
		h.pollLogin(loginID, w, r)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts("codearts")})
}

// codeartsRefresh POST /api/jethub/codearts/refresh {accountId} — renew one
// account credential (Jet Hub account card "refresh" button).
func (h *Handler) codeartsRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.RefreshCodeArtsAccount(r.Context(), req.AccountID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// codeartsClaim POST /api/jethub/codearts/claim {accountId} — daily credit
// claim for one account (P4 "一键签到" iterates enabled accounts).
func (h *Handler) codeartsClaim(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	outcome, err := h.d.Manager.ClaimCodeArtsDaily(r.Context(), req.AccountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"outcome": outcome})
}

// codeartsBalance GET /api/jethub/codearts/balance?accountId= — credit
// balance snapshot for the UI.
func (h *Handler) codeartsBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	balance, err := h.d.Manager.CodeArtsBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"balance": balance})
}
