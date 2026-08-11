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

// fakeAsyncProxy implements both ImageProxyCaller and ImageTaskCaller so the
// ModelScope async path (submit -> poll -> asset) can be exercised without
// network. It captures the submit request (headers + body) and each poll URL.
type fakeAsyncProxy struct {
	submitBody    []byte
	pollBodies    [][]byte
	submitHeaders http.Header
	submitBodyRaw []byte
	pollHeaders   http.Header
	pollURLs      []string
	pollIdx       int
}

func (f *fakeAsyncProxy) ImagesGenerations(w http.ResponseWriter, r *http.Request) {
	if r.Context().Err() != nil {
		return
	}
	f.submitHeaders = r.Header.Clone()
	b, _ := io.ReadAll(r.Body)
	f.submitBodyRaw = b
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, _ = w.Write(f.submitBody)
}

func (f *fakeAsyncProxy) ImageTask(w http.ResponseWriter, r *http.Request) {
	if r.Context().Err() != nil {
		return
	}
	if f.pollHeaders == nil {
		f.pollHeaders = r.Header.Clone()
	}
	f.pollURLs = append(f.pollURLs, r.URL.String())
	idx := f.pollIdx
	f.pollIdx++
	body := []byte(`{"output":{"task_status":"PENDING"}}`)
	if idx < len(f.pollBodies) {
		body = f.pollBodies[idx]
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, _ = w.Write(body)
}

func TestRemoteGeneratorModelScopeAsyncPoll(t *testing.T) {
	img := testPNG(t)
	poll := []byte(`{"output":{"task_status":"SUCCEEDED","results":[{"b64_json":"` + stringBytesB64(img) + `"}]}}`)
	f := &fakeAsyncProxy{
		submitBody: []byte(`{"output":{"task_id":"task-1"}}`),
		pollBodies: [][]byte{poll},
	}
	got, err := NewRemoteGenerator(f).Generate(context.Background(), ImageGenerationRequest{ProjectID: "p", PromptID: "q", VariantID: "v", Protocol: "modelscope", Model: "modelscope/qwen", Prompt: "a cat"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.Assets) != 1 || got.Assets[0].Extension != "png" {
		t.Fatalf("expected 1 png asset, got %+v", got.Assets)
	}
	if f.submitHeaders.Get("X-Modelscope-Async-Mode") != "true" {
		t.Fatal("X-Modelscope-Async-Mode header not set on submit")
	}
	if len(f.pollURLs) != 1 {
		t.Fatalf("expected exactly 1 poll, got %d", len(f.pollURLs))
	}
	if !strings.Contains(f.pollURLs[0], "model=modelscope") {
		t.Fatalf("poll URL missing model query: %s", f.pollURLs[0])
	}
	if f.pollHeaders.Get("X-Modelscope-Task-Type") != "image_generation" {
		t.Fatal("X-Modelscope-Task-Type header not set on poll")
	}
	if bytes.Contains(f.submitBodyRaw, []byte(`"n":1`)) {
		t.Fatal("n:1 must not be forced for ModelScope")
	}
}

func TestRemoteGeneratorModelScopeAsyncFailed(t *testing.T) {
	f := &fakeAsyncProxy{
		submitBody: []byte(`{"output":{"task_id":"task-2"}}`),
		pollBodies: [][]byte{[]byte(`{"output":{"task_status":"FAILED","message":"boom"}}`)},
	}
	_, err := NewRemoteGenerator(f).Generate(context.Background(), ImageGenerationRequest{Protocol: "modelscope", Model: "modelscope/qwen", Prompt: "x"})
	if err == nil || !strings.Contains(err.Error(), "FAILED") || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("expected FAILED:boom error, got %v", err)
	}
}

func TestRemoteGeneratorModelScopeSyncResults(t *testing.T) {
	img := testPNG(t)
	body := []byte(`{"output":{"task_status":"SUCCEEDED","results":[{"b64_json":"` + stringBytesB64(img) + `"}]}}`)
	f := &fakeAsyncProxy{submitBody: body}
	got, err := NewRemoteGenerator(f).Generate(context.Background(), ImageGenerationRequest{Protocol: "modelscope", Model: "modelscope/qwen", Prompt: "x"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.Assets) != 1 {
		t.Fatalf("expected 1 asset, got %d", len(got.Assets))
	}
	if len(f.pollURLs) != 0 {
		t.Fatalf("expected no polling for sync results, got %d polls", len(f.pollURLs))
	}
}

func TestRemoteGeneratorNonModelScopeDefaults(t *testing.T) {
	img := testPNG(t)
	body, _ := json.Marshal(map[string]any{"data": []map[string]any{{"b64_json": stringBytesB64(img)}}})
	f := &fakeAsyncProxy{submitBody: body}
	_, err := NewRemoteGenerator(f).Generate(context.Background(), ImageGenerationRequest{Protocol: "gpt", Model: "gpt/image", Prompt: "x"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.submitHeaders.Get("X-Modelscope-Async-Mode") != "" {
		t.Fatal("X-Modelscope-Async-Mode must be absent for non-ModelScope")
	}
	if !bytes.Contains(f.submitBodyRaw, []byte(`"n":1`)) {
		t.Fatal("n:1 must default to 1 for non-ModelScope")
	}
}
