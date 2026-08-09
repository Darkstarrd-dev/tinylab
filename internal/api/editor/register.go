// Package editor implements the Editor page's text-file open/save handlers.
//
// Path capability contract (audit_fix.md F-02, B-3): the browser never
// submits server-side physical paths. Files inside the configured docDir are
// addressed by their docDir-relative fileId; files the native picker selects
// outside docDir are addressed by a short-TTL pathGrantId the server issued
// from the picker. Raw `path` fields are rejected with 410. Every read,
// write, and delete resolves through the requesting owner's grants or through
// strict canonical containment under docDir.
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
	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/fsutil"
	"github.com/tinyrouter/tinyrouter/internal/owner"
	"github.com/tinyrouter/tinyrouter/internal/pathgrant"
)

// maxOpenSize caps the size of a file the editor will read into memory.
const maxOpenSize int64 = 16 * 1024 * 1024 // 16 MiB

// editorImageExts is the allowlist for uploaded/session images.
var editorImageExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
	".webp": true, ".bmp": true, ".tiff": true, ".tif": true,
}

// Handler provides HTTP handlers for the editor page.
type Handler struct {
	d      *apibase.Deps
	grants *pathgrant.Store
}

// NewHandler creates a new editor Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d, grants: pathgrant.NewStore(0)}
}

// chiRouter is the chi router surface the editor needs, decoupled so tests
// can mount the routes without importing chi.
type chiRouter interface {
	Use(...func(http.Handler) http.Handler)
	Get(string, http.HandlerFunc)
	Post(string, http.HandlerFunc)
}

// Register wires up the editor routes on the given router. The owner
// middleware runs first so every grant lookup is session-bound.
func (h *Handler) Register(r chiRouter) {
	r.Use(owner.Middleware)
	r.Get("/tree", h.editorTree)
	r.Get("/docs", h.editorTree)
	r.Post("/open", h.editorOpen)
	r.Post("/save", h.editorSave)
	r.Post("/rename", h.editorRename)
	r.Post("/delete", h.editorDeleteFile)
	r.Post("/upload-image", h.editorUploadImage)
	r.Post("/save-session-images", h.editorSaveSessionImages)
	r.Get("/image", h.editorServeImage)
}

// errCancelled signals the user dismissed the native picker.
var errCancelled = errors.New("cancelled")

// DocFileItem represents a file or directory inside the docDir. Path is
// deliberately absent: clients only ever see the docDir-relative fileId.
type DocFileItem struct {
	Name    string `json:"name"`
	RelPath string `json:"relPath"`
	FileID  string `json:"fileId"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size,omitempty"`
}

// docDir resolves the configured documents directory to an absolute path.
func (h *Handler) docDir() string {
	docDir := "docs"
	if h != nil && h.d != nil {
		cfg := h.d.Reg.Config()
		configDir := ""
		if h.d.ConfigPath != "" {
			configDir = filepath.Dir(h.d.ConfigPath)
		}
		docDir = config.ResolveDocDir(cfg.DocDir, configDir)
	}
	abs, err := filepath.Abs(docDir)
	if err != nil {
		return docDir
	}
	return abs
}

// resolveDocFile maps a docDir-relative fileId to a real path inside docDir.
// It rejects every escape vector (.., absolute, drive, UNC, NUL, symlink
// jump-out) and returns an error the caller maps to 400. A single leading
// "./" (the frontend's image URL convention) is normalized away.
func (h *Handler) resolveDocFile(fileID string) (string, error) {
	rel := strings.TrimPrefix(fileID, "./")
	rel, err := pathgrant.StrictRel(rel)
	if err != nil {
		return "", err
	}
	root := h.docDir()
	full := filepath.Join(root, filepath.FromSlash(rel))
	// Symlink containment: a link inside docDir pointing outside must not
	// grant access. The leaf or its parents may not exist yet (new save
	// target); the deepest existing ancestor must stay inside the root.
	if !realPathWithin(root, filepath.Dir(full)) {
		return "", errors.New("path escapes the document directory")
	}
	if _, lerr := os.Lstat(full); lerr == nil {
		if real, rerr := filepath.EvalSymlinks(full); rerr == nil {
			if !realPathWithin(root, real) {
				return "", errors.New("path escapes the document directory")
			}
		}
	}
	return full, nil
}

// realPathWithin reports whether the deepest existing ancestor of dir (or dir
// itself) resolves, after symlinks, to a path inside root.
func realPathWithin(root, dir string) bool {
	cur := dir
	for {
		if real, err := filepath.EvalSymlinks(cur); err == nil {
			return real == root || strings.HasPrefix(real, root+string(filepath.Separator))
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return false
		}
		cur = parent
	}
}

// editorTree returns the list of files in the configured docDir, addressed
// only by docDir-relative fileId (no absolute paths, no root leak).
func (h *Handler) editorTree(w http.ResponseWriter, r *http.Request) {
	docDir := h.docDir()
	_ = os.MkdirAll(docDir, 0o755)

	var files []DocFileItem
	_ = filepath.WalkDir(docDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || p == docDir {
			return nil
		}
		rel, relErr := filepath.Rel(docDir, p)
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
			RelPath: relPath,
			FileID:  relPath,
			IsDir:   d.IsDir(),
			Size:    size,
		})
		return nil
	})

	if files == nil {
		files = []DocFileItem{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"files": files})
}

// editorOpen reads a file by docDir fileId or by a server-issued
// pathGrantId; with neither, it shows the native picker, registers the picked
// path as a read+write grant, and returns the content plus the grant id.
// POST /api/editor/open { "fileId": "..." } | { "pathGrantId": "..." }
func (h *Handler) editorOpen(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path        string `json:"path"` // legacy raw-path contract: rejected
		FileID      string `json:"fileId"`
		PathGrantID string `json:"pathGrantId"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	if req.Path != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw paths are no longer accepted; use fileId or pathGrantId")
		return
	}

	path, grantID, err := h.openTarget(r, req.FileID, req.PathGrantID)
	if err != nil {
		if errors.Is(err, errCancelled) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"cancelled": true})
			return
		}
		if errors.Is(err, fsutil.ErrUnsupportedPlatform) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"unsupported": true})
			return
		}
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
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
	if fi.Size() > maxOpenSize {
		apibase.WriteAPIError(w, http.StatusBadRequest, "file too large (max 16 MiB)")
		return
	}

	content, err := os.ReadFile(path)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "read failed: "+err.Error())
		return
	}

	fileID := ""
	if rel, rerr := filepath.Rel(h.docDir(), path); rerr == nil && !strings.HasPrefix(rel, "..") {
		fileID = filepath.ToSlash(rel)
	}
	resp := map[string]any{
		"fileId":  fileID,
		"name":    filepath.Base(path),
		"size":    len(content),
		"content": string(content),
	}
	if grantID != "" {
		// A picker grant is authoritative even when the selected file happens
		// to be inside docDir. Returning only the grant prevents WebView/native
		// picker imports from accidentally switching to the docDir identity.
		resp["pathGrantId"] = grantID
		resp["fileId"] = ""
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (h *Handler) openTarget(r *http.Request, fileID, grantID string) (string, string, error) {
	ownerID := owner.From(r.Context())
	switch {
	case grantID != "":
		if ownerID == "" {
			return "", "", errors.New("request has no owner identity")
		}
		p, err := h.grants.Resolve(ownerID, grantID, pathgrant.OpRead)
		if err != nil {
			return "", "", errors.New("path grant denied or expired; re-select the file")
		}
		return p, grantID, nil
	case fileID != "":
		p, err := h.resolveDocFile(fileID)
		return p, "", err
	}

	filter := "Markdown & HTML & Text (*.md;*.html;*.htm;*.markdown;*.txt;*.json;*.yaml;*.yml;*.js;*.ts;*.go;*.css;*.xml)|*.md;*.html;*.htm;*.markdown;*.txt;*.json;*.yaml;*.yml;*.js;*.ts;*.go;*.css;*.xml|All Files (*.*)|*.*"
	path, err := fsutil.OpenFilePickerAt(filter, h.docDir())
	if err != nil {
		return "", "", err
	}
	if path == "" {
		return "", "", errCancelled
	}
	if ownerID == "" {
		return "", "", errors.New("request has no owner identity")
	}
	g, err := h.grants.Grant(ownerID, []pathgrant.Operation{pathgrant.OpRead, pathgrant.OpWrite}, path, false, false)
	if err != nil {
		return "", "", err
	}
	return g.Path, g.ID, nil
}

// editorSave writes text content to a docDir fileId or a write-granted path
// atomically. POST /api/editor/save { "fileId": "...", "content": "..." }
// or { "pathGrantId": "...", "content": "..." }
func (h *Handler) editorSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path        string `json:"path"` // legacy raw-path contract: rejected
		FileID      string `json:"fileId"`
		PathGrantID string `json:"pathGrantId"`
		Content     string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.Path != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw paths are no longer accepted; use fileId or pathGrantId")
		return
	}

	target, err := h.saveTarget(r, req.FileID, req.PathGrantID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	_ = os.MkdirAll(filepath.Dir(target), 0o755)
	if err := fsutil.AtomicWrite(target, []byte(req.Content), 0o644); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// saveTarget resolves the write target: a docDir fileId or a write grant.
func (h *Handler) saveTarget(r *http.Request, fileID, grantID string) (string, error) {
	if grantID != "" {
		ownerID := owner.From(r.Context())
		if ownerID == "" {
			return "", errors.New("request has no owner identity")
		}
		p, err := h.grants.Resolve(ownerID, grantID, pathgrant.OpWrite)
		if err != nil {
			return "", errors.New("path grant denied or expired; re-select the file")
		}
		return p, nil
	}
	if fileID != "" {
		return h.resolveDocFile(fileID)
	}
	return "", errors.New("fileId or pathGrantId is required")
}

// editorRename atomically renames a file while preserving the editor's
// path-capability identity. The browser sends only a docDir-relative fileId
// or an owner-bound pathGrantId plus a single new filename.
// POST /api/editor/rename { "fileId": "old.md", "newName": "new.md" }
func (h *Handler) editorRename(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path        string `json:"path"` // legacy raw-path contract: rejected
		FileID      string `json:"fileId"`
		PathGrantID string `json:"pathGrantId"`
		NewName     string `json:"newName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.Path != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw paths are no longer accepted; use fileId or pathGrantId")
		return
	}
	name, err := validateRenameName(req.NewName)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}

	target, err := h.renameTarget(r, req.FileID, req.PathGrantID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := os.Lstat(target)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		apibase.WriteAPIError(w, http.StatusBadRequest, "rename target must be a regular file")
		return
	}

	oldName := filepath.Base(target)
	newPath := filepath.Join(filepath.Dir(target), name)
	if oldName == name {
		writeRenameResponse(w, req.FileID, req.PathGrantID, name)
		return
	}
	if _, err := os.Lstat(newPath); err == nil {
		apibase.WriteAPIError(w, http.StatusConflict, "a file with that name already exists")
		return
	} else if !os.IsNotExist(err) {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "rename destination check failed: "+err.Error())
		return
	}
	if err := os.Rename(target, newPath); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "rename failed: "+err.Error())
		return
	}

	if req.PathGrantID != "" {
		ownerID := owner.From(r.Context())
		if err := h.grants.Rebind(ownerID, req.PathGrantID, newPath); err != nil {
			_ = os.Rename(newPath, target)
			apibase.WriteAPIError(w, http.StatusInternalServerError, "rename authorization update failed")
			return
		}
	}

	newFileID := req.FileID
	if req.FileID != "" {
		dir := filepath.Dir(filepath.ToSlash(req.FileID))
		if dir == "." {
			newFileID = name
		} else {
			newFileID = filepath.ToSlash(filepath.Join(filepath.FromSlash(dir), name))
		}
	}
	writeRenameResponse(w, newFileID, req.PathGrantID, name)
}

func validateRenameName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\\:*?"<>|`) {
		return "", errors.New("invalid filename")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", errors.New("invalid filename")
		}
	}
	if strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
		return "", errors.New("invalid filename")
	}
	return name, nil
}

func (h *Handler) renameTarget(r *http.Request, fileID, grantID string) (string, error) {
	if grantID != "" {
		ownerID := owner.From(r.Context())
		if ownerID == "" {
			return "", errors.New("request has no owner identity")
		}
		target, err := h.grants.Resolve(ownerID, grantID, pathgrant.OpWrite)
		if err != nil {
			return "", errors.New("path grant denied or expired; re-select the file")
		}
		return target, nil
	}
	if fileID != "" {
		return h.resolveDocFile(fileID)
	}
	return "", errors.New("fileId or pathGrantId is required")
}

func writeRenameResponse(w http.ResponseWriter, fileID, grantID, name string) {
	if grantID != "" {
		fileID = ""
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":          true,
		"name":        name,
		"fileId":      fileID,
		"pathGrantId": grantID,
	})
}

// editorUploadImage saves an uploaded image file into docDir/imgs/ and
// returns relative and API URLs for rendering in Markdown. The filename is
// server-generated; the extension must be on the image allowlist.
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

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !editorImageExts[ext] {
		apibase.WriteAPIError(w, http.StatusBadRequest, "unsupported image extension: "+ext)
		return
	}

	imgsDir := filepath.Join(h.docDir(), "imgs")
	_ = os.MkdirAll(imgsDir, 0o755)

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

// editorServeImage serves images saved under docDir. The `path` query
// parameter is a strict docDir-relative entry (never an absolute path): the
// legacy arbitrary-path contract is gone.
func (h *Handler) editorServeImage(w http.ResponseWriter, r *http.Request) {
	relPath := r.URL.Query().Get("path")
	if relPath == "" {
		http.Error(w, "missing path parameter", http.StatusBadRequest)
		return
	}
	full, err := h.resolveDocFile(relPath)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "unsafe path: "+err.Error())
		return
	}
	http.ServeFile(w, r, full)
}

// editorSaveSessionImages accepts multipart form with a docDir fileId (or a
// write pathGrantId), a safe imgsSubdir basename, and image files, saving
// them into the target file's parent directory + imgsSubdir. Filenames must
// be clean basenames (the saved text references them verbatim).
// POST /api/editor/save-session-images
func (h *Handler) editorSaveSessionImages(w http.ResponseWriter, r *http.Request) {
	err := r.ParseMultipartForm(32 << 20)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "failed to parse multipart form")
		return
	}

	targetPath := r.FormValue("targetPath") // legacy raw-path contract: rejected
	fileID := r.FormValue("fileId")
	pathGrantID := r.FormValue("pathGrantId")
	imgsSubdir := r.FormValue("imgsSubdir")
	if targetPath != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw paths are no longer accepted; use fileId or pathGrantId")
		return
	}
	if fileID == "" && pathGrantID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "fileId or pathGrantId required")
		return
	}
	sub, err := pathgrant.StrictRel(imgsSubdir)
	if err != nil || strings.Contains(sub, "/") {
		apibase.WriteAPIError(w, http.StatusBadRequest, "imgsSubdir must be a single safe directory name")
		return
	}

	var dir string
	if fileID != "" {
		target, err := h.resolveDocFile(fileID)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
			return
		}
		dir = filepath.Dir(target)
	} else {
		ownerID := owner.From(r.Context())
		if ownerID == "" {
			apibase.WriteAPIError(w, http.StatusForbidden, "request has no owner identity")
			return
		}
		p, err := h.grants.Resolve(ownerID, pathGrantID, pathgrant.OpWrite)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusBadRequest, "path grant denied or expired; re-select the file")
			return
		}
		dir = filepath.Dir(p)
	}
	targetImgDir := filepath.Join(dir, sub)
	_ = os.MkdirAll(targetImgDir, 0o755)

	files := r.MultipartForm.File
	for fieldName, fileHeaders := range files {
		if fieldName == "targetPath" || fieldName == "fileId" || fieldName == "pathGrantId" || fieldName == "imgsSubdir" {
			continue
		}
		for _, header := range fileHeaders {
			name := filepath.Base(filepath.ToSlash(header.Filename))
			if name == "." || name == ".." || name == "" || strings.ContainsAny(name, `/\`) {
				continue // reject traversal filenames outright
			}
			ext := strings.ToLower(filepath.Ext(name))
			if !editorImageExts[ext] {
				continue
			}
			f, err := header.Open()
			if err != nil {
				continue
			}
			dstPath := filepath.Join(targetImgDir, name)
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
		"imgsSubdir": sub,
	})
}

// editorDeleteFile deletes a docDir file (or delete-granted file) and its
// accompanying imgs directory if present.
// POST /api/editor/delete { "fileId": "..." } | { "pathGrantId": "..." }
func (h *Handler) editorDeleteFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path        string `json:"path"` // legacy raw-path contract: rejected
		FileID      string `json:"fileId"`
		PathGrantID string `json:"pathGrantId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.Path != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw paths are no longer accepted; use fileId or pathGrantId")
		return
	}

	target, err := h.deleteTarget(r, req.FileID, req.PathGrantID)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}

	_ = os.Remove(target)

	baseName := filepath.Base(target)
	ext := filepath.Ext(baseName)
	if len(baseName) > len(ext) {
		rawName := baseName[:len(baseName)-len(ext)]
		imgsDir := filepath.Join(filepath.Dir(target), rawName+"_imgs")
		_ = os.RemoveAll(imgsDir)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// deleteTarget resolves the delete target: a docDir fileId or a delete grant.
func (h *Handler) deleteTarget(r *http.Request, fileID, grantID string) (string, error) {
	if fileID != "" {
		return h.resolveDocFile(fileID)
	}
	if grantID != "" {
		ownerID := owner.From(r.Context())
		if ownerID == "" {
			return "", errors.New("request has no owner identity")
		}
		p, err := h.grants.Resolve(ownerID, grantID, pathgrant.OpDelete)
		if err != nil {
			return "", errors.New("path grant denied or expired; re-select the file")
		}
		return p, nil
	}
	return "", errors.New("fileId or pathGrantId is required")
}
