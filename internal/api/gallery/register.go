// Package gallery provides HTTP handlers for gallery-related operations.
package gallery

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/fsutil"
	gallerylib "github.com/tinyrouter/tinyrouter/internal/gallery"
	"golang.org/x/image/draw"

	// Register all image format decoders so image.Decode works for PNG/GIF/WebP/BMP.
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
	_ "image/gif"
	_ "image/png"
)

const (
	// galleryMaxSessions caps the number of in-memory zip sessions retained.
	// Sessions are evicted only by LRU once the store exceeds this capacity.
	// There is intentionally no time-based TTL: a common usage pattern is
	// loading several archives and autoplaying through one while the others
	// sit idle. A short idle TTL would evict the idle archives mid-session,
	// surfacing as 404s when the user switches back to them. Bounding by LRU
	// alone keeps idle archives alive as long as they remain within the most
	// recently used set, which matches the single-user local nature of the app.
	//
	// The capacity is set above the prior 32 to cover a typical bulk import
	// in one shot (the original 32 surfaced as "first N packs fail" because a
	// concurrent bulk upload evicted the earliest sessions before their
	// thumbnails were fetched). Eviction is no longer fatal regardless: the
	// frontend rehydrates an evicted session on 404 by re-uploading from the
	// pack's source (gallery-io.js rehydrateZipSession), and clears whole
	// sessions via DELETE /api/gallery/zip/{sessionId} when packs are removed.
	// 128 trades a higher worst-case resident memory ceiling for far less
	// re-upload churn; the per-session 500 MiB upload cap still bounds a
	// single session, and the single-user localhost deployment model keeps
	// the realistic working set well below this.
	galleryMaxSessions = 128
)

// zipSession holds an uploaded zip archive in memory along with bookkeeping
// for LRU eviction. pinCount prevents the session from being evicted while
// an AI review task is in progress.
type zipSession struct {
	data       []byte
	createdAt  time.Time
	lastAccess time.Time
	pinCount   int32
}

// gallerySessionStore is a thread-safe, bounded LRU store of in-memory zip
// sessions. Retention is bounded solely by galleryMaxSessions via LRU
// eviction; there is no time-based expiry.
type gallerySessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*zipSession
	order    []string // insertion/access order for LRU eviction
}

func newGallerySessionStore() *gallerySessionStore {
	return &gallerySessionStore{
		sessions: make(map[string]*zipSession),
	}
}

// put stores data under sessionID, evicting the least-recently-used session
// when the store is over capacity.
func (s *gallerySessionStore) put(sessionID string, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.sessions[sessionID]; ok {
		s.removeLocked(sessionID)
	}
	s.sessions[sessionID] = &zipSession{
		data:       data,
		createdAt:  time.Now(),
		lastAccess: time.Now(),
	}
	s.order = append(s.order, sessionID)

	for len(s.order) > galleryMaxSessions {
		evicted := false
		for i, id := range s.order {
			if sess, ok := s.sessions[id]; ok && sess.pinCount == 0 {
				s.removeLocked(s.order[i])
				evicted = true
				break
			}
		}
		if !evicted {
			break // all remaining sessions are pinned
		}
	}
}

// touch updates the last-access time of sessionID and moves it to the
// most-recently-used position without returning its data. Returns false if
// the session does not exist. The frontend calls POST /zip/{sessionId}/touch
// when a pack becomes the main view, so the currently-viewed session is not
// the first candidate for LRU eviction while the user is looking at it.
func (s *gallerySessionStore) touch(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return false
	}
	sess.lastAccess = time.Now()
	s.bumpLocked(sessionID)
	return true
}

// get returns the session data for sessionID and updates its last-access time.
func (s *gallerySessionStore) get(sessionID string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return nil, false
	}
	sess.lastAccess = time.Now()
	s.bumpLocked(sessionID)
	return sess.data, true
}

// update replaces the stored zip data for an existing session and refreshes
// its last-access time. Returns false if the session does not exist.
func (s *gallerySessionStore) update(sessionID string, data []byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return false
	}
	sess.data = data
	sess.lastAccess = time.Now()
	s.bumpLocked(sessionID)
	return true
}

// remove deletes a session by id.
func (s *gallerySessionStore) remove(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removeLocked(sessionID)
}

// removeLocked deletes a single session under lock (caller must hold mu).
func (s *gallerySessionStore) removeLocked(sessionID string) {
	delete(s.sessions, sessionID)
	for i, id := range s.order {
		if id == sessionID {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}

// pin increments the pin count for a session, preventing LRU eviction.
func (s *gallerySessionStore) pin(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return false
	}
	sess.pinCount++
	return true
}

// unpin decrements the pin count for a session.
func (s *gallerySessionStore) unpin(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[sessionID]
	if !ok {
		return false
	}
	if sess.pinCount > 0 {
		sess.pinCount--
	}
	return true
}

// bumpLocked moves sessionID to the most-recently-used position (caller holds mu).
func (s *gallerySessionStore) bumpLocked(sessionID string) {
	for i, id := range s.order {
		if id == sessionID {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
	s.order = append(s.order, sessionID)
}

// gallerySessions is the package-level store for zip preview sessions.
var gallerySessions = newGallerySessionStore()

// Gallery-supported file extensions (mirrors gallery-state.js).
var galleryImgExts = map[string]bool{
	".webp": true, ".png": true, ".jpg": true, ".jpeg": true,
	".bmp": true, ".tiff": true, ".tif": true, ".avif": true, ".gif": true,
}
var galleryVidExts = map[string]bool{
	".mp4": true, ".webm": true, ".ogv": true,
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

// reviewTask manages a single AI review task.
type reviewTask struct {
	SessionID    string
	Status       gallerylib.ReviewStatus
	Total        int
	Processed    int
	Failed       int
	Results      []gallerylib.ReviewResult
	SystemPrompt string
	UserPrompt   string
	MatchField   string
	mu           sync.Mutex
	cancel       context.CancelFunc
	done         chan struct{}
	err          error
}

// reviewTasks is the global review task map.
var reviewTasks sync.Map

// startReviewRequest is the request body for starting a review.
type startReviewRequest struct {
	SessionID    string `json:"sessionId"`
	Provider     string `json:"provider"`
	Model        string `json:"model"`
	SystemPrompt string `json:"systemPrompt"`
	UserPrompt   string `json:"userPrompt,omitempty"`
	MatchField   string `json:"matchField,omitempty"`
	Strategy     string `json:"strategy"`
	HeadSize     int    `json:"headSize"`
	TailSize     int    `json:"tailSize"`
	Concurrency  int    `json:"concurrency"`
}

// genPromptRequest is the request body for generating a prompt.
type genPromptRequest struct {
	Provider    string `json:"provider"`
	Model       string `json:"model"`
	JudgeTarget string `json:"judgeTarget"`
}

// newGallerySessionID returns a short random hex identifier for a zip session.
// Returns an error if the system's crypto/rand fails, so the caller can
// respond with 500 instead of silently using a colliding constant.
func newGallerySessionID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate session id: %w", err)
	}
	return hex.EncodeToString(b), nil
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

func mimeTypeForEntry(path string) string {
	ext := strings.ToLower(path)
	if i := strings.LastIndexByte(ext, '.'); i >= 0 {
		ext = ext[i+1:]
	}
	switch ext {
	case "png":
		return "image/png"
	case "jpg", "jpeg":
		return "image/jpeg"
	case "gif":
		return "image/gif"
	case "webp":
		return "image/webp"
	case "bmp":
		return "image/bmp"
	case "tif", "tiff":
		return "image/tiff"
	default:
		return "image/jpeg"
	}
}

func resizeImage(img image.Image, maxSize int) image.Image {
	bounds := img.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()
	if w <= maxSize && h <= maxSize {
		return img
	}

	var newW, newH int
	if w > h {
		newW = maxSize
		newH = h * maxSize / w
	} else {
		newH = maxSize
		newW = w * maxSize / h
	}

	dst := image.NewRGBA(image.Rect(0, 0, newW, newH))
	draw.BiLinear.Scale(dst, dst.Bounds(), img, img.Bounds(), draw.Over, nil)
	return dst
}

func selectReviewIndices(total int, strategy string, headSize, tailSize int) []int {
	switch gallerylib.ReviewStrategy(strategy) {
	case gallerylib.ReviewStrategyHeadTail:
		return selectHeadTailIndices(total, headSize, tailSize)
	default:
		indices := make([]int, total)
		for i := 0; i < total; i++ {
			indices[i] = i
		}
		return indices
	}
}

func selectHeadTailIndices(total, headSize, tailSize int) []int {
	seen := make(map[int]bool)
	var indices []int

	for i := 0; i < headSize && i < total; i++ {
		if !seen[i] {
			indices = append(indices, i)
			seen[i] = true
		}
	}

	for i := total - tailSize; i < total; i++ {
		if i >= 0 && !seen[i] {
			indices = append(indices, i)
			seen[i] = true
		}
	}

	return indices
}

// Handler wires up gallery routes.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new gallery Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register registers the gallery routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Post("/zip", h.galleryListZip)
	r.Get("/zip/{sessionId}/*", h.galleryGetZipEntry)
	r.Delete("/zip/{sessionId}", h.galleryDeleteZipSession)
	r.Delete("/zip/{sessionId}/*", h.galleryDeleteZipEntry)
	r.Post("/zip/{sessionId}/touch", h.galleryTouchSession)
	r.Post("/tiff", h.galleryConvertTiff)
	r.Post("/review/start", h.galleryStartReview)
	r.Get("/review/status/{sessionId}", h.galleryReviewStatus)
	r.Post("/review/cancel/{sessionId}", h.galleryCancelReview)
	r.Post("/review/gen-prompt", h.galleryGeneratePrompt)
	r.Post("/open-dir", h.galleryOpenDir)
	r.Post("/list-dir", h.galleryListDir)
	r.Get("/file", h.galleryServeFile)
	r.Delete("/fs", h.galleryDeleteFs)
	r.Post("/zip-from-path", h.galleryZipFromPath)
	r.Post("/zip-writeback", h.galleryZipWriteback)
	r.Post("/paste-paths", h.galleryPastePaths)
}

// --- Handler methods ---

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
	gallerySessions.put(sessionID, body)

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

	data, ok := gallerySessions.get(sessionID)
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
	gallerySessions.remove(sessionID)
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
	if !gallerySessions.touch(sessionID) {
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

	data, ok := gallerySessions.get(sessionID)
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

	if !gallerySessions.update(sessionID, newData) {
		apibase.WriteAPIError(w, http.StatusNotFound, "zip session expired during deletion")
		return
	}

	h.d.Logger.Info("gallery: deleted zip entry %q (session %s, %d -> %d bytes)",
		entryPath, sessionID, len(data), len(newData))

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(newData)
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

	data, err := os.ReadFile(req.Path)
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
	gallerySessions.put(sessionID, data)

	h.d.Logger.Info("gallery: zip-from-path %q, %d entries (session %s)", req.Path, manifest.Total, sessionID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"sessionId": sessionID,
		"manifest":  manifest,
	})
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

	data, ok := gallerySessions.get(req.SessionID)
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

// galleryStartReview launches an AI review task.
//
// POST /api/gallery/review/start
// Content-Type: application/json
//
//	{
//	    "sessionId": "abc123",
//	    "provider": "openai",
//	    "model": "gpt-4o",
//	    "systemPrompt": "...",
//	    "userPrompt": "...",
//	    "matchField": "match",
//	    "strategy": "all",
//	    "headSize": 5,
//	    "tailSize": 5,
//	    "concurrency": 3
//	}
func (h *Handler) galleryStartReview(w http.ResponseWriter, r *http.Request) {
	var req startReviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	if req.SessionID == "" || req.Provider == "" || req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "sessionId, provider, and model are required")
		return
	}
	if req.Strategy == "" {
		req.Strategy = string(gallerylib.ReviewStrategyAll)
	}
	if req.Concurrency <= 0 {
		req.Concurrency = 3
	}
	if req.HeadSize <= 0 {
		req.HeadSize = 5
	}
	if req.TailSize <= 0 {
		req.TailSize = 5
	}
	if req.UserPrompt == "" {
		req.UserPrompt = gallerylib.DefaultUserPrompt
	}

	// Check if a review is already in progress
	if _, loaded := reviewTasks.Load(req.SessionID); loaded {
		apibase.WriteAPIError(w, http.StatusConflict, "review already in progress for this session")
		return
	}

	// Get ZIP session data and pin to prevent eviction
	zipData, ok := gallerySessions.get(req.SessionID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "zip session not found")
		return
	}
	gallerySessions.pin(req.SessionID)

	// Parse manifest to get entry list
	reader := bytes.NewReader(zipData)
	manifest, err := gallerylib.ListZipEntries(reader, int64(len(zipData)))
	if err != nil {
		gallerySessions.unpin(req.SessionID)
		apibase.WriteAPIError(w, http.StatusBadRequest, "failed to list zip entries: "+err.Error())
		return
	}

	if manifest.Total == 0 {
		gallerySessions.unpin(req.SessionID)
		apibase.WriteAPIError(w, http.StatusBadRequest, "no image entries found in zip")
		return
	}

	// Select entries to review based on strategy
	indices := selectReviewIndices(manifest.Total, req.Strategy, req.HeadSize, req.TailSize)
	if len(indices) == 0 {
		gallerySessions.unpin(req.SessionID)
		apibase.WriteAPIError(w, http.StatusBadRequest, "no entries selected for review")
		return
	}

	// Create review task
	ctx, cancel := context.WithCancel(context.Background())
	task := &reviewTask{
		SessionID:    req.SessionID,
		Status:       gallerylib.ReviewStatusRunning,
		Total:        len(indices),
		Results:      make([]gallerylib.ReviewResult, 0),
		SystemPrompt: req.SystemPrompt,
		UserPrompt:   req.UserPrompt,
		MatchField:   req.MatchField,
		cancel:       cancel,
		done:         make(chan struct{}),
	}

	reviewTasks.Store(req.SessionID, task)

	// Start review goroutine
	go h.runReview(ctx, task, zipData, manifest.Entries, indices, req.Provider, req.Model, req.Concurrency)

	h.d.Logger.Info("gallery: started AI review for session %s, %d entries, strategy=%s, provider=%s, model=%s",
		req.SessionID, len(indices), req.Strategy, req.Provider, req.Model)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"total":   len(indices),
	})
}

// galleryReviewStatus returns the status of a review task.
//
// GET /api/gallery/review/status/{sessionId}
func (h *Handler) galleryReviewStatus(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	val, ok := reviewTasks.Load(sessionID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "review task not found")
		return
	}

	task := val.(*reviewTask)
	task.mu.Lock()
	status := task.Status
	total := task.Total
	processed := task.Processed
	failed := task.Failed
	results := make([]gallerylib.ReviewResult, len(task.Results))
	copy(results, task.Results)
	task.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"status":    status,
		"total":     total,
		"processed": processed,
		"failed":    failed,
		"results":   results,
	})
}

// galleryCancelReview cancels a review task.
//
// POST /api/gallery/review/cancel/{sessionId}
func (h *Handler) galleryCancelReview(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	val, ok := reviewTasks.Load(sessionID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "review task not found")
		return
	}

	task := val.(*reviewTask)
	task.cancel()

	// Wait for the task to finish
	<-task.done

	// Delete is idempotent
	reviewTasks.Delete(sessionID)

	h.d.Logger.Info("gallery: cancelled AI review for session %s", sessionID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"success": true,
	})
}

// runReview is the review engine core, using a worker pool for concurrent processing.
// indices are 0-based positions in the sorted manifest.Entries slice.
func (h *Handler) runReview(ctx context.Context, task *reviewTask, zipData []byte, entries []gallerylib.Entry, indices []int, provider, model string, concurrency int) {
	defer func() {
		task.mu.Lock()
		if task.Status == gallerylib.ReviewStatusRunning {
			task.Status = gallerylib.ReviewStatusCompleted
		}
		task.mu.Unlock()
		reviewTasks.Delete(task.SessionID)
		gallerySessions.unpin(task.SessionID)
		close(task.done)
	}()

	workCh := make(chan int, len(indices))
	for _, idx := range indices {
		workCh <- idx
	}
	close(workCh)

	var wg sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for entryIdx := range workCh {
				select {
				case <-ctx.Done():
					task.mu.Lock()
					task.Status = gallerylib.ReviewStatusCancelled
					task.mu.Unlock()
					return
				default:
				}

				if entryIdx < 0 || entryIdx >= len(entries) {
					task.mu.Lock()
					task.Processed++
					task.Failed++
					task.mu.Unlock()
					continue
				}

				entry := entries[entryIdx]
				result, err := h.analyzeImage(ctx, zipData, entry, provider, model, task.SystemPrompt, task.UserPrompt, task.MatchField)
				task.mu.Lock()
				task.Processed++
				if err != nil {
					task.Failed++
					h.d.Logger.Warn("gallery: review error for %s (session %s): %v", entry.Path, task.SessionID, err)
				} else if result != nil && result.IsMatch {
					task.Results = append(task.Results, *result)
				}
				task.mu.Unlock()
			}
		}()
	}
	wg.Wait()
}

// analyzeImage analyzes a single image using a vision model.
func (h *Handler) analyzeImage(ctx context.Context, zipData []byte, entry gallerylib.Entry, provider, model string, systemPrompt, userPrompt, matchField string) (*gallerylib.ReviewResult, error) {
	// 1. Read image data from ZIP
	reader := bytes.NewReader(zipData)
	imgData, _, err := gallerylib.GetZipEntry(reader, int64(len(zipData)), entry.Path)
	if err != nil {
		return nil, fmt.Errorf("read entry %s: %w", entry.Path, err)
	}

	// 2. Decode and resize to max 1024px
	img, _, err := image.Decode(bytes.NewReader(imgData))
	if err != nil {
		// Decode failed: send raw bytes with correct MIME type
		mimeType := mimeTypeForEntry(entry.Path)
		return h.sendVisionRequest(ctx, imgData, mimeType, provider, model, entry, systemPrompt, userPrompt, matchField)
	}

	// 3. Resize
	resized := resizeImage(img, 1024)

	// 4. Encode as JPEG
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, resized, &jpeg.Options{Quality: 80}); err != nil {
		return nil, fmt.Errorf("jpeg encode: %w", err)
	}

	// 5. Send request
	return h.sendVisionRequest(ctx, buf.Bytes(), "image/jpeg", provider, model, entry, systemPrompt, userPrompt, matchField)
}

// sendVisionRequest sends a vision request to the LLM proxy.
func (h *Handler) sendVisionRequest(ctx context.Context, imgData []byte, mimeType, provider, model string, entry gallerylib.Entry, systemPrompt, userPrompt, matchField string) (*gallerylib.ReviewResult, error) {
	b64Data := base64.StdEncoding.EncodeToString(imgData)
	dataURL := "data:" + mimeType + ";base64," + b64Data

	body := map[string]any{
		"model": provider + "/" + model,
		"messages": []any{
			map[string]any{
				"role":    "system",
				"content": systemPrompt,
			},
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{
						"type": "text",
						"text": userPrompt,
					},
					map[string]any{
						"type": "image_url",
						"image_url": map[string]any{
							"url": dataURL,
						},
					},
				},
			},
		},
		"max_tokens":  120,
		"temperature": 0,
		"stream":      false,
	}

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	// Call the proxy handler via httptest
	req := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(bodyBytes))
	req = req.WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.d.ProxyHandler.ChatCompletions(rec, req)

	resp := rec.Result()
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read proxy response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("proxy returned status %d: %s", resp.StatusCode, string(respBody))
	}

	// Parse response
	result, err := gallerylib.ParseReviewResponse(respBody, matchField)
	if err != nil {
		return nil, err
	}

	return &gallerylib.ReviewResult{
		Index:   entry.Index,
		Path:    entry.Path,
		IsMatch: result.Match,
		Reason:  result.Reason,
	}, nil
}

// galleryGeneratePrompt generates a review prompt.
//
// POST /api/gallery/review/gen-prompt
// Body: {provider, model, judgeTarget}
// Response: {systemPrompt}
func (h *Handler) galleryGeneratePrompt(w http.ResponseWriter, r *http.Request) {
	var req genPromptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	if req.Provider == "" || req.Model == "" || req.JudgeTarget == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "provider, model, and judgeTarget are required")
		return
	}

	body := map[string]any{
		"model": req.Provider + "/" + req.Model,
		"messages": []any{
			map[string]any{
				"role":    "system",
				"content": gallerylib.PromptGenSystemPrompt,
			},
			map[string]any{
				"role":    "user",
				"content": fmt.Sprintf(gallerylib.PromptGenUserPromptTemplate, req.JudgeTarget),
			},
		},
		"max_tokens":  800,
		"temperature": 0.3,
		"stream":      false,
	}

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to marshal request: "+err.Error())
		return
	}

	proxyReq := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(bodyBytes))
	proxyReq.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.d.ProxyHandler.ChatCompletions(rec, proxyReq)

	resp := rec.Result()
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to read proxy response: "+err.Error())
		return
	}

	if resp.StatusCode != http.StatusOK {
		apibase.WriteAPIError(w, http.StatusBadGateway, fmt.Sprintf("proxy returned status %d: %s", resp.StatusCode, string(respBody)))
		return
	}

	var chatResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &chatResp); err != nil || len(chatResp.Choices) == 0 {
		apibase.WriteAPIError(w, http.StatusBadGateway, "failed to parse proxy response")
		return
	}

	systemPrompt := chatResp.Choices[0].Message.Content

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"systemPrompt": systemPrompt,
	})
}
