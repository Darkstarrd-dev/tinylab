package proxy

import (
	"bytes"
	"context"
	"net/http"
	"net/url"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/urlutil"
)

// upstreamClientFor returns the non-streaming upstream client for sel: the
// proxy-routed client when sel.Provider.UseProxy is set AND a proxy URL is
// configured, else the direct client. See clientFor for the timeout handling.
func (h *Handler) upstreamClientFor(sel *rotation.SelectedKey) *http.Client {
	if sel.Provider.UseProxy {
		if pu, _ := h.proxyURL.Load().(*url.URL); pu != nil {
			return h.clientFor(h.proxyClient)
		}
	}
	return h.clientFor(h.client)
}

// streamClientFor returns the streaming upstream client for sel (unbounded
// timeout; connection lifecycle follows the request context).
func (h *Handler) streamClientFor(sel *rotation.SelectedKey) *http.Client {
	if sel.Provider.UseProxy {
		if pu, _ := h.proxyURL.Load().(*url.URL); pu != nil {
			return h.proxyStream
		}
	}
	return h.streamClient
}

func (h *Handler) forwardUpstream(ctx context.Context, sel *rotation.SelectedKey, body []byte, headers http.Header, isStream bool, path string, entryFormat combo.EntryFormat) (*http.Response, error) {

	var upstreamURL string
	var req *http.Request
	var err error

	// The upstream construction is chosen by the entry protocol, not by the
	// provider's APIType. A single aggregating provider may serve both the
	// anthropic (/v1/messages) and OpenAI (/v1/chat/completions) entry points,
	// so we must route by entryFormat rather than rejecting on provider type.
	switch {
	case entryFormat == combo.EntryFormatAnthropic:
		upstreamURL, req, err = buildUpstreamRequest(ctx, sel, body, "/v1/messages", false)
	case entryFormat == combo.EntryFormatOpenAIResponses:
		upstreamURL, req, err = buildUpstreamRequest(ctx, sel, body, "/v1/responses", true)
	default:
		upstreamURL = urlutil.BuildUpstreamURL(sel.Provider.BaseURL, path)
		req, err = http.NewRequestWithContext(ctx, "POST", upstreamURL, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+sel.Key.Key)
	}

	if err != nil {
		return nil, err
	}

	// OpenAI-specific passthrough headers (harmless for anthropic; anthropic
	// ignores them and they never include an Authorization for anthropic since
	// the branch above sets x-api-key instead).
	if ua := headers.Get("User-Agent"); ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	if am := headers.Get("X-Modelscope-Async-Mode"); am != "" {
		req.Header.Set("X-Modelscope-Async-Mode", am)
	}
	if tt := headers.Get("X-Modelscope-Task-Type"); tt != "" {
		req.Header.Set("X-Modelscope-Task-Type", tt)
	}
	if isStream {
		req.Header.Set("Accept", "text/event-stream")
	}
	// api.cline.bot gates cline-free/* models behind an x-client-type
	// product-surface header; inject for matching providers (replaces any
	// client-supplied value with a known-good one).
	applyClineHeaders(req, sel)

	if isStream {
		return h.streamClientFor(sel).Do(req)
	}
	return h.upstreamClientFor(sel).Do(req)
}

// buildUpstreamRequest constructs an upstream POST request for a provider
// speaking the given endpoint path. URL is built by BuildUpstreamURL with
// the heuristic-A logic handling raw-mode, host-root, and path-bearing bases
// uniformly. When authBearer is true, sets "Authorization: Bearer <key>";
// otherwise calls setAnthropicHeaders (x-api-key + anthropic-version + optional
// anthropic-beta).
func buildUpstreamRequest(ctx context.Context, sel *rotation.SelectedKey, body []byte, endpointPath string, authBearer bool) (string, *http.Request, error) {
	upstreamURL := urlutil.BuildUpstreamURL(sel.Provider.BaseURL, endpointPath)
	req, err := http.NewRequestWithContext(ctx, "POST", upstreamURL, bytes.NewReader(body))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if authBearer {
		req.Header.Set("Authorization", "Bearer "+sel.Key.Key)
	} else {
		setAnthropicHeaders(req, sel)
	}
	return upstreamURL, req, nil
}

// setAnthropicHeaders applies the Content-Type and Anthropic-specific auth
// headers to an outgoing upstream request. No Authorization header is set.
func setAnthropicHeaders(req *http.Request, sel *rotation.SelectedKey) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", sel.Key.Key)
	version := sel.Provider.AnthropicVersion
	if version == "" {
		version = "2023-06-01"
	}
	req.Header.Set("anthropic-version", version)
	if sel.Provider.AnthropicBeta != "" {
		req.Header.Set("anthropic-beta", sel.Provider.AnthropicBeta)
	}
}

// clineClientTypeHeaderValue marks a Cline product surface. cline-free/*
// models on api.cline.bot 403 without it; verified values are cline-cli and
// vscode. Harmless for paid models, which do not depend on it.
const clineClientTypeHeaderValue = "cline-cli"

// applyClineHeaders sets the x-client-type header when the provider targets
// api.cline.bot (Provider.IsCline). No-op for other providers.
func applyClineHeaders(req *http.Request, sel *rotation.SelectedKey) {
	if sel.Provider.IsCline() {
		req.Header.Set("X-Client-Type", clineClientTypeHeaderValue)
	}
}

func (h *Handler) forwardGetUpstream(ctx context.Context, sel *rotation.SelectedKey, path string, headers http.Header) (*http.Response, error) {
	upstreamURL := urlutil.BuildUpstreamURL(sel.Provider.BaseURL, path)
	req, err := http.NewRequestWithContext(ctx, "GET", upstreamURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+sel.Key.Key)
	if ua := headers.Get("User-Agent"); ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	if tt := headers.Get("X-Modelscope-Task-Type"); tt != "" {
		req.Header.Set("X-Modelscope-Task-Type", tt)
	}
	applyClineHeaders(req, sel)
	return h.upstreamClientFor(sel).Do(req)
}
