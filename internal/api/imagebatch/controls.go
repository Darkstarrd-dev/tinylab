package imagebatch

import (
	"github.com/go-chi/chi/v5"
	domain "github.com/tinyrouter/tinyrouter/internal/imagebatch"
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
		errJSON(w, 400, "mode must be after-current or immediate")
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
		errJSON(w, 400, "invalid project id")
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
		errJSON(w, 409, "operation failed")
		return
	}
	writeJSON(w, 200, p)
}
func (h *Handler) retry(w http.ResponseWriter, r *http.Request) {
	if !requireManager(h, w) {
		return
	}
	id, pid, vid := chi.URLParam(r, "projectID"), chi.URLParam(r, "promptID"), chi.URLParam(r, "variantID")
	if !pathID(id) || !pathID(pid) || !pathID(vid) {
		errJSON(w, 400, "invalid id")
		return
	}
	p, err := h.manager.Retry(r.Context(), id, pid, vid)
	if err != nil {
		errJSON(w, 409, "retry failed")
		return
	}
	writeJSON(w, 200, p)
}
