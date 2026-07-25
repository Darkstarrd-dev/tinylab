package proxy

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
)

// versionSegmentRE matches a path segment like "v1", "v1beta", "v2", "v3", etc.
var versionSegmentRE = regexp.MustCompile(`^v\d+(?:beta|alpha)?$`)

// isOllamaBaseURL reports whether baseURL points at an Ollama instance: the
// public cloud (host "ollama.com") or a local default-port server (host
// localhost/127.0.0.1 on port 11434). Detection is purely string-based so it
// works without contacting the server (the local server may not be running).
func isOllamaBaseURL(baseURL string) bool {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	switch host {
	case "ollama.com":
		return true
	case "localhost", "127.0.0.1":
		return port == "11434"
	}
	return false
}

// normalizeOllamaBaseURL reduces any Ollama BaseURL to its host root by
// discarding the entire path (and query/fragment). Ollama serves a native API
// under /api/* and an OpenAI-compatible API under /v1/*; the project does no
// format conversion, so requests must always land on /v1/*. Whatever path the
// user entered (native forms like /api, /api/tags, /api/chat, or OpenAI forms
// like /v1, /v1/chat/completions), dropping the path lets BuildUpstreamURL's
// host-root branch inject /v1 uniformly.
func normalizeOllamaBaseURL(baseURL string) string {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return baseURL
	}
	u.Path = ""
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

// normalizeBaseURL strips known endpoint suffixes so the URL ends at the API root.
// Stripping is done longest-first so "/v1/chat/completions" is removed before
// "/chat/completions".  This method does NOT strip trailing version segments
// (e.g. "/v1", "/v1beta", "/v2"); version-segment detection is handled by
// BuildUpstreamURL's heuristic A.
//
// Examples:
//
//	"https://api.example.com/v1/chat/completions" → "https://api.example.com"
//	"https://api.example.com/v1/models"            → "https://api.example.com"
//	"https://api.example.com/chat/completions"     → "https://api.example.com"
func normalizeBaseURL(baseURL string) string {
	baseURL = strings.TrimSpace(baseURL)
	baseURL = strings.TrimSuffix(baseURL, "/")
	// Longest-first ordering avoids partial matches (e.g. "/v1/chat/completions"
	// must be checked before "/chat/completions").
	for _, suffix := range []string{
		"/v1/chat/completions",
		"/v1/images/generations",
		"/chat/completions",
		"/v1/responses",
		"/v1/completions",
		"/v1/messages",
		"/v1/models",
		"/images/generations",
		"/completions",
		"/responses",
		"/messages",
		"/models",
	} {
		if strings.HasSuffix(baseURL, suffix) {
			baseURL = baseURL[:len(baseURL)-len(suffix)]
			break
		}
	}
	return baseURL
}

// BuildUpstreamURL constructs the full upstream URL from a base URL and an endpoint path.
// endpointPath is like "/v1/chat/completions" or "/v1/messages".
//
// Three base URL forms are supported:
//   - Raw mode: a trailing '*' means the trimmed prefix is the exact endpoint and is
//     returned unchanged (no normalization or suffix handling).
//   - Host root (no path, e.g. "https://api.deepseek.com"): the "/v1" prefix is injected
//     and the endpointPath suffix (after stripping "/v1") is appended.
//   - Path-bearing base (e.g. "https://generativelanguage.googleapis.com/v1beta/openai"):
//     heuristic A determines whether the path already contains a version segment (v1,
//     v1beta, v2, v3, …). If yes, no "/v1" is injected; if no, "/v1" is injected before
//     the endpointPath suffix.
//
// Heuristic A: after normalization, the URL path is split into segments. If any segment
// matches the pattern /^v\d+(beta|alpha)?$/ (e.g. "v1", "v1beta", "v2"), the base is
// considered to already carry a version prefix and "/v1" is NOT injected. Otherwise
// "/v1" is injected to ensure the final URL matches the expected endpoint format.
func BuildUpstreamURL(baseURL, endpointPath string) string {
	trimmed := strings.TrimSpace(baseURL)

	// 1) Raw mode: trailing '*' marks the prefix as the complete endpoint.
	if strings.HasSuffix(trimmed, "*") {
		return strings.TrimRight(strings.TrimSuffix(trimmed, "*"), "/")
	}

	// Ollama special case: drop the user-entered path entirely so the request
	// always lands on Ollama's OpenAI-compatible /v1/* endpoints (the project
	// does no format conversion; the native /api/* endpoints use a different
	// request/response/streaming shape). Whatever the user typed (/api,
	// /api/chat, /v1, /v1/chat/completions, …) is reduced to the host root and
	// the host-root branch below injects /v1 uniformly.
	if isOllamaBaseURL(trimmed) {
		trimmed = normalizeOllamaBaseURL(trimmed)
	}

	normalized := normalizeBaseURL(trimmed)
	suffix := strings.TrimPrefix(endpointPath, "/v1") // "/v1/chat/completions" -> "/chat/completions"

	// 2) Host root (no path) -> inject "/v1" then append the endpointPath suffix.
	if isHostRoot(normalized) {
		return normalized + "/v1" + suffix
	}

	// 3) Path-bearing base: check if any path segment is a version identifier.
	parsed, err := url.Parse(normalized)
	if err == nil {
		segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
		for _, seg := range segments {
			if versionSegmentRE.MatchString(seg) {
				// Base already has a version segment; do NOT inject "/v1".
				return normalized + suffix
			}
		}
	}

	// No version segment found -> inject "/v1".
	return normalized + "/v1" + suffix
}

// isHostRoot reports whether base has no path beyond the host (e.g. "https://api.deepseek.com").
func isHostRoot(base string) bool {
	u, err := url.Parse(base)
	if err != nil {
		return false
	}
	return u.Path == "" || u.Path == "/"
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
		upstreamURL, req, err = buildAnthropicUpstreamRequest(ctx, sel, body, headers, isStream)
	case entryFormat == combo.EntryFormatOpenAIResponses:
		upstreamURL, req, err = buildResponsesUpstreamRequest(ctx, sel, body, isStream)
	default:
		upstreamURL = BuildUpstreamURL(sel.Provider.BaseURL, path)
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

// buildAnthropicUpstreamRequest constructs an upstream POST request for a
// provider speaking the Anthropic Messages API. It differs from the OpenAI path
// in two ways:
//
//   - URL: built by BuildUpstreamURL with endpointPath "/v1/messages". The
//     heuristic-A logic handles raw-mode, host-root, and path-bearing bases
//     uniformly.
//   - Auth: instead of "Authorization: Bearer <key>", it sets "x-api-key: <key>"
//     plus "anthropic-version" (default "2023-06-01") and, when configured,
//     "anthropic-beta". No Authorization header is set.
func buildAnthropicUpstreamRequest(ctx context.Context, sel *rotation.SelectedKey, body []byte, headers http.Header, isStream bool) (string, *http.Request, error) {
	upstreamURL := BuildUpstreamURL(sel.Provider.BaseURL, "/v1/messages")
	req, err := http.NewRequestWithContext(ctx, "POST", upstreamURL, strings.NewReader(string(body)))
	if err != nil {
		return "", nil, err
	}
	setAnthropicHeaders(req, sel)
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

// buildResponsesUpstreamRequest constructs an upstream POST request for a
// provider speaking the OpenAI Responses API (/v1/responses). URL is built by
// BuildUpstreamURL with endpointPath "/v1/responses"; the heuristic-A logic
// handles raw-mode, host-root, and path-bearing bases uniformly.
//
// Auth uses the standard "Authorization: Bearer <key>" header (NOT x-api-key),
// mirroring the OpenAI chat entry. No anthropic-version / anthropic-beta headers
// are set.
func buildResponsesUpstreamRequest(ctx context.Context, sel *rotation.SelectedKey, body []byte, isStream bool) (string, *http.Request, error) {
	upstreamURL := BuildUpstreamURL(sel.Provider.BaseURL, "/v1/responses")
	req, err := http.NewRequestWithContext(ctx, "POST", upstreamURL, strings.NewReader(string(body)))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+sel.Key.Key)
	return upstreamURL, req, nil
}

func (h *Handler) forwardGetUpstream(ctx context.Context, sel *rotation.SelectedKey, path string, headers http.Header) (*http.Response, error) {
	upstreamURL := BuildUpstreamURL(sel.Provider.BaseURL, path)
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
