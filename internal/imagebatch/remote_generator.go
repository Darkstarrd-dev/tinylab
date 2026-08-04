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
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"time"
)

// ImageProxyCaller is the deliberately narrow interface used to invoke the
// normal image proxy without exposing provider credentials to imagebatch.
type ImageProxyCaller interface {
	ImagesGenerations(http.ResponseWriter, *http.Request)
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
}

func NewRemoteGenerator(caller ImageProxyCaller, opts ...RemoteGeneratorOption) *RemoteGenerator {
	g := &RemoteGenerator{caller: caller, client: safeImageClient(), maxBytes: 32 << 20}
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
	if _, ok := body["n"]; !ok {
		body["n"] = 1
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return ImageGenerationResult{}, fmt.Errorf("marshal image request: %w", err)
	}
	path := req.Endpoint
	if path == "" || !strings.HasPrefix(path, "/") {
		path = "/v1/images/generations"
	}
	in := httptest.NewRequestWithContext(ctx, http.MethodPost, path, bytes.NewReader(raw))
	in.Header.Set("Content-Type", "application/json")
	in.Header.Set("X-TinyRouter-Source", "playground-batch")
	in.Header.Set("X-TinyRouter-Provenance", "playground-batch:project="+clipID(req.ProjectID)+":prompt="+clipID(req.PromptID)+":variant="+clipID(req.VariantID))
	rec := httptest.NewRecorder()
	proxyDone := make(chan struct{})
	go func() { g.caller.ImagesGenerations(rec, in); close(proxyDone) }()
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
		return ImageGenerationResult{}, fmt.Errorf("image proxy returned %s", resp.Status)
	}
	var envelope remoteResponse
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return ImageGenerationResult{}, fmt.Errorf("invalid image response: %w", err)
	}
	if len(envelope.Data) == 0 && envelope.TaskID == "" && envelope.ID == "" {
		return ImageGenerationResult{}, errors.New("image response contains no assets")
	}
	// Some ModelScope deployments return a task id. Polling is delegated to an
	// optional caller so the regular proxy interface remains intentionally small.
	if len(envelope.Data) == 0 {
		if p, ok := g.caller.(ImageTaskCaller); ok {
			var e error
			envelope, e = g.pollTask(ctx, p, firstNonEmpty(envelope.TaskID, envelope.ID), req)
			if e != nil {
				return ImageGenerationResult{}, e
			}
		} else {
			return ImageGenerationResult{}, errors.New("image provider returned an asynchronous task")
		}
	}
	result := ImageGenerationResult{Provider: protocolProvider(req.Protocol), RevisedPrompt: envelope.Revised, Duration: time.Since(started), RawMeta: map[string]any{"protocol": req.Protocol}}
	for _, item := range envelope.Data {
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

type remoteResponse struct {
	Data    []remoteItem    `json:"data"`
	Revised string          `json:"revised_prompt"`
	TaskID  string          `json:"task_id"`
	ID      string          `json:"id"`
	Output  json.RawMessage `json:"output"`
	Status  string          `json:"status"`
}

func (g *RemoteGenerator) pollTask(ctx context.Context, caller ImageTaskCaller, id string, req ImageGenerationRequest) (remoteResponse, error) {
	_ = req
	for range 300 {
		if err := ctx.Err(); err != nil {
			return remoteResponse{}, err
		}
		r := httptest.NewRequestWithContext(ctx, http.MethodGet, "/v1/tasks/"+url.PathEscape(id), nil)
		r.Header.Set("X-TinyRouter-Source", "playground-batch")
		r.Header.Set("X-TinyRouter-Provenance", "playground-batch:task="+clipID(id))
		rec := httptest.NewRecorder()
		caller.ImageTask(rec, r)
		resp := rec.Result()
		b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if err != nil {
			return remoteResponse{}, err
		}
		if rec.Code >= 400 {
			return remoteResponse{}, fmt.Errorf("image task returned %s", resp.Status)
		}
		var out remoteResponse
		if err := json.Unmarshal(b, &out); err != nil {
			return remoteResponse{}, err
		}
		if len(out.Data) > 0 {
			return out, nil
		}
		if strings.EqualFold(out.Status, "failed") || strings.EqualFold(out.Status, "canceled") {
			return remoteResponse{}, fmt.Errorf("image task %s", out.Status)
		}
		select {
		case <-ctx.Done():
			return remoteResponse{}, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return remoteResponse{}, context.DeadlineExceeded
}

func (g *RemoteGenerator) fetchImage(ctx context.Context, raw string) ([]byte, string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return nil, "", errors.New("invalid image URL")
	}
	if blockedHost(u.Hostname()) {
		return nil, "", errors.New("image URL target is not allowed")
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
	return &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		if blockedHost(r.URL.Hostname()) {
			return errors.New("redirect target is not allowed")
		}
		return nil
	}}
}
func blockedHost(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(host, "."))
	if h == "localhost" || strings.HasSuffix(h, ".localhost") || h == "0.0.0.0" || h == "::" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast())
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
func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
func clipID(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 80 {
		s = s[:80]
	}
	return s
}
