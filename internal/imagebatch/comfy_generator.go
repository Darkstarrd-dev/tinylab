package imagebatch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type ComfyGeneratorOption func(*ComfyGenerator)

func WithComfyHTTPClient(c *http.Client) ComfyGeneratorOption {
	return func(g *ComfyGenerator) {
		if c != nil {
			g.client = c
		}
	}
}
func WithComfyWorkflow(w map[string]any) ComfyGeneratorOption {
	return func(g *ComfyGenerator) { g.workflow = cloneMap(w) }
}

type ComfyGenerator struct {
	port     int
	workflow map[string]any
	client   *http.Client
	maxBytes int64
}

func NewComfyGenerator(port int, workflow map[string]any, opts ...ComfyGeneratorOption) *ComfyGenerator {
	g := &ComfyGenerator{port: port, workflow: cloneMap(workflow), client: comfyHTTPClient(port), maxBytes: 32 << 20}
	for _, opt := range opts {
		if opt != nil {
			opt(g)
		}
	}
	return g
}

func (g *ComfyGenerator) Generate(ctx context.Context, req ImageGenerationRequest) (ImageGenerationResult, error) {
	started := time.Now()
	if g == nil || g.port < 1 || g.port > 65535 {
		return ImageGenerationResult{}, errors.New("invalid ComfyUI port")
	}
	if err := ctx.Err(); err != nil {
		return ImageGenerationResult{}, err
	}
	workflow := cloneMap(g.workflow)
	if v, ok := req.Params["workflow"].(map[string]any); ok {
		workflow = cloneMap(v)
	}
	if len(workflow) == 0 {
		return ImageGenerationResult{}, errors.New("ComfyUI workflow is empty")
	}
	applyComfyInputs(workflow, req)
	body, err := json.Marshal(map[string]any{"prompt": workflow, "client_id": "tinyrouter-batch"})
	if err != nil {
		return ImageGenerationResult{}, fmt.Errorf("marshal ComfyUI prompt: %w", err)
	}
	var queued struct {
		PromptID string `json:"prompt_id"`
		Error    any    `json:"error"`
	}
	if err := g.doJSON(ctx, http.MethodPost, "/prompt", "", body, &queued); err != nil {
		return ImageGenerationResult{}, err
	}
	if queued.Error != nil || queued.PromptID == "" {
		return ImageGenerationResult{}, errors.New("ComfyUI did not return prompt_id")
	}
	hist, err := g.waitHistory(ctx, queued.PromptID)
	if err != nil {
		return ImageGenerationResult{}, err
	}
	outputs := extractComfyImages(hist, queued.PromptID)
	if len(outputs) == 0 {
		return ImageGenerationResult{}, errors.New("ComfyUI history contains no images")
	}
	result := ImageGenerationResult{Provider: "comfyui", Duration: time.Since(started), RawMeta: map[string]any{"promptId": queued.PromptID}}
	for _, out := range outputs {
		q := url.Values{}
		q.Set("filename", out.Filename)
		q.Set("subfolder", out.Subfolder)
		q.Set("type", out.Type)
		b, ct, err := g.getBytes(ctx, "/view", q.Encode())
		if err != nil {
			return ImageGenerationResult{}, err
		}
		asset, err := validateImageBytes(b, ct, g.maxBytes)
		if err != nil {
			return ImageGenerationResult{}, err
		}
		asset.Meta = map[string]any{"promptId": queued.PromptID, "nodeId": out.NodeID, "filename": out.Filename, "subfolder": out.Subfolder, "type": out.Type}
		result.Assets = append(result.Assets, asset)
	}
	return result, nil
}

type comfyImage struct{ NodeID, Filename, Subfolder, Type string }

func extractComfyImages(v map[string]any, pid string) []comfyImage {
	if x, ok := v[pid].(map[string]any); ok {
		v = x
	}
	outs, _ := v["outputs"].(map[string]any)
	var result []comfyImage
	for nodeID, raw := range outs {
		obj, _ := raw.(map[string]any)
		imgs, _ := obj["images"].([]any)
		for _, rawImg := range imgs {
			im, _ := rawImg.(map[string]any)
			filename, _ := im["filename"].(string)
			if filename == "" {
				continue
			}
			sub, _ := im["subfolder"].(string)
			typ, _ := im["type"].(string)
			if typ == "" {
				typ = "output"
			}
			result = append(result, comfyImage{NodeID: nodeID, Filename: filename, Subfolder: sub, Type: typ})
		}
	}
	return result
}
func (g *ComfyGenerator) waitHistory(ctx context.Context, pid string) (map[string]any, error) {
	for range 1500 {
		var hist map[string]any
		if err := g.doJSON(ctx, http.MethodGet, "/history/"+url.PathEscape(pid), "", nil, &hist); err != nil {
			return nil, err
		}
		if _, ok := hist[pid]; ok && len(extractComfyImages(hist, pid)) > 0 {
			return hist, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return nil, context.DeadlineExceeded
}
func (g *ComfyGenerator) doJSON(ctx context.Context, method, path, query string, body []byte, out any) error {
	b, _, err := g.do(ctx, method, path, query, body, "application/json")
	if err != nil {
		return err
	}
	if out != nil && len(b) > 0 {
		if err := json.Unmarshal(b, out); err != nil {
			return fmt.Errorf("invalid ComfyUI JSON: %w", err)
		}
	}
	return nil
}
func (g *ComfyGenerator) getBytes(ctx context.Context, path, query string) ([]byte, string, error) {
	return g.do(ctx, http.MethodGet, path, query, nil, "")
}
func (g *ComfyGenerator) do(ctx context.Context, method, path, query string, body []byte, contentType string) ([]byte, string, error) {
	if method != http.MethodGet && method != http.MethodPost {
		return nil, "", errors.New("ComfyUI method not allowed")
	}
	if err := validateComfyPath(path, query); err != nil {
		return nil, "", err
	}
	target := "http://127.0.0.1:" + strconv.Itoa(g.port) + path
	if query != "" {
		target += "?" + query
	}
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	if contentType != "" && len(body) > 0 {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := g.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return nil, "", fmt.Errorf("ComfyUI request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", fmt.Errorf("ComfyUI returned %s", resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, g.maxBytes+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(b)) > g.maxBytes {
		return nil, "", errors.New("ComfyUI response too large")
	}
	return b, resp.Header.Get("Content-Type"), nil
}
func validateComfyPath(path, query string) error {
	if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, " \\\r\n") || len(path) > 1024 {
		return errors.New("invalid ComfyUI path")
	}
	if strings.ContainsAny(query, "\r\n") || len(query) > 4096 {
		return errors.New("invalid ComfyUI query")
	}
	if path != "/prompt" && path != "/view" && !strings.HasPrefix(path, "/history/") {
		return errors.New("ComfyUI path not allowed")
	}
	return nil
}
func comfyHTTPClient(port int) *http.Client {
	return &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		if r.URL.Hostname() != "127.0.0.1" || r.URL.Port() != strconv.Itoa(port) {
			return errors.New("ComfyUI redirect outside port")
		}
		return nil
	}}
}
func applyComfyInputs(w map[string]any, req ImageGenerationRequest) {
	for _, raw := range w {
		n, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		inputs, _ := n["inputs"].(map[string]any)
		if inputs == nil {
			continue
		}
		if req.Prompt != "" {
			if t, _ := n["class_type"].(string); t == "CLIPTextEncode" {
				title, _ := n["_meta"].(map[string]any)
				ts, _ := title["title"].(string)
				if !strings.Contains(strings.ToLower(ts), "negative") {
					inputs["text"] = req.Prompt
				}
			}
		}
		if req.Seed != nil {
			if _, ok := inputs["seed"]; ok {
				inputs["seed"] = *req.Seed
			}
		}
	}
}
func cloneMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	b, _ := json.Marshal(in)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}
