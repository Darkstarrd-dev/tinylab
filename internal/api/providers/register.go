// Package providers provides HTTP handlers for provider management.
package providers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/customheaders"
	"github.com/tinyrouter/tinyrouter/internal/outbound"
	"github.com/tinyrouter/tinyrouter/internal/urlutil"
)

// Handler wires up provider routes.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new providers Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// ProviderDTO is the public, secret-minimized representation of a provider.
// Keys are never embedded in provider responses — the list carries only
// keyCount/hasKey, and the key values themselves are listed via
// GET /api/providers/{id}/keys with masked values only (see internal/api/keys).
// The non-secret editable fields are preserved so the frontend's whole-object
// PUT round-trip does not zero them in Registry.UpdateProvider.
type ProviderDTO struct {
	ID                    string              `json:"id"`
	Name                  string              `json:"name"`
	Prefix                string              `json:"prefix"`
	BaseURL               string              `json:"baseUrl"`
	APIType               string              `json:"apiType"`
	AnthropicVersion      string              `json:"anthropicVersion,omitempty"`
	AnthropicBeta         string              `json:"anthropicBeta,omitempty"`
	IsActive              bool                `json:"isActive"`
	Models                []config.ModelDef   `json:"models,omitempty"`
	KeyCount              int                 `json:"keyCount"`
	HasKey                bool                `json:"hasKey"`
	RotationStrategy      string              `json:"rotationStrategy,omitempty"`
	StickyLimit           int                 `json:"stickyLimit,omitempty"`
	InjectStreamOpts      bool                `json:"injectStreamOptions,omitempty"`
	NormalizeStreamChunks bool                `json:"normalizeStreamChunks,omitempty"`
	NIMConfig             *config.NIMSettings `json:"nim,omitempty"`
	UseProxy              bool                `json:"useProxy,omitempty"`
	UseCustomHeaders      bool                `json:"useCustomHeaders,omitempty"`
	CustomHeaders         map[string]string   `json:"customHeaders,omitempty"`
}

// toProviderDTO converts a config.Provider to its public DTO, dropping all
// key material.
func toProviderDTO(p config.Provider) ProviderDTO {
	return ProviderDTO{
		ID:                    p.ID,
		Name:                  p.Name,
		Prefix:                p.Prefix,
		BaseURL:               p.BaseURL,
		APIType:               p.APIType,
		AnthropicVersion:      p.AnthropicVersion,
		AnthropicBeta:         p.AnthropicBeta,
		IsActive:              p.IsActive,
		Models:                p.Models,
		KeyCount:              len(p.Keys),
		HasKey:                len(p.Keys) > 0,
		RotationStrategy:      p.RotationStrategy,
		StickyLimit:           p.StickyLimit,
		InjectStreamOpts:      p.InjectStreamOpts,
		NormalizeStreamChunks: p.NormalizeStreamChunks,
		NIMConfig:             p.NIMConfig,
		UseProxy:              p.UseProxy,
		UseCustomHeaders:      p.UseCustomHeaders,
		CustomHeaders:         p.CustomHeaders,
	}
}

// Register registers the provider routes on the given router.
func (h *Handler) Register(r chi.Router) {
	// Providers
	r.Get("/providers", h.listProviders)
	r.Post("/providers", h.createProvider)
	r.Post("/providers/validate", h.validateProvider)
	r.Put("/providers/{id}", h.updateProvider)
	r.Put("/providers/{id}/reorder", h.reorderProvider)
	r.Delete("/providers/{id}", h.deleteProvider)

	// Provider testing
	r.Post("/providers/{id}/test", h.testProviderKey)

	// Provider models
	r.Get("/providers/{id}/models", h.fetchProviderModels)
	r.Post("/providers/{id}/models", h.addProviderModel)
	r.Patch("/providers/{id}/models/quota", h.updateModelQuota)
	r.Patch("/providers/{id}/models/alias", h.updateModelAlias)
	r.Patch("/providers/{id}/models/note", h.updateModelNote)
	r.Patch("/providers/{id}/models/nim", h.updateModelNIM)
	r.Patch("/providers/{id}/models/kind", h.updateModelKind)
	r.Patch("/providers/{id}/models/imgProtocol", h.updateModelImgProtocol)
	r.Patch("/providers/{id}/models/textProtocol", h.updateModelTextProtocol)
	r.Patch("/providers/{id}/models/imgSizes", h.updateModelImgSizes)
	r.Patch("/providers/{id}/models/protocols", h.updateModelProtocols)
	r.Delete("/providers/{id}/models", h.deleteProviderModel)
}

// --- Providers ---

func (h *Handler) listProviders(w http.ResponseWriter, r *http.Request) {
	providers := h.d.Reg.ListProviders()
	dtos := make([]ProviderDTO, 0, len(providers))
	for _, p := range providers {
		dtos = append(dtos, toProviderDTO(p))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"providers": dtos})
}

func (h *Handler) createProvider(w http.ResponseWriter, r *http.Request) {
	var p config.Provider
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if p.ID == "" {
		p.ID = apibase.GenerateID("prov")
	}
	for h.d.Reg.HasProvider(p.ID) {
		p.ID = apibase.GenerateID("prov")
	}
	if p.APIType == "" {
		p.APIType = "openai-compatible"
	}
	p.IsActive = true
	if p.Name == "" {
		p.Name = "Provider-" + strconv.Itoa(len(h.d.Reg.ListProviders())+1)
	}
	h.d.Reg.AddProvider(p)
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfig(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(toProviderDTO(p))
}

func (h *Handler) updateProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var updates config.Provider
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	oldName := ""
	if p, ok := h.d.Reg.GetProvider(id); ok {
		oldName = p.Name
	}

	if h.d.Reg.UpdateProvider(id, updates) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}

		if oldName != "" && oldName != updates.Name {
			h.d.QuotaTracker.RenameProvider(oldName, updates.Name)
			h.d.Usage.Accumulator().RenameProvider(oldName, updates.Name)
		}

		p, _ := h.d.Reg.GetProvider(id)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(toProviderDTO(*p))
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "provider not found")
	}
}

func (h *Handler) deleteProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if h.d.Reg.DeleteProvider(id) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "provider not found")
	}
}

type reorderRequest struct {
	Index int `json:"index"`
}

func (h *Handler) reorderProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req reorderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if err := h.d.Reg.ReorderProvider(id, req.Index); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfig(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":        true,
		"providers": h.d.Reg.ListProviders(),
	})
}

// --- Provider Validation ---

// validateProvider tests connectivity to an upstream provider before creation.
// Request: {baseUrl, apiKey, modelId?}
// Response: {valid, error?, method?}
func (h *Handler) validateProvider(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BaseURL  string `json:"baseUrl"`
		APIKey   string `json:"apiKey"`
		ModelID  string `json:"modelId"`
		UseProxy bool   `json:"useProxy"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.BaseURL == "" || req.APIKey == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "baseUrl and apiKey required")
		return
	}

	valid, method, err := h.probeUpstream(r.Context(), req.BaseURL, req.APIKey, req.ModelID, req.UseProxy, customheaders.Config{}, false)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"valid":  valid,
		"error":  err,
		"method": method,
	})
}

// probeUpstream tries GET /v1/models first, then falls back to POST /v1/chat/completions if modelId is provided.
// Returns (valid, method, errorMessage).
// allowPrivate gates private/loopback targets: it is only ever true for a
// registered provider whose explicit AllowPrivateNetwork capability is set.
func (h *Handler) probeUpstream(ctx context.Context, baseURL, apiKey, modelID string, useProxy bool, custom customheaders.Config, allowPrivate bool) (bool, string, string) {
	modelsURL := urlutil.BuildUpstreamURL(baseURL, "/v1/models")
	if u, err := outbound.ValidateURL(modelsURL); err != nil {
		return false, "", "blocked baseUrl: " + err.Error()
	} else if !useProxy {
		if err := (outbound.Policy{AllowPrivate: allowPrivate}).CheckHost(ctx, u.Hostname()); err != nil {
			return false, "", "blocked baseUrl: " + err.Error()
		}
	}
	req, err := http.NewRequestWithContext(ctx, "GET", modelsURL, nil)
	if err != nil {
		return false, "", "invalid URL: " + err.Error()
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	customheaders.Apply(req.Header, custom.Enabled, custom.Headers)

	resp, err := h.d.ManagementClient(config.Provider{UseProxy: useProxy, AllowPrivateNetwork: allowPrivate}).Do(req)
	if err != nil {
		h.d.ProxyHandler.TraceMgmtCall("probe:upstream:provider="+req.URL.Host+":model="+modelID, "probe", "probe", modelID, "upstream", modelsURL, req.Header, nil, 0, nil, nil, err.Error(), 0)
		return false, "", "request failed: " + err.Error()
	}
	defer resp.Body.Close()

	if resp.StatusCode == 200 {
		h.d.ProxyHandler.TraceMgmtCall("probe:upstream:provider="+req.URL.Host+":model="+modelID, "probe", "probe", modelID, "upstream", modelsURL, req.Header, nil, resp.StatusCode, resp.Header, nil, "", 0)
		return true, "models", ""
	}

	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		h.d.ProxyHandler.TraceMgmtCall("probe:upstream:provider="+req.URL.Host+":model="+modelID, "probe", "probe", modelID, "upstream", modelsURL, req.Header, nil, resp.StatusCode, resp.Header, nil, "authentication failed (status "+http.StatusText(resp.StatusCode)+")", 0)
		return false, "", "authentication failed (status " + http.StatusText(resp.StatusCode) + ")"
	}

	if modelID != "" {
		chatURL := urlutil.BuildUpstreamURL(baseURL, "/v1/chat/completions")
		body := `{"model":"` + modelID + `","messages":[{"role":"user","content":"generate 100 tokens self introduction"}],"max_tokens":150,"stream":false}`
		chatReq, err := http.NewRequestWithContext(ctx, "POST", chatURL, strings.NewReader(body))
		if err != nil {
			return false, "", "invalid URL: " + err.Error()
		}
		chatReq.Header.Set("Content-Type", "application/json")
		chatReq.Header.Set("Authorization", "Bearer "+apiKey)
		customheaders.Apply(chatReq.Header, custom.Enabled, custom.Headers)

		chatResp, err := h.d.ManagementClient(config.Provider{UseProxy: useProxy, AllowPrivateNetwork: allowPrivate}).Do(chatReq)
		if err != nil {
			h.d.ProxyHandler.TraceMgmtCall("probe:upstream:provider="+req.URL.Host+":model="+modelID, "probe", "probe", modelID, "upstream", chatURL, chatReq.Header, nil, 0, nil, nil, err.Error(), 0)
			return false, "", "chat request failed: " + err.Error()
		}
		defer chatResp.Body.Close()

		if chatResp.StatusCode == 401 || chatResp.StatusCode == 403 {
			h.d.ProxyHandler.TraceMgmtCall("probe:upstream:provider="+req.URL.Host+":model="+modelID, "probe", "probe", modelID, "upstream", chatURL, chatReq.Header, nil, chatResp.StatusCode, chatResp.Header, nil, "authentication failed (status "+http.StatusText(chatResp.StatusCode)+")", 0)
			return false, "", "authentication failed (status " + http.StatusText(chatResp.StatusCode) + ")"
		}
		h.d.ProxyHandler.TraceMgmtCall("probe:upstream:provider="+req.URL.Host+":model="+modelID, "probe", "probe", modelID, "upstream", chatURL, chatReq.Header, nil, chatResp.StatusCode, chatResp.Header, nil, "", 0)
		return true, "chat", ""
	}

	h.d.ProxyHandler.TraceMgmtCall("probe:upstream:provider="+req.URL.Host+":model="+modelID, "probe", "probe", modelID, "upstream", modelsURL, req.Header, nil, resp.StatusCode, resp.Header, nil, "upstream returned status "+http.StatusText(resp.StatusCode), 0)
	return false, "", "upstream returned status " + http.StatusText(resp.StatusCode)
}

// --- Provider Key Testing ---

// testProviderKey tests a specific key's connectivity.
// Request: {keyId?} (defaults to first active key)
// Response: {valid, error?}
func (h *Handler) testProviderKey(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	provider, ok := h.d.Reg.GetProvider(providerID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "provider not found")
		return
	}

	var req struct {
		KeyID string `json:"keyId"`
	}
	if r.ContentLength > 0 {
		json.NewDecoder(r.Body).Decode(&req)
	}

	var key *config.Key
	for i := range provider.Keys {
		k := &provider.Keys[i]
		if !k.IsActive {
			continue
		}
		if req.KeyID != "" {
			if k.ID == req.KeyID {
				key = k
				break
			}
		} else {
			key = k
			break
		}
	}
	if key == nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "no active key found")
		return
	}

	valid, _, errMsg := h.probeUpstream(r.Context(), provider.BaseURL, key.Key, "", provider.UseProxy, customheaders.Config{Enabled: provider.UseCustomHeaders, Headers: provider.CustomHeaders}, provider.AllowPrivateNetwork)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"valid": valid,
		"error": errMsg,
	})
}

// --- Provider Model Fetching ---

// fetchProviderModels fetches available models from the upstream provider's /v1/models endpoint.
// Response: {models: [{id}]}
func (h *Handler) fetchProviderModels(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	provider, ok := h.d.Reg.GetProvider(providerID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "provider not found")
		return
	}

	key := firstActiveKey(provider)
	if key == nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "no active key for this provider")
		return
	}

	modelsURL := urlutil.BuildUpstreamURL(provider.BaseURL, "/v1/models")
	if u, err := outbound.ValidateURL(modelsURL); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "blocked baseUrl: "+err.Error())
		return
	} else if !provider.UseProxy {
		if err := (outbound.Policy{AllowPrivate: provider.AllowPrivateNetwork}).CheckHost(r.Context(), u.Hostname()); err != nil {
			apibase.WriteAPIError(w, http.StatusForbidden, "blocked baseUrl: "+err.Error())
			return
		}
	}
	req, err := http.NewRequestWithContext(r.Context(), "GET", modelsURL, nil)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid base URL")
		return
	}
	req.Header.Set("Authorization", "Bearer "+key.Key)
	customheaders.Apply(req.Header, provider.UseCustomHeaders, provider.CustomHeaders)

	resp, err := h.d.ManagementClient(*provider).Do(req)
	if err != nil {
		h.d.ProxyHandler.TraceMgmtCall("probe:models:provider="+providerID, "probe", "probe", "", provider.Name, modelsURL, req.Header, nil, 0, nil, nil, err.Error(), 0)
		apibase.WriteAPIError(w, http.StatusBadGateway, "request failed: "+err.Error())
		return
	}
	defer resp.Body.Close()

	// Bound the upstream response: an unbounded ReadAll lets a hostile or
	// misbehaving upstream force unbounded memory growth in the management
	// process. 8 MiB is far beyond any real /v1/models payload.
	const maxModelsResponseBytes = 8 << 20
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxModelsResponseBytes+1))
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, "failed to read response: "+err.Error())
		return
	}
	if len(respBody) > maxModelsResponseBytes {
		apibase.WriteAPIError(w, http.StatusBadGateway, "models response exceeds the 8 MiB limit")
		return
	}

	if resp.StatusCode != 200 {
		h.d.ProxyHandler.TraceMgmtCall("probe:models:provider="+providerID, "probe", "probe", "", provider.Name, modelsURL, req.Header, nil, resp.StatusCode, resp.Header, respBody, "upstream returned "+http.StatusText(resp.StatusCode), 0)
		// Never echo the full upstream error body to the client: it can
		// contain internal details of a target the caller must not scan.
		apibase.WriteAPIError(w, http.StatusBadGateway, "upstream returned "+http.StatusText(resp.StatusCode))
		return
	}

	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, "failed to parse models response: "+err.Error())
		return
	}

	models := make([]map[string]string, 0, len(result.Data))
	for _, m := range result.Data {
		if m.ID != "" {
			models = append(models, map[string]string{"id": m.ID})
		}
	}

	h.d.ProxyHandler.TraceMgmtCall("probe:models:provider="+providerID, "probe", "probe", "", provider.Name, modelsURL, req.Header, nil, resp.StatusCode, resp.Header, respBody, "", 0)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"models": models})
}

// --- Provider Model CRUD ---

// addProviderModel adds a custom model ID to a provider.
// Request: {model}
func (h *Handler) addProviderModel(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model required")
		return
	}

	// Check provider existence first so we can return the correct status.
	if _, ok := h.d.Reg.GetProvider(providerID); !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "provider not found")
		return
	}

	if h.d.Reg.AddModel(providerID, config.ModelDef{ID: req.Model}) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusConflict, "model or alias already exists")
	}
}

// updateModelQuota updates the quotaType of a single model on a provider.
// Request: {"model": "model-id", "quotaType": "unlimited|limited|paid"}
func (h *Handler) updateModelQuota(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model     string `json:"model"`
		QuotaType string `json:"quotaType"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	switch req.QuotaType {
	case "unlimited", "limited", "paid":
	default:
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid quotaType, must be unlimited | limited | paid")
		return
	}
	if h.d.Reg.UpdateModelQuotaType(providerID, req.Model, req.QuotaType) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "model not found on provider")
	}
}

// updateModelAlias updates the alias of a single model on a provider.
// Request: {"model": "model-id", "alias": "some-alias"}
func (h *Handler) updateModelAlias(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model string `json:"model"`
		Alias string `json:"alias"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	if h.d.Reg.UpdateModelAlias(providerID, req.Model, req.Alias) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		// UpdateModelAlias returns false when provider/model not found OR when
		// the alias conflicts with an existing model ID/alias. Try to
		// distinguish via GetModelByAliasOrID check.
		if _, ok := h.d.Reg.GetModelByAliasOrID(providerID, req.Model); ok {
			apibase.WriteAPIError(w, http.StatusBadRequest, "alias conflicts with existing model ID or alias in this provider")
		} else {
			apibase.WriteAPIError(w, http.StatusNotFound, "model not found on provider")
		}
	}
}

// updateModelNote updates the note of a single model on a provider.
// Request: {"model": "model-id", "note": "some note text"}
func (h *Handler) updateModelNote(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model string `json:"model"`
		Note  string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	if h.d.Reg.UpdateModelNote(providerID, req.Model, req.Note) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "model not found on provider")
	}
}

// updateModelKind updates the kind (text/image/embedding) of a single model on a provider.
// Request: {"model": "model-id", "kind": "text|image|embedding"}
func (h *Handler) updateModelKind(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model string `json:"model"`
		Kind  string `json:"kind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	switch req.Kind {
	case "text", "image", "embedding":
	default:
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid kind, must be text | image | embedding")
		return
	}
	if h.d.Reg.UpdateModelKind(providerID, req.Model, req.Kind) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "model not found on provider")
	}
}

// updateModelImgProtocol updates the image protocol of a single model on a provider.
// Request: {"model": "model-id", "imgProtocol": "gpt|xai|modelscope"}
func (h *Handler) updateModelImgProtocol(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model       string `json:"model"`
		ImgProtocol string `json:"imgProtocol"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	switch req.ImgProtocol {
	case "gpt", "xai", "modelscope":
	default:
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid imgProtocol, must be gpt | xai | modelscope")
		return
	}
	if h.d.Reg.UpdateModelImgProtocol(providerID, req.Model, req.ImgProtocol) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "model not found on provider")
	}
}

// updateModelTextProtocol updates the text protocol of a single model on a provider.
// Request: {"model": "model-id", "textProtocol": "auto|openai-compat|openai-responses|anthropic|google"}
func (h *Handler) updateModelTextProtocol(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model        string `json:"model"`
		TextProtocol string `json:"textProtocol"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	switch req.TextProtocol {
	case "", "auto", config.ProtocolOpenAICompat, config.ProtocolOpenAIResponses, config.ProtocolAnthropic, config.ProtocolGoogle:
	default:
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid textProtocol, must be auto | openai-compat | openai-responses | anthropic | google")
		return
	}
	storedVal := req.TextProtocol
	if storedVal == "auto" {
		storedVal = ""
	}
	if h.d.Reg.UpdateModelTextProtocol(providerID, req.Model, storedVal) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "model not found on provider")
	}
}

// updateModelImgSizes updates the custom size option list for a single model on a provider.
// Request: {"model": "model-id", "imgSizes": ["1024x1024", "2560x3840", ...]}
// Pass an empty array to clear the list and fall back to built-in defaults.
func (h *Handler) updateModelImgSizes(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model    string   `json:"model"`
		ImgSizes []string `json:"imgSizes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	// Normalize: trim spaces, drop duplicates, drop empties, enforce a sane upper bound.
	seen := make(map[string]struct{})
	cleaned := make([]string, 0, len(req.ImgSizes))
	for _, s := range req.ImgSizes {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		cleaned = append(cleaned, s)
		if len(cleaned) >= 200 {
			break
		}
	}
	if h.d.Reg.UpdateModelImgSizes(providerID, req.Model, cleaned) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "imgSizes": cleaned})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "model not found on provider")
	}
}

// updateModelProtocols sets the probed protocol set for a single model on a
// provider. Request: {"model": "model-id", "protocols": ["openai-compat",
// "openai-responses", "anthropic"]}. An empty array is valid and clears the
// protocol set (meaning: probed, supports no known protocol). This is a pure
// metadata update, so only saveConfig (no reload) is used.
func (h *Handler) updateModelProtocols(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model     string   `json:"model"`
		Protocols []string `json:"protocols"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	if err := h.d.Reg.UpdateModelProtocols(providerID, req.Model, req.Protocols); err != nil {
		apibase.WriteAPIError(w, http.StatusNotFound, err.Error())
		return
	}
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfig(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	// Read back the persisted value so the response reflects what is stored
	// (e.g. nil vs empty slice normalization).
	updated := req.Protocols
	if m, ok := h.d.Reg.GetModelByAliasOrID(providerID, req.Model); ok {
		updated = m.Protocols
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocols": updated})
}

// updateModelNIM updates the NIM (non-interactive mode) override settings for a
// single model on a provider.
// Request: {"model": "model-id", "nim": {"enabled": true, "request_count_per_key": 30, "min_interval_ms": 2000}}
func (h *Handler) updateModelNIM(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model string                  `json:"model"`
		NIM   config.ModelNIMOverride `json:"nim"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	if h.d.Reg.UpdateModelNIMOverride(providerID, req.Model, req.NIM) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "model not found on provider")
	}
}

// deleteProviderModel removes a custom model ID from a provider.
func (h *Handler) deleteProviderModel(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	modelID := r.URL.Query().Get("model")

	if h.d.Reg.DeleteModel(providerID, modelID) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "model not found")
	}
}

// --- Helpers ---

func firstActiveKey(provider *config.Provider) *config.Key {
	for i := range provider.Keys {
		if provider.Keys[i].IsActive {
			return &provider.Keys[i]
		}
	}
	return nil
}

// getIntQuery reads an integer query parameter with a default fallback.
func getIntQuery(r *http.Request, key string, defaultVal int) int {
	valStr := r.URL.Query().Get(key)
	if valStr == "" {
		return defaultVal
	}
	val, err := strconv.Atoi(valStr)
	if err != nil || val < 0 {
		return defaultVal
	}
	return val
}
