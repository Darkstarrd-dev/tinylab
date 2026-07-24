package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/proxy"
)

// Protocol identifiers (mirror config.Protocol* constants; defined locally so
// probe helpers can be referenced without importing config in callers that only
// need the literal values).
const (
	probeProtocolOpenAICompat    = "openai-compat"
	probeProtocolOpenAIResponses = "openai-responses"
	probeProtocolAnthropic       = "anthropic"
	probeProtocolOpenAIEmbedding = "openai-embedding"
)

// ProbeResult is the outcome of probing a single protocol entry point for a model.
type ProbeResult struct {
	Protocol        string         // "openai-compat" / "openai-responses" / "anthropic" / "openai-embedding"
	Ok              bool           // resp.StatusCode == 200 and body has no error field
	Status          int            // HTTP status code
	LatencyMs       int64          // round-trip latency in milliseconds
	OutputTokens    int            // extracted or estimated output token count
	TokensPerSec    float64        // speed in tokens per second
	EmbeddingDim    int            // embedding vector dimension (only for openai-embedding protocol)
	Error           string         // human-readable error (empty on success)
	Request         map[string]any // {method, url, headers, body, bodyRaw}
	ResponseHeaders map[string][]string
	ResponseBody    any // JSON-parsed response body; nil if not parseable
	ResponseBodyRaw string
	Skipped         bool // true if the probe was skipped (e.g. no key available)
}

// probeQuotaHook is invoked (when non-nil) on a successful probe so the caller
// can extract quota info from the response headers. It is intentionally decoupled
// from the probe helpers so the helpers remain testable with a mocked upstream
// without requiring a Registry/quotaTracker.
type probeQuotaHook func(model string, resp *http.Response)

const probeTestPrompt = "generate 100 tokens self introduction"

// probeEmbeddingTestInput is the input text used for embedding model probes.
// Chosen to be a meaningful sentence that exercises the embedding model.
const probeEmbeddingTestInput = "The quick brown fox jumps over the lazy dog near a river at sunset."

// probeOpenAICompat sends an /v1/chat/completions probe request (OpenAI Chat
// Completions compatible). Body: {model, messages:[{role:"user",content:probeTestPrompt}],
// max_tokens:150, stream:false}. Auth: Authorization: Bearer <key>.
func probeOpenAICompat(ctx context.Context, client *http.Client, baseURL, model, apiKey string, onOK probeQuotaHook) ProbeResult {
	const path = "/v1/chat/completions"
	url := proxy.BuildUpstreamURL(baseURL, path)
	body := map[string]any{
		"model":      model,
		"messages":   []map[string]any{{"role": "user", "content": probeTestPrompt}},
		"max_tokens": 150,
		"stream":     false,
	}
	return doProbe(ctx, client, probeProtocolOpenAICompat, http.MethodPost, url, "application/json", "Authorization", "Bearer "+apiKey, body, onOK)
}

// probeOpenAIResponses sends an /v1/responses probe request (OpenAI Responses API).
// Body: {model, input:[{role:"user",content:probeTestPrompt}], max_output_tokens:150, stream:false}.
// Auth: Authorization: Bearer <key>.
func probeOpenAIResponses(ctx context.Context, client *http.Client, baseURL, model, apiKey string, onOK probeQuotaHook) ProbeResult {
	const path = "/v1/responses"
	url := proxy.BuildUpstreamURL(baseURL, path)
	body := map[string]any{
		"model":             model,
		"input":             []map[string]any{{"role": "user", "content": probeTestPrompt}},
		"max_output_tokens": 150,
		"stream":            false,
	}
	return doProbe(ctx, client, probeProtocolOpenAIResponses, http.MethodPost, url, "application/json", "Authorization", "Bearer "+apiKey, body, onOK)
}

// probeAnthropic sends an /v1/messages probe request (Anthropic Messages API).
// Body: {model, max_tokens:150, messages:[{role:"user",content:probeTestPrompt}], stream:false}.
// Auth: x-api-key: <key> + anthropic-version: 2023-06-01.
func probeAnthropic(ctx context.Context, client *http.Client, baseURL, model, apiKey string, onOK probeQuotaHook) ProbeResult {
	const path = "/v1/messages"
	url := proxy.BuildUpstreamURL(baseURL, path)
	body := map[string]any{
		"model":      model,
		"max_tokens": 150,
		"messages":   []map[string]any{{"role": "user", "content": probeTestPrompt}},
		"stream":     false,
	}
	return doProbe(ctx, client, probeProtocolAnthropic, http.MethodPost, url, "application/json", "x-api-key", apiKey, body, onOK, "anthropic-version", "2023-06-01")
}

// probeOpenAIEmbedding sends an /v1/embeddings probe request (OpenAI Embeddings API).
// Body: {model, input:probeEmbeddingTestInput}. Auth: Authorization: Bearer <key>.
// Validates response format: expects {data:[{embedding:[float64]}]}, extracts dimension.
func probeOpenAIEmbedding(ctx context.Context, client *http.Client, baseURL, model, apiKey string, onOK probeQuotaHook) ProbeResult {
	const path = "/v1/embeddings"
	url := proxy.BuildUpstreamURL(baseURL, path)
	body := map[string]any{
		"model": model,
		"input": probeEmbeddingTestInput,
	}
	res := doProbe(ctx, client, probeProtocolOpenAIEmbedding, http.MethodPost, url, "application/json", "Authorization", "Bearer "+apiKey, body, onOK)
	// Validate embedding response format and extract dimension
	if res.Ok {
		dim, err := extractEmbeddingDim(res.ResponseBodyRaw)
		if err != "" {
			res.Ok = false
			res.Error = "invalid embedding response: " + err
		} else {
			res.EmbeddingDim = dim
		}
	}
	return res
}

// doProbe performs a single JSON POST probe and normalizes the result into a
// ProbeResult. authKey/authVal set the primary auth header; extraHeaders is a
// variadic list of additional header key/value pairs.
func doProbe(ctx context.Context, client *http.Client, protocol, method, url, contentType, authKey, authVal string, body map[string]any, onOK probeQuotaHook, extraHeaders ...string) ProbeResult {
	res := ProbeResult{Protocol: protocol}

	rawBody, err := json.Marshal(body)
	if err != nil {
		res.Error = "failed to encode request: " + err.Error()
		return res
	}
	rawStr := string(rawBody)

	var parsedReqBody any = rawStr
	if j := map[string]any{}; json.Unmarshal(rawBody, &j) == nil {
		parsedReqBody = j
	}

	req, err := http.NewRequestWithContext(ctx, method, url, strings.NewReader(rawStr))
	if err != nil {
		res.Error = "invalid URL: " + err.Error()
		return res
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set(authKey, authVal)
	for i := 0; i+1 < len(extraHeaders); i += 2 {
		req.Header.Set(extraHeaders[i], extraHeaders[i+1])
	}

	start := time.Now()
	resp, err := client.Do(req)
	res.LatencyMs = time.Since(start).Milliseconds()
	if err != nil {
		res.Error = err.Error()
		res.Status = 0
		safe := redactAuth(req.Header)
		res.Request = map[string]any{
			"method":  method,
			"url":     url,
			"headers": headerToMap(safe),
			"body":    parsedReqBody,
			"bodyRaw": rawStr,
		}
		return res
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	raw := string(respBody)
	var parsedResp any = raw
	if j := map[string]any{}; json.Unmarshal(respBody, &j) == nil {
		parsedResp = j
	}
	res.Status = resp.StatusCode
	res.ResponseHeaders = headerToMap(resp.Header)
	res.ResponseBody = parsedResp
	res.ResponseBodyRaw = raw

	var errMsg string
	statusText := http.StatusText(resp.StatusCode)
	statusCode := strconv.Itoa(resp.StatusCode)
	ok := resp.StatusCode == http.StatusOK
	if !ok {
		errMsg = "upstream returned " + statusText + " (status " + statusCode + ")"
		if e := extractErrorMsg(raw); e != "" {
			errMsg = "upstream returned " + statusText + " (status " + statusCode + "): " + e
		}
	}
	if ok {
		if e := extractErrorMsg(raw); e != "" {
			ok = false
			errMsg = "upstream returned " + statusText + " (status " + statusCode + "): " + e
		}
	}
	res.Ok = ok
	res.Error = errMsg

	if ok {
		res.OutputTokens = extractOutputTokens(raw)
		if res.LatencyMs > 0 && res.OutputTokens > 0 {
			res.TokensPerSec = float64(res.OutputTokens) / (float64(res.LatencyMs) / 1000.0)
		}
		if onOK != nil {
			onOK(protocol, resp)
		}
	}

	safe := redactAuth(req.Header)
	res.Request = map[string]any{
		"method":  method,
		"url":     url,
		"headers": headerToMap(safe),
		"body":    parsedReqBody,
		"bodyRaw": rawStr,
	}
	return res
}

// extractErrorMsg pulls a top-level "error.message" (object or string) from a
// raw JSON response body. Returns "" when no error is present.
func extractErrorMsg(raw string) string {
	var errResp map[string]any
	if json.Unmarshal([]byte(raw), &errResp) != nil {
		return ""
	}
	if e, ok := errResp["error"].(map[string]any); ok {
		if msg, ok := e["message"].(string); ok {
			return msg
		}
	} else if e, ok := errResp["error"].(string); ok {
		return e
	}
	return ""
}

// redactAuth returns a clone of h with the auth headers removed before logging.
func redactAuth(h http.Header) http.Header {
	safe := h.Clone()
	safe.Del("Authorization")
	safe.Del("X-Api-Key")
	safe.Del("x-api-key")
	return safe
}

// keyTestResult is the per-key outcome of the "test all keys" batch probe.
type keyTestResult struct {
	KeyID        string  `json:"keyId"`
	KeyName      string  `json:"keyName"`
	Ok           bool    `json:"ok"`
	TTFTMs       int64   `json:"ttftMs"`
	LatencyMs    int64   `json:"latencyMs"`
	InputTokens  int     `json:"inputTokens"`
	OutputTokens int     `json:"outputTokens"`
	TokensPerSec float64 `json:"tokensPerSec"`
	Status       int     `json:"status"`
	Error        string  `json:"error,omitempty"`
	QuotaRemain  int     `json:"quotaRemain,omitempty"`
	QuotaTotal   int     `json:"quotaTotal,omitempty"`
}

// testAllKeysPrompt is sent to each key during the "test all keys" batch probe.
const testAllKeysPrompt = "generate 100 tokens self introduction"

// extractOutputTokens parses output token count from an upstream response body.
// It checks standard JSON usage fields (completion_tokens, output_tokens), or
// estimates tokens based on generated text content if usage is missing.
func extractOutputTokens(raw string) int {
	var resp map[string]any
	if json.Unmarshal([]byte(raw), &resp) != nil {
		return 0
	}
	if usage, ok := resp["usage"].(map[string]any); ok {
		if ct, ok := usage["completion_tokens"].(float64); ok && ct > 0 {
			return int(ct)
		}
		if ot, ok := usage["output_tokens"].(float64); ok && ot > 0 {
			return int(ot)
		}
	}
	text := extractTextFromResponse(resp)
	if len(text) > 0 {
		runes := []rune(text)
		est := int(float64(len(runes)) / 3.5)
		if est < 1 {
			est = 1
		}
		return est
	}
	return 0
}

// extractTextFromResponse tries to extract generated text from OpenAI compat,
// OpenAI responses, or Anthropic response JSONs.
func extractTextFromResponse(resp map[string]any) string {
	var sb strings.Builder
	if choices, ok := resp["choices"].([]any); ok && len(choices) > 0 {
		if choice, ok := choices[0].(map[string]any); ok {
			if msg, ok := choice["message"].(map[string]any); ok {
				if content, ok := msg["content"].(string); ok {
					sb.WriteString(content)
				}
			} else if text, ok := choice["text"].(string); ok {
				sb.WriteString(text)
			}
		}
	}
	if output, ok := resp["output"].([]any); ok && len(output) > 0 {
		for _, item := range output {
			if m, ok := item.(map[string]any); ok {
				if content, ok := m["content"].([]any); ok {
					for _, c := range content {
						if cm, ok := c.(map[string]any); ok {
							if text, ok := cm["text"].(string); ok {
								sb.WriteString(text)
							}
						}
					}
				}
			}
		}
	}
	if content, ok := resp["content"].([]any); ok && len(content) > 0 {
		for _, c := range content {
			if cm, ok := c.(map[string]any); ok {
				if text, ok := cm["text"].(string); ok {
					sb.WriteString(text)
				}
			}
		}
	}
	return sb.String()
}

// extractContentFromSSE extracts the text content (both delta.content and
// delta.reasoning_content) from a single SSE data chunk JSON payload.
func extractContentFromSSE(body []byte) string {
	var resp map[string]any
	if err := json.Unmarshal(body, &resp); err != nil {
		return ""
	}
	choices, ok := resp["choices"].([]any)
	if !ok || len(choices) == 0 {
		return ""
	}
	choice, ok := choices[0].(map[string]any)
	if !ok {
		return ""
	}
	delta, ok := choice["delta"].(map[string]any)
	if !ok {
		return ""
	}
	var sb strings.Builder
	if c, ok := delta["content"].(string); ok {
		sb.WriteString(c)
	}
	if rc, ok := delta["reasoning_content"].(string); ok {
		sb.WriteString(rc)
	}
	return sb.String()
}

// headerToMap converts an http.Header to a map[string][]string,
// preserving multi-value structure without filtering or merging.
func headerToMap(h http.Header) map[string][]string {
	m := make(map[string][]string, len(h))
	for k, v := range h {
		m[k] = v
	}
	return m
}

// extractEmbeddingDim parses the embedding vector dimension from an upstream
// /v1/embeddings response body. Expects {data:[{embedding:[float64]}]}.
// Returns (dimension, "") on success or (0, errorMessage) on failure.
func extractEmbeddingDim(raw string) (int, string) {
	var resp map[string]any
	if err := json.Unmarshal([]byte(raw), &resp); err != nil {
		return 0, "response is not valid JSON"
	}
	dataArr, ok := resp["data"].([]any)
	if !ok || len(dataArr) == 0 {
		return 0, "missing or empty 'data' array"
	}
	firstObj, ok := dataArr[0].(map[string]any)
	if !ok {
		return 0, "first data element is not an object"
	}
	embeddingArr, ok := firstObj["embedding"].([]any)
	if !ok {
		return 0, "missing or invalid 'embedding' array"
	}
	if len(embeddingArr) == 0 {
		return 0, "embedding array is empty"
	}
	return len(embeddingArr), ""
}
