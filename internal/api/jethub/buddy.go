package jethub

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// RegisterBuddy mounts the buddy/workbuddy routes (P3.1). Both products share
// one implementation; the provider path param selects the product config.
func (h *Handler) RegisterBuddy(r chi.Router) {
	for _, provider := range []string{"buddy", "workbuddy"} {
		p := provider
		r.Post("/"+p+"/login", func(w http.ResponseWriter, r *http.Request) { h.startBuddyFlow(p, w, r) })
		r.Get("/"+p+"/status", h.buddyStatus(p))
		r.Post("/"+p+"/refresh", h.buddyRefresh(p))
		r.Post("/"+p+"/claim", h.buddyClaim(p))
		r.Get("/"+p+"/balance", h.buddyBalance(p))
	}
}

// startBuddyFlow begins the two-step login for one account (shared by both
// products).
func (h *Handler) startBuddyFlow(provider string, w http.ResponseWriter, r *http.Request) {
	var req struct {
		Nickname string `json:"nickname"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	id, credentialRef := corejethub.NewAccountID(provider)
	nickname := firstNonEmptyStr(req.Nickname, id)
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: provider, Nickname: nickname,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	started, err := h.d.Manager.StartBuddyLogin(r.Context(), provider, id, nil)
	if err != nil {
		_ = h.d.Manager.DeleteAccount(id)
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	corejethub.RegisterLoginSession(loginID, &corejethub.LoginSession{Started: started, Account: id})
	go func() {
		outcome := <-started.Result
		if outcome.Err == nil && outcome.CredentialJSON != nil {
			_ = h.d.Manager.CompleteBuddyLoginFromJSON(id, outcome.CredentialJSON, outcome.ExpiresAt, outcome.Refreshable)
		}
		corejethub.TakeLoginSession(loginID)
	}()
	writeJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  started.LoginURL,
		"loginMode": "url",
	})
}

// buddyStatus GET — per-account login state snapshot (nickname/expiry/
// refreshable from the account entry; the flow poll uses /status?loginId=).
func (h *Handler) buddyStatus(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if loginID := r.URL.Query().Get("loginId"); loginID != "" {
			h.pollLogin(loginID, w, r)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts(provider)})
	}
}

// pollLogin is the shared login-flow poll (codearts + buddy products).
func (h *Handler) pollLogin(loginID string, w http.ResponseWriter, r *http.Request) {
	sess, ok := corejethub.PeekLoginSession(loginID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown or settled loginId")
		return
	}
	select {
	case outcome := <-sess.Started.Result:
		corejethub.TakeLoginSession(loginID)
		if outcome.Err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"done": true, "success": false, "error": outcome.Err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"done": true, "success": true, "accountId": sess.Account})
		return
	default:
	}
	acc, _ := h.d.Manager.FindAccount(sess.Account)
	writeJSON(w, http.StatusOK, map[string]any{"done": false, "accountId": sess.Account, "nickname": acc.Nickname})
}

// buddyRefresh POST — silent renewal of one account credential.
func (h *Handler) buddyRefresh(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			AccountID string `json:"accountId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
			apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
			return
		}
		if err := h.d.Manager.RefreshBuddyAccount(r.Context(), provider, req.AccountID); err != nil {
			apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// buddyClaim POST — daily check-in claim for one account.
func (h *Handler) buddyClaim(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			AccountID string `json:"accountId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
			apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
			return
		}
		outcome, err := h.d.Manager.ClaimBuddyDaily(r.Context(), provider, req.AccountID)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"outcome": outcome})
	}
}

// buddyBalance GET — credit balance for one account.
func (h *Handler) buddyBalance(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID := r.URL.Query().Get("accountId")
		balance, err := h.d.Manager.BuddyBalance(r.Context(), provider, accountID)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"balance": balance})
	}
}

func firstNonEmptyStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
