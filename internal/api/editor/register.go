// Package editor implements the Editor page's text-file open/save handlers:
// editorOpen uses a native file picker + os.ReadFile (or reads path from JSON body),
// editorSave uses atomic file writes (fsutil.AtomicWrite), and editorTree lists
// docDir files.
package editor

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/fsutil"
)

// Handler provides HTTP handlers for the editor page.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new editor Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register wires up the editor routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/tree", h.editorTree)
	r.Get("/docs", h.editorTree)
	r.Post("/open", h.editorOpen)
	r.Post("/save", h.editorSave)
}

// DocFileItem represents a file or directory inside the docDir.
type DocFileItem struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	RelPath string `json:"relPath"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size,omitempty"`
}

// editorTree returns the list of files in the configured docDir.
func (h *Handler) editorTree(w http.ResponseWriter, r *http.Request) {
	docDir := "docs"
	if h != nil && h.d != nil {
		cfg := h.d.Reg.Config()
		configDir := ""
		if h.d.ConfigPath != "" {
			configDir = filepath.Dir(h.d.ConfigPath)
		}
		docDir = config.ResolveDocDir(cfg.DocDir, configDir)
	}
	_ = os.MkdirAll(docDir, 0755)

	absDocDir, err := filepath.Abs(docDir)
	if err != nil {
		absDocDir = docDir
	}

	var files []DocFileItem
	_ = filepath.WalkDir(absDocDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || p == absDocDir {
			return nil
		}
		rel, relErr := filepath.Rel(absDocDir, p)
		if relErr != nil {
			rel = filepath.Base(p)
		}
		relPath := filepath.ToSlash(rel)

		info, infoErr := d.Info()
		var size int64
		if infoErr == nil && !d.IsDir() {
			size = info.Size()
		}

		files = append(files, DocFileItem{
			Name:    d.Name(),
			Path:    p,
			RelPath: relPath,
			IsDir:   d.IsDir(),
			Size:    size,
		})
		return nil
	})

	if files == nil {
		files = []DocFileItem{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"docDir": absDocDir,
		"files":  files,
	})
}

// editorOpen shows a native file picker (or reads path if specified in JSON body)
// and returns the selected file's text content. POST /api/editor/open.
func (h *Handler) editorOpen(w http.ResponseWriter, r *http.Request) {
	const maxSize int64 = 16 * 1024 * 1024 // 16 MiB

	var req struct {
		Path string `json:"path"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}

	path := req.Path
	if path == "" {
		filter := "Markdown & HTML & Text (*.md;*.html;*.htm;*.markdown;*.txt;*.json;*.yaml;*.yml;*.js;*.ts;*.go;*.css;*.xml)|*.md;*.html;*.htm;*.markdown;*.txt;*.json;*.yaml;*.yml;*.js;*.ts;*.go;*.css;*.xml|All Files (*.*)|*.*"

		docDir := "docs"
		if h != nil && h.d != nil {
			cfg := h.d.Reg.Config()
			configDir := ""
			if h.d.ConfigPath != "" {
				configDir = filepath.Dir(h.d.ConfigPath)
			}
			docDir = config.ResolveDocDir(cfg.DocDir, configDir)
		}

		var err error
		path, err = fsutil.OpenFilePickerAt(filter, docDir)
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
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"cancelled": true})
			return
		}
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
