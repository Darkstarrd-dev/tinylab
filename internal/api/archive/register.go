// Package archive implements the /api/archive HTTP surface for the shared
// archive capability (archive_compatibility_plan.md §7.2): capability status,
// source registration (uploaded ZIP/7z/RAR), single-entry reads, asset
// registration/release and pack (ZIP via stdlib, 7z/RAR via external tools).
//
// The handler is a thin translation layer: sources and assets live in the
// archivetool.Runner's TempStore (server-side paths never leave the process),
// and every entry path is re-validated by the foundation's StrictArchivePath
// before it reaches a tool.
package archive

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/archive"
	"github.com/tinyrouter/tinyrouter/internal/archivetool"
)

// Body caps (archive_compatibility_plan.md §4.3).
const (
	sourceUploadCap = 500 << 20 // browser-uploaded archive input
	assetUploadCap  = 200 << 20 // pack inputs / GIF frame assets
)

// sourceEntry is one registered archive source: the server-side temp asset
// plus its validated manifest.
type sourceEntry struct {
	src       archive.Source
	refID     string // TempStore asset id (release target)
	manifest  archive.Manifest
	createdAt time.Time
}

// Handler exposes the archive API endpoints.
type Handler struct {
	d      *apibase.Deps
	runner apibase.ArchiveRunner

	mu      sync.Mutex
	sources map[string]*sourceEntry
	// replacing tracks sources with an in-flight zip-replace so a second
	// concurrent writeback to the same source is rejected (plan §8.3:
	// "冲突时拒绝第二个并发写回").
	replacing map[string]bool
}

// NewHandler creates the archive handler. runner may be nil when the archive
// temp store could not be created at startup; every endpoint then reports a
// diagnostic 503 instead of panicking.
func NewHandler(d *apibase.Deps, runner apibase.ArchiveRunner) *Handler {
	return &Handler{d: d, runner: runner, sources: make(map[string]*sourceEntry), replacing: make(map[string]bool)}
}

// Register registers the archive routes. They are mounted outside the generic
// 1 MiB /api body group (uploads are up to 500 MiB) but behind the same auth
// middleware; per-route body caps are applied inside the handlers.
func (h *Handler) Register(r chi.Router) {
	r.Get("/status", h.status)
	r.Post("/sources", h.createSource)
	r.Get("/sources/{id}/entries/*", h.getSourceEntry)
	r.Delete("/sources/{id}", h.deleteSource)
	r.Post("/assets", h.createAsset)
	r.Get("/assets/{id}", h.getAsset)
	r.Post("/pack", h.pack)
	r.Post("/zip-replace", h.zipReplace)
	r.Post("/release/{id}", h.release)
}

// --- Gallery bridge -----------------------------------------------------
// The gallery handler consumes the /api/archive surface through
// gallery.archiveBridge (SetArchive). These methods expose the registered
// source lookup + list/read operations without handing the browser paths.

// ResolveSource returns the registered source for a sourceId, or false when
// the source is unknown or expired (TTL). It mirrors the lookup used by
// getSourceEntry so the gallery bridge sees the same lifecycle.
func (h *Handler) ResolveSource(id string) (archive.Source, bool) {
	if h.runner == nil {
		return archive.Source{}, false
	}
	h.mu.Lock()
	se := h.sources[id]
	if se != nil && time.Since(se.createdAt) > h.runner.Store().TTL() {
		delete(h.sources, id)
		se = nil
	}
	h.mu.Unlock()
	if se == nil {
		return archive.Source{}, false
	}
	return se.src, true
}

// List returns the strict-validated manifest of a registered source.
func (h *Handler) List(ctx context.Context, src archive.Source, b archive.Budget) (archive.Manifest, error) {
	if h.runner == nil {
		return archive.Manifest{}, archivetool.ErrNoRunner
	}
	return h.runner.List(ctx, src, b)
}

// ReadEntry returns the bytes + content-type of one source entry, addressed
// by decimal index or strict relative archive path.
func (h *Handler) ReadEntry(ctx context.Context, src archive.Source, identifier string, b archive.Budget) ([]byte, string, error) {
	if h.runner == nil {
		return nil, "", archivetool.ErrNoRunner
	}
	return h.runner.ReadEntry(ctx, src, identifier, b)
}

func (h *Handler) status(w http.ResponseWriter, r *http.Request) {
	if h.runner == nil {
		h.writeError(w, http.StatusServiceUnavailable, "archive.unavailable", "archive runner is not available")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(h.runner.Status(ctx))
}

func (h *Handler) createSource(w http.ResponseWriter, r *http.Request) {
	if h.runner == nil {
		h.writeError(w, http.StatusServiceUnavailable, "archive.unavailable", "archive runner is not available")
		return
	}
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		h.writeError(w, http.StatusBadRequest, "archive.bad-request", "missing name query parameter")
		return
	}
	format, err := detectFormat(name)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, "archive.unsupported-format", err.Error())
		return
	}
	body := http.MaxBytesReader(w, r.Body, sourceUploadCap)
	// Magic-byte sniff: reject mislabeled uploads before they reach a tool
	// (a .zip that is actually a 7z archive, garbage renamed, etc.).
	prefix, err := peekMagic(body)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	if got := sniffFormat(prefix); got != "" && got != format {
		h.writeError(w, http.StatusBadRequest, "archive.unsupported-format",
			fmt.Sprintf("file content looks like %s, not %s", got, format))
		return
	}
	// Random unguessable sourceId (plan §7.1: server issues random tokens);
	// sequential ids would let a client enumerate other sessions' sources.
	id, err := newSourceID()
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	ctx := r.Context()
	ref, err := h.runner.Store().Create(ctx, "src", id, name, mimeForName(name), io.MultiReader(bytes.NewReader(prefix), body), sourceUploadCap)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}

	src := archive.Source{
		ID:       id,
		Format:   format,
		Name:     name,
		Path:     ref.Path,
		Size:     ref.Size,
		Writable: format == archive.FormatZIP, // 7z/RAR are read-only in P2/P3
	}
	manifest, err := h.runner.List(ctx, src, archive.DefaultBudget())
	if err != nil {
		_ = h.runner.Store().Release(ref.ID)
		h.writeRunError(w, err)
		return
	}

	h.mu.Lock()
	h.sources[id] = &sourceEntry{src: src, refID: ref.ID, manifest: manifest, createdAt: time.Now()}
	h.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"sourceId": id,
		"format":   format,
		"name":     name,
		"size":     ref.Size,
		"writable": src.Writable,
		"manifest": manifest,
	})
}

func (h *Handler) getSourceEntry(w http.ResponseWriter, r *http.Request) {
	if h.runner == nil {
		h.writeError(w, http.StatusServiceUnavailable, "archive.unavailable", "archive runner is not available")
		return
	}
	id := chi.URLParam(r, "id")
	entryPath := chi.URLParam(r, "*")
	h.mu.Lock()
	se := h.sources[id]
	if se != nil && time.Since(se.createdAt) > h.runner.Store().TTL() {
		delete(h.sources, id)
		se = nil
	}
	h.mu.Unlock()
	if se == nil {
		h.writeError(w, http.StatusNotFound, "archive.not-found", "source not found or expired")
		return
	}

	data, ctype, err := h.runner.ReadEntry(r.Context(), se.src, entryPath, archive.DefaultBudget())
	if err != nil {
		h.writeRunError(w, err)
		return
	}
	if ctype == "" {
		ctype = mimeForName(entryPath)
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(data)))
	w.Write(data)
}

func (h *Handler) deleteSource(w http.ResponseWriter, r *http.Request) {
	if h.runner == nil {
		h.writeError(w, http.StatusServiceUnavailable, "archive.unavailable", "archive runner is not available")
		return
	}
	id := chi.URLParam(r, "id")
	h.mu.Lock()
	se := h.sources[id]
	delete(h.sources, id)
	h.mu.Unlock()
	if se == nil {
		w.WriteHeader(http.StatusNoContent) // idempotent release
		return
	}
	_ = h.runner.Store().Release(se.refID)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) getAsset(w http.ResponseWriter, r *http.Request) {
	if h.runner == nil {
		h.writeError(w, http.StatusServiceUnavailable, "archive.unavailable", "archive runner is not available")
		return
	}
	id := chi.URLParam(r, "id")
	rc, ref, err := h.runner.Store().Open(id)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	defer rc.Close()
	ctype := ref.MIME
	if ctype == "" {
		ctype = mimeForName(ref.Name)
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", ref.Size))
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", ref.Name))
	io.Copy(w, rc)
}

func (h *Handler) createAsset(w http.ResponseWriter, r *http.Request) {
	if h.runner == nil {
		h.writeError(w, http.StatusServiceUnavailable, "archive.unavailable", "archive runner is not available")
		return
	}
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		h.writeError(w, http.StatusBadRequest, "archive.bad-request", "missing name query parameter")
		return
	}
	body := http.MaxBytesReader(w, r.Body, assetUploadCap)
	ref, err := h.runner.Store().Create(r.Context(), "asset", "upload", name, mimeForName(name), body, assetUploadCap)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"assetId": ref.ID,
		"name":    ref.Name,
		"mime":    ref.MIME,
		"size":    ref.Size,
		"kind":    kindForName(ref.Name),
	})
}

type packRequest struct {
	AssetIDs []string `json:"assetIds"`
	Format   string   `json:"format"`
	Name     string   `json:"name"`
}

func (h *Handler) pack(w http.ResponseWriter, r *http.Request) {
	if h.runner == nil {
		h.writeError(w, http.StatusServiceUnavailable, "archive.unavailable", "archive runner is not available")
		return
	}
	var req packRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "archive.bad-request", "invalid JSON")
		return
	}
	format := archive.Format(req.Format)
	if !format.Valid() {
		h.writeError(w, http.StatusBadRequest, "archive.unsupported-format", fmt.Sprintf("unknown archive format %q", req.Format))
		return
	}
	if len(req.AssetIDs) == 0 {
		h.writeError(w, http.StatusBadRequest, "archive.bad-request", "assetIds must not be empty")
		return
	}
	assets := make([]archive.AssetRef, 0, len(req.AssetIDs))
	for _, id := range req.AssetIDs {
		ref, err := h.runner.Store().Stat(id)
		if err != nil {
			h.writeStoreError(w, fmt.Errorf("asset %s: %w", id, err))
			return
		}
		assets = append(assets, *ref)
	}
	ref, err := h.runner.Pack(r.Context(), format, assets, req.Name, archive.DefaultBudget())
	if err != nil {
		h.writeRunError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"assetId": ref.ID})
}

type zipReplaceRequest struct {
	SourceID     string `json:"sourceId"`
	Replacements []struct {
		EntryPath string `json:"entryPath"`
		AssetID   string `json:"assetId"`
	} `json:"replacements"`
	// Deletes lists strict entry paths dropped from the source in the same
	// atomic rewrite (Gallery delete semantics).
	Deletes []string `json:"deletes,omitempty"`
}

// zipReplace implements POST /api/archive/zip-replace: atomically rewrites a
// REGISTERED ZIP source (never an arbitrary path — the source is looked up in
// the server-side registry by sourceId) by swapping its entry contents for
// registered assets, then re-points the source at the output archive. 7z/RAR
// sources are read-only and rejected with archive.read-only.
func (h *Handler) zipReplace(w http.ResponseWriter, r *http.Request) {
	if h.runner == nil {
		h.writeError(w, http.StatusServiceUnavailable, "archive.unavailable", "archive runner is not available")
		return
	}
	var req zipReplaceRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "archive.bad-request", "invalid JSON")
		return
	}
	if req.SourceID == "" || (len(req.Replacements) == 0 && len(req.Deletes) == 0) {
		h.writeError(w, http.StatusBadRequest, "archive.bad-request", "sourceId with replacements or deletes is required")
		return
	}

	h.mu.Lock()
	se := h.sources[req.SourceID]
	if se != nil && time.Since(se.createdAt) > h.runner.Store().TTL() {
		delete(h.sources, req.SourceID)
		se = nil
	}
	h.mu.Unlock()
	if se == nil {
		h.writeError(w, http.StatusNotFound, "archive.not-found", "source not found or expired")
		return
	}
	if se.src.Format != archive.FormatZIP || !se.src.Writable {
		h.writeError(w, http.StatusForbidden, "archive.read-only", "only registered zip sources can be rewritten")
		return
	}

	// Reject a second concurrent writeback to the same source (plan §8.3:
	// "冲突时拒绝第二个并发写回"). The flag is cleared on every exit path.
	h.mu.Lock()
	if h.replacing[req.SourceID] {
		h.mu.Unlock()
		h.writeError(w, http.StatusConflict, "archive.busy", "another zip-replace is already rewriting this source")
		return
	}
	h.replacing[req.SourceID] = true
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.replacing, req.SourceID)
		h.mu.Unlock()
	}()

	replacements := make(map[string]archive.AssetRef, len(req.Replacements))
	for _, rep := range req.Replacements {
		clean, err := archive.StrictArchivePath(rep.EntryPath)
		if err != nil {
			h.writeError(w, http.StatusBadRequest, "archive.unsafe-path", err.Error())
			return
		}
		if _, dup := replacements[clean]; dup {
			h.writeError(w, http.StatusBadRequest, "archive.unsafe-path", "duplicate replacement entry: "+clean)
			return
		}
		ref, err := h.runner.Store().Stat(rep.AssetID)
		if err != nil {
			h.writeStoreError(w, fmt.Errorf("asset %s: %w", rep.AssetID, err))
			return
		}
		replacements[clean] = *ref
	}
	deletes := make([]string, 0, len(req.Deletes))
	seen := make(map[string]bool, len(req.Deletes))
	for _, d := range req.Deletes {
		clean, err := archive.StrictArchivePath(d)
		if err != nil {
			h.writeError(w, http.StatusBadRequest, "archive.unsafe-path", err.Error())
			return
		}
		if !seen[clean] {
			seen[clean] = true
			deletes = append(deletes, clean)
		}
	}

	var newRef archive.AssetRef
	var rerr error
	if len(deletes) > 0 {
		newRef, rerr = h.runner.ReplaceZIPDeleting(r.Context(), se.src, replacements, deletes, archive.DefaultBudget())
	} else {
		newRef, rerr = h.runner.ReplaceZIP(r.Context(), se.src, replacements, archive.DefaultBudget())
	}
	if rerr != nil {
		h.writeRunError(w, rerr)
		return
	}
	// Re-list the output archive for the refreshed manifest, then atomically
	// re-point the registered source at it (last-writer-wins under the lock;
	// each output is its own registered asset, so a concurrent replace can
	// never corrupt a source file).
	newSrc := se.src
	newSrc.Path = newRef.Path
	newSrc.Size = newRef.Size
	newManifest, err := h.runner.List(r.Context(), newSrc, archive.DefaultBudget())
	if err != nil {
		// The output archive is still registered; keep the stale manifest.
		newManifest = se.manifest
	}
	h.mu.Lock()
	if cur := h.sources[req.SourceID]; cur != nil {
		oldRef := cur.refID
		cur.src = newSrc
		cur.refID = newRef.ID
		cur.manifest = newManifest
		h.mu.Unlock()
		_ = h.runner.Store().Release(oldRef) // idempotent; old file removed
	} else {
		h.mu.Unlock()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"assetId": newRef.ID})
}

func (h *Handler) release(w http.ResponseWriter, r *http.Request) {
	if h.runner == nil {
		h.writeError(w, http.StatusServiceUnavailable, "archive.unavailable", "archive runner is not available")
		return
	}
	id := chi.URLParam(r, "id")
	// Owner binding: source-owned assets are released through
	// DELETE /api/archive/sources/{id} so a registered source is never
	// orphaned by a stray release call.
	h.mu.Lock()
	for _, se := range h.sources {
		if se.refID == id {
			h.mu.Unlock()
			h.writeError(w, http.StatusConflict, "archive.source-owned", "release the source via DELETE /api/archive/sources/{id}")
			return
		}
	}
	h.mu.Unlock()
	if err := h.runner.Store().Release(id); err != nil {
		h.writeStoreError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// writeError writes the JSON error envelope with a stable machine code the
// frontend can key i18n off.
func (h *Handler) writeError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg, "code": code})
}

// writeStoreError maps TempStore failures.
func (h *Handler) writeStoreError(w http.ResponseWriter, err error) {
	if archive.IsNotFound(err) {
		h.writeError(w, http.StatusNotFound, "archive.not-found", err.Error())
		return
	}
	if archive.IsBudgetExceeded(err) {
		h.writeError(w, http.StatusUnprocessableEntity, "archive.budget", err.Error())
		return
	}
	if errors.Is(err, archive.ErrClosed) {
		h.writeError(w, http.StatusServiceUnavailable, "archive.unavailable", err.Error())
		return
	}
	h.writeError(w, http.StatusInternalServerError, "archive.internal", err.Error())
}

// writeRunError maps archive/tool operation failures to HTTP status + code.
// Every branch writes exactly one response; the ToolError block only handles
// errors the sentinel switch above did not claim.
func (h *Handler) writeRunError(w http.ResponseWriter, err error) {
	switch {
	case archive.IsNotFound(err):
		h.writeError(w, http.StatusNotFound, "archive.not-found", err.Error())
		return
	case archive.IsUnsafePath(err), archive.IsPathCollision(err):
		h.writeError(w, http.StatusBadRequest, "archive.unsafe-path", err.Error())
		return
	case archive.IsBudgetExceeded(err):
		h.writeError(w, http.StatusUnprocessableEntity, "archive.budget", err.Error())
		return
	case errors.Is(err, archive.ErrUnsupportedFormat):
		h.writeError(w, http.StatusBadRequest, "archive.unsupported-format", err.Error())
		return
	case errors.Is(err, archive.ErrUnsupportedWriteback):
		h.writeError(w, http.StatusForbidden, "archive.read-only", err.Error())
		return
	case errors.Is(err, zip.ErrFormat), errors.Is(err, io.ErrUnexpectedEOF):
		// Corrupt/truncated archives (incl. a valid extension over garbage)
		// are a distinguishable client error (plan §5.3), mirroring the
		// external-tool ErrCorrupt mapping.
		h.writeError(w, http.StatusUnprocessableEntity, "archive.corrupt", err.Error())
		return
	}
	var te *archivetool.ToolError
	if errors.As(err, &te) {
		switch te.Kind {
		case archivetool.ErrToolMissing:
			h.writeError(w, http.StatusServiceUnavailable, string(te.Kind), te.Error())
		case archivetool.ErrToolTimeout:
			h.writeError(w, http.StatusGatewayTimeout, string(te.Kind), te.Error())
		case archivetool.ErrReadOnly:
			h.writeError(w, http.StatusForbidden, string(te.Kind), te.Error())
		case archivetool.ErrEncrypted, archivetool.ErrMultiVolume, archivetool.ErrCorrupt:
			h.writeError(w, http.StatusUnprocessableEntity, string(te.Kind), te.Error())
		default:
			h.writeError(w, http.StatusBadGateway, string(te.Kind), te.Error())
		}
		return
	}
	if errors.Is(err, context.DeadlineExceeded) {
		h.writeError(w, http.StatusGatewayTimeout, "archive.tool-timeout", err.Error())
		return
	}
	h.writeError(w, http.StatusInternalServerError, "archive.internal", err.Error())
}

// detectFormat identifies the archive format from the filename extension,
// falling back to magic-byte sniffing when the extension is missing.
func detectFormat(name string) (archive.Format, error) {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".zip":
		return archive.FormatZIP, nil
	case ".7z":
		return archive.Format7Z, nil
	case ".rar":
		return archive.FormatRAR, nil
	}
	return "", fmt.Errorf("%w: %s (expected .zip/.7z/.rar)", archive.ErrUnsupportedFormat, name)
}

// mimeForName maps a filename extension to a content-type for asset/source
// registration and entry responses.
func mimeForName(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".tif", ".tiff":
		return "image/tiff"
	case ".mp4":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mkv":
		return "video/x-matroska"
	case ".zip":
		return "application/zip"
	case ".7z":
		return "application/x-7z-compressed"
	case ".rar":
		return "application/vnd.rar"
	default:
		return "application/octet-stream"
	}
}

// peekMagic reads up to 8 bytes from the request body so createSource can
// sniff the archive signature. The bytes are replayed via io.MultiReader, so
// nothing is consumed.
func peekMagic(r io.Reader) ([]byte, error) {
	buf := make([]byte, 8)
	n, err := io.ReadFull(r, buf)
	if err == io.ErrUnexpectedEOF || err == io.EOF {
		return buf[:n], nil
	}
	if err != nil {
		return nil, err
	}
	return buf, nil
}

// sniffFormat identifies the container format from magic bytes; returns ""
// when the signature is unknown (plain files are rejected by the extension
// check instead).
func sniffFormat(p []byte) archive.Format {
	switch {
	case len(p) >= 4 && p[0] == 'P' && p[1] == 'K' &&
		(p[2] == 0x03 || p[2] == 0x05 || p[2] == 0x07) && p[3] == 0x04:
		return archive.FormatZIP
	case len(p) >= 6 && p[0] == 0x37 && p[1] == 0x7a && p[2] == 0xbc && p[3] == 0xaf && p[4] == 0x27 && p[5] == 0x1c:
		return archive.Format7Z
	case len(p) >= 7 && p[0] == 'R' && p[1] == 'a' && p[2] == 'r' && p[3] == '!' && p[4] == 0x1a && p[5] == 0x07:
		return archive.FormatRAR
	}
	return ""
}

// newSourceID returns a random 128-bit hex source identifier, mirroring the
// TempStore's asset id scheme so source ids are unguessable (plan §7.1).
func newSourceID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generate source id: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// kindForName classifies an asset for the MediaAsset.kind field.
func kindForName(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg":
		return "image"
	case ".mp4", ".webm", ".mkv", ".mov", ".avi":
		return "video"
	case ".mp3", ".wav", ".ogg", ".flac", ".m4a":
		return "audio"
	default:
		return "file"
	}
}
