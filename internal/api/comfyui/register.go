// Package comfyui provides a same-origin HTTP proxy to a local ComfyUI server.
//
// The Playground Image mode "comfyui" protocol drives a locally running
// ComfyUI (REST API + image download) from the browser. Browsers cannot read
// cross-origin responses from 127.0.0.1:{port} unless ComfyUI is started with
// --enable-cors-header, so the frontend posts proxy requests here and this
// handler forwards them to 127.0.0.1. The target host is hard-coded to
// loopback: the only caller-supplied values are the port, method, path and
// body, which keeps the surface small (no SSRF: nothing but the local
// machine's own services are ever reachable, and only GET/POST are allowed).
package comfyui

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
)

// proxyRequest is the JSON payload accepted by POST /api/comfyui/proxy.
type proxyRequest struct {
	Port   int             `json:"port"`
	Method string          `json:"method"`
	Path   string          `json:"path"`
	Query  string          `json:"query,omitempty"`
	Body   json.RawMessage `json:"body,omitempty"`
}

// Handler wires up the ComfyUI proxy routes.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new ComfyUI proxy Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register adds the ComfyUI proxy and local Desktop-tab routes.
func (h *Handler) Register(r chi.Router) {
	r.Post("/proxy", h.proxy)
	r.Get("/active", h.active)
}

var activeWorkflowReader = readActiveWorkflow

func (h *Handler) active(w http.ResponseWriter, r *http.Request) {
	workflow, err := activeWorkflowReader()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "active ComfyUI workflow not found")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(workflow)
}

// comfyClient bounds a single proxied call and rejects redirects that leave
// the exact loopback port requested by the caller. This preserves the
// localhost-only contract even if ComfyUI (or a local service) returns a
// malicious redirect.
var comfyClient = &http.Client{
	Timeout: 60 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("too many redirects")
		}
		if req.URL.Hostname() != "127.0.0.1" || req.URL.Port() != via[0].URL.Port() {
			return fmt.Errorf("redirect outside requested ComfyUI port")
		}
		return nil
	},
}

func (h *Handler) httpClient() *http.Client {
	if h.d != nil && h.d.TestClient != nil {
		return h.d.TestClient
	}
	return comfyClient
}

// proxy forwards a single HTTP call to http://127.0.0.1:{port}{path}?{query}
// and streams the response back verbatim (status, Content-Type, body).
func (h *Handler) proxy(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "failed to read request body")
		return
	}
	var req proxyRequest
	if err := json.Unmarshal(body, &req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate port: only local ComfyUI instances are reachable.
	if req.Port < 1 || req.Port > 65535 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "port must be 1-65535")
		return
	}
	// Validate method: the ComfyUI API surface we proxy only needs GET/POST.
	method := strings.ToUpper(req.Method)
	if method != http.MethodGet && method != http.MethodPost {
		apibase.WriteAPIError(w, http.StatusBadRequest, "method must be GET or POST")
		return
	}
	// Validate path: must be an absolute path with no whitespace/backslash,
	// so it can never escape the URL space or smuggle extra request lines.
	if !strings.HasPrefix(req.Path, "/") || strings.ContainsAny(req.Path, " \t\r\n\\") || len(req.Path) > 1024 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid path")
		return
	}
	if strings.ContainsAny(req.Query, "\r\n") || len(req.Query) > 4096 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid query")
		return
	}

	target := "http://127.0.0.1:" + strconv.Itoa(req.Port) + req.Path
	if req.Query != "" {
		target += "?" + req.Query
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	upReq, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(req.Body))
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "failed to build upstream request")
		return
	}
	if req.Body != nil && len(req.Body) > 0 {
		upReq.Header.Set("Content-Type", "application/json")
	}

	resp, err := h.httpClient().Do(upReq)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway,
			fmt.Sprintf("failed to reach ComfyUI at 127.0.0.1:%d: %v", req.Port, err))
		return
	}
	defer resp.Body.Close()

	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(resp.StatusCode)
	// Images and JSON are both streamed through; no size cap on a localhost pipe.
	_, _ = io.Copy(w, resp.Body)
}
