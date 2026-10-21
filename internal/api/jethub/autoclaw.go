package jethub

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
)

// RegisterAutoclaw mounts the AutoClaw endpoints (R7-3):
// SMS login + balance + claim + refresh + status.
func (h *Handler) RegisterAutoclaw(r chi.Router) {
	r.Post("/autoclaw/login/sms/send", h.autoclawSmsSend)
	r.Post("/autoclaw/login/sms/submit", h.autoclawSmsSubmit)
	r.Get("/autoclaw/status", h.autoclawStatus)
	r.Get("/autoclaw/balance", h.autoclawBalance)
	r.Post("/autoclaw/claim", h.autoclawClaim)
	r.Post("/autoclaw/refresh", h.autoclawRefresh)
}

// autoclawSmsSend POST /api/jethub/autoclaw/login/sms/send
func (h *Handler) autoclawSmsSend(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone string `json:"phone"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Phone) == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "phone required")
		return
	}
	msgid, err := h.d.Manager.SendAutoclawSmsCode(r.Context(), req.Phone)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "msgid": msgid})
}

// autoclawSmsSubmit POST /api/jethub/autoclaw/login/sms/submit
func (h *Handler) autoclawSmsSubmit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone string `json:"phone"`
		Code  string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Phone) == "" || strings.TrimSpace(req.Code) == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "phone and code required")
		return
	}
	accountID, err := h.d.Manager.SubmitAutoclawSmsCode(r.Context(), req.Phone, req.Code)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "accountId": accountID})
}

// autoclawStatus GET /api/jethub/autoclaw/status
func (h *Handler) autoclawStatus(w http.ResponseWriter, r *http.Request) {
	if loginID := r.URL.Query().Get("loginId"); loginID != "" {
		h.pollLogin(loginID, w, r)
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts("autoclaw")})
}

// autoclawBalance GET /api/jethub/autoclaw/balance?accountId=...
func (h *Handler) autoclawBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	if accountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	balance, err := h.d.Manager.AutoclawBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"balance": balance})
}

// autoclawClaim POST /api/jethub/autoclaw/claim
func (h *Handler) autoclawClaim(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	outcome, err := h.d.Manager.ClaimAutoclawDaily(r.Context(), req.AccountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"outcome": outcome})
}

// autoclawRefresh POST /api/jethub/autoclaw/refresh
func (h *Handler) autoclawRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	if err := h.d.Manager.RefreshAutoclawAccount(r.Context(), req.AccountID); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}
