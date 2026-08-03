// Package anysearch provides HTTP handlers for the AnySearch API.
// It proxies search, sub-domain listing, and URL extraction to the
// AnySearch backend.
package anysearch

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/anysearch"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
)

// Handler wires up AnySearch routes.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new AnySearch handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register registers the AnySearch routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Post("/anysearch/search", h.anySearchHandler)
	r.Post("/anysearch/subdomains", h.anySearchSubDomainsHandler)
	r.Post("/anysearch/extract", h.anySearchExtractHandler)
}

// anySearchHandler proxies a search request to the AnySearch API.
// POST /api/anysearch/search
func (h *Handler) anySearchHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Query           string                 `json:"query"`
		Domain          string                 `json:"domain,omitempty"`
		SubDomain       string                 `json:"sub_domain,omitempty"`
		SubDomainParams map[string]interface{} `json:"sub_domain_params,omitempty"`
		MaxResults      int                    `json:"max_results,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Query == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "query is required")
		return
	}

	cfg := h.d.Reg.Config()
	maxResults := req.MaxResults
	if maxResults == 0 {
		maxResults = cfg.AnySearch.MaxResults
	}

	client := anysearch.New(cfg.AnySearch.APIKey)
	text, err := client.Search(req.Query, req.Domain, req.SubDomain, req.SubDomainParams, maxResults)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"result": text})
}

// anySearchSubDomainsHandler proxies a get_sub_domains request to the AnySearch API.
// POST /api/anysearch/subdomains
func (h *Handler) anySearchSubDomainsHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Domain string `json:"domain"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Domain == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "domain is required")
		return
	}

	cfg := h.d.Reg.Config()
	client := anysearch.New(cfg.AnySearch.APIKey)
	text, err := client.GetSubDomains(req.Domain)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"result": text})
}

// anySearchExtractHandler proxies an extract request to the AnySearch API.
// POST /api/anysearch/extract
func (h *Handler) anySearchExtractHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.URL == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "url is required")
		return
	}

	cfg := h.d.Reg.Config()
	client := anysearch.New(cfg.AnySearch.APIKey)
	text, err := client.Extract(req.URL)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"result": text})
}
