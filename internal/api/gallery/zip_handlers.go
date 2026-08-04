// Code in this file: gallery in-memory zip session handlers (Fix 1 split from register.go). Frontend: gallery-edit.js + gallery.js.
package gallery

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/fsutil"
	gallerylib "github.com/tinyrouter/tinyrouter/internal/gallery"
)

// maxZipDiskSize caps loading an on-disk zip archive into memory (1 GiB).
// Larger archives must be opened entry-by-entry instead of wholesale.
const maxZipDiskSize = 1 << 30

// readZipFile reads an on-disk zip archive with a size cap so a huge file
// cannot be slurped into memory unchecked.
func readZipFile(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > maxZipDiskSize {
		return nil, fmt.Errorf("zip too large: %d bytes (max %d)", info.Size(), maxZipDiskSize)
	}
	return os.ReadFile(path)
}

// galleryListZip receives a raw zip binary, caches it in an in-memory session,
// and returns the image manifest plus the session id the frontend uses to
// fetch individual entries.
func (h *Handler) galleryListZip(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 500<<20)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "failed to read zip body")
		return
	}
	if len(body) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "empty zip body")
		return
	}

	reader := bytes.NewReader(body)
	manifest, err := gallerylib.ListZipEntries(reader, int64(len(body)))
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid zip: "+err.Error())
		return
	}

	sessionID, err := newGallerySessionID()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.sessions.put(sessionID, body)

	h.d.Logger.Info("gallery: received zip, %d image entries (session %s)", manifest.Total, sessionID)

	resp := struct {
		SessionID string              `json:"sessionId"`
		Manifest  gallerylib.Manifest `json:"manifest"`
	}{
		SessionID: sessionID,
		Manifest:  manifest,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// galleryGetZipEntry streams a single image entry out of a cached zip session.
// The entry path (which may contain slashes) is matched via the `{entryPath:*}`
// chi wildcard.
func (h *Handler) galleryGetZipEntry(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	entryPath := chi.URLParam(r, "*")
	if unescaped, err := url.PathUnescape(entryPath); err == nil {
		entryPath = unescaped
	}

	data, ok := h.sessions.get(sessionID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "zip session not found")
		return
	}

	reader := bytes.NewReader(data)
	entry, contentType, err := gallerylib.GetZipEntry(reader, int64(len(data)), entryPath)
	if err != nil {
		if gallerylib.IsNotFound(err) {
			apibase.WriteAPIError(w, http.StatusNotFound, "entry not found")
			return
		}
		apibase.WriteAPIError(w, http.StatusBadRequest, "failed to read entry: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.Write(entry)
}

// galleryDeleteZipSession drops an entire in-memory zip session. The frontend
// fires this when a pack is cleared/removed so the backend reclaims the zip
// bytes immediately rather than waiting for LRU eviction. Idempotent: removing
// a missing session is not an error (the store may have evicted it already).
func (h *Handler) galleryDeleteZipSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	h.sessions.remove(sessionID)
	h.d.Logger.Info("gallery: dropped zip session %s", sessionID)
	w.WriteHeader(http.StatusNoContent)
}

// galleryTouchSession refreshes a session's LRU position without fetching an
// entry. The frontend calls this when a pack becomes the main view so the
// currently-viewed session is not the first candidate for LRU eviction while
// the user is looking at it. Returns 404 if the session has already been
// evicted; the frontend then rehydrates the entry via rehydrateZipSession.
func (h *Handler) galleryTouchSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if !h.sessions.touch(sessionID) {
		apibase.WriteAPIError(w, http.StatusNotFound, "zip session not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// galleryConvertTiff receives a raw TIFF binary and returns a JPEG re-encoding
// so Chromium/WebView2 can display it inline.
func (h *Handler) galleryConvertTiff(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 50<<20)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "failed to read tiff body")
		return
	}
	if len(data) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "empty tiff body")
		return
	}

	out, err := gallerylib.ConvertTIFFBlobToJPEG(data, 85)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "failed to convert tiff: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(out)
}

// galleryDeleteZipEntry removes a single entry from a cached zip session by
// performing a local binary rewrite (store-mode only). On success it updates
// the session in place and returns the rewritten zip bytes as
// application/octet-stream, so the frontend can write them back to disk via
// FileSystemFileHandle.createWritable().
func (h *Handler) galleryDeleteZipEntry(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	entryPath := chi.URLParam(r, "*")
	if unescaped, err := url.PathUnescape(entryPath); err == nil {
		entryPath = unescaped
	}

	data, ok := h.sessions.get(sessionID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "zip session not found")
		return
	}

	newData, _, err := gallerylib.DeleteZipEntry(data, entryPath)
	if err != nil {
		switch {
		case errors.Is(err, gallerylib.ErrEntryNotFound):
			apibase.WriteAPIError(w, http.StatusNotFound, "entry not found")
		case errors.Is(err, gallerylib.ErrUnsupportedMethod), errors.Is(err, gallerylib.ErrZip64):
			apibase.WriteAPIError(w, http.StatusConflict, "unsupported zip for deletion: "+err.Error())
		default:
			apibase.WriteAPIError(w, http.StatusInternalServerError, "delete entry failed: "+err.Error())
		}
		return
	}

	if !h.sessions.update(sessionID, newData) {
		apibase.WriteAPIError(w, http.StatusNotFound, "zip session expired during deletion")
		return
	}

	h.d.Logger.Info("gallery: deleted zip entry %q (session %s, %d -> %d bytes)",
		entryPath, sessionID, len(data), len(newData))

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(newData)
}

// galleryZipFromPath creates a zip session from a file already on disk (avoids
// re-uploading the zip over HTTP).
// POST /api/gallery/zip-from-path { "path": "..." } → { sessionId, manifest }
func (h *Handler) galleryZipFromPath(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Path == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing path")
		return
	}
	data, err := readZipFile(req.Path)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "cannot read zip: "+err.Error())
		return
	}

	reader := bytes.NewReader(data)
	manifest, err := gallerylib.ListZipEntries(reader, int64(len(data)))
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid zip: "+err.Error())
		return
	}

	sessionID, err := newGallerySessionID()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.sessions.put(sessionID, data)

	h.d.Logger.Info("gallery: zip-from-path %q, %d entries (session %s)", req.Path, manifest.Total, sessionID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"sessionId": sessionID,
		"manifest":  manifest,
	})
}

// galleryZipWriteback writes the current session zip bytes back to the
// original file on disk. Called after zip entry deletions to persist changes.
// POST /api/gallery/zip-writeback { "sessionId": "...", "path": "..." }
func (h *Handler) galleryZipWriteback(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID string `json:"sessionId"`
		Path      string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SessionID == "" || req.Path == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing sessionId or path")
		return
	}

	data, ok := h.sessions.get(req.SessionID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "zip session not found")
		return
	}

	if err := fsutil.AtomicWrite(req.Path, data, 0644); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "writeback failed: "+err.Error())
		return
	}
	h.d.Logger.Info("gallery: zip writeback %q (session %s, %d bytes)", req.Path, req.SessionID, len(data))
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
