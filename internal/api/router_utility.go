// Package api provides HTTP handlers for the management REST API.
package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	archiveapi "github.com/tinyrouter/tinyrouter/internal/api/archive"
	"github.com/tinyrouter/tinyrouter/internal/api/auth"
	"github.com/tinyrouter/tinyrouter/internal/api/editor"
	"github.com/tinyrouter/tinyrouter/internal/api/gallery"
	"github.com/tinyrouter/tinyrouter/internal/api/textreview"
	"github.com/tinyrouter/tinyrouter/internal/feature"
	"github.com/tinyrouter/tinyrouter/internal/filetransfer"
)

// registerUtilityRoutes mounts utility-domain API endpoints (editor, text-review,
// gallery, filetransfer, archive) that sit outside the generic 1 MiB /api group
// so large payloads remain usable while still auth-gated.
func (rt *Router) registerUtilityRoutes(
	r chi.Router,
	authHandler *auth.Handler,
	editorHandler *editor.Handler,
	textReviewHandler *textreview.Handler,
	galleryHandler *gallery.Handler,
	fileTransferHandler *filetransfer.Handler,
	archiveHandler *archiveapi.Handler,
) {
	// Gallery: zip uploads up to 500 MiB; auth-gated but outside the 1 MiB group.
	r.Route("/api/gallery", func(r chi.Router) {
		r.Use(authHandler.AuthMiddleware)
		if feature.Enabled(feature.Gallery) {
			galleryHandler.Register(r)
		}
	})

	// FileTransfer: browser files / ZIP archive up to ~610 MiB.
	r.Route("/api/filetransfer", func(r chi.Router) {
		r.Use(authHandler.AuthMiddleware)
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				req.Body = http.MaxBytesReader(w, req.Body, 610<<20)
				next.ServeHTTP(w, req)
			})
		})
		if feature.Enabled(feature.FileTransfer) {
			fileTransferHandler.Register(r)
		}
	})

	r.Route("/api/archive", func(r chi.Router) {
		r.Use(authHandler.AuthMiddleware)
		if feature.Enabled(feature.Archive) {
			archiveHandler.Register(r)
		}
	})

	// Editor: text file open/save via native picker; up to 32 MiB.
	r.Route("/api/editor", func(r chi.Router) {
		r.Use(authHandler.AuthMiddleware)
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				req.Body = http.MaxBytesReader(w, req.Body, 32<<20)
				next.ServeHTTP(w, req)
			})
		})
		if feature.Enabled(feature.Editor) {
			editorHandler.Register(r)
		}
	})

	// Text-review: AI text-review config + sessions; up to 32 MiB sessions.
	r.Route("/api/text-review", func(r chi.Router) {
		r.Use(authHandler.AuthMiddleware)
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				req.Body = http.MaxBytesReader(w, req.Body, 32<<20)
				next.ServeHTTP(w, req)
			})
		})
		if feature.Enabled(feature.Editor) {
			textReviewHandler.Register(r)
		}
	})
}
