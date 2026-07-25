// Package monitor provides the monitor command execution and SSE streaming handlers.
package monitor

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
)

// Handler wires the monitor routes.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register registers the monitor routes under the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/monitor/status", h.getMonitorStatus)
	r.Post("/monitor/start", h.startMonitor)
	r.Post("/monitor/stop", h.stopMonitor)
	r.Get("/monitor/stream", h.streamMonitor)
}

func (h *Handler) getMonitorStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(h.d.MonitorMgr.Status())
}

func (h *Handler) startMonitor(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Command string   `json:"command"`
		Args    []string `json:"args"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Command == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "command is required")
		return
	}

	allowed := h.d.Reg.Config().Monitor.AllowedCommands
	if err := h.d.MonitorMgr.Start(req.Command, req.Args, allowed); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	h.d.Logger.Info("monitor started: %s", req.Command)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (h *Handler) stopMonitor(w http.ResponseWriter, r *http.Request) {
	if err := h.d.MonitorMgr.Stop(); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.d.Logger.Info("monitor stopped")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (h *Handler) streamMonitor(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	for _, line := range h.d.MonitorMgr.BufferedLines() {
		payload, _ := json.Marshal(map[string]string{"type": "line", "line": line})
		fmt.Fprintf(w, "data: %s\n\n", payload)
		flusher.Flush()
	}

	ch := h.d.MonitorMgr.Subscribe()
	defer h.d.MonitorMgr.Unsubscribe(ch)

	ctx := r.Context()
	for {
		select {
		case line, ok := <-ch:
			if !ok {
				return
			}
			payload, _ := json.Marshal(map[string]string{"type": "line", "line": line})
			fmt.Fprintf(w, "data: %s\n\n", payload)
			flusher.Flush()
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}