// Package gallery provides HTTP handlers for gallery-related operations.
// Frontend: all web/playground/static-pg/*.js (routes wired here).
package gallery

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/archive"
	"github.com/tinyrouter/tinyrouter/internal/mediaedit"
	"github.com/tinyrouter/tinyrouter/internal/owner"
	"github.com/tinyrouter/tinyrouter/internal/pathgrant"

	// Register all image format decoders so image.Decode works for PNG/GIF/WebP/BMP/TIFF.
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
	_ "image/gif"
	_ "image/png"
)

// archiveBridge is the /api/archive surface the gallery handlers consume for
// sourceId-based flows (zip entry extraction for editing, AI review over a
// registered archive source). It is implemented by *archiveapi.Handler and
// injected via SetArchive by the router; a nil bridge keeps every gallery
// flow on the legacy in-memory zip sessions (compatibility boundary).
type archiveBridge interface {
	// ResolveSource returns the registered source for a sourceId when the
	// caller is the owner that registered it, or false when the source is
	// unknown, expired, or owned by another session (owner-bound, F-29).
	// Gallery passes owner.From(r.Context()).
	ResolveSource(ownerID, id string) (archive.Source, bool)
	// List returns the strict-validated manifest of a source.
	List(ctx context.Context, src archive.Source, b archive.Budget) (archive.Manifest, error)
	// ReadEntry returns the bytes + content-type of one entry, addressed by
	// decimal index or strict relative archive path.
	ReadEntry(ctx context.Context, src archive.Source, identifier string, b archive.Budget) ([]byte, string, error)
}

// proxyCaller is the subset of the proxy handler the gallery subsystem needs.
// *proxy.Handler satisfies it (ChatCompletions); tests may substitute a fake.
// Decoupling from the concrete *proxy.Handler avoids importing internal/proxy
// and lets the AI review engine and prompt generator call the proxy without an
// httptest-backed request.
type proxyCaller interface {
	ChatCompletions(http.ResponseWriter, *http.Request)
}

// Handler wires up gallery routes and owns the gallery subsystem's mutable
// in-process state: zip sessions, AI review tasks, and ffmpeg media edit jobs.
// State is injected at construction (NewHandler) instead of package globals so
// tests and concurrent Handler instances are isolated. See Fix 3 of the refactor
// spec.
type Handler struct {
	d        *apibase.Deps
	sessions *gallerySessionStore
	reviews  sync.Map // map[string]*reviewTask
	media    *mediaedit.Manager
	proxy    proxyCaller
	archive  archiveBridge // nil = legacy in-memory zip sessions only
	// grants is the owner-bound path-grant registry for open-dir / paste /
	// zip-from-path / edit inputs (F-03/F-28/F-30: browser never sends paths).
	grants *pathgrant.Store
	// uploadSem caps concurrent zip upload bodies being read into memory
	// (galleryListZip); excess uploads get 429 (F-15).
	uploadSem chan struct{}
	// tempFiles tracks gallery-created temp files (upload-temp / subtitle /
	// extracted entries) so the success path is eventually cleaned up even
	// when the frontend never asks (F-27).
	tempFiles *tempRegistry

	assetsOnce sync.Once
	assets     *archive.TempStore
	assetsErr  error
}

// NewHandler creates a new gallery Handler with per-instance state.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{
		d:         d,
		sessions:  newGallerySessionStore(),
		media:     mediaedit.NewManager(),
		proxy:     d.ProxyHandler,
		grants:    pathgrant.NewStore(0),
		uploadSem: make(chan struct{}, galleryMaxConcurrentUploads),
		tempFiles: newTempRegistry(),
	}
}

// assetStore lazily creates the gallery's private temp-asset store (0700
// workspace under the OS temp dir). Edit inputs, extracted entries, uploaded
// temps, and outputs are registered here and addressed by assetId only.
func (h *Handler) assetStore() (*archive.TempStore, error) {
	h.assetsOnce.Do(func() {
		root := filepath.Join(os.TempDir(), "tinyrouter-gallery-assets")
		h.assets, h.assetsErr = archive.NewTempStore(root, 0)
	})
	if h.assetsErr != nil {
		return nil, errors.New("gallery asset store unavailable")
	}
	return h.assets, nil
}

// SetArchive wires the /api/archive bridge so sourceId-based gallery items
// (archive-registered zip sources) can be extracted and reviewed through the
// shared archive capability instead of the legacy in-memory zip sessions. The
// router calls this after constructing both handlers; nil is a valid value
// (keeps the legacy flows when the archive runner is unavailable).
func (h *Handler) SetArchive(b archiveBridge) {
	h.archive = b
}

// Register registers the gallery routes on the given router.
func (h *Handler) Register(r chi.Router) {
	// Owner middleware binds every gallery resource (zip sessions, assets,
	// grants, archive source lookups) to the requesting browser session.
	r.Use(owner.Middleware)
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
	r.Post("/open-folder", h.galleryOpenFolder)
	r.Delete("/fs", h.galleryDeleteFs)
	r.Post("/zip-from-path", h.galleryZipFromPath)
	r.Post("/zip-writeback", h.galleryZipWriteback)
	// Media edit endpoints.
	r.Get("/edit/ffmpeg-status", h.galleryEditFfmpegStatus)
	r.Post("/edit/probe", h.galleryEditProbe)
	r.Post("/edit/subtitle-upload", h.galleryEditSubtitleUpload)
	r.Post("/edit/start", h.galleryEditStart)
	r.Get("/edit/status/{jobId}", h.galleryEditStatus)
	r.Post("/edit/cancel/{jobId}", h.galleryEditCancel)
	r.Post("/edit/extract-zip-entry", h.galleryEditExtractZipEntry)
	r.Post("/edit/upload-temp", h.galleryEditUploadTemp)
	r.Post("/edit/zip-outputs", h.galleryEditZipOutputs)
	r.Post("/edit/zip-writeback", h.galleryEditZipWriteback)
	r.Post("/paste-paths", h.galleryPastePaths)
}
