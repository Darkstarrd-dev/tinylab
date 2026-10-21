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

// RegisterMinimax mounts the minimax routes (P3.3.5 / R7-1): device-code login +
// signin + credit balance for minimax and minimaxintl. Inference is Anthropic-native
// passthrough via the bridged provider (no conversion).
func (h *Handler) RegisterMinimax(r chi.Router) {
	h.registerMinimaxRoutes(r, "minimax")
	h.registerMinimaxRoutes(r, "minimaxintl")
}

func (h *Handler) registerMinimaxRoutes(r chi.Router, provider string) {
	r.Post("/"+provider+"/login", func(w http.ResponseWriter, req *http.Request) {
		h.minimaxLoginFor(w, req, provider)
	})
	r.Get("/"+provider+"/status", func(w http.ResponseWriter, req *http.Request) {
		h.minimaxStatusFor(w, req, provider)
	})
	r.Post("/"+provider+"/refresh", h.minimaxRefresh)
	r.Post("/"+provider+"/claim", h.minimaxClaim)
	r.Get("/"+provider+"/balance", h.minimaxBalance)
}

// minimaxLoginFor POST — device grant + background poll; loginId tracks it.
func (h *Handler) minimaxLoginFor(w http.ResponseWriter, r *http.Request, provider string) {
	sel := decodeLoginOpen(r)
	id, credentialRef := corejethub.NewAccountID(provider)
	opt, err := h.prepareLoginOpen(sel, id)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: provider, Nickname: id,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	grant, err := h.d.Manager.StartMinimaxDeviceAuthorizationFor(r.Context(), provider)
	if err != nil {
		_ = h.d.Manager.DeleteAccount(id)
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	loginID := corejethub.NewLoginSessionID()
	// Device-code flow: the background goroutine polls the token endpoint
	// until the user authorizes, then delivers the outcome.
	resultCh := make(chan corejethub.LoginOutcome, 1)
	started := corejethub.NewStartedLoginWithChannel(grant.VerificationURIComplete, resultCh)
	sess := &corejethub.LoginSession{Started: started, Account: id, Manager: h.d.Manager}
	corejethub.RegisterLoginSession(loginID, sess)
	// Auto-open the verification URL like the other providers (this flow is
	// inline in the handler rather than a Manager Start*Login function, so it
	// must open the browser itself — the dialog link stays as a fallback).
	h.d.Manager.OpenURLWithBrowser(grant.VerificationURIComplete, opt)
	// ⚠️ Background context, not r.Context(): the poll must outlive this
	// handler (the request context is canceled the moment the response is
	// written — binding the poll to it aborted every login before the user
	// even opened the verification URL).
	go func() {
		cred, err := h.d.Manager.PollMinimaxDeviceTokenFor(context.Background(), provider, grant)
		if err != nil {
			corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{Err: err})
			return
		}
		if err := h.d.Manager.CompleteMinimaxLogin(id, cred); err != nil {
			corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{Err: err})
			return
		}
		credJSON, _ := json.Marshal(cred)
		corejethub.DeliverLoginOutcome(resultCh, corejethub.LoginOutcome{
			CredentialJSON: credJSON,
			ExpiresAt:      corejethub.MinimaxExpiresAtMs(cred),
			Refreshable:    corejethub.MinimaxRefreshable(cred),
		})
	}()
	// Single-winner pump (the poll goroutine above is the producer): persists
	// nothing extra (CompleteMinimaxLogin already ran), deletes the
	// placeholder on failure, records the outcome for the status poll.
	go corejethub.SettleAndCleanup(sess, nil)
	apibase.WriteJSON(w, http.StatusCreated, map[string]any{
		"accountId": id,
		"loginId":   loginID,
		"loginUrl":  started.LoginURL,
		"loginMode": "url",
	})
}

// minimaxStatusFor GET — flow poll via loginId, or account snapshot.
func (h *Handler) minimaxStatusFor(w http.ResponseWriter, r *http.Request, provider string) {
	if loginID := r.URL.Query().Get("loginId"); loginID != "" {
		h.pollLogin(loginID, w, r)
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts(provider)})
}

// minimaxRefresh POST — silent renewal.
func (h *Handler) minimaxRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.RefreshMinimaxAccount(r.Context(), req.AccountID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// minimaxClaim POST — daily check-in (timezone_id required query param).
func (h *Handler) minimaxClaim(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID  string `json:"accountId"`
		TimezoneID string `json:"timezoneId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	outcome, err := h.d.Manager.ClaimMinimaxDaily(r.Context(), req.AccountID, req.TimezoneID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"outcome": outcome})
}

// minimaxBalance GET — Σ remaining_amount (total_count is the record COUNT,
// NOT the balance).
func (h *Handler) minimaxBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	balance, err := h.d.Manager.MinimaxBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"balance": balance})
}
