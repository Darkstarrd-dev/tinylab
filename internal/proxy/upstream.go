package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/customheaders"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/urlutil"
)

// readCloserOf wraps an interceptor-returned reader with the original body's
// closer: the interceptor replaced the content, but the proxy still owns the
// connection close.
func readCloserOf(r io.Reader, orig io.Closer) io.ReadCloser {
	return struct {
		io.Reader
		io.Closer
	}{r, orig}
}

// currentClientRequestKey is the context key used to carry the original client
// *http.Request through to forwardUpstream for the augmenter hook.
type currentClientRequestKey struct{}

// WithClientRequest returns a context carrying the original client request so
// forwardUpstream can hand it to the RequestAugmenter for bridged providers.
func WithClientRequest(ctx context.Context, r *http.Request) context.Context {
	return context.WithValue(ctx, currentClientRequestKey{}, r)
}

// isHopByHopHeader reports whether a header must not be forwarded upstream
// (RFC 2616 hop-by-hop + Go'shttp transport internals).
func isHopByHopHeader(name string) bool {
	switch http.CanonicalHeaderKey(name) {
	case "Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
		"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade":
		return true
	}
	return false
}

// upstreamClientFor returns the non-streaming upstream client for sel: the
// **per-key** egress client when the key carries its own proxy, else the
// proxy-routed client when sel.Provider.UseProxy is set AND a proxy URL is
// configured, else the direct client. See clientFor for the timeout handling.
//
// ⚠️ 顺序有意义：per-key 代理**优先于** provider 级开关（账号自己的出口是更具体
// 的意图；两者同时存在时以账号为准），而 provider 级开关**优先于**直连。
// 未设置 per-key 代理时走的就是原路径 —— 默认行为不变。
func (h *Handler) upstreamClientFor(sel *rotation.SelectedKey) *http.Client {
	if set, ok := h.keyProxyClientsFor(sel.Key.Proxy); ok {
		return h.clientFor(set.plain)
	}
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
	if set, ok := h.keyProxyClientsFor(sel.Key.Proxy); ok {
		return set.stream
	}
	if sel.Provider.UseProxy {
		if pu, _ := h.proxyURL.Load().(*url.URL); pu != nil {
			return h.proxyStream
		}
	}
	return h.streamClient
}

func (h *Handler) forwardUpstream(ctx context.Context, sel *rotation.SelectedKey, body []byte, headers http.Header, isStream bool, path string, entryFormat combo.EntryFormat, upstreamModel string) (*http.Response, error) {

	// Bridged provider hook: providers owned by an external augmenter (e.g.
	// jethub) get URL/body/headers rewritten just before send. The augmenter
	// mutates the client request's headers (its mutations become the outbound
	// header base — e.g. SDK-HMAC signature headers) and may replace the body.
	// A returned error is treated as a forwarding failure (the retry loop
	// classifies and retries/excludes).
	//
	// webhub (APIType=="webhub") is bridged too, but it has NO BaseURL — there
	// is no endpoint to dial. Its customizer drives a browser page and the
	// interceptor supplies the response body, so it takes the
	// endpoint-less branch below rather than a real HTTP send.
	if isBridgedAugmenterType(sel.Provider.APIType) && h.augmenter != nil {
		if clientReq, _ := ctx.Value(currentClientRequestKey{}).(*http.Request); clientReq != nil {
			augmented := body
			upstreamURL := urlutil.BuildUpstreamURL(sel.Provider.BaseURL, path)
			// Optional richer customizer: bridged providers whose outbound
			// URL is not derivable from the entry path (encrypted-inference
			// endpoints) supply the full URL. outURL == "" → default.
			if cu, ok := h.augmenter.(RequestCustomizer); ok {
				outURL, outBody, err := cu.Customize(clientReq, body, sel.Provider.ID, sel.Key.ID, upstreamModel)
				if err != nil {
					return nil, err
				}
				if outURL != "" {
					upstreamURL = outURL
				}
				if outBody != nil {
					augmented = outBody
				}
			} else if augmented2, err := h.augmenter.Augment(clientReq, body, sel.Provider.ID, sel.Key.ID, upstreamModel); err != nil {
				return nil, err
			} else {
				augmented = augmented2
			}
			body = augmented

			// Endpoint-less bridge (webhub): the customizer produced no URL and
			// the provider has no BaseURL, so there is nothing to dial. Hand
			// the request to the interceptor, which serves it from the browser
			// page and returns the response body. Without this branch the
			// proxy would POST to a URL built from an empty BaseURL.
			if upstreamURL == "" || strings.TrimSpace(sel.Provider.BaseURL) == "" {
				return h.serveBridgedWithoutEndpoint(ctx, clientReq, sel, body, isStream, upstreamModel)
			}

			req, err := http.NewRequestWithContext(ctx, "POST", upstreamURL, bytes.NewReader(body))
			if err != nil {
				return nil, err
			}
			// The augmented client headers ARE the outbound headers (minus
			// hop-by-hop fields and the loopback retry marker); the augmenter's
			// mutations propagate.
			for k, vs := range clientReq.Header {
				if isHopByHopHeader(k) || strings.EqualFold(k, RetryDropHeaderMarker) {
					continue
				}
				for _, v := range vs {
					req.Header.Add(k, v)
				}
			}
			// Generated auth/content-type come last so a bridged provider
			// always has sane defaults; the augmenter may have set its own
			// Authorization/Content-Type — those win (Set only when absent).
			if req.Header.Get("Content-Type") == "" {
				req.Header.Set("Content-Type", "application/json")
			}
			if req.Header.Get("Authorization") == "" {
				req.Header.Set("Authorization", "Bearer "+sel.Key.Key)
			}
			customheaders.Apply(req.Header, sel.Provider.UseCustomHeaders, sel.Provider.CustomHeaders)
			var resp *http.Response
			if isStream {
				req.Header.Set("Accept", "text/event-stream")
				resp, err = h.doStream(h.streamClientFor(sel), req, sel)
			} else {
				resp, err = h.upstreamClientFor(sel).Do(req)
			}
			if err != nil {
				return nil, err
			}
			// Optional response-side interception (envelope stripping /
			// queue / billing classification) before anything reaches the
			// client.
			if ri, ok := h.augmenter.(ResponseInterceptor); ok {
				outBody, retryAfterMs, ierr := ri.InterceptResponse(clientReq, resp, sel.Provider.ID, sel.Key.ID, upstreamModel, isStream)
				if ierr != nil {
					_ = resp.Body.Close()
					return nil, ierr
				}
				if retryAfterMs > 0 {
					_ = resp.Body.Close()
					return nil, &QueueRetryError{RetryAfter: time.Duration(retryAfterMs) * time.Millisecond}
				}
				if outBody != nil {
					resp.Body = readCloserOf(outBody, resp.Body)
				}
			}
			return resp, nil
		}
	}

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
	case entryFormat == combo.EntryFormatGoogle:
		realModel := ""
		cleanBody := body
		var m map[string]any
		if err := json.Unmarshal(body, &m); err == nil {
			if modelVal, ok := m["model"].(string); ok {
				realModel = modelVal
			}
			delete(m, "model")
			delete(m, "stream")
			if nb, err := json.Marshal(m); err == nil {
				cleanBody = nb
			}
		}
		upstreamURL = urlutil.BuildGoogleGenerateContentURL(sel.Provider.BaseURL, realModel, isStream)
		req, err = http.NewRequestWithContext(ctx, "POST", upstreamURL, bytes.NewReader(cleanBody))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("x-goog-api-key", sel.Key.Key)
		}
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
	// Per-provider custom headers augment the generated headers above and may
	// override same-named ones. applyClineHeaders below stays the final
	// hardcoded override so api.cline.bot always gets the known-good value.
	customheaders.Apply(req.Header, sel.Provider.UseCustomHeaders, sel.Provider.CustomHeaders)
	// api.cline.bot gates cline-free/* models behind an x-client-type
	// product-surface header; inject for matching providers (replaces any
	// client-supplied value with a known-good one).
	applyClineHeaders(req, sel)

	if isStream {
		return h.doStream(h.streamClientFor(sel), req, sel)
	}
	return h.upstreamClientFor(sel).Do(req)
}

// isBridgedAugmenterType reports whether an APIType is owned by the injected
// bridged-provider augmenter. jethub (HTTP protocol bridge) and webhub
// (browser page driver) are both bridged; everything else is a normal provider
// with a real upstream.
func isBridgedAugmenterType(apiType string) bool {
	return apiType == "jethub" || apiType == "webhub"
}

// serveBridgedWithoutEndpoint serves a bridged provider that has no HTTP
// endpoint (webhub): the interceptor drives the real work (operating a browser
// page) and returns the response body, which is wrapped in a synthetic
// *http.Response so the rest of the pipeline (usage recording, streaming,
// status handling) behaves exactly as it does for a real upstream.
func (h *Handler) serveBridgedWithoutEndpoint(ctx context.Context, clientReq *http.Request, sel *rotation.SelectedKey, body []byte, isStream bool, upstreamModel string) (*http.Response, error) {
	ri, ok := h.augmenter.(ResponseInterceptor)
	if !ok {
		return nil, fmt.Errorf("webhub: bridged provider %s has no endpoint and the augmenter cannot serve it", sel.Provider.ID)
	}
	// A placeholder response: the interceptor replaces its body. Status must
	// be 200 so the pipeline treats it as a successful upstream response; real
	// failures come back as an error from InterceptResponse and are classified
	// by the retry loop like any other attempt failure.
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{},
	}
	outBody, retryAfterMs, err := ri.InterceptResponse(clientReq, resp, sel.Provider.ID, sel.Key.ID, upstreamModel, isStream)
	if err != nil {
		return nil, err
	}
	if retryAfterMs > 0 {
		return nil, &QueueRetryError{RetryAfter: time.Duration(retryAfterMs) * time.Millisecond}
	}
	if outBody == nil {
		return nil, fmt.Errorf("webhub: bridge produced no response body")
	}
	resp.Body = readCloserOf(outBody, io.NopCloser(strings.NewReader("")))
	resp.Request = &http.Request{Method: "POST", URL: &url.URL{Scheme: "webhub", Host: sel.Provider.ID, Path: "/" + upstreamModel}}
	return resp, nil
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
	// Per-provider custom headers augment the generated headers above and may
	// override same-named ones. applyClineHeaders below stays the final
	// hardcoded override so api.cline.bot always gets the known-good value.
	customheaders.Apply(req.Header, sel.Provider.UseCustomHeaders, sel.Provider.CustomHeaders)
	applyClineHeaders(req, sel)
	return h.upstreamClientFor(sel).Do(req)
}
