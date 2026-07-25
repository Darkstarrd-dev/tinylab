// Package api provides HTTP handlers for the management REST API.
//
// File editor.go implements the Editor page's text-file open/save handlers:
// editorOpen uses a native file picker + os.ReadFile, and editorSave uses
// atomic file writes (fsutil.AtomicWrite). Both speak JSON.
package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"

	"github.com/tinyrouter/tinyrouter/internal/fsutil"
)

// editorOpen shows a native file picker and returns the selected file's text
// content. POST /api/editor/open (empty body or {}). Returns:
//
//	{ "cancelled": true }              — user cancelled the picker
//	{ "unsupported": true }            — platform without a native picker
//	{ "path": "...", "name": "...", "size": 1234, "content": "..." }
//
// On read error: 500 { "error": "..." }.
func (rt *Router) editorOpen(w http.ResponseWriter, r *http.Request) {
	const maxSize int64 = 16 * 1024 * 1024 // 16 MiB

	filter := "Text & Code (*.txt;*.md;*.json;*.yaml;*.yml;*.js;*.ts;*.go;*.html;*.css;*.xml;*.csv;*.log;*.py;*.sh;*.sql;*.lua)|*.txt;*.md;*.json;*.yaml;*.yml;*.js;*.ts;*.go;*.html;*.css;*.xml;*.csv;*.log;*.py;*.sh;*.sql;*.lua|All Files (*.*)|*.*"

	path, err := fsutil.OpenFilePicker(filter)
	if err != nil {
		if errors.Is(err, fsutil.ErrUnsupportedPlatform) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"unsupported": true})
			return
		}
		writeAPIError(w, http.StatusInternalServerError, "picker failed: "+err.Error())
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
		writeAPIError(w, http.StatusInternalServerError, "stat failed: "+err.Error())
		return
	}
	if fi.Size() > maxSize {
		writeAPIError(w, http.StatusBadRequest, "file too large (max 16 MiB)")
		return
	}

	content, err := os.ReadFile(path)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "read failed: "+err.Error())
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
func (rt *Router) editorSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	if req.Path == "" {
		writeAPIError(w, http.StatusBadRequest, "path required")
		return
	}

	if err := fsutil.AtomicWrite(req.Path, []byte(req.Content), 0644); err != nil {
		writeAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":   true,
		"path": req.Path,
	})
}
