package proxy

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/urlutil"
)


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
		req, err = http.NewRequestWithContext(ctx, "POST", upstreamURL, strings.NewReader(string(body)))
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

	var httpClient *http.Client
	if sel.Provider.UseProxy {
		if pu, _ := h.proxyURL.Load().(*url.URL); pu != nil {
			httpClient = h.proxyClient
		} else {
			httpClient = h.client
		}
	} else {
		httpClient = h.client
	}
	if isStream {
		if httpClient == h.proxyClient {
			return h.proxyStream.Do(req)
		}
		return h.streamClient.Do(req)
	}
	return httpClient.Do(req)
}

// buildUpstreamRequest constructs an upstream POST request for a provider
// speaking the given endpoint path. URL is built by BuildUpstreamURL with
// the heuristic-A logic handling raw-mode, host-root, and path-bearing bases
// uniformly. When authBearer is true, sets "Authorization: Bearer <key>";
// otherwise calls setAnthropicHeaders (x-api-key + anthropic-version + optional
// anthropic-beta).
func buildUpstreamRequest(ctx context.Context, sel *rotation.SelectedKey, body []byte, endpointPath string, authBearer bool) (string, *http.Request, error) {
	upstreamURL := urlutil.BuildUpstreamURL(sel.Provider.BaseURL, endpointPath)
	req, err := http.NewRequestWithContext(ctx, "POST", upstreamURL, strings.NewReader(string(body)))
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
	return h.client.Do(req)
}
