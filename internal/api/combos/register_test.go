package combos

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/registry"
)

// newSpeedTestHandler builds a combos Handler backed by a fresh registry and a
// writable config path, mirroring the production wiring.
func newSpeedTestHandler(t *testing.T, combo config.Combo) (string, *chi.Mux) {
	t.Helper()
	cfg := config.DefaultConfig()
	reg := registry.New(cfg)
	if combo.ID != "" {
		reg.AddCombo(combo)
	}
	deps := &apibase.Deps{Reg: reg, ConfigPath: filepath.Join(t.TempDir(), "config.yaml"), Logger: console.New(100)}
	h := NewHandler(deps)
	r := chi.NewRouter()
	h.Register(r)
	return combo.ID, r
}

// TestSpeedTest_ModelCountCap verifies the F-15 max-model budget: a combo with
// more models than speedTestMaxModels is refused with a deterministic 400
// before any probe is launched or any config mutation happens.
func TestSpeedTest_ModelCountCap(t *testing.T) {
	models := make([]string, speedTestMaxModels+1)
	for i := range models {
		models[i] = fmt.Sprintf("p/m%d", i)
	}
	id, r := newSpeedTestHandler(t, config.Combo{ID: "c1", Name: "big", Models: models})

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/combos/"+id+"/speed-test", nil))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "too many models") {
		t.Fatalf("body = %q, want a too-many-models message", rr.Body.String())
	}
}

// TestSpeedTest_ModelCountBoundary verifies a combo at exactly the cap is not
// refused: it streams an SSE result set (every model fails fast here because
// the registry has no providers/keys) instead of a 400.
func TestSpeedTest_ModelCountBoundary(t *testing.T) {
	models := make([]string, speedTestMaxModels)
	for i := range models {
		models[i] = fmt.Sprintf("p/m%d", i)
	}
	id, r := newSpeedTestHandler(t, config.Combo{ID: "c2", Name: "full", Models: models})

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/combos/"+id+"/speed-test", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (SSE stream)", rr.Code)
	}
	body := rr.Body.String()
	if !strings.Contains(body, "event: meta") {
		t.Fatalf("SSE body missing meta event")
	}
	if !strings.Contains(body, "event: done") {
		t.Fatalf("SSE body missing done event")
	}
}
