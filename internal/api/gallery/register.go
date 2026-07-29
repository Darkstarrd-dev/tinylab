// Package gallery provides HTTP handlers for gallery-related operations.
// Frontend: all web/playground/static-pg/*.js (routes wired here).
package gallery

import (
	"net/http"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/mediaedit"

	// Register all image format decoders so image.Decode works for PNG/GIF/WebP/BMP/TIFF.
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
	_ "image/gif"
	_ "image/png"
)

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
}

// NewHandler creates a new gallery Handler with per-instance state.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{
		d:        d,
		sessions: newGallerySessionStore(),
		media:    mediaedit.NewManager(),
		proxy:    d.ProxyHandler,
	}
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
