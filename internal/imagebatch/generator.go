package imagebatch

import (
	"context"
	"errors"
	"fmt"
	"strconv"
)

// ProtocolGenerator dispatches a frozen batch request to the configured image
// protocol without exposing provider credentials to the batch package.
type ProtocolGenerator struct {
	remote ImageGenerator
	comfy  func(port int, workflow map[string]any) ImageGenerator
}

// NewProtocolGenerator creates a generator using the existing proxy for remote
// protocols and a ComfyUI factory for loopback requests.
func NewProtocolGenerator(remote ImageGenerator) *ProtocolGenerator {
	return &ProtocolGenerator{remote: remote, comfy: func(port int, workflow map[string]any) ImageGenerator {
		return NewComfyGenerator(port, workflow)
	}}
}

func (g *ProtocolGenerator) Generate(ctx context.Context, req ImageGenerationRequest) (ImageGenerationResult, error) {
	if g == nil {
		return ImageGenerationResult{}, errors.New("image generator unavailable")
	}
	if req.Protocol == "comfyui" {
		port := 8188
		var workflow map[string]any
		if req.Params != nil {
			switch v := req.Params["port"].(type) {
			case int:
				port = v
			case int64:
				port = int(v)
			case float64:
				port = int(v)
			case string:
				if n, err := strconv.Atoi(v); err == nil {
					port = n
				}
			}
			if v, ok := req.Params["workflow"].(map[string]any); ok {
				workflow = v
			}
		}
		if port < 1 || port > 65535 {
			return ImageGenerationResult{}, fmt.Errorf("invalid ComfyUI port %d", port)
		}
		return g.comfy(port, workflow).Generate(ctx, req)
	}
	if g.remote == nil {
		return ImageGenerationResult{}, errors.New("remote image generator unavailable")
	}
	return g.remote.Generate(ctx, req)
}
