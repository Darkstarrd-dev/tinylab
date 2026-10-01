package jethub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// newRouteTestHandler mounts the real jethub route table on a chi router so
// route-shape regressions are caught at the HTTP layer (the reported
// "Failed: HTTP 404 (non-JSON body)" was a UI/backend path mismatch —
// /jethub/{provider}/proxy vs /jethub/providers/{provider}/proxy).
func newRouteTestHandler(t *testing.T) http.Handler {
	t.Helper()
	m, err := corejethub.NewManager(t.TempDir(), "", nil)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	h := NewHandler(&Deps{Manager: m, Bridge: nil})
	r := chi.NewRouter()
	r.Route("/api", func(r chi.Router) { h.Register(r) })
	return r
}

// TestProxyToggleRouteShape: PUT /api/jethub/providers/{provider}/proxy must
// be registered (200, JSON body) — NOT 404 with a text/plain body.
func TestProxyToggleRouteShape(t *testing.T) {
	srv := newRouteTestHandler(t)

	req := httptest.NewRequest(http.MethodPut,
		"/api/jethub/providers/cline/proxy", strings.NewReader(`{"enabled":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("PUT proxy = %d (body %q), want 200", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON (%v): %q", err, rec.Body.String())
	}
	if enabled, _ := out["proxyEnabled"].(bool); !enabled {
		t.Fatalf("proxyEnabled = %v, want true", out["proxyEnabled"])
	}

	// The old wrong shape must NOT resolve to the handler (it is a different
	// route family); this documents why the UI path had to change.
	req2 := httptest.NewRequest(http.MethodPut,
		"/api/jethub/cline/proxy", strings.NewReader(`{"enabled":true}`))
	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusNotFound {
		t.Fatalf("/api/jethub/cline/proxy = %d, want 404 (the shape that caused the defect)", rec2.Code)
	}
}

// TestProxyToggleRouteValidation: missing body field → 400 JSON; unknown
// provider → 404 JSON with an error field (not the router's plain-text 404).
func TestProxyToggleRouteValidation(t *testing.T) {
	srv := newRouteTestHandler(t)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPut,
		"/api/jethub/providers/cline/proxy", strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing enabled = %d, want 400", rec.Code)
	}

	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, httptest.NewRequest(http.MethodPut,
		"/api/jethub/providers/nope/proxy", strings.NewReader(`{"enabled":true}`)))
	if rec2.Code != http.StatusNotFound {
		t.Fatalf("unknown provider = %d, want 404", rec2.Code)
	}
	if !strings.Contains(rec2.Body.String(), "error") {
		t.Fatalf("handler 404 must carry a JSON error: %q", rec2.Body.String())
	}
}

// TestProvidersListCarriesProxyEnabled: GET /providers exposes the toggle so
// the UI can render the checkbox state.
func TestProvidersListCarriesProxyEnabled(t *testing.T) {
	srv := newRouteTestHandler(t)

	// Flip the toggle through the API, then list.
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPut,
		"/api/jethub/providers/qoder/proxy", strings.NewReader(`{"enabled":true}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("toggle = %d", rec.Code)
	}

	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/api/jethub/providers", nil))
	if rec2.Code != http.StatusOK {
		t.Fatalf("list providers = %d", rec2.Code)
	}
	var payload struct {
		Providers []struct {
			ID           string `json:"id"`
			ProxyEnabled bool   `json:"proxyEnabled"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(rec2.Body.Bytes(), &payload); err != nil {
		t.Fatalf("parse providers: %v", err)
	}
	var found, other bool
	for _, p := range payload.Providers {
		switch p.ID {
		case "qoder":
			found = p.ProxyEnabled
		case "cline":
			other = p.ProxyEnabled
		}
	}
	if !found {
		t.Fatal("qoder must report proxyEnabled=true after the toggle")
	}
	if other {
		t.Fatal("cline must stay proxyEnabled=false")
	}
}
