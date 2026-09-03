// Code in this file: gallery filesystem handlers + helpers. Frontend: gallery.js.
//
// Path capability contract (docs/audit_fix.md F-03/F-30, B-4): the browser never
// submits server-side paths. Directory listings are bound to a server-issued
// directory grant (open-dir / paste-paths); file reads resolve through
// assetId (TempStore), sourceId+entryPath (archive bridge), or a
// grantId+rel combination. Raw `path` parameters are rejected with 410, and
// no response contains an absolute filesystem path.
package gallery

import (
	"encoding/json"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/archive"
	"github.com/tinylab/tinylab/internal/fsutil"
	"github.com/tinylab/tinylab/internal/owner"
	"github.com/tinylab/tinylab/internal/pathgrant"
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
// Path is deliberately absent: entries are addressed by grantId + relative
// path (or assetId for registered assets), never by an absolute path.
type galleryFsEntry struct {
	Name string `json:"name"`
	Rel  string `json:"rel"` // relative to the granted root dir
	Size int64  `json:"size"`
	Kind string `json:"kind"` // "image", "video", or "zip"
}

// listGalleryFiles walks dir recursively and returns gallery-supported files
// with paths relative to dir (never absolute).
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
			Rel:  rel,
			Size: size,
			Kind: kind,
		})
		return nil
	})
	return out
}

// galleryOpenDir shows a native directory picker, registers the picked
// directory as an owner-bound grant, and returns the relative file listing
// plus the grant id.
// POST /api/gallery/open-dir → { grantId, files: [...] }
func (h *Handler) galleryOpenDir(w http.ResponseWriter, r *http.Request) {
	ownerID := owner.From(r.Context())
	if ownerID == "" {
		apibase.WriteAPIError(w, http.StatusForbidden, "request has no owner identity")
		return
	}
	dirPath, err := fsutil.OpenDirectoryPicker()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "picker failed: "+err.Error())
		return
	}
	if dirPath == "" {
		// User cancelled.
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"grantId": "", "files": []galleryFsEntry{}})
		return
	}

	g, err := h.grants.Grant(ownerID, []pathgrant.Operation{pathgrant.OpRead, pathgrant.OpWrite, pathgrant.OpDelete}, dirPath, true, false)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "directory grant failed: "+err.Error())
		return
	}

	files := listGalleryFiles(g.Path)
	h.d.Logger.Info("gallery: opened dir, %d supported files (grant %s)", len(files), g.ID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"grantId": g.ID, "files": files})
}

// galleryListDir returns the recursive file listing for a granted directory.
// POST /api/gallery/list-dir { "grantId": "..." } → { grantId, files: [...] }
// The legacy raw { "dir": "..." } contract returns 410.
func (h *Handler) galleryListDir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Dir     string `json:"dir"` // legacy: rejected
		GrantID string `json:"grantId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing grantId")
		return
	}
	if req.Dir != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw directory paths are no longer accepted; use grantId from open-dir")
		return
	}
	ownerID := owner.From(r.Context())
	root, err := h.grants.Resolve(ownerID, req.GrantID, pathgrant.OpRead)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusForbidden, "directory grant denied or expired; re-open the folder")
		return
	}

	files := listGalleryFiles(root)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"grantId": req.GrantID, "files": files})
}

// galleryServeFile serves a file by assetId, sourceId+entryPath, or
// grantId+rel. GET /api/gallery/file?assetId=... | ?sourceId=...&entryPath=...
// | ?grantId=...&rel=... — the legacy ?path= contract returns 410.
func (h *Handler) galleryServeFile(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("path") != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw file paths are no longer accepted; use assetId, sourceId+entryPath, or grantId+rel")
		return
	}
	ownerID := owner.From(r.Context())

	switch {
	case q.Get("assetId") != "":
		st, err := h.assetStore()
		if err != nil {
			apibase.WriteAPIError(w, http.StatusServiceUnavailable, "asset store unavailable")
			return
		}
		rc, ref, err := st.Open(ownerID, q.Get("assetId"))
		if err != nil {
			apibase.WriteAPIError(w, http.StatusNotFound, "asset not found")
			return
		}
		defer rc.Close()
		serveBlob(w, rc, ref.MIME, ref.Name, ref.Size)
		return

	case q.Get("sourceId") != "" && q.Get("entryPath") != "":
		if h.archive == nil {
			apibase.WriteAPIError(w, http.StatusServiceUnavailable, "archive source lookup is unavailable")
			return
		}
		src, ok := h.archive.ResolveSource(ownerID, q.Get("sourceId"))
		if !ok {
			apibase.WriteAPIError(w, http.StatusNotFound, "archive source not found or expired")
			return
		}
		data, ctype, err := h.archive.ReadEntry(r.Context(), src, q.Get("entryPath"), archive.DefaultBudget())
		if err != nil {
			apibase.WriteAPIError(w, http.StatusNotFound, "entry not found in source")
			return
		}
		if ctype == "" {
			ctype = mime.TypeByExtension(strings.ToLower(filepath.Ext(q.Get("entryPath"))))
		}
		if ctype == "" {
			ctype = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ctype)
		w.Header().Set("Cache-Control", "no-store")
		w.Write(data)
		return

	case q.Get("grantId") != "":
		rel := q.Get("rel")
		var p string
		var err error
		if rel == "" {
			p, err = h.grants.Resolve(ownerID, q.Get("grantId"), pathgrant.OpRead)
		} else {
			p, err = h.grants.ResolveChild(ownerID, q.Get("grantId"), rel, pathgrant.OpRead)
		}
		if err != nil {
			apibase.WriteAPIError(w, http.StatusForbidden, "grant denied or expired; re-open the folder")
			return
		}
		info, err := os.Stat(p)
		if err != nil || info.IsDir() {
			apibase.WriteAPIError(w, http.StatusNotFound, "file not found")
			return
		}
		ext := strings.ToLower(filepath.Ext(p))
		ct := mime.TypeByExtension(ext)
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "no-store")
		// Explicit Accept-Ranges for video streaming: http.ServeFile already
		// handles Range requests, but declaring it ensures the <video> element
		// with preload="metadata" can seek without re-downloading the whole
		// file — the remaining path to eliminating the 2 s+ stall for PCIe4
		// SSD <100 MB videos after the frontend adjacent preload lands.
		w.Header().Set("Accept-Ranges", "bytes")
		http.ServeFile(w, r, p)
		return
	}
	apibase.WriteAPIError(w, http.StatusBadRequest, "assetId, sourceId+entryPath, or grantId+rel is required")
}

// serveBlob streams a temp asset to the response.
func serveBlob(w http.ResponseWriter, rc io.Reader, ctype, name string, size int64) {
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	if size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	w.Header().Set("Cache-Control", "no-store")
	io.Copy(w, rc)
}

// galleryDeleteFs deletes a file or directory inside a granted root.
// DELETE /api/gallery/fs { "grantId": "...", "rel": "...", "recursive": bool }
// The legacy { "path": "..." } contract returns 410.
func (h *Handler) galleryDeleteFs(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path      string `json:"path"` // legacy: rejected
		GrantID   string `json:"grantId"`
		Rel       string `json:"rel"`
		Recursive bool   `json:"recursive"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing grantId or rel")
		return
	}
	if req.Path != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw paths are no longer accepted; use grantId + rel")
		return
	}
	ownerID := owner.From(r.Context())
	var target string
	var err error
	if req.Rel == "" {
		target, err = h.grants.Resolve(ownerID, req.GrantID, pathgrant.OpDelete)
	} else {
		target, err = h.grants.ResolveChild(ownerID, req.GrantID, req.Rel, pathgrant.OpDelete)
	}
	if err != nil {
		apibase.WriteAPIError(w, http.StatusForbidden, "grant denied or expired; re-open the folder")
		return
	}

	if req.Recursive {
		err = os.RemoveAll(target)
	} else {
		err = os.Remove(target)
	}
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "delete failed: "+err.Error())
		return
	}
	h.d.Logger.Info("gallery: deleted under grant %s (rel %q, recursive=%v)", req.GrantID, req.Rel, req.Recursive)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// galleryPastePaths reads file paths from the system clipboard (CF_HDROP on
// Windows) and registers each as an owner-bound grant. Returns only grant ids
// and metadata — never the paths.
// POST /api/gallery/paste-paths → { grants: [{pathGrantId, name, size, isDir, kind}] }
func (h *Handler) galleryPastePaths(w http.ResponseWriter, r *http.Request) {
	ownerID := owner.From(r.Context())
	if ownerID == "" {
		apibase.WriteAPIError(w, http.StatusForbidden, "request has no owner identity")
		return
	}
	paths := fsutil.GetClipboardFilePaths()
	infos := make([]grantInfo, 0, len(paths))
	for _, p := range paths {
		fi, err := os.Lstat(p)
		if err != nil || fi.Mode()&os.ModeSymlink != 0 {
			continue
		}
		ops := []pathgrant.Operation{pathgrant.OpRead, pathgrant.OpWrite, pathgrant.OpDelete}
		g, err := h.grants.Grant(ownerID, ops, p, fi.IsDir(), false)
		if err != nil {
			continue
		}
		kind := "file"
		if fi.IsDir() {
			kind = "dir"
		} else if isGalleryZip(p) {
			kind = "zip"
		} else if isGalleryFile(p) {
			if galleryVidExts[strings.ToLower(filepath.Ext(p))] {
				kind = "video"
			} else {
				kind = "image"
			}
		}
		infos = append(infos, grantInfo{
			PathGrantID: g.ID,
			Name:        filepath.Base(g.Path),
			Size:        fi.Size(),
			IsDir:       fi.IsDir(),
			Kind:        kind,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"grants": infos})
}

// grantInfo is the browser-facing metadata for one registered path grant.
type grantInfo struct {
	PathGrantID string `json:"pathGrantId"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	IsDir       bool   `json:"isDir"`
	Kind        string `json:"kind,omitempty"`
}

// galleryOpenFolder opens the containing directory (or the directory itself)
// of a granted file in the platform file manager, selecting the file when
// supported. POST /api/gallery/open-folder { "grantId": "...", "rel": "..." }
func (h *Handler) galleryOpenFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path    string `json:"path"` // legacy: rejected
		GrantID string `json:"grantId"`
		Rel     string `json:"rel"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing grantId or rel")
		return
	}
	if req.Path != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw paths are no longer accepted; use grantId + rel")
		return
	}
	ownerID := owner.From(r.Context())
	var target string
	var err error
	if req.Rel == "" {
		target, err = h.grants.Resolve(ownerID, req.GrantID, pathgrant.OpRead)
	} else {
		target, err = h.grants.ResolveChild(ownerID, req.GrantID, req.Rel, pathgrant.OpRead)
	}
	if err != nil {
		apibase.WriteAPIError(w, http.StatusForbidden, "grant denied or expired; re-open the folder")
		return
	}
	if err := fsutil.OpenInFileManager(target); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "open folder: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
