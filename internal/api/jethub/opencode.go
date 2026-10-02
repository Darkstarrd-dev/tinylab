package jethub

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
)

// RegisterOpencode mounts the OpenCode Zen login endpoint.
//
// OpenCode is the first provider whose login is NOT a browser flow: the user
// pastes a Zen API key (`sk-…`), or adds the anonymous channel (no key at all —
// free models only). There is no login session to poll, hence no /status
// endpoint on this provider.
func (h *Handler) RegisterOpencode(r chi.Router) {
	r.Post("/opencode/login", h.opencodeLogin)
}

// opencodeLogin POST /api/jethub/opencode/login
//
//	{apiKey, nickname?}            → store a keyed account
//	{anonymous: true}              → add the anonymous channel (idempotent)
//
// A key already present is reused (reused:true), matching the reference's
// account.create semantics.
func (h *Handler) opencodeLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		APIKey    string `json:"apiKey"`
		Nickname  string `json:"nickname"`
		Anonymous bool   `json:"anonymous"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !req.Anonymous && strings.TrimSpace(req.APIKey) == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "apiKey required")
		return
	}
	accountID, reused, err := h.d.Manager.AddOpencodeAccount(req.APIKey, req.Nickname, req.Anonymous)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "accountId": accountID, "reused": reused})
}
