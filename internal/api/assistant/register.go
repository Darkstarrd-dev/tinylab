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
