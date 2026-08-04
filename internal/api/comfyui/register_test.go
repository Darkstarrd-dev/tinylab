package comfyui

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestProxyValidation(t *testing.T) {
	h := NewHandler(nil)
	r := chi.NewRouter()
	h.Register(r)
	cases := []struct {
		name string
		body string
		want int
	}{
		{"invalid JSON", "{", http.StatusBadRequest},
		{"invalid port", `{"port":0,"method":"GET","path":"/system_stats"}`, http.StatusBadRequest},
		{"invalid method", `{"port":8188,"method":"PUT","path":"/system_stats"}`, http.StatusBadRequest},
		{"invalid path", `{"port":8188,"method":"GET","path":"system_stats"}`, http.StatusBadRequest},
		{"path whitespace", `{"port":8188,"method":"GET","path":"/system stats"}`, http.StatusBadRequest},
		{"query newline", `{"port":8188,"method":"GET","path":"/view","query":"x=1\n"}`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/proxy", strings.NewReader(tc.body))
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}

func TestProxyForwardsToLocalComfyUI(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/system_stats" {
			t.Fatalf("upstream path = %s", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Fatalf("upstream method = %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"system":{"comfyui_version":"test"}}`)
	}))
	defer upstream.Close()

	// Bind the test server's handler port by replacing the package client with a
	// transport that sends the hard-coded loopback request to the test server.
	oldClient := comfyClient
	comfyClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		req.URL.Scheme = "http"
		req.URL.Host = strings.TrimPrefix(upstream.URL, "http://")
		return http.DefaultTransport.RoundTrip(req)
	})}
	defer func() { comfyClient = oldClient }()

	r := chi.NewRouter()
	NewHandler(nil).Register(r)
	req := httptest.NewRequest(http.MethodPost, "/proxy", strings.NewReader(`{"port":8188,"method":"GET","path":"/system_stats"}`))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != `{"system":{"comfyui_version":"test"}}` {
		t.Fatalf("body = %s", got)
	}
}
