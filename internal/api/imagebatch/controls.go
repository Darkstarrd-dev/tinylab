package imagebatch

import (
	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
	domain "github.com/tinylab/tinylab/internal/imagebatch"
	"net/http"
)

func (h *Handler) pause(w http.ResponseWriter, r *http.Request)  { h.control(w, r, "pause", "") }
func (h *Handler) resume(w http.ResponseWriter, r *http.Request) { h.control(w, r, "resume", "") }

type stopRequest struct {
	Mode string `json:"mode"`
}

func (h *Handler) stop(w http.ResponseWriter, r *http.Request) {
	var in stopRequest
	if err := decodeJSON(r, &in); err != nil || (in.Mode != "after-current" && in.Mode != "immediate") {
		apibase.WriteAPIError(w, 400, "mode must be after-current or immediate")
		return
	}
	h.control(w, r, "stop", in.Mode)
}
func (h *Handler) control(w http.ResponseWriter, r *http.Request, op, mode string) {
	if !requireManager(h, w) {
		return
	}
	id := chi.URLParam(r, "projectID")
	if !pathID(id) {
		apibase.WriteAPIError(w, 400, "invalid project id")
		return
	}
	var (
		p   *domain.Project
		err error
	)
	switch op {
	case "pause":
		p, err = h.manager.Pause(r.Context(), id)
	case "resume":
		p, err = h.manager.Resume(r.Context(), id)
	case "stop":
		p, err = h.manager.Stop(r.Context(), id, mode)
	}
	if err != nil {
		apibase.WriteAPIError(w, 409, "operation failed")
		return
	}
	apibase.WriteJSON(w, 200, p)
}
func (h *Handler) retry(w http.ResponseWriter, r *http.Request) {
	if !requireManager(h, w) {
		return
	}
	id, pid, vid := chi.URLParam(r, "projectID"), chi.URLParam(r, "promptID"), chi.URLParam(r, "variantID")
	if !pathID(id) || !pathID(pid) || !pathID(vid) {
		apibase.WriteAPIError(w, 400, "invalid id")
		return
	}
	p, err := h.manager.Retry(r.Context(), id, pid, vid)
	if err != nil {
		apibase.WriteAPIError(w, 409, "retry failed")
		return
	}
	apibase.WriteJSON(w, 200, p)
}
