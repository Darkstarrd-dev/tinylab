// Package editor implements the Editor page's text-file open/save handlers:
// editorOpen uses a native file picker + os.ReadFile, and editorSave uses
// atomic file writes (fsutil.AtomicWrite). Both speak JSON.
package editor

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/fsutil"
)

// Handler provides HTTP handlers for the editor page.
type Handler struct{}

// NewHandler creates a new editor Handler.
func NewHandler() *Handler {
	return &Handler{}
}

// Register wires up the editor routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Post("/open", h.editorOpen)
	r.Post("/save", h.editorSave)
}

// editorOpen shows a native file picker and returns the selected file's text
// content. POST /api/editor/open (empty body or {}). Returns:
//
//	{ "cancelled": true }              — user cancelled the picker
//	{ "unsupported": true }            — platform without a native picker
//	{ "path": "...", "name": "...", "size": 1234, "content": "..." }
//
// On read error: 500 { "error": "..." }.
func (h *Handler) editorOpen(w http.ResponseWriter, r *http.Request) {
	const maxSize int64 = 16 * 1024 * 1024 // 16 MiB

	filter := "Text & Code (*.txt;*.md;*.json;*.yaml;*.yml;*.js;*.ts;*.go;*.html;*.css;*.xml;*.csv;*.log;*.py;*.sh;*.sql;*.lua)|*.txt;*.md;*.json;*.yaml;*.yml;*.js;*.ts;*.go;*.html;*.css;*.xml;*.csv;*.log;*.py;*.sh;*.sql;*.lua|All Files (*.*)|*.*"

	path, err := fsutil.OpenFilePicker(filter)
	if err != nil {
		if errors.Is(err, fsutil.ErrUnsupportedPlatform) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"unsupported": true})
			return
		}
		apibase.WriteAPIError(w, http.StatusInternalServerError, "picker failed: "+err.Error())
		return
	}
	if path == "" {
		// User cancelled.
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"cancelled": true})
		return
	}

	fi, err := os.Stat(path)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "stat failed: "+err.Error())
		return
	}
	if fi.Size() > maxSize {
		apibase.WriteAPIError(w, http.StatusBadRequest, "file too large (max 16 MiB)")
		return
	}

	content, err := os.ReadFile(path)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "read failed: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"path":    path,
		"name":    filepath.Base(path),
		"size":    len(content),
		"content": string(content),
	})
}

// editorSave writes text content to an absolute path atomically.
// POST /api/editor/save { "path": "...", "content": "..." }
// Returns { "ok": true, "path": "..." } or 4xx/500 { "error": "..." }.
func (h *Handler) editorSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	if req.Path == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "path required")
		return
	}

	if err := fsutil.AtomicWrite(req.Path, []byte(req.Content), 0644); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":   true,
		"path": req.Path,
	})
}
