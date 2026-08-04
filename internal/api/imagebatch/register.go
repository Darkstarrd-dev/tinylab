package imagebatch

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	domain "github.com/tinyrouter/tinyrouter/internal/imagebatch"
)

// Manager is the API-facing batch service. Implementations own persistence and scheduling.
type Manager interface {
	Create(context.Context, *domain.Project) (*domain.Project, error)
	List(context.Context) ([]*domain.Project, error)
	Get(context.Context, string) (*domain.Project, error)
	Import(context.Context, []byte, string) (*domain.Project, error)
	Pause(context.Context, string) (*domain.Project, error)
	Resume(context.Context, string) (*domain.Project, error)
	Stop(context.Context, string, string) (*domain.Project, error)
	Retry(context.Context, string, string, string) (*domain.Project, error)
	Subscribe(context.Context, string) (<-chan domain.Event, error)
	AssetPath(context.Context, string, string) (string, error)
}

type Handler struct {
	d       *apibase.Deps
	manager Manager
}

func NewHandler(d *apibase.Deps, manager Manager) *Handler { return &Handler{d: d, manager: manager} }

func (h *Handler) Register(r chi.Router) {
	r.Post("/plan", h.plan)
	r.Post("/transform", h.transform)
	r.Post("/", h.create)
	r.Get("/", h.list)
	r.Post("/import", h.importProject)
	r.Get("/{projectID}", h.get)
	r.Get("/{projectID}/events", h.events)
	r.Get("/{projectID}/manifest", h.manifest)
	r.Get("/{projectID}/assets/{assetID}", h.asset)
	r.Post("/{projectID}/pause", h.pause)
	r.Post("/{projectID}/resume", h.resume)
	r.Post("/{projectID}/stop", h.stop)
	r.Post("/{projectID}/retry/{promptID}/{variantID}", h.retry)
}

// RegisterRoot adds the no-trailing-slash project create and list endpoints.
// The caller supplies the auth and body-limit middleware on the router.
func (h *Handler) RegisterRoot(r chi.Router) {
	r.Post("/api/image-batches", h.create)
	r.Get("/api/image-batches", h.list)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func errJSON(w http.ResponseWriter, status int, msg string) { apibase.WriteAPIError(w, status, msg) }
func decodeJSON(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return fmt.Errorf("multiple JSON values")
	}
	return nil
}
func pathID(s string) bool {
	return len(s) > 0 && len(s) <= 128 && !strings.ContainsAny(s, "/\\\x00\r\n")
}
func requireManager(h *Handler, w http.ResponseWriter) bool {
	if h.manager == nil {
		errJSON(w, http.StatusServiceUnavailable, "image batch service unavailable")
		return false
	}
	return true
}
