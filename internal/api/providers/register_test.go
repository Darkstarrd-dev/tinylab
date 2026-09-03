package providers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/registry"
)

func newTestProvidersHandler(t *testing.T, p config.Provider) (*chi.Mux, *registry.Registry) {
	t.Helper()
	cfg := config.DefaultConfig()
	reg := registry.New(cfg)
	if p.ID != "" {
		reg.AddProvider(p)
	}
	deps := &apibase.Deps{
		Reg:        reg,
		ConfigPath: filepath.Join(t.TempDir(), "config.yaml"),
		Logger:     console.New(100),
	}
	h := NewHandler(deps)
	r := chi.NewRouter()
	h.Register(r)
	return r, reg
}

func TestUpdateModelImgProtocol(t *testing.T) {
	prov := config.Provider{
		ID:       "p1",
		Name:     "Provider 1",
		Prefix:   "p1",
		BaseURL:  "https://api.example.com",
		APIType:  "openai-compatible",
		IsActive: true,
		Models: []config.ModelDef{
			{ID: "m-img", Kind: "image", ImgProtocol: "gpt"},
		},
	}
	r, reg := newTestProvidersHandler(t, prov)

	cases := []struct {
		name       string
		model      string
		protocol   string
		wantStatus int
		wantProto  string
	}{
		{"sensenova protocol", "m-img", "sensenova", http.StatusOK, "sensenova"},
		{"modelscope protocol", "m-img", "modelscope", http.StatusOK, "modelscope"},
		{"xai protocol", "m-img", "xai", http.StatusOK, "xai"},
		{"gpt protocol", "m-img", "gpt", http.StatusOK, "gpt"},
		{"invalid protocol", "m-img", "dall-e-3", http.StatusBadRequest, "gpt"},
		{"missing model", "", "sensenova", http.StatusBadRequest, "gpt"},
		{"unknown model", "m-unknown", "sensenova", http.StatusNotFound, "gpt"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := map[string]string{
				"model":       tc.model,
				"imgProtocol": tc.protocol,
			}
			data, _ := json.Marshal(payload)
			req := httptest.NewRequest(http.MethodPatch, "/providers/p1/models/imgProtocol", bytes.NewReader(data))
			rr := httptest.NewRecorder()
			r.ServeHTTP(rr, req)

			if rr.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rr.Code, tc.wantStatus, rr.Body.String())
			}

			if tc.wantStatus == http.StatusOK {
				// Verify in registry
				p, ok := reg.GetProvider("p1")
				if !ok {
					t.Fatalf("provider p1 not found")
				}
				for _, m := range p.Models {
					if m.ID == tc.model && m.ImgProtocol != tc.wantProto {
						t.Errorf("model imgProtocol = %q, want %q", m.ImgProtocol, tc.wantProto)
					}
				}
			}
		})
	}
}
