// Package editor implements the Editor page's text-file open/save handlers:
// editorOpen uses a native file picker + os.ReadFile (or reads path from JSON body),
// editorSave uses atomic file writes (fsutil.AtomicWrite), and editorTree lists
// docDir files.
package editor

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"

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
	r.Post("/delete", h.editorDeleteFile)
	r.Post("/upload-image", h.editorUploadImage)
	r.Post("/save-session-images", h.editorSaveSessionImages)
	r.Get("/image", h.editorServeImage)
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
		if os.IsNotExist(err) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]any{"error": "file not found", "not_found": true})
			return
		}
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

	_ = os.MkdirAll(filepath.Dir(req.Path), 0755)

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

// editorUploadImage saves an uploaded image file into docDir/imgs/
// and returns relative and API URLs for rendering in Markdown.
func (h *Handler) editorUploadImage(w http.ResponseWriter, r *http.Request) {
	err := r.ParseMultipartForm(32 << 20) // 32MB max
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "failed to parse multipart form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing image file parameter")
		return
	}
	defer file.Close()

	docDir := "docs"
	if h != nil && h.d != nil {
		cfg := h.d.Reg.Config()
		configDir := ""
		if h.d.ConfigPath != "" {
			configDir = filepath.Dir(h.d.ConfigPath)
		}
		docDir = config.ResolveDocDir(cfg.DocDir, configDir)
	}

	imgsDir := filepath.Join(docDir, "imgs")
	_ = os.MkdirAll(imgsDir, 0755)

	ext := filepath.Ext(header.Filename)
	if ext == "" {
		ext = ".png"
	}
	filename := fmt.Sprintf("img_%d%s", time.Now().UnixNano()/1e6, ext)
	dstPath := filepath.Join(imgsDir, filename)

	out, err := os.Create(dstPath)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to create image file")
		return
	}
	defer out.Close()

	if _, err = io.Copy(out, file); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to write image file")
		return
	}

	relUrl := "./imgs/" + filename
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"url":     relUrl,
		"apiPath": "/api/editor/image?path=" + url.QueryEscape(relUrl),
		"name":    filename,
	})
}

// editorServeImage serves images saved under docDir.
func (h *Handler) editorServeImage(w http.ResponseWriter, r *http.Request) {
	relPath := r.URL.Query().Get("path")
	if relPath == "" {
		http.Error(w, "missing path parameter", http.StatusBadRequest)
		return
	}

	docDir := "docs"
	if h != nil && h.d != nil {
		cfg := h.d.Reg.Config()
		configDir := ""
		if h.d.ConfigPath != "" {
			configDir = filepath.Dir(h.d.ConfigPath)
		}
		docDir = config.ResolveDocDir(cfg.DocDir, configDir)
	}

	cleanRel := filepath.Clean(relPath)
	fullPath := filepath.Join(docDir, cleanRel)
	http.ServeFile(w, r, fullPath)
}

// editorSaveSessionImages accepts multipart form with targetPath, imgsSubdir, and image files,
// saving them into targetFile's parent directory + imgsSubdir.
func (h *Handler) editorSaveSessionImages(w http.ResponseWriter, r *http.Request) {
	err := r.ParseMultipartForm(32 << 20)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "failed to parse multipart form")
		return
	}

	targetPath := r.FormValue("targetPath")
	imgsSubdir := r.FormValue("imgsSubdir")
	if targetPath == "" || imgsSubdir == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "targetPath and imgsSubdir required")
		return
	}

	dir := filepath.Dir(targetPath)
	targetImgDir := filepath.Join(dir, imgsSubdir)
	_ = os.MkdirAll(targetImgDir, 0755)

	files := r.MultipartForm.File
	for fieldName, fileHeaders := range files {
		if fieldName == "targetPath" || fieldName == "imgsSubdir" {
			continue
		}
		for _, header := range fileHeaders {
			f, err := header.Open()
			if err != nil {
				continue
			}
			dstPath := filepath.Join(targetImgDir, header.Filename)
			out, err := os.Create(dstPath)
			if err != nil {
				f.Close()
				continue
			}
			_, _ = io.Copy(out, f)
			out.Close()
			f.Close()
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":         true,
		"targetDir":  targetImgDir,
		"imgsSubdir": imgsSubdir,
	})
}

// editorDeleteFile deletes a physical file and its accompanying imgs directory if present.
func (h *Handler) editorDeleteFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	if req.Path == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "path required")
		return
	}

	_ = os.Remove(req.Path)

	baseName := filepath.Base(req.Path)
	ext := filepath.Ext(baseName)
	if len(baseName) > len(ext) {
		rawName := baseName[:len(baseName)-len(ext)]
		imgsDir := filepath.Join(filepath.Dir(req.Path), rawName+"_imgs")
		_ = os.RemoveAll(imgsDir)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":   true,
		"path": req.Path,
	})
}
