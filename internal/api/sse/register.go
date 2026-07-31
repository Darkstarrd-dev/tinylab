// Package sse provides the Server-Sent Events endpoint for streaming usage
// and proxy events to the admin UI.
package sse

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/proxy"
)

// Handler wires up the SSE event stream route.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new SSE handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register adds the SSE routes to the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/monitor/events", h.streamUsageEvents)
}

// streamUsageEvents pushes the combined usage/inflight/request event streams to
// the connected admin UI over a single SSE connection.
func (h *Handler) streamUsageEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	fmt.Fprintf(w, "data: {\"type\":\"connected\"}\n\n")
	flusher.Flush()

	// Send existing inflight (processing) entries as request-start events so
	// a freshly connected client immediately sees all currently-running requests.
	if h.d.ProxyHandler != nil && h.d.ProxyHandler.EntryTracker != nil {
		for _, e := range h.d.ProxyHandler.EntryTracker.All() {
			raw := proxy.MarshalEntryJSON(e)
			if raw != nil {
				fmt.Fprintf(w, "data: {\"type\":\"request-start\",\"id\":%s,\"entry\":%s}\n\n",
					json.RawMessage(mustJSON(e.ID)), raw)
				flusher.Flush()
			}
		}
	}

	ch, unsubUsage := h.d.ProxyHandler.UsageUpdates.Subscribe()
	infCh, unsubInflight := h.d.ProxyHandler.InflightUpdates.Subscribe()
	reqCh, unsubRequests := h.d.ProxyHandler.RequestUpdates.Subscribe()
	defer unsubUsage()
	defer unsubInflight()
	defer unsubRequests()
	ctx := r.Context()
	for {
		select {
		case <-ch:
			fmt.Fprintf(w, "data: {\"type\":\"usage-updated\"}\n\n")
			flusher.Flush()
		case <-infCh:
			fmt.Fprintf(w, "data: {\"type\":\"key-inflight\"}\n\n")
			flusher.Flush()
		case ev, ok := <-reqCh:
			if !ok {
				return
			}
			if reqEv, ok := ev.(proxy.RequestEvent); ok {
				// Marshal a single JSON object for SSE transport.
				data, err := json.Marshal(reqEv)
				if err != nil {
					continue
				}
				fmt.Fprintf(w, "data: %s\n\n", data)
				flusher.Flush()
			}
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

// mustJSON returns the JSON encoding of s as a string, or the original string
// (quoted by the caller) if it cannot be encoded.
func mustJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}