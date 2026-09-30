// Package jethub provides the Free Hub management API endpoints under
// /api/jethub. It exposes the provider metadata list, prefix bridging and the
// account CRUD minimal set (P1.9); provider-specific login/credits endpoints
// are added by later phases (P2/P3).
package jethub

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/config"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// Deps bundles the manager + bridge the handlers operate on. The router wires
// these after constructing the app-level Manager/Bridge.
type Deps struct {
	Manager *corejethub.Manager
	Bridge  *corejethub.Bridge
}

// Handler serves the /api/jethub routes.
type Handler struct {
	d *Deps
}

// NewHandler creates the jethub API handler.
func NewHandler(d *Deps) *Handler { return &Handler{d: d} }

// Register mounts the jethub routes onto the protected /api group.
func (h *Handler) Register(r chi.Router) {
	r.Route("/jethub", func(r chi.Router) {
		r.Get("/providers", h.listProviders)
		r.Put("/providers/{provider}/prefix", h.setPrefix)
		r.Delete("/providers/{provider}/prefix", h.clearPrefix)
		r.Get("/providers/{provider}/accounts", h.listAccounts)
		r.Post("/providers/{provider}/accounts", h.createAccount)
		r.Patch("/accounts/{accountID}", h.patchAccount)
		r.Delete("/accounts/{accountID}", h.deleteAccount)
		r.Get("/providers/{provider}/models", h.listModels)
		r.Put("/providers/{provider}/models", h.setModelDisabled)
		// P2: codearts provider-specific flows (login/refresh/claim/balance).
		h.RegisterCodeArts(r)
		// P3.1: buddy + workbuddy flows.
		h.RegisterBuddy(r)
		// P3.2: lobsterai flows.
		h.RegisterLobsterai(r)
	})
}

// providerDTO is the metadata + live state of one jethub provider.
type providerDTO struct {
	ID              string   `json:"id"`
	DisplayName     string   `json:"displayName"`
	Description     string   `json:"description,omitempty"`
	HasCredits      bool     `json:"hasCredits"`
	HasBalance      bool     `json:"hasBalance"`
	LoginModes      []string `json:"loginModes,omitempty"`
	AccountCount    int      `json:"accountCount"`
	EnabledAccounts int      `json:"enabledAccounts"`
	Prefix          string   `json:"prefix"`
	Bridged         bool     `json:"bridged"`
}

func (h *Handler) listProviders(w http.ResponseWriter, r *http.Request) {
	metas := corejethub.Providers()
	out := make([]providerDTO, 0, len(metas))
	for _, meta := range metas {
		dto := providerDTO{
			ID:              meta.ID,
			DisplayName:     meta.DisplayName,
			Description:     meta.Description,
			HasCredits:      meta.HasCredits,
			HasBalance:      meta.HasBalance,
			LoginModes:      meta.LoginModes,
			AccountCount:    h.d.Manager.AccountCount(meta.ID),
			EnabledAccounts: h.d.Manager.EnabledAccountCount(meta.ID),
			Prefix:          h.d.Manager.Prefix(meta.ID),
		}
		dto.Bridged = dto.Prefix != "" && h.d.Bridge != nil && h.d.Bridge.HasBridgedProvider(meta.ID)
		out = append(out, dto)
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": out})
}

type prefixRequest struct {
	Prefix string `json:"prefix"`
}

// setPrefix PUT /api/jethub/{provider}/prefix — validate + persist + bridge.
func (h *Handler) setPrefix(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	var req prefixRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if err := h.d.Bridge.SetPrefix(provider, req.Prefix); err != nil {
		if _, ok := err.(*corejethub.ConflictError); ok {
			apibase.WriteAPIError(w, http.StatusConflict, err.Error())
			return
		}
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "prefix": h.d.Manager.Prefix(provider)})
}

// clearPrefix DELETE /api/jethub/{provider}/prefix — unbridge.
func (h *Handler) clearPrefix(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if err := h.d.Bridge.ClearPrefix(provider); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) listAccounts(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if !corejethub.ProviderExists(provider) {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown provider")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": h.d.Manager.Accounts(provider)})
}

type createAccountRequest struct {
	Nickname string `json:"nickname"`
}

// createAccount POST /api/jethub/{provider}/accounts — P1 registers a
// placeholder account; the provider-specific login flow (P2/P3) attaches the
// credential afterwards.
func (h *Handler) createAccount(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if !corejethub.ProviderExists(provider) {
		apibase.WriteAPIError(w, http.StatusNotFound, "unknown provider")
		return
	}
	var req createAccountRequest
	_ = json.NewDecoder(r.Body).Decode(&req) // body optional
	id, credentialRef := corejethub.NewAccountID(provider)
	nickname := req.Nickname
	if nickname == "" {
		nickname = id
	}
	if err := h.d.Manager.AddAccount(corejethub.Account{
		ID: id, Provider: provider, Nickname: nickname,
		Enabled: true, CredentialRef: credentialRef,
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"accountId": id, "credentialRef": credentialRef})
}

type patchAccountRequest struct {
	Nickname *string `json:"nickname"`
	Enabled  *bool   `json:"enabled"`
}

// patchAccount PATCH /api/jethub/accounts/{accountID} — enable/disable +
// rename. Toggling enabled re-syncs the bridged provider keys.
func (h *Handler) patchAccount(w http.ResponseWriter, r *http.Request) {
	accountID := chi.URLParam(r, "accountID")
	var req patchAccountRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	err := h.d.Manager.UpdateAccount(accountID, func(a *corejethub.Account) {
		if req.Nickname != nil {
			a.Nickname = *req.Nickname
		}
		if req.Enabled != nil {
			a.Enabled = *req.Enabled
		}
	})
	if err == corejethub.ErrNotFound {
		apibase.WriteAPIError(w, http.StatusNotFound, "account not found")
		return
	}
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Keys follow the enabled set: re-sync if the account's provider is bridged.
	if acc, ok := h.d.Manager.FindAccount(accountID); ok && h.d.Manager.Prefix(acc.Provider) != "" {
		_ = h.d.Bridge.SyncKeys(acc.Provider)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// deleteAccount DELETE /api/jethub/accounts/{accountID} — removes the entry,
// its credential and re-syncs the bridge.
func (h *Handler) deleteAccount(w http.ResponseWriter, r *http.Request) {
	accountID := chi.URLParam(r, "accountID")
	acc, ok := h.d.Manager.FindAccount(accountID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "account not found")
		return
	}
	if err := h.d.Manager.DeleteAccount(accountID); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if h.d.Manager.Prefix(acc.Provider) != "" {
		_ = h.d.Bridge.SyncKeys(acc.Provider)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// listModels GET /api/jethub/{provider}/models — the static product table
// with the per-model disabled flag for the UI blacklist toggles.
func (h *Handler) listModels(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	prod, ok := h.d.Bridge.Product(provider)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "no product registered for provider")
		return
	}
	disabled := h.d.Manager.DisabledModels(provider)
	type modelEntry struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Disabled bool   `json:"disabled"`
	}
	out := make([]modelEntry, 0, len(prod.Models))
	for _, md := range prod.Models {
		out = append(out, modelEntry{ID: md.ID, Name: modelDisplayName(md), Disabled: disabled[md.ID]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": out})
}

type setModelDisabledRequest struct {
	ModelID  string `json:"modelId"`
	Disabled *bool  `json:"disabled"`
}

// setModelDisabled PUT /api/jethub/{provider}/models — toggle the blacklist
// and re-sync the bridged provider's registry model list.
func (h *Handler) setModelDisabled(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	var req setModelDisabledRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.ModelID == "" || req.Disabled == nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "modelId and disabled are required")
		return
	}
	if _, ok := h.d.Bridge.Product(provider); !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "no product registered for provider")
		return
	}
	if err := h.d.Manager.SetModelDisabled(provider, req.ModelID, *req.Disabled); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if h.d.Manager.Prefix(provider) != "" {
		_ = h.d.Bridge.SyncKeys(provider)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"disabledModels": h.d.Manager.DisabledModels(provider),
	})
}

// modelDisplayName picks Alias when set (matching /v1/models display rules).
func modelDisplayName(md config.ModelDef) string {
	if md.Alias != "" {
		return md.Alias
	}
	return md.ID
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
