package textreview

import (
	"net/http"
	"sort"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/registry"
)

// TestRoutesRegistered verifies all 7 P1 endpoints are mounted under the
// /api/text-review group with the expected methods and paths (mirrors the
// real wiring in internal/api/router.go).
func TestRoutesRegistered(t *testing.T) {
	reg := registry.New(&config.Config{})
	h := NewHandler(&apibase.Deps{Reg: reg})

	r := chi.NewRouter()
	r.Route("/api/text-review", func(r chi.Router) {
		h.Register(r)
	})

	got := map[string]bool{}
	_ = chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		got[method+" "+route] = true
		return nil
	})

	want := []string{
		http.MethodGet + " /api/text-review/review-nodes",
		http.MethodPost + " /api/text-review/review-nodes",
		http.MethodDelete + " /api/text-review/review-nodes/{id}",
		http.MethodGet + " /api/text-review/split-patterns",
		http.MethodPost + " /api/text-review/split-patterns",
		http.MethodDelete + " /api/text-review/split-patterns/{key}",
		http.MethodGet + " /api/text-review/prompt-default",
		http.MethodPost + " /api/text-review/prompt-default",
	}
	sort.Strings(want)
	for _, w := range want {
		if !got[w] {
			t.Errorf("missing route %s", w)
		}
	}
}
