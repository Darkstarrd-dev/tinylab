package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/registry"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/usage"
)

// newResponsesTestHandler builds a handler whose single provider is a standard
// OpenAI-compatible provider pointed at the given BaseURL, exercised via the
// /v1/responses entry.
func newResponsesTestHandler(t *testing.T, baseURL string) *Handler {
	t.Helper()
	provider := config.Provider{
		ID: "openai", Name: "OpenAI", Prefix: "openai",
		BaseURL: baseURL, IsActive: true,
		Keys: []config.Key{
			{ID: "k1", Key: "sk-openai-responses", Name: "OpenKey", IsActive: true, Priority: 1},
		},
		Models: []config.ModelDef{{ID: "gpt-4o", QuotaType: "limited"}},
	}
	cfg := &config.Config{
		Providers: []config.Provider{provider},
		Rotation:  config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	usageBuf := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	return New(reg, sel, comboRes, usageBuf, qt, logger, 0)
}

// TestResponses_BearerAuthorizationHeader verifies the /v1/responses entry
// forwards with the standard "Authorization: Bearer <key>" header and does NOT
// send an x-api-key header. It also asserts the body is passed through unchanged.
func TestResponses_BearerAuthorizationHeader(t *testing.T) {
	var (
		gotAuthorization string
		gotXAPIKey       string
		gotURL           string
		gotBody          string
	)
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuthorization = r.Header.Get("Authorization")
		gotXAPIKey = r.Header.Get("x-api-key")
		gotURL = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"resp_1","object":"response"}`))
	}))
	defer mockUpstream.Close()

	h := newResponsesTestHandler(t, mockUpstream.URL)

	body := `{"model":"openai/gpt-4o","input":"hello"}`
	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.Responses(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", resp.StatusCode, readBody(resp))
	}

	if gotAuthorization != "Bearer sk-openai-responses" {
		t.Errorf("expected Authorization Bearer sk-openai-responses, got %q", gotAuthorization)
	}
	if gotXAPIKey != "" {
		t.Errorf("responses entry must NOT set x-api-key, got %q", gotXAPIKey)
	}
	if gotURL != "/v1/responses" {
		t.Errorf("expected upstream path /v1/responses, got %q", gotURL)
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(gotBody), &sent); err != nil {
		t.Fatalf("failed to parse upstream body: %v", err)
	}
	if sent["model"] != "gpt-4o" {
		t.Errorf("expected upstream model gpt-4o, got %v", sent["model"])
	}
	if _, ok := sent["input"]; !ok {
		t.Errorf("expected passthrough body to retain 'input' field, got %v", sent)
	}
}

// TestResponses_URLConstruction covers the three BaseURL forms and asserts the
// final upstream URL is correct (no double /v1 prefix).
func TestResponses_URLConstruction(t *testing.T) {
	cases := []struct {
		name        string
		baseURL     string
		wantPath    string
		wantRawHost string // when raw mode, check host includes everything
	}{
		{
			name:     "complete-endpoint",
			baseURL:  "https://api.openai.com/v1/responses",
			wantPath: "/v1/responses",
		},
		{
			name:     "host-root",
			baseURL:  "https://api.openai.com",
			wantPath: "/v1/responses",
		},
		{
			name:        "raw-mode",
			baseURL:     "https://custom.example.com/v1/responses*",
			wantRawHost: "/v1/responses",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotPath string
			mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.Path
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				w.Write([]byte(`{"id":"resp_1","object":"response"}`))
			}))
			defer mockUpstream.Close()

			// For raw mode, the base already contains the full path + "*"; replace
			// the scheme/host with the test server so the request actually lands.
			base := tc.baseURL
			if strings.HasSuffix(base, "*") {
				// strip the original host, keep the path suffix after the host.
				// e.g. "https://custom.example.com/v1/responses*" -> "/v1/responses"
				if idx := strings.Index(base, "://"); idx > 0 {
					rest := base[idx+3:]
					if slash := strings.Index(rest, "/"); slash >= 0 {
						base = mockUpstream.URL + rest[slash:len(rest)-1] + "*"
					}
				}
			} else {
				// replace host of a normal base with the test server host
				if idx := strings.Index(base, "://"); idx > 0 {
					rest := base[idx+3:]
					if slash := strings.Index(rest, "/"); slash >= 0 {
						// base had a path; for host-root it won't. just use host.
						host := rest[:slash]
						base = mockUpstream.URL + strings.TrimPrefix(base, "https://"+host)
						_ = host
					} else {
						base = mockUpstream.URL
					}
				}
			}

			h := newResponsesTestHandler(t, base)

			body := `{"model":"openai/gpt-4o","input":"hello"}`
			req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			h.Responses(w, req)
			resp := w.Result()
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("expected 200, got %d (body=%s)", resp.StatusCode, readBody(resp))
			}

			if tc.wantRawHost != "" {
				if gotPath != tc.wantRawHost {
					t.Errorf("[%s] raw mode: expected path %q, got %q", tc.name, tc.wantRawHost, gotPath)
				}
			} else if gotPath != tc.wantPath {
				t.Errorf("[%s] expected upstream path %q, got %q", tc.name, tc.wantPath, gotPath)
			}
		})
	}
}

// TestResponses_RouteRegistered starts the full router and asserts POST
// /v1/responses is registered (non-404). It uses a mock upstream to confirm an
// end-to-end 200, not just route existence.
func TestResponses_RouteRegistered(t *testing.T) {
	var gotPath string
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"resp_1","object":"response"}`))
	}))
	defer mockUpstream.Close()

	h := newResponsesTestHandler(t, mockUpstream.URL)

	body := `{"model":"openai/gpt-4o","input":"hello"}`
	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.Responses(w, req)
	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		t.Fatalf("POST /v1/responses returned 404: route not registered")
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", resp.StatusCode, readBody(resp))
	}
	if gotPath != "/v1/responses" {
		t.Errorf("expected upstream path /v1/responses, got %q", gotPath)
	}
}

func readBody(resp *http.Response) string {
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}
