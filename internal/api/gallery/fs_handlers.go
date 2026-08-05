// Code in this file: gallery filesystem handlers + helpers (Fix 1 split from register.go). Frontend: gallery.js.
package gallery

import (
	"encoding/json"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/fsutil"
)

// Gallery-supported file extensions (mirrors gallery-state.js).
var galleryImgExts = map[string]bool{
	".webp": true, ".png": true, ".jpg": true, ".jpeg": true,
	".bmp": true, ".tiff": true, ".tif": true, ".avif": true, ".gif": true,
}
var galleryVidExts = map[string]bool{
	".mp4": true, ".webm": true, ".ogv": true, ".gif": true, ".webp": true,
}

func isGalleryFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return galleryImgExts[ext] || galleryVidExts[ext]
}

func isGalleryZip(name string) bool {
	return strings.EqualFold(filepath.Ext(name), ".zip")
}

// galleryFsEntry represents a single file in a directory listing response.
type galleryFsEntry struct {
	Name string `json:"name"`
	Path string `json:"path"` // absolute path
	Rel  string `json:"rel"`  // relative to root dir
	Size int64  `json:"size"`
	Kind string `json:"kind"` // "image", "video", or "zip"
}

// listGalleryFiles walks dir recursively and returns gallery-supported files.
func listGalleryFiles(dir string) []galleryFsEntry {
	var out []galleryFsEntry
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		rel, _ := filepath.Rel(dir, path)
		if rel == "" {
			rel = name
		}
		rel = filepath.ToSlash(rel)

		var kind string
		switch {
		case isGalleryZip(name):
			kind = "zip"
		case isGalleryFile(name):
			ext := strings.ToLower(filepath.Ext(name))
			if galleryVidExts[ext] {
				kind = "video"
			} else {
				kind = "image"
			}
		default:
			return nil
		}

		var size int64
		if info, e := d.Info(); e == nil {
			size = info.Size()
		}
		out = append(out, galleryFsEntry{
			Name: name,
			Path: filepath.ToSlash(path),
			Rel:  rel,
			Size: size,
			Kind: kind,
		})
		return nil
	})
	return out
}

// galleryOpenDir shows a native directory picker and returns the recursive
// file listing of gallery-supported files.
// POST /api/gallery/open-dir → { dirPath, files: [...] }
func (h *Handler) galleryOpenDir(w http.ResponseWriter, r *http.Request) {
	dirPath, err := fsutil.OpenDirectoryPicker()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "picker failed: "+err.Error())
		return
	}
	if dirPath == "" {
		// User cancelled.
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"dirPath": "", "files": []galleryFsEntry{}})
		return
	}

	files := listGalleryFiles(dirPath)
	h.d.Logger.Info("gallery: opened dir %q, %d supported files", dirPath, len(files))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"dirPath": dirPath, "files": files})
}

// galleryListDir returns the recursive file listing for a given directory path.
// POST /api/gallery/list-dir { "dir": "..." } → { dirPath, files: [...] }
func (h *Handler) galleryListDir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Dir string `json:"dir"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Dir == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing dir")
		return
	}
	info, err := os.Stat(req.Dir)
	if err != nil || !info.IsDir() {
		apibase.WriteAPIError(w, http.StatusBadRequest, "not a directory")
		return
	}

	files := listGalleryFiles(req.Dir)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"dirPath": req.Dir, "files": files})
}

// galleryServeFile serves a file from disk by absolute path.
// GET /api/gallery/file?path=...
func (h *Handler) galleryServeFile(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing path")
		return
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		apibase.WriteAPIError(w, http.StatusNotFound, "file not found")
		return
	}

	ext := strings.ToLower(filepath.Ext(path))
	ct := mime.TypeByExtension(ext)
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, path)
}

// galleryDeleteFs deletes a file or directory from disk.
// DELETE /api/gallery/fs { "path": "...", "recursive": bool }
func (h *Handler) galleryDeleteFs(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Path == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing path")
		return
	}

	var err error
	if req.Recursive {
		err = os.RemoveAll(req.Path)
	} else {
		err = os.Remove(req.Path)
	}
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "delete failed: "+err.Error())
		return
	}
	h.d.Logger.Info("gallery: deleted %q (recursive=%v)", req.Path, req.Recursive)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// galleryPastePaths reads file paths from the system clipboard (CF_HDROP on
// Windows). Returns the paths if available.
// POST /api/gallery/paste-paths → { paths: [...] }
func (h *Handler) galleryPastePaths(w http.ResponseWriter, r *http.Request) {
	paths := fsutil.GetClipboardFilePaths()
	if paths == nil {
		paths = []string{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"paths": paths})
}

// galleryOpenFolder opens the file's containing directory (or the directory
// itself) in the platform file manager, selecting the file when supported.
// POST /api/gallery/open-folder { "path": "..." } → { "ok": true }
func (h *Handler) galleryOpenFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Path == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing path")
		return
	}
	if err := fsutil.OpenInFileManager(req.Path); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "open folder: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
