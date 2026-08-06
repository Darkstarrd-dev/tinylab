// Code in this file: AI review engine core (Fix 1 split from register.go). Frontend: gallery-review.js.
package gallery

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"

	gallerylib "github.com/tinyrouter/tinyrouter/internal/gallery"
	"golang.org/x/image/draw"
)

// reviewTask manages a single AI review task.
type reviewTask struct {
	SessionID    string
	Status       gallerylib.ReviewStatus
	Total        int
	Processed    int
	Failed       int
	Results      []gallerylib.ReviewResult
	SystemPrompt string
	UserPrompt   string
	MatchField   string
	mu           sync.Mutex
	cancel       context.CancelFunc
	done         chan struct{}
	err          error
}

// runReview is the review engine core, using a worker pool for concurrent processing.
// indices are 0-based positions in the sorted entries slice. readEntry resolves
// one entry's bytes: the legacy zip-session flow reads from the in-memory
// session bytes, the archive flow (sourceId) reads through the /api/archive
// bridge by strict entry path.
func (h *Handler) runReview(ctx context.Context, task *reviewTask, entries []gallerylib.Entry, indices []int, readEntry func(context.Context, string) ([]byte, error), provider, model string, concurrency int) {
	defer func() {
		task.mu.Lock()
		if task.Status == gallerylib.ReviewStatusRunning {
			task.Status = gallerylib.ReviewStatusCompleted
		}
		task.mu.Unlock()
		h.reviews.Delete(task.SessionID)
		h.sessions.unpin(task.SessionID)
		close(task.done)
	}()

	workCh := make(chan int, len(indices))
	for _, idx := range indices {
		workCh <- idx
	}
	close(workCh)

	var wg sync.WaitGroup
	// 错开启动步长：每个 Worker 错开 120ms 启动，防止 WebView2 与 Windows 代理高并发时连接死锁与拒绝
	staggerStep := 120 * time.Millisecond

	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		workerID := i
		go func() {
			defer wg.Done()

			// 第 workerID 个协程延迟 workerID * staggerStep 启动首个请求
			if workerID > 0 {
				delayTimer := time.NewTimer(time.Duration(workerID) * staggerStep)
				select {
				case <-delayTimer.C:
				case <-ctx.Done():
					delayTimer.Stop()
					task.mu.Lock()
					task.Status = gallerylib.ReviewStatusCancelled
					task.mu.Unlock()
					return
				}
			}

			for entryIdx := range workCh {
				select {
				case <-ctx.Done():
					task.mu.Lock()
					task.Status = gallerylib.ReviewStatusCancelled
					task.mu.Unlock()
					return
				default:
				}

				if entryIdx < 0 || entryIdx >= len(entries) {
					task.mu.Lock()
					task.Processed++
					task.Failed++
					task.mu.Unlock()
					continue
				}

				entry := entries[entryIdx]
				result, err := h.analyzeImage(ctx, readEntry, entry, provider, model, task.SystemPrompt, task.UserPrompt, task.MatchField)
				task.mu.Lock()
				task.Processed++
				if err != nil {
					task.Failed++
					h.d.Logger.Warn("gallery: review error for %s (session %s): %v", entry.Path, task.SessionID, err)
				} else if result != nil && result.IsMatch {
					task.Results = append(task.Results, *result)
				}
				task.mu.Unlock()
			}
		}()
	}
	wg.Wait()
}

// analyzeImage analyzes a single image using a vision model. readEntry
// resolves the entry's bytes (zip session or archive source).
func (h *Handler) analyzeImage(ctx context.Context, readEntry func(context.Context, string) ([]byte, error), entry gallerylib.Entry, provider, model string, systemPrompt, userPrompt, matchField string) (*gallerylib.ReviewResult, error) {
	// 1. Read image data
	imgData, err := readEntry(ctx, entry.Path)
	if err != nil {
		return nil, fmt.Errorf("read entry %s: %w", entry.Path, err)
	}

	// Pre-check dimensions from the container header BEFORE decoding: a crafted
	// small file declaring a huge canvas would otherwise allocate
	// width×height×4 bytes during image.Decode (decompression bomb / OOM).
	if err := gallerylib.CheckImageSize(imgData); err != nil {
		return nil, err
	}

	// 2. Decode and resize to max 1024px
	img, _, err := image.Decode(bytes.NewReader(imgData))
	if err != nil {
		// Decode failed: send raw bytes with correct MIME type
		mimeType := mimeTypeForEntry(entry.Path)
		return h.sendVisionRequest(ctx, imgData, mimeType, provider, model, entry, systemPrompt, userPrompt, matchField)
	}

	// 3. Resize
	resized := resizeImage(img, 1024)

	// 4. Encode as JPEG
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, resized, &jpeg.Options{Quality: 80}); err != nil {
		return nil, fmt.Errorf("jpeg encode: %w", err)
	}

	// 5. Send request
	return h.sendVisionRequest(ctx, buf.Bytes(), "image/jpeg", provider, model, entry, systemPrompt, userPrompt, matchField)
}

// sendVisionRequest sends a vision request to the LLM proxy.
func (h *Handler) sendVisionRequest(ctx context.Context, imgData []byte, mimeType, provider, model string, entry gallerylib.Entry, systemPrompt, userPrompt, matchField string) (*gallerylib.ReviewResult, error) {
	b64Data := base64.StdEncoding.EncodeToString(imgData)
	dataURL := "data:" + mimeType + ";base64," + b64Data

	body := map[string]any{
		"model": provider + "/" + model,
		"messages": []any{
			map[string]any{
				"role":    "system",
				"content": systemPrompt,
			},
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{
						"type": "text",
						"text": userPrompt,
					},
					map[string]any{
						"type": "image_url",
						"image_url": map[string]any{
							"url": dataURL,
						},
					},
				},
			},
		},
		"max_tokens":  120,
		"temperature": 0,
		"stream":      false,
	}

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	var lastErr error
	maxRetries := 2
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt*600) * time.Millisecond):
			}
		}

		reqCtx, reqCancel := context.WithTimeout(ctx, 45*time.Second)
		req, err := http.NewRequestWithContext(reqCtx, "POST", "/v1/chat/completions", bytes.NewReader(bodyBytes))
		if err != nil {
			lastErr = fmt.Errorf("build proxy request: %w", err)
			reqCancel()
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-TinyRouter-Provenance", "gallery:review:image="+strconv.Itoa(entry.Index))
		rec := httptest.NewRecorder()

		h.proxy.ChatCompletions(rec, req)
		reqCancel()

		resp := rec.Result()
		respBody, err := io.ReadAll(resp.Body)
		resp.Body.Close()

		if err != nil {
			lastErr = fmt.Errorf("read proxy response: %w", err)
			continue
		}

		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("proxy returned status %d: %s", resp.StatusCode, string(respBody))
			continue
		}

		// Parse response
		result, parseErr := gallerylib.ParseReviewResponse(respBody, matchField)
		if parseErr != nil {
			return nil, parseErr
		}

		return &gallerylib.ReviewResult{
			Index:   entry.Index,
			Path:    entry.Path,
			IsMatch: result.Match,
			Reason:  result.Reason,
		}, nil
	}

	return nil, lastErr
}

func mimeTypeForEntry(path string) string {
	ext := strings.ToLower(path)
	if i := strings.LastIndexByte(ext, '.'); i >= 0 {
		ext = ext[i+1:]
	}
	switch ext {
	case "png":
		return "image/png"
	case "jpg", "jpeg":
		return "image/jpeg"
	case "gif":
		return "image/gif"
	case "webp":
		return "image/webp"
	case "bmp":
		return "image/bmp"
	case "tif", "tiff":
		return "image/tiff"
	default:
		return "image/jpeg"
	}
}

func resizeImage(img image.Image, maxSize int) image.Image {
	bounds := img.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()
	if w <= maxSize && h <= maxSize {
		return img
	}

	var newW, newH int
	if w > h {
		newW = maxSize
		newH = h * maxSize / w
	} else {
		newH = maxSize
		newW = w * maxSize / h
	}

	dst := image.NewRGBA(image.Rect(0, 0, newW, newH))
	draw.BiLinear.Scale(dst, dst.Bounds(), img, img.Bounds(), draw.Over, nil)
	return dst
}

func selectReviewIndices(total int, strategy string, headSize, tailSize int) []int {
	switch gallerylib.ReviewStrategy(strategy) {
	case gallerylib.ReviewStrategyHeadTail:
		return selectHeadTailIndices(total, headSize, tailSize)
	default:
		indices := make([]int, total)
		for i := 0; i < total; i++ {
			indices[i] = i
		}
		return indices
	}
}

func selectHeadTailIndices(total, headSize, tailSize int) []int {
	seen := make(map[int]bool)
	var indices []int

	for i := 0; i < headSize && i < total; i++ {
		if !seen[i] {
			indices = append(indices, i)
			seen[i] = true
		}
	}

	for i := total - tailSize; i < total; i++ {
		if i >= 0 && !seen[i] {
			indices = append(indices, i)
			seen[i] = true
		}
	}

	return indices
}
