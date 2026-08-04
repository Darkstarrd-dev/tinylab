package imagebatch

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	domain "github.com/tinyrouter/tinyrouter/internal/imagebatch"
)

func (h *Handler) transform(w http.ResponseWriter, r *http.Request) {
	var in domain.TransformInput
	if err := decodeJSON(r, &in); err != nil {
		errJSON(w, 400, "invalid JSON")
		return
	}
	if err := in.Validate(); err != nil {
		errJSON(w, 400, err.Error())
		return
	}
	if h.d == nil || h.d.ProxyHandler == nil {
		errJSON(w, 503, "helper model unavailable")
		return
	}
	b, _ := json.Marshal(in.Items)
	text, err := h.callHelper(r.Context(), in.HelperModel, "Convert each prompt to format "+in.Format+". Preserve naturalPrompt exactly. Input: "+string(b))
	if err != nil {
		errJSON(w, 502, "helper model request failed")
		return
	}
	var out domain.TransformOutput
	if err := decodeStrictContent(text, &out); err != nil || out.Validate() != nil || out.Format != in.Format || len(out.Items) != len(in.Items) {
		errJSON(w, 502, "helper model returned invalid transform")
		return
	}
	for i := range out.Items {
		out.Items[i].NaturalPrompt = in.Items[i].NaturalPrompt
	}
	writeJSON(w, 200, out)
}

type createRequest struct {
	SchemaVersion int                `json:"schemaVersion"`
	DisplayName   string             `json:"displayName"`
	Slug          string             `json:"slug"`
	PromptPlan    domain.PromptPlan  `json:"promptPlan"`
	ImageConfig   domain.ImageConfig `json:"imageConfig"`
	BatchConfig   domain.BatchConfig `json:"batchConfig"`
	Prompts       []domain.Prompt    `json:"prompts"`
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	if !requireManager(h, w) {
		return
	}
	var in createRequest
	if err := decodeJSON(r, &in); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	p := &domain.Project{
		SchemaVersion: in.SchemaVersion,
		DisplayName:   in.DisplayName,
		Slug:          in.Slug,
		PromptPlan:    in.PromptPlan,
		ImageConfig:   in.ImageConfig,
		BatchConfig:   in.BatchConfig,
		Prompts:       in.Prompts,
	}
	if p.SchemaVersion == 0 {
		p.SchemaVersion = 1
	}
	out, err := h.manager.Create(r.Context(), p)
	if err != nil {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"projectId": out.ProjectID, "snapshot": out})
}
func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	if !requireManager(h, w) {
		return
	}
	v, err := h.manager.List(r.Context())
	if err != nil {
		errJSON(w, 500, "failed to list projects")
		return
	}
	writeJSON(w, 200, v)
}
func (h *Handler) importProject(w http.ResponseWriter, r *http.Request) {
	if !requireManager(h, w) {
		return
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		errJSON(w, 400, "invalid import")
		return
	}
	format := r.URL.Query().Get("format")
	if format != "json" && format != "yaml" {
		format = "json"
	}
	p, err := h.manager.Import(r.Context(), b, format)
	if err != nil {
		errJSON(w, 400, "invalid project")
		return
	}
	writeJSON(w, 201, map[string]any{"projectId": p.ProjectID, "snapshot": p})
}
func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	if !requireManager(h, w) {
		return
	}
	id := chi.URLParam(r, "projectID")
	if !pathID(id) {
		errJSON(w, 400, "invalid project id")
		return
	}
	p, err := h.manager.Get(r.Context(), id)
	if err != nil {
		errJSON(w, 404, "project not found")
		return
	}
	writeJSON(w, 200, p)
}
func (h *Handler) manifest(w http.ResponseWriter, r *http.Request) { h.get(w, r) }
func (h *Handler) asset(w http.ResponseWriter, r *http.Request) {
	if !requireManager(h, w) {
		return
	}
	id, aid := chi.URLParam(r, "projectID"), chi.URLParam(r, "assetID")
	if !pathID(id) || !pathID(aid) {
		errJSON(w, 400, "invalid asset id")
		return
	}
	path, err := h.manager.AssetPath(r.Context(), id, aid)
	if err != nil {
		errJSON(w, 404, "asset not found")
		return
	}
	f, err := os.Open(filepath.Clean(path))
	if err != nil {
		errJSON(w, 404, "asset not found")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		errJSON(w, 404, "asset not found")
		return
	}
	http.ServeContent(w, r, filepath.Base(path), st.ModTime(), f)
}
