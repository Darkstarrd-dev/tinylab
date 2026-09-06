package editor

import (
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/owner"
	"github.com/tinylab/tinylab/internal/pathgrant"
)

// editorServeFileImage handles GET /api/editor/file-image?fileId=...&rel=... or ?pathGrantId=...&rel=...
// It strictly checks canonical containment, allowlisted raster image extensions,
// and ensures no symlink escape or arbitrary non-image access.
func (h *Handler) editorServeFileImage(w http.ResponseWriter, r *http.Request) {
	fileID := r.URL.Query().Get("fileId")
	grantID := r.URL.Query().Get("pathGrantId")
	rel := r.URL.Query().Get("rel")

	if rel == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "rel query parameter is required")
		return
	}
	if fileID == "" && grantID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "fileId or pathGrantId query parameter is required")
		return
	}

	strictRel, err := pathgrant.StrictRel(rel)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid image rel: "+err.Error())
		return
	}

	ext := strings.ToLower(filepath.Ext(strictRel))
	if !editorImageExts[ext] {
		apibase.WriteAPIError(w, http.StatusBadRequest, "unsupported image extension: "+ext)
		return
	}

	var baseFolder string
	var allowedRoot string

	if grantID != "" {
		ownerID := owner.From(r.Context())
		if ownerID == "" {
			apibase.WriteAPIError(w, http.StatusBadRequest, "request has no owner identity")
			return
		}
		docPath, err := h.grants.Resolve(ownerID, grantID, pathgrant.OpRead)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusForbidden, "path grant expired or denied: "+err.Error())
			return
		}
		baseFolder = filepath.Dir(docPath)
		allowedRoot = baseFolder
	} else {
		docPath, err := h.resolveDocFile(fileID)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusBadRequest, "invalid fileId: "+err.Error())
			return
		}
		baseFolder = filepath.Dir(docPath)
		allowedRoot = h.docDir()
	}

	// Resolve target image file path
	targetPath := filepath.Join(baseFolder, filepath.FromSlash(strictRel))

	// Containment validation
	if !realPathWithin(allowedRoot, targetPath) {
		apibase.WriteAPIError(w, http.StatusForbidden, "image path escapes allowed directory")
		return
	}

	// Real symlink check
	realPath, err := filepath.EvalSymlinks(targetPath)
	if err != nil {
		if os.IsNotExist(err) {
			apibase.WriteAPIError(w, http.StatusNotFound, "image file not found")
			return
		}
		apibase.WriteAPIError(w, http.StatusInternalServerError, "eval symlinks failed: "+err.Error())
		return
	}

	if !realPathWithin(allowedRoot, realPath) {
		apibase.WriteAPIError(w, http.StatusForbidden, "image path escapes allowed directory via symlink")
		return
	}

	info, err := os.Lstat(realPath)
	if err != nil {
		if os.IsNotExist(err) {
			apibase.WriteAPIError(w, http.StatusNotFound, "image file not found")
			return
		}
		apibase.WriteAPIError(w, http.StatusInternalServerError, "stat image failed: "+err.Error())
		return
	}
	if !info.Mode().IsRegular() {
		apibase.WriteAPIError(w, http.StatusBadRequest, "target image is not a regular file")
		return
	}

	// Serve image
	ctype := mime.TypeByExtension(ext)
	if ctype == "" {
		switch ext {
		case ".webp":
			ctype = "image/webp"
		case ".png":
			ctype = "image/png"
		case ".jpg", ".jpeg":
			ctype = "image/jpeg"
		case ".gif":
			ctype = "image/gif"
		case ".bmp":
			ctype = "image/bmp"
		case ".tiff", ".tif":
			ctype = "image/tiff"
		default:
			ctype = "application/octet-stream"
		}
	}

	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, realPath)
}
