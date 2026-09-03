package playground

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/registry"
)

func TestFfmpegStatus(t *testing.T) {
	cfg := &config.Config{}
	reg := registry.New(cfg)
	d := &apibase.Deps{Reg: reg}
	h := NewHandler(d)

	req := httptest.NewRequest("GET", "/ffmpeg-status", nil)
	w := httptest.NewRecorder()
	h.ffmpegStatus(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	var res map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatalf("json decode error: %v", err)
	}
	if _, ok := res["available"]; !ok {
		t.Fatalf("missing available field in response: %+v", res)
	}
}

func TestMediaPrep_ImageDirect(t *testing.T) {
	cfg := &config.Config{}
	reg := registry.New(cfg)
	d := &apibase.Deps{Reg: reg}
	h := NewHandler(d)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	_ = writer.WriteField("mimeType", "image/png")
	part, _ := writer.CreateFormFile("file", "test.png")
	_, _ = part.Write([]byte("fake-png-data"))
	_ = writer.Close()

	req := httptest.NewRequest("POST", "/media-prep", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()
	h.mediaPrep(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	var res map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatalf("json decode error: %v", err)
	}
	if res["ok"] != true {
		t.Fatalf("ok != true: %+v", res)
	}
	inlineData, ok := res["inlineData"].(map[string]any)
	if !ok || inlineData["mimeType"] != "image/png" {
		t.Fatalf("unexpected inlineData: %+v", res)
	}
}
