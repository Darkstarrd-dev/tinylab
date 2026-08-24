package assistant

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/owner"
	"github.com/tinyrouter/tinyrouter/internal/registry"
)

// writeTestPNG writes a tiny valid PNG and returns its path.
func writeTestPNG(t *testing.T) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	path := filepath.Join(t.TempDir(), "sheet.png")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create png: %v", err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return path
}

// doWithOwner runs req through the router and replays the issued owner cookie
// on subsequent requests, simulating one browser session.
type ownerJar struct{ value string }

func (j *ownerJar) do(r chi.Router, req *http.Request) *httptest.ResponseRecorder {
	if j.value != "" {
		req.AddCookie(&http.Cookie{Name: owner.CookieName, Value: j.value})
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	for _, sc := range rec.Result().Cookies() {
		if sc.Name == owner.CookieName {
			j.value = sc.Value
		}
	}
	return rec
}

func TestSheetPreviewRegisterAndServe(t *testing.T) {
	h := NewHandler(nil, nil, nil, nil, nil)
	r := chi.NewRouter()
	r.Route("/api/assistant", func(sub chi.Router) { h.Register(sub) })
	jar := &ownerJar{}
	pngPath := writeTestPNG(t)

	body, _ := json.Marshal(map[string]string{"path": pngPath})
	req := httptest.NewRequest("POST", "/api/assistant/sheet-preview", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := jar.do(r, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("register preview: got %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		PreviewID string `json:"previewId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || resp.PreviewID == "" {
		t.Fatalf("bad register response %q: %v", rec.Body.String(), err)
	}

	get := httptest.NewRequest("GET", "/api/assistant/sheet-preview/"+resp.PreviewID, nil)
	rec = jar.do(r, get)
	if rec.Code != http.StatusOK {
		t.Fatalf("serve preview: got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", ct)
	}
	original, _ := os.ReadFile(pngPath)
	if !bytes.Equal(rec.Body.Bytes(), original) {
		t.Error("served bytes differ from source PNG")
	}

	// A different browser session (fresh cookie) must not resolve the id.
	other := &ownerJar{}
	rec = other.do(r, httptest.NewRequest("GET", "/api/assistant/sheet-preview/"+resp.PreviewID, nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("cross-session preview access: got %d, want 404", rec.Code)
	}

	// Unsupported extension rejected.
	txt := filepath.Join(t.TempDir(), "sheet.exe")
	os.WriteFile(txt, []byte("MZ"), 0644)
	body, _ = json.Marshal(map[string]string{"path": txt})
	req = httptest.NewRequest("POST", "/api/assistant/sheet-preview", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec = jar.do(r, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("exe path: got %d, want 400", rec.Code)
	}
}

func TestSheetImageServesConfiguredAction(t *testing.T) {
	pngPath := writeTestPNG(t)
	cfg := config.DefaultConfig()
	cfg.Assistant.Actions = []config.AssistantAction{
		{Name: "walk", SpritesheetPath: pngPath, Cols: 2, Rows: 1, Fps: 6},
	}
	h := NewHandler(&apibase.Deps{Reg: registry.New(cfg)}, nil, nil, nil, nil)
	r := chi.NewRouter()
	r.Route("/api/assistant", func(sub chi.Router) { h.Register(sub) })

	rec := (&ownerJar{}).do(r, httptest.NewRequest("GET", "/api/assistant/sheet-image/walk", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("sheet-image walk: got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", ct)
	}

	rec = (&ownerJar{}).do(r, httptest.NewRequest("GET", "/api/assistant/sheet-image/missing", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown action: got %d, want 404", rec.Code)
	}
}
