// Package api provides HTTP handlers for the management REST API.
package api

import (
	"io/fs"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/auth"
	"github.com/tinylab/tinylab/internal/api/comfyui"
	"github.com/tinylab/tinylab/internal/api/image"
	apimagebatch "github.com/tinylab/tinylab/internal/api/imagebatch"
	playgroundapi "github.com/tinylab/tinylab/internal/api/playground"
	"github.com/tinylab/tinylab/internal/feature"
	"github.com/tinylab/tinylab/web"
)

// registerPlaygroundRoutes mounts playground-attached API endpoints that sit
// outside the generic 1 MiB /api group so large payloads (images, media,
// batch manifests) remain usable while still auth-gated.
func (rt *Router) registerPlaygroundRoutes(
	r chi.Router,
	authHandler *auth.Handler,
	imageHandler *image.Handler,
	playgroundHandler *playgroundapi.Handler,
	comfyuiHandler *comfyui.Handler,
	imageBatchHandler *apimagebatch.Handler,
) {
	// Image save/proxy: 32 MiB body limit for base64 data URLs and proxied fetches.
	r.Route("/api/save-image", func(r chi.Router) {
		r.Use(authHandler.AuthMiddleware)
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				req.Body = http.MaxBytesReader(w, req.Body, 32<<20)
				next.ServeHTTP(w, req)
			})
		})
		r.Post("/", imageHandler.SaveImage)
	})
	r.Route("/api/image-proxy", func(r chi.Router) {
		r.Use(authHandler.AuthMiddleware)
		r.Get("/", imageHandler.ImageProxy)
	})

	// Playground media prep: up to 32 MiB audio/media blobs.
	r.Route("/api/playground", func(r chi.Router) {
		r.Use(authHandler.AuthMiddleware)
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				req.Body = http.MaxBytesReader(w, req.Body, 32<<20)
				next.ServeHTTP(w, req)
			})
		})
		playgroundHandler.Register(r)
	})

	// ComfyUI workflow proxy: large API-format workflows, playground-attached.
	r.Route("/api/comfyui", func(r chi.Router) {
		r.Use(authHandler.AuthMiddleware)
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				req.Body = http.MaxBytesReader(w, req.Body, 32<<20)
				next.ServeHTTP(w, req)
			})
		})
		comfyuiHandler.Register(r)
	})

	// Image Batch: project manifests/imports can exceed the generic 1 MiB limit.
	r.Route("/api/image-batches", func(r chi.Router) {
		r.Use(authHandler.AuthMiddleware)
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				req.Body = http.MaxBytesReader(w, req.Body, 32<<20)
				next.ServeHTTP(w, req)
			})
		})
		imageBatchHandler.Register(r)
	})
	r.Group(func(r chi.Router) {
		r.Use(authHandler.AuthMiddleware)
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				req.Body = http.MaxBytesReader(w, req.Body, 32<<20)
				next.ServeHTTP(w, req)
			})
		})
		imageBatchHandler.RegisterRoot(r)
	})
}

// registerPlaygroundStatic mounts the embedded playground static assets
// (playground.css, vendor shims, per-feature JS bundles) when the playground
// feature is compiled into the binary. Must be called before the catch-all
// serveUI route so specific patterns win.
func (rt *Router) registerPlaygroundStatic(r chi.Router) {
	if !feature.Enabled(feature.Playground) {
		return
	}
	pgStatic, err := fs.Sub(web.PlaygroundStatic, "playground/static-pg")
	if err != nil {
		return
	}
	pgFSRoot := http.FileServer(http.FS(pgStatic))
	noCacheHandler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
		pgFSRoot.ServeHTTP(w, req)
	})
	// /vendor/*: serve the playground vendor dir first, fall back to the main
	// static FS for vendors that only live there (gif.js etc.).
	vendorHandler := noCacheHandler
	if mainStaticFS, err := fs.Sub(web.Static, "static"); err == nil {
		vendorHandler = http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
			rel := strings.TrimPrefix(req.URL.Path, "/")
			if f, ferr := pgStatic.Open(rel); ferr == nil {
				f.Close()
				pgFSRoot.ServeHTTP(w, req)
				return
			}
			http.FileServer(http.FS(mainStaticFS)).ServeHTTP(w, req)
		})
	} else {
		rt.logger.Warn("router: main static sub for /vendor/* fallback failed: %v", err)
	}
	r.Get("/playground.css", noCacheHandler)
	r.Get("/vendor/*", vendorHandler)
	pgJSFiles := feature.Assets(feature.RootPlaygroundPG)
	for _, f := range pgJSFiles {
		r.Get("/"+f, noCacheHandler)
	}
}
