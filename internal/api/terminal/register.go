// Package terminal provides the WebSocket terminal handler.
package terminal

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/terminal"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		return origin == "http://"+r.Host || origin == "https://"+r.Host
	},
}

// Handler wires the terminal routes.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register registers the terminal routes under the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/terminal/ws", h.handleTerminalWS)
	r.Post("/terminal/stop", h.stopTerminal)
}

func (h *Handler) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	if !h.d.DebugMode.Load() {
		http.Error(w, "terminal requires debug mode", http.StatusForbidden)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	var session *terminal.Session
	onClose := func() {
		h.d.TerminalState.Mu.Lock()
		if h.d.TerminalState.Term == session {
			h.d.TerminalState.Term = nil
		}
		h.d.TerminalState.Mu.Unlock()
		h.d.Logger.Info("terminal session closed")
	}

	session, err = terminal.NewSession("", conn, onClose)
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("Error: "+err.Error()))
		_ = conn.Close()
		return
	}

	h.d.TerminalState.Mu.Lock()
	if h.d.TerminalState.Term != nil {
		h.d.TerminalState.Mu.Unlock()
		_ = conn.WriteMessage(websocket.TextMessage, []byte("terminal session already active"))
		session.Close()
		return
	}
	h.d.TerminalState.Term = session
	h.d.TerminalState.Mu.Unlock()
	h.d.Logger.Info("terminal session started")
}

func (h *Handler) stopTerminal(w http.ResponseWriter, r *http.Request) {
	h.d.TerminalState.Mu.Lock()
	session := h.d.TerminalState.Term
	h.d.TerminalState.Term = nil
	h.d.TerminalState.Mu.Unlock()

	if session == nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "no active terminal session")
		return
	}

	session.Close()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}