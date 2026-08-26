package assistant

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/owner"
)

// Register mounts assistant routes on the provided chi router.
func (h *Handler) Register(r chi.Router) {
	r.Use(owner.Middleware)

	r.Get("/tools", h.getTools)
	r.Post("/dispatch", h.dispatch)
	r.Get("/events", h.events.ServeSSE)

	// Spritesheet serving (Action editor preview + runtime pet animation)
	r.Post("/sheet-preview", h.sheetPreviewRegister)
	r.Get("/sheet-preview/{id}", h.sheetPreviewServe)
	r.Get("/sheet-image/{name}", h.sheetImageServe)
	// Pet trigger (settings state-machine panel — visual smoke test without
	// requiring the modal to share a browsing context with the pet window).
	r.Post("/pet-trigger", h.petTrigger)
	r.Get("/pet-state", h.petState)
	// Jobs (Task B)
	r.Get("/jobs", h.getJobs)
	r.Post("/jobs", h.createJob)
	r.Delete("/jobs/{name}", h.deleteJob)
	// Todos (R2)
	r.Get("/todos", h.getTodos)
	r.Post("/todos", h.createTodo)
	r.Put("/todos/{id}", h.updateTodo)
	r.Delete("/todos/{id}", h.deleteTodo)
}
// Events returns the EventBroadcaster for serving SSE.
func (h *Handler) Events(w http.ResponseWriter, r *http.Request) {
	h.events.ServeSSE(w, r)
}
