package imagebatch

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeImageProxy struct {
	body    []byte
	headers http.Header
}

func (f fakeImageProxy) ImagesGenerations(w http.ResponseWriter, r *http.Request) {
	if r.Context().Err() != nil {
		return
	}
	if r.Header.Get("X-TinyRouter-Source") != "playground-batch" {
		http.Error(w, "source", 400)
		return
	}
	if r.Header.Get("X-TinyRouter-Provenance") == "" {
		http.Error(w, "provenance", 400)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, _ = w.Write(f.body)
}

func testPNG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	im := image.NewRGBA(image.Rect(0, 0, 1, 1))
	im.Set(0, 0, color.RGBA{255, 0, 0, 255})
	if err := png.Encode(&b, im); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func TestRemoteGeneratorBase64AndValidation(t *testing.T) {
	img := testPNG(t)
	body, _ := json.Marshal(map[string]any{"data": []map[string]any{{"b64_json": stringBytesB64(img), "revised_prompt": "revised"}}})
	got, err := NewRemoteGenerator(fakeImageProxy{body: body}).Generate(context.Background(), ImageGenerationRequest{ProjectID: "p", PromptID: "q", VariantID: "v", Protocol: "gpt", Prompt: "cat"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Assets) != 1 || got.Assets[0].Width != 1 || got.Assets[0].Extension != "png" || got.RevisedPrompt != "revised" {
		t.Fatalf("unexpected result: %+v", got)
	}
}
func stringBytesB64(b []byte) string {
	const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var out strings.Builder
	for i := 0; i < len(b); i += 3 {
		n := int(b[i]) << 16
		if i+1 < len(b) {
			n |= int(b[i+1]) << 8
		}
		if i+2 < len(b) {
			n |= int(b[i+2])
		}
		out.WriteByte(table[(n>>18)&63])
		out.WriteByte(table[(n>>12)&63])
		if i+1 < len(b) {
			out.WriteByte(table[(n>>6)&63])
		} else {
			out.WriteByte('=')
		}
		if i+2 < len(b) {
			out.WriteByte(table[n&63])
		} else {
			out.WriteByte('=')
		}
	}
	return out.String()
}

func TestRemoteGeneratorRejectsSSRFURL(t *testing.T) {
	body := []byte(`{"data":[{"url":"http://127.0.0.1/private.png"}]}`)
	_, err := NewRemoteGenerator(fakeImageProxy{body: body}).Generate(context.Background(), ImageGenerationRequest{Protocol: "xai", Prompt: "x"})
	if err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("expected SSRF rejection, got %v", err)
	}
}

type comfyRoundTrip func(*http.Request) (*http.Response, error)

func (f comfyRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestComfyGeneratorPromptHistoryView(t *testing.T) {
	img := testPNG(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _ = r }))
	defer server.Close()
	serverURL := strings.TrimPrefix(server.URL, "http://")
	client := &http.Client{Transport: comfyRoundTrip(func(r *http.Request) (*http.Response, error) {
		r.URL.Scheme = "http"
		r.URL.Host = serverURL
		return http.DefaultTransport.RoundTrip(r)
	})}
	workflow := map[string]any{"1": map[string]any{"class_type": "CLIPTextEncode", "inputs": map[string]any{"text": "old"}}}
	calls := 0
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch r.URL.Path {
		case "/prompt":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"prompt_id":"abc"}`)
		case "/history/abc":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"abc":{"outputs":{"9":{"images":[{"filename":"x.png","subfolder":"","type":"output"}]}}}}`)
		case "/view":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(img)
		default:
			http.NotFound(w, r)
		}
	})
	got, err := NewComfyGenerator(8188, workflow, WithComfyHTTPClient(client)).Generate(context.Background(), ImageGenerationRequest{Prompt: "new", Seed: ptr(7)})
	if err != nil {
		t.Fatal(err)
	}
	if calls < 3 || len(got.Assets) != 1 || got.Assets[0].Meta["promptId"] != "abc" {
		t.Fatalf("unexpected Comfy result: %+v calls=%d", got, calls)
	}
}
func ptr(v int64) *int64 { return &v }
