package imagebatch

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/outbound"
)

// ImageProxyCaller is the deliberately narrow interface used to invoke the
// normal image proxy without exposing provider credentials to imagebatch.
type ImageProxyCaller interface {
	ImagesGenerations(http.ResponseWriter, *http.Request)
}

type ImageEditsCaller interface {
	ImagesEdits(http.ResponseWriter, *http.Request)
}

// ImageTaskCaller is optional support for providers which return an async task.
// The normal proxy does not need to implement it; callers that support task
// polling may expose it alongside ImageProxyCaller.
type ImageTaskCaller interface {
	ImageTask(http.ResponseWriter, *http.Request)
}

type RemoteGeneratorOption func(*RemoteGenerator)

func WithRemoteHTTPClient(c *http.Client) RemoteGeneratorOption {
	return func(g *RemoteGenerator) {
		if c != nil {
			g.client = c
			// A custom client is responsible for its own outbound behavior;
			// skip the SSRF pre-check so tests on loopback servers work.
			g.enforcePolicy = false
		}
	}
}
func WithRemoteMaxImageBytes(n int64) RemoteGeneratorOption {
	return func(g *RemoteGenerator) {
		if n > 0 {
			g.maxBytes = n
		}
	}
}

// RemoteGenerator adapts OpenAI-compatible GPT, xAI and ModelScope image APIs.
type RemoteGenerator struct {
	caller   ImageProxyCaller
	client   *http.Client
	maxBytes int64
	policy   outbound.Policy
	// enforcePolicy applies the SSRF policy in fetchImage before the request
	// (fail-fast). It is disabled only when a custom client was injected via
	// WithRemoteHTTPClient, which takes responsibility for its own dialing.
	enforcePolicy bool
}

func NewRemoteGenerator(caller ImageProxyCaller, opts ...RemoteGeneratorOption) *RemoteGenerator {
	g := &RemoteGenerator{
		caller:        caller,
		client:        safeImageClient(),
		maxBytes:      32 << 20,
		policy:        outbound.Policy{Timeout: 60 * time.Second},
		enforcePolicy: true,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(g)
		}
	}
	return g
}

func (g *RemoteGenerator) Generate(ctx context.Context, req ImageGenerationRequest) (ImageGenerationResult, error) {
	started := time.Now()
	if g == nil || g.caller == nil {
		return ImageGenerationResult{}, errors.New("image proxy unavailable")
	}
	if err := ctx.Err(); err != nil {
		return ImageGenerationResult{}, err
	}
	body := map[string]any{"model": req.Model, "prompt": req.Prompt}
	for k, v := range req.Params {
		body[k] = v
	}
	if req.NegativePrompt != "" {
		body["negative_prompt"] = req.NegativePrompt
	}
	if req.Seed != nil {
		body["seed"] = *req.Seed
	}
	if _, ok := body["n"]; !ok && !modelscopeIs(req.Protocol, req.Model) {
		body["n"] = 1
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return ImageGenerationResult{}, fmt.Errorf("marshal image request: %w", err)
	}
	path := req.Endpoint
	isEdit := path == "edits" || path == "/edits" || strings.HasSuffix(path, "/images/edits")
	if isEdit {
		path = "/v1/images/edits"
	} else {
		path = "/v1/images/generations"
	}
	in := httptest.NewRequestWithContext(ctx, http.MethodPost, path, bytes.NewReader(raw))
	in.Header.Set("Content-Type", "application/json")
	in.Header.Set("X-TinyRouter-Source", "playground-batch")
	in.Header.Set("X-TinyRouter-Provenance", "playground-batch:project="+clipID(req.ProjectID)+":prompt="+clipID(req.PromptID)+":variant="+clipID(req.VariantID))
	if modelscopeIs(req.Protocol, req.Model) {
		in.Header.Set("X-Modelscope-Async-Mode", "true")
	}
	rec := httptest.NewRecorder()
	proxyDone := make(chan struct{})
	go func() {
		if isEdit {
			if editCaller, ok := g.caller.(ImageEditsCaller); ok {
				editCaller.ImagesEdits(rec, in)
			} else {
				http.Error(rec, "image edit proxy unavailable", http.StatusNotImplemented)
			}
		} else {
			g.caller.ImagesGenerations(rec, in)
		}
		close(proxyDone)
	}()
	select {
	case <-ctx.Done():
		return ImageGenerationResult{}, ctx.Err()
	case <-proxyDone:
	}
	if err := ctx.Err(); err != nil {
		return ImageGenerationResult{}, err
	}
	resp := rec.Result()
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, g.maxBytes+1))
	if err != nil {
		return ImageGenerationResult{}, fmt.Errorf("read image proxy response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail := compactErrorBody(payload)
		if detail != "" {
			return ImageGenerationResult{}, fmt.Errorf("image proxy returned %s: %s", resp.Status, detail)
		}
		return ImageGenerationResult{}, fmt.Errorf("image proxy returned %s", resp.Status)
	}
	var doc map[string]any
	if err := json.Unmarshal(payload, &doc); err != nil {
		return ImageGenerationResult{}, fmt.Errorf("invalid image response: %w", err)
	}
	items := modelscopeItems(doc)
	revised := modelscopeRevised(doc)
	taskID := modelscopeTaskID(doc)
	if len(items) == 0 && taskID == "" {
		return ImageGenerationResult{}, errors.New("image response contains no assets")
	}
	// Async providers (e.g. ModelScope) return a task id without assets; poll
	// until the image is ready. Polling is delegated to an optional caller so
	// the regular proxy interface remains intentionally small.
	if len(items) == 0 {
		p, ok := g.caller.(ImageTaskCaller)
		if !ok {
			return ImageGenerationResult{}, errors.New("image provider returned an asynchronous task")
		}
		pi, pr, err := g.pollTask(ctx, p, taskID, req)
		if err != nil {
			return ImageGenerationResult{}, err
		}
		items = pi
		if revised == "" {
			revised = pr
		}
	}
	result := ImageGenerationResult{Provider: protocolProvider(req.Protocol), RevisedPrompt: revised, Duration: time.Since(started), RawMeta: map[string]any{"protocol": req.Protocol}}
	for _, item := range items {
		if item.Revised != "" {
			result.RevisedPrompt = item.Revised
		}
		var b []byte
		var mimeType string
		if item.B64 != "" {
			var err error
			b, err = base64.StdEncoding.DecodeString(item.B64)
			if err != nil {
				return ImageGenerationResult{}, fmt.Errorf("decode image base64: %w", err)
			}
			mimeType = http.DetectContentType(b)
		} else if item.URL != "" {
			b, mimeType, err = g.fetchImage(ctx, item.URL)
			if err != nil {
				return ImageGenerationResult{}, err
			}
		} else {
			return ImageGenerationResult{}, errors.New("image item has neither url nor b64_json")
		}
		asset, err := validateImageBytes(b, mimeType, g.maxBytes)
		if err != nil {
			return ImageGenerationResult{}, err
		}
		result.Assets = append(result.Assets, asset)
	}
	if len(result.Assets) == 0 {
		return ImageGenerationResult{}, errors.New("image response contains no valid assets")
	}
	return result, nil
}

type remoteItem struct {
	B64     string `json:"b64_json"`
	URL     string `json:"url"`
	Revised string `json:"revised_prompt"`
}

func compactErrorBody(payload []byte) string {
	const maxDetail = 512
	var envelope struct {
		Error   any    `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(payload, &envelope) == nil {
		switch v := envelope.Error.(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				return clipError(v, maxDetail)
			}
		case map[string]any:
			if msg, ok := v["message"].(string); ok && strings.TrimSpace(msg) != "" {
				return clipError(msg, maxDetail)
			}
			if code, ok := v["code"].(string); ok && strings.TrimSpace(code) != "" {
				return clipError(code, maxDetail)
			}
		}
		if strings.TrimSpace(envelope.Message) != "" {
			return clipError(envelope.Message, maxDetail)
		}
	}
	return clipError(string(payload), maxDetail)
}

func clipError(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}

// pollTask polls an async image task (ModelScope/DashScope) until it completes
// or fails. The GET /v1/tasks/{id}?model={req.Model} request is routed through
// the proxy's ImageTask so provider/key selection and header pass-through
// (X-Modelscope-Task-Type) are reused. Limits mirror the verified manual
// canvas flow: 60 attempts, 2s interval, 10s per-attempt timeout.
func (g *RemoteGenerator) pollTask(ctx context.Context, caller ImageTaskCaller, id string, req ImageGenerationRequest) ([]remoteItem, string, error) {
	const (
		maxPolls       = 60
		interval       = 2 * time.Second
		attemptTimeout = 10 * time.Second
	)
	pollURL := "/v1/tasks/" + url.PathEscape(id) + "?model=" + url.QueryEscape(req.Model)
	for range maxPolls {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		items, revised, pending, err := g.pollOnce(ctx, caller, pollURL, id, attemptTimeout)
		if err != nil {
			return nil, "", err
		}
		if !pending {
			return items, revised, nil
		}
		select {
		case <-ctx.Done():
			return nil, "", ctx.Err()
		case <-time.After(interval):
		}
	}
	return nil, "", errors.New("image task polling timed out")
}

// pollOnce performs a single task poll. pending=true means the task is still
// running and the caller should retry; pending=false with nil error means the
// task finished and items (if any) are ready. A non-2xx response or a failed
// status is a definitive error (transient retries are handled by the
// scheduler's maxRetries on a fresh Generate, not within one poll sequence).
func (g *RemoteGenerator) pollOnce(ctx context.Context, caller ImageTaskCaller, pollURL, id string, timeout time.Duration) (items []remoteItem, revised string, pending bool, err error) {
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	r := httptest.NewRequestWithContext(callCtx, http.MethodGet, pollURL, nil)
	r.Header.Set("X-Modelscope-Task-Type", "image_generation")
	r.Header.Set("X-TinyRouter-Source", "playground-batch")
	r.Header.Set("X-TinyRouter-Provenance", "playground-batch:task="+clipID(id))
	rec := httptest.NewRecorder()
	caller.ImageTask(rec, r)
	if err := ctx.Err(); err != nil {
		return nil, "", false, err
	}
	resp := rec.Result()
	b, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	if readErr != nil {
		return nil, "", false, fmt.Errorf("read image task response: %w", readErr)
	}
	if rec.Code < 200 || rec.Code >= 300 {
		return nil, "", false, fmt.Errorf("image task returned %s: %s", resp.Status, compactErrorBody(b))
	}
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, "", false, fmt.Errorf("invalid image task response: %w", err)
	}
	if st := modelscopeStatus(raw); modelscopeDecision(st) == "failed" {
		return nil, "", false, fmt.Errorf("image task %s: %s", st, modelscopeMessage(raw))
	}
	if items = modelscopeItems(raw); len(items) > 0 {
		return items, modelscopeRevised(raw), false, nil
	}
	return nil, "", true, nil
}

func (g *RemoteGenerator) fetchImage(ctx context.Context, raw string) ([]byte, string, error) {
	u, err := outbound.ValidateURL(raw)
	if err != nil || u.Hostname() == "" {
		return nil, "", errors.New("invalid image URL")
	}
	if g.enforcePolicy {
		if err := g.policy.CheckHost(ctx, u.Hostname()); err != nil {
			return nil, "", errors.New("image URL target is not allowed")
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := g.client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("fetch image URL: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", fmt.Errorf("image URL returned %s", resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, g.maxBytes+1))
	if err != nil {
		return nil, "", err
	}
	return b, resp.Header.Get("Content-Type"), nil
}

func validateImageBytes(b []byte, contentType string, max int64) (GeneratedAsset, error) {
	if len(b) == 0 || int64(len(b)) > max {
		return GeneratedAsset{}, errors.New("invalid image size")
	}
	mt, _, _ := mime.ParseMediaType(contentType)
	if mt == "" {
		mt = http.DetectContentType(b)
	}
	if !strings.HasPrefix(mt, "image/") {
		return GeneratedAsset{}, fmt.Errorf("unsupported image MIME %q", mt)
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return GeneratedAsset{}, fmt.Errorf("decode image: %w", err)
	}
	ext := strings.ToLower(format)
	if ext == "jpeg" {
		ext = "jpg"
	}
	return GeneratedAsset{Bytes: b, MIME: mt, Extension: ext, Width: cfg.Width, Height: cfg.Height}, nil
}

func safeImageClient() *http.Client {
	// Outbound SSRF policy: no private/loopback targets, DNS-rebinding-safe
	// dialing, per-redirect revalidation with a bounded hop count.
	return outbound.Policy{Timeout: 60 * time.Second}.Client()
}

func protocolProvider(p string) string {
	switch strings.ToLower(p) {
	case "xai":
		return "xai"
	case "modelscope":
		return "modelscope"
	default:
		return "gpt"
	}
}

func clipID(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 80 {
		s = s[:80]
	}
	return s
}

// modelscopeIs reports whether the request targets a ModelScope-style async
// image API. The protocol field (set by the playground from the model's
// imgProtocol) is the authoritative signal; the model-prefix check is a
// belt-and-suspenders fallback for the canonical "modelscope/" prefix.
func modelscopeIs(protocol, model string) bool {
	if strings.EqualFold(strings.TrimSpace(protocol), "modelscope") {
		return true
	}
	return strings.HasPrefix(strings.ToLower(model), "modelscope/")
}

// modelscopeTaskID extracts an async task id from any known ModelScope /
// DashScope submission envelope.
func modelscopeTaskID(j map[string]any) string {
	for _, k := range []string{"task_id", "id"} {
		if s, _ := j[k].(string); s != "" {
			return s
		}
	}
	if out, ok := j["output"].(map[string]any); ok {
		if s, _ := out["task_id"].(string); s != "" {
			return s
		}
	}
	if res, ok := j["result"].(map[string]any); ok {
		if s, _ := res["task_id"].(string); s != "" {
			return s
		}
	}
	if data, ok := j["data"].([]any); ok && len(data) > 0 {
		if m, ok := data[0].(map[string]any); ok {
			if s, _ := m["task_id"].(string); s != "" {
				return s
			}
		}
	}
	// Some ModelScope deployments expose only request_id. Use it only after
	// all task-specific locations have been checked.
	if s, _ := j["request_id"].(string); s != "" {
		return s
	}
	return ""
}

// modelscopeItems extracts image items (url or base64) from any known
// ModelScope / DashScope result shape, falling back to OpenAI-style data[].
// It also accepts plain OpenAI data[] so a single code path serves both
// sync and async providers.
func modelscopeItems(j map[string]any) []remoteItem {
	var lists [][]any
	if v, ok := j["output_images"].([]any); ok {
		lists = append(lists, v)
	}
	if v, ok := j["data"].([]any); ok {
		lists = append(lists, v)
	}
	if v, ok := j["results"].([]any); ok {
		lists = append(lists, v)
	}
	if out, ok := j["output"].(map[string]any); ok {
		for _, k := range []string{"output_images", "results", "images"} {
			if v, ok := out[k].([]any); ok {
				lists = append(lists, v)
			}
		}
	}
	var out []remoteItem
	seen := map[string]bool{}
	for _, list := range lists {
		for _, item := range list {
			it, ok := item.(map[string]any)
			if !ok {
				if s, ok := item.(string); ok && s != "" {
					if !seen[s] {
						seen[s] = true
						out = append(out, remoteItem{URL: s})
					}
				}
				continue
			}
			url := strFrom(it, "url", "image_url", "oss_url")
			if url == "" {
				if u, ok := it["url"].(map[string]any); ok {
					url = strFrom(u, "url", "href")
				}
			}
			b64 := strFrom(it, "b64_json", "base64")
			if url == "" && b64 == "" {
				continue
			}
			if url != "" {
				if seen[url] {
					continue
				}
				seen[url] = true
			}
			out = append(out, remoteItem{URL: url, B64: b64, Revised: strFrom(it, "revised_prompt")})
		}
	}
	if len(out) == 0 {
		if u := strFrom(j, "image_url"); u != "" {
			out = append(out, remoteItem{URL: u})
		}
		if outObj, ok := j["output"].(map[string]any); ok {
			if u := strFrom(outObj, "image_url"); u != "" {
				out = append(out, remoteItem{URL: u})
			}
		}
	}
	return out
}

// strFrom returns the first non-empty string value among the given keys.
func strFrom(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if s, _ := m[k].(string); s != "" {
			return s
		}
	}
	return ""
}

func modelscopeRevised(j map[string]any) string {
	if s, _ := j["revised_prompt"].(string); s != "" {
		return s
	}
	if data, ok := j["data"].([]any); ok && len(data) > 0 {
		if m, ok := data[0].(map[string]any); ok {
			if s, _ := m["revised_prompt"].(string); s != "" {
				return s
			}
		}
	}
	return ""
}

// modelscopeStatus extracts the task status string from any known shape.
func modelscopeStatus(j map[string]any) string {
	if s, _ := j["task_status"].(string); s != "" {
		return s
	}
	if s, _ := j["status"].(string); s != "" {
		return s
	}
	if out, ok := j["output"].(map[string]any); ok {
		if s, _ := out["task_status"].(string); s != "" {
			return s
		}
		if s, _ := out["status"].(string); s != "" {
			return s
		}
	}
	if data, ok := j["data"].([]any); ok && len(data) > 0 {
		if m, ok := data[0].(map[string]any); ok {
			if s, _ := m["task_status"].(string); s != "" {
				return s
			}
		}
	}
	return ""
}

// modelscopeDecision classifies a status string as done/failed/pending.
func modelscopeDecision(st string) string {
	st = strings.ToUpper(st)
	for _, tok := range []string{"SUCCEED", "SUCCESS", "COMPLETE", "DONE"} {
		if strings.Contains(st, tok) {
			return "done"
		}
	}
	for _, tok := range []string{"FAIL", "ERROR", "CANCEL"} {
		if strings.Contains(st, tok) {
			return "failed"
		}
	}
	return "pending"
}

// modelscopeMessage extracts a human-readable failure reason from a task
// response (ModelScope/DashScope shapes).
func modelscopeMessage(j map[string]any) string {
	for _, k := range []string{"message", "msg"} {
		if s, _ := j[k].(string); s != "" {
			return s
		}
	}
	switch e := j["error"].(type) {
	case string:
		return e
	case map[string]any:
		if s := strFrom(e, "message", "code"); s != "" {
			return s
		}
	}
	if out, ok := j["output"].(map[string]any); ok {
		if s := strFrom(out, "message", "msg"); s != "" {
			return s
		}
	}
	return ""
}
