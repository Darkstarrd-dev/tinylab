// Package playground provides API endpoints for Playground media preparation and operations.
package playground

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/mediaedit"
)

// Handler owns playground media preparation and operations.
type Handler struct {
	d *apibase.Deps
}

// NewHandler constructs a new playground Handler with shared dependencies.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register registers playground routes on the router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/ffmpeg-status", h.ffmpegStatus)
	r.Post("/media-prep", h.mediaPrep)
}

func (h *Handler) resolveFfmpeg() (string, error) {
	cfg := h.d.Reg.Config()
	return mediaedit.ResolveFfmpeg(cfg.Download.FfmpegPath)
}

// ffmpegStatus reports whether ffmpeg is available on the system.
func (h *Handler) ffmpegStatus(w http.ResponseWriter, r *http.Request) {
	ffmpegPath, err := h.resolveFfmpeg()
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"available": false,
			"path":      "",
			"error":     err.Error(),
		})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"available": true,
		"path":      ffmpegPath,
		"error":     "",
	})
}

// mediaPrep converts uploaded audio or video into an optimized inlineData structure (e.g. mp3).
func (h *Handler) mediaPrep(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Limit to 32MB upload
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)

	var fileData []byte
	var mimeType string
	var target string // "audio" or "video"

	contentType := r.Header.Get("Content-Type")
	if strings.HasPrefix(contentType, "multipart/form-data") {
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": fmt.Sprintf("failed to parse multipart: %v", err)})
			return
		}
		target = r.FormValue("target")
		mimeType = r.FormValue("mimeType")

		file, header, err := r.FormFile("file")
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "file field required in multipart upload"})
			return
		}
		defer file.Close()

		if mimeType == "" && header != nil {
			mimeType = header.Header.Get("Content-Type")
		}

		b, err := io.ReadAll(file)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": fmt.Sprintf("read file error: %v", err)})
			return
		}
		fileData = b
	} else {
		// JSON body
		var req struct {
			File     string `json:"file"` // data URL or base64
			MimeType string `json:"mimeType"`
			Target   string `json:"target"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": fmt.Sprintf("invalid JSON payload: %v", err)})
			return
		}
		target = req.Target
		mimeType = req.MimeType

		raw := req.File
		if strings.HasPrefix(raw, "data:") {
			parts := strings.SplitN(raw, ",", 2)
			if len(parts) == 2 {
				if mimeType == "" {
					headerPart := parts[0]
					if semi := strings.Index(headerPart, ";"); semi != -1 {
						mimeType = strings.TrimPrefix(headerPart[:semi], "data:")
					}
				}
				raw = parts[1]
			}
		}
		decoded, err := base64.StdEncoding.DecodeString(raw)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": fmt.Sprintf("invalid base64: %v", err)})
			return
		}
		fileData = decoded
	}

	if len(fileData) == 0 {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "file data is empty"})
		return
	}

	if target == "" {
		if strings.HasPrefix(mimeType, "audio/") || strings.HasPrefix(mimeType, "video/") {
			target = "audio"
		}
	}

	// If image or PDF and not requesting audio conversion, pass through directly
	if strings.HasPrefix(mimeType, "image/") || mimeType == "application/pdf" {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true,
			"inlineData": map[string]string{
				"mimeType": mimeType,
				"data":     base64.StdEncoding.EncodeToString(fileData),
			},
		})
		return
	}

	// Audio or video to mp3 conversion via ffmpeg
	ffmpegPath, err := h.resolveFfmpeg()
	if err != nil {
		// Fallback: return raw data if audio mimeType
		if strings.HasPrefix(mimeType, "audio/") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"inlineData": map[string]string{
					"mimeType": mimeType,
					"data":     base64.StdEncoding.EncodeToString(fileData),
				},
				"warning": fmt.Sprintf("ffmpeg not found (%v); returned unconverted audio", err),
			})
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": fmt.Sprintf("ffmpeg is not available: %v", err)})
		return
	}

	// Temporary directory for processing
	tempDir, err := os.MkdirTemp("", "tr_media_prep_*")
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": fmt.Sprintf("temp dir error: %v", err)})
		return
	}
	defer os.RemoveAll(tempDir)

	inExt := ".bin"
	if strings.Contains(mimeType, "wav") {
		inExt = ".wav"
	} else if strings.Contains(mimeType, "mp3") || strings.Contains(mimeType, "mpeg") {
		inExt = ".mp3"
	} else if strings.Contains(mimeType, "ogg") {
		inExt = ".ogg"
	} else if strings.Contains(mimeType, "aac") {
		inExt = ".aac"
	} else if strings.Contains(mimeType, "mp4") {
		inExt = ".mp4"
	} else if strings.Contains(mimeType, "webm") {
		inExt = ".webm"
	}

	inPath := filepath.Join(tempDir, "input"+inExt)
	outPath := filepath.Join(tempDir, "output.mp3")

	if err := os.WriteFile(inPath, fileData, 0600); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": fmt.Sprintf("temp write error: %v", err)})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	// Convert audio to mp3 mono 44.1kHz 128kbps (recommended for Gemini API §7)
	args := []string{
		"-i", inPath,
		"-vn",
		"-acodec", "libmp3lame",
		"-b:a", "128k",
		"-ac", "1",
		"-ar", "44100",
	}

	runErr := mediaedit.RunFfmpeg(ctx, ffmpegPath, args, outPath, 0, nil, nil)
	if runErr != nil {
		if errors.Is(runErr, context.DeadlineExceeded) {
			w.WriteHeader(http.StatusGatewayTimeout)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "ffmpeg transcoding timed out (60s)"})
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": fmt.Sprintf("ffmpeg transcoding failed: %v", runErr)})
		return
	}

	outBytes, err := os.ReadFile(outPath)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": fmt.Sprintf("failed to read transcoded output: %v", err)})
		return
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok": true,
		"inlineData": map[string]string{
			"mimeType": "audio/mp3",
			"data":     base64.StdEncoding.EncodeToString(outBytes),
		},
	})
}
