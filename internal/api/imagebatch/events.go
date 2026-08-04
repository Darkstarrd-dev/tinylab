package imagebatch

import (
	"encoding/json"
	"fmt"
	"github.com/go-chi/chi/v5"
	domain "github.com/tinyrouter/tinyrouter/internal/imagebatch"
	"net/http"
	"time"
)

func (h *Handler) events(w http.ResponseWriter, r *http.Request) {
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
	ch, err := h.manager.Subscribe(r.Context(), id)
	if err != nil {
		errJSON(w, 500, "events unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	fl, ok := w.(http.Flusher)
	if !ok {
		return
	}
	send := func(name string, v any) {
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b)
		fl.Flush()
	}
	send("snapshot", p)
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			if ev.At.IsZero() {
				ev.At = time.Now()
			}
			send(string(ev.Type), ev)
		}
	}
}

var _ domain.Event
