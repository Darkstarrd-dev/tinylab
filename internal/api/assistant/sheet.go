package assistant

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/owner"
)

// Spritesheet serving for assistant actions.
//
// The settings Action editor picks a local image through the native OS picker
// (/api/browse returns an absolute server-side path the browser cannot read),
// so the picked file is registered here and re-served under a short-TTL
// random-id URL for the grid/frame preview canvas. Saved actions are served
// deterministically via /sheet-image/{name}, which is what sprite-pet.html
// and any future consumer load at runtime.

const (
	sheetPreviewTTL   = time.Hour // covers a long editing session; stale ids just 404
	sheetPreviewMax   = 64        // LRU-capped so a looping client cannot grow the map
	sheetImageSizeCap = 64 << 20  // generous spritesheet ceiling
)

var sheetImageExts = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
}

// sheetPreviewEntry is one registered native-picker selection, bound to the
// browser session (owner) that registered it — a guessed id from another
// session resolves to nothing.
type sheetPreviewEntry struct {
	path        string
	owner       string
	expires     time.Time
	contentType string
}

type sheetPreviewStore struct {
	mu      sync.Mutex
	entries map[string]sheetPreviewEntry
}

var sheetPreviews = &sheetPreviewStore{entries: make(map[string]sheetPreviewEntry)}

func (s *sheetPreviewStore) put(entry sheetPreviewEntry) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for id, e := range s.entries {
		if now.After(e.expires) {
			delete(s.entries, id)
		}
	}
	for len(s.entries) >= sheetPreviewMax {
		var oldestID string
		var oldest time.Time
		for id, e := range s.entries {
			if oldestID == "" || e.expires.Before(oldest) {
				oldestID = id
				oldest = e.expires
			}
		}
		delete(s.entries, oldestID)
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		panic("assistant: crypto/rand failed: " + err.Error())
	}
	id := hex.EncodeToString(buf)
	entry.expires = now.Add(sheetPreviewTTL)
	s.entries[id] = entry
	return id
}

func (s *sheetPreviewStore) get(id, reqOwner string, now time.Time) (sheetPreviewEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[id]
	if !ok || now.After(e.expires) {
		return sheetPreviewEntry{}, false
	}
	if e.owner != "" && e.owner != reqOwner {
		return sheetPreviewEntry{}, false
	}
	return e, true
}

// sheetContentType maps an image extension to its MIME type, "" if unsupported.
func sheetContentType(path string) string {
	return sheetImageExts[strings.ToLower(filepath.Ext(path))]
}

// sheetPreviewRegister handles POST /api/assistant/sheet-preview
// {"path": "<absolute local image path>"} → {"previewId": "..."}.
// The path comes from /api/browse (native picker); only existing image files
// within the size cap are accepted.
func (h *Handler) sheetPreviewRegister(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&input); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	path := strings.TrimSpace(input.Path)
	if path == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "path is required")
		return
	}
	ct := sheetContentType(path)
	if ct == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "unsupported image type")
		return
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		apibase.WriteAPIError(w, http.StatusBadRequest, "file not found")
		return
	}
	if info.Size() > sheetImageSizeCap {
		apibase.WriteAPIError(w, http.StatusBadRequest, "file too large (max 64 MiB)")
		return
	}
	id := sheetPreviews.put(sheetPreviewEntry{
		path:        path,
		owner:       owner.From(r.Context()),
		contentType: ct,
	})
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"previewId": id})
}

// sheetPreviewServe handles GET /api/assistant/sheet-preview/{id}.
func (h *Handler) sheetPreviewServe(w http.ResponseWriter, r *http.Request) {
	e, ok := sheetPreviews.get(chi.URLParam(r, "id"), owner.From(r.Context()), time.Now())
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "preview not found or expired")
		return
	}
	serveSheetFile(w, r, e.path, e.contentType)
}

// sheetImageServe handles GET /api/assistant/sheet-image/{name}: serves the
// spritesheet configured on the named action, so runtime consumers (desktop
// pet page) never need filesystem access.
func (h *Handler) sheetImageServe(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	cfg := h.d.Reg.Config().Assistant
	var path string
	for _, a := range cfg.Actions {
		if a.Name == name && a.SpritesheetPath != "" {
			path = a.SpritesheetPath
			break
		}
	}
	if path == "" {
		apibase.WriteAPIError(w, http.StatusNotFound, "no spritesheet configured for action")
		return
	}
	ct := sheetContentType(path)
	if ct == "" {
		apibase.WriteAPIError(w, http.StatusUnsupportedMediaType, "unsupported image type")
		return
	}
	serveSheetFile(w, r, path, ct)
}

// serveSheetFile streams the image with no-store caching (config can change
// between requests) and a hard size guard against config edits pointing at
// huge files.
func serveSheetFile(w http.ResponseWriter, r *http.Request, path, contentType string) {
	f, err := os.Open(path)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "spritesheet file not readable")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() || info.Size() > sheetImageSizeCap {
		apibase.WriteAPIError(w, http.StatusBadRequest, "file too large (max 64 MiB)")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
}
