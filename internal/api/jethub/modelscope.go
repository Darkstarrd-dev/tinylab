package jethub

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
)

// RegisterModelscope mounts the ModelScope (魔搭) endpoints (R7-2):
// API Key login + balance + status.
func (h *Handler) RegisterModelscope(r chi.Router) {
	r.Post("/modelscope/login", h.modelscopeLogin)
	r.Get("/modelscope/balance", h.modelscopeBalance)
	r.Get("/modelscope/status", h.modelscopeStatus)
}

// modelscopeLogin POST /api/jethub/modelscope/login
// Body: { apiKey: string, nickname?: string }
func (h *Handler) modelscopeLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		APIKey   string `json:"apiKey"`
		Nickname string `json:"nickname"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if strings.TrimSpace(req.APIKey) == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "apiKey required")
		return
	}
	accountID, reused, err := h.d.Manager.AddModelscopeAccount(req.APIKey, req.Nickname)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "accountId": accountID, "reused": reused})
}

// modelscopeBalance GET /api/jethub/modelscope/balance?accountId=...
func (h *Handler) modelscopeBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("accountId")
	if accountID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "accountId required")
		return
	}
	balance, err := h.d.Manager.ModelscopeBalance(r.Context(), accountID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"balance": balance})
}

// modelscopeStatus GET /api/jethub/modelscope/status
func (h *Handler) modelscopeStatus(w http.ResponseWriter, r *http.Request) {
	if loginID := r.URL.Query().Get("loginId"); loginID != "" {
		h.pollLogin(loginID, w, r)
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts("modelscope")})
}
