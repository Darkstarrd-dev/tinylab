// Package console_logs provides HTTP handlers for the server-side console log
// stream, exposing get, SSE-stream, and clear endpoints.
package console_logs

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
)

// Handler wires the console-log HTTP handlers to the shared dependencies.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a console-log Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register mounts the console-log routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/console-logs", h.getConsoleLogs)
	r.Get("/console-logs/stream", h.streamConsoleLogs)
	r.Delete("/console-logs", h.clearConsoleLogs)
}

func (h *Handler) getConsoleLogs(w http.ResponseWriter, r *http.Request) {
	lines := h.d.Logger.AllLines()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"lines": lines,
		"count": len(lines),
	})
}

func (h *Handler) streamConsoleLogs(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	// Exempt long-lived SSE from the server's WriteTimeout.
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Time{})
	}

	// Send existing lines first
	for _, line := range h.d.Logger.AllLines() {
		payload, _ := json.Marshal(map[string]string{"type": "line", "line": line})
		if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
			return
		}
		flusher.Flush()
	}

	// Subscribe to new lines
	ch := h.d.Logger.Subscribe()
	defer h.d.Logger.Unsubscribe(ch)

	ctx := r.Context()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case line, ok := <-ch:
			if !ok {
				return
			}
			payload, _ := json.Marshal(map[string]string{"type": "line", "line": line})
			if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
				return
			}
			flusher.Flush()
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Keepalive ping
			if _, err := fmt.Fprintf(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (h *Handler) clearConsoleLogs(w http.ResponseWriter, r *http.Request) {
	h.d.Logger.Clear()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
