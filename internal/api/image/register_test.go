package image

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/registry"
)

func TestSaveImage_LargeBodyAndWebP(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.yaml")

	cfg := &config.Config{
		ImageSaveDir: filepath.Join(tempDir, "imgs"),
	}
	reg := registry.New(cfg)

	deps := &apibase.Deps{
		Reg:        reg,
		ConfigPath: configPath,
	}

	h := NewHandler(deps)
	r := chi.NewRouter()
	// Apply 32MB limit middleware matching router.go
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			req.Body = http.MaxBytesReader(w, req.Body, 32<<20)
			next.ServeHTTP(w, req)
		})
	})
	h.Register(r)

	// Create a simulated 2 MB WebP payload (> 1MB body limit test)
	largeData := bytes.Repeat([]byte("RIFF1234WEBPVP8 "), 131072) // ~2MB
	b64WebP := "data:image/webp;base64," + base64.StdEncoding.EncodeToString(largeData)

	reqBody, err := json.Marshal(saveImageRequest{
		URL: b64WebP,
		Metadata: &imageMetadata{
			Prompt: "test large webp image",
			Model:  "sensenova-u1.5-lite",
		},
	})
	if err != nil {
		t.Fatalf("failed to marshal request: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/save-image", bytes.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	savedPath := resp["path"]
	if savedPath == "" {
		t.Fatalf("expected saved path, got empty")
	}

	if !strings.HasSuffix(savedPath, ".webp") {
		t.Errorf("expected .webp extension, got %s", savedPath)
	}

	savedBytes, err := os.ReadFile(savedPath)
	if err != nil {
		t.Fatalf("failed to read saved file: %v", err)
	}
	if len(savedBytes) != len(largeData) {
		t.Errorf("expected saved file size %d, got %d", len(largeData), len(savedBytes))
	}
}
