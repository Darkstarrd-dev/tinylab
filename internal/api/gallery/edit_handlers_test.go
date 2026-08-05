package gallery

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/mediaedit"
	"github.com/tinyrouter/tinyrouter/internal/registry"
)

// newEditTestHandler builds a Handler whose configured ffmpeg path is the
// given path ("" = default resolution). The mediaedit capability cache is
// path-keyed, so each test gets an isolated result via its own temp dir.
func newEditTestHandler(t *testing.T, ffmpegPath string) *Handler {
	t.Helper()
	cfg := &config.Config{}
	cfg.Download.FfmpegPath = ffmpegPath
	reg := registry.New(cfg)
	d := &apibase.Deps{Reg: reg, Logger: console.New(100)}
	return NewHandler(d)
}

// writeFakeFFmpeg writes a fake ffmpeg executable that answers
// `-hide_banner -encoders` / `-hide_banner -decoders` with the given codec
// name tokens, and returns its absolute path. Used to simulate builds that
// lack a specific encoder/decoder while still executing successfully.
func writeFakeFFmpeg(t *testing.T, encoders, decoders []string) string {
	t.Helper()
	le := "\n"
	if runtime.GOOS == "windows" {
		le = "\r\n"
	}
	line := func(name string) string { return "echo  V....D " + name + le }
	var content string
	if runtime.GOOS == "windows" {
		content = "@echo off" + le +
			"if \"%2\"==\"-encoders\" goto enc" + le +
			"if \"%2\"==\"-decoders\" goto dec" + le +
			"exit /b 1" + le +
			":enc" + le +
			"echo Encoders:" + le +
			line("V..... = Video") +
			line("------")
		for _, e := range encoders {
			content += line(e)
		}
		content += "exit /b 0" + le +
			":dec" + le +
			"echo Decoders:" + le +
			line("V..... = Video") +
			line("------")
		for _, d := range decoders {
			content += line(d)
		}
		content += "exit /b 0" + le
	} else {
		content = "#!/bin/sh\n"
		content += "if [ \"$2\" = \"-encoders\" ]; then\n"
		for _, e := range encoders {
			content += "  echo ' V....D " + e + "'\n"
		}
		content += "  exit 0\nfi\n"
		content += "if [ \"$2\" = \"-decoders\" ]; then\n"
		for _, d := range decoders {
			content += "  echo ' V....D " + d + "'\n"
		}
		content += "  exit 0\nfi\nexit 1\n"
	}

	name := "fake-ffmpeg"
	if runtime.GOOS == "windows" {
		name += ".bat"
	}
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0755); err != nil {
		t.Fatalf("write fake ffmpeg: %v", err)
	}
	return path
}

// fakeFFmpegPath returns an absolute path to a nonexistent ffmpeg binary:
// resolution succeeds (configured path is trusted), but the capability probe
// fails, which exercises the all-false/error capability path.
func fakeFFmpegPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "no-such-ffmpeg.exe")
}

// TestGalleryEditFfmpegStatus_Fields pins the §9.3 contract: the response has
// exactly the six fields {available, path, error, gif, webpAnim,
// webpAnimDecode}, and a broken/unresolvable ffmpeg reports available=false
// with all capability bits false.
func TestGalleryEditFfmpegStatus_Fields(t *testing.T) {
	h := newEditTestHandler(t, fakeFFmpegPath(t))
	r := chi.NewRouter()
	h.Register(r)

	req := httptest.NewRequest(http.MethodGet, "/edit/ffmpeg-status", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v (body=%q)", err, rec.Body.String())
	}
	for _, k := range []string{"available", "path", "error", "gif", "webpAnim", "webpAnimDecode"} {
		if _, ok := body[k]; !ok {
			t.Errorf("missing field %q in %v", k, body)
		}
	}
	if body["available"] != false {
		t.Errorf("expected available=false for unresolvable ffmpeg, got %v", body["available"])
	}
	for _, k := range []string{"gif", "webpAnim", "webpAnimDecode"} {
		if body[k] != false {
			t.Errorf("expected %s=false for unresolvable ffmpeg, got %v", k, body[k])
		}
	}
}

// TestGalleryEditFfmpegStatus_RealCapabilities runs the probe against the real
// ffmpeg on this machine (skipped when absent) and asserts the capability bits
// are present as booleans. On this machine all three are true.
func TestGalleryEditFfmpegStatus_RealCapabilities(t *testing.T) {
	ff, err := mediaedit.ResolveFfmpeg("")
	if err != nil {
		t.Skipf("ffmpeg not resolvable: %v", err)
	}
	h := newEditTestHandler(t, ff)
	r := chi.NewRouter()
	h.Register(r)

	req := httptest.NewRequest(http.MethodGet, "/edit/ffmpeg-status", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["available"] != true {
		t.Errorf("expected available=true for real ffmpeg, got %v (error=%v)", body["available"], body["error"])
	}
	if body["path"] != ff {
		t.Errorf("expected path=%q, got %v", ff, body["path"])
	}
	for _, k := range []string{"gif", "webpAnim", "webpAnimDecode"} {
		if _, ok := body[k].(bool); !ok {
			t.Errorf("expected %s to be a boolean, got %T (%v)", k, body[k], body[k])
		}
	}
}

// TestGalleryEditStart_RejectsMissingCapability verifies the backend does not
// trust the frontend disable state: with an ffmpeg whose capability probe
// fails (fake path), every animated-image operation is refused with a clear
// error and no job is created.
func TestGalleryEditStart_RejectsMissingCapability(t *testing.T) {
	h := newEditTestHandler(t, fakeFFmpegPath(t))
	r := chi.NewRouter()
	h.Register(r)

	for _, tc := range []struct {
		name      string
		operation string
		input     string
	}{
		{"video_to_gif", "video_to_gif", "C:/videos/clip.mp4"},
		{"video_to_webp", "video_to_webp", "C:/videos/clip.mp4"},
		{"gif anim trim", "video_anim_trim", "C:/anims/clip.gif"},
		{"webp anim trim", "video_anim_trim", "C:/anims/clip.webp"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"inputPath":"` + tc.input + `","operation":"` + tc.operation + `","params":{}}`
			req := httptest.NewRequest(http.MethodPost, "/edit/start", strings.NewReader(body))
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("want 400, got %d (body=%q)", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "capability probe failed") {
				t.Errorf("expected capability probe error, body=%q", rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "jobId") {
				t.Errorf("job must not be created, body=%q", rec.Body.String())
			}
		})
	}
}

// TestGalleryEditStart_EncoderGates simulates a working ffmpeg build that has
// the gif encoder and webp_anim decoder but lacks libwebp_anim: only
// WebP-producing operations are refused, GIF operations pass the gate and
// proceed to input validation.
func TestGalleryEditStart_EncoderGates(t *testing.T) {
	ff := writeFakeFFmpeg(t, []string{"gif"}, []string{"webp_anim", "gif"})
	h := newEditTestHandler(t, ff)
	r := chi.NewRouter()
	h.Register(r)

	start := func(t *testing.T, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/edit/start", strings.NewReader(body))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	t.Run("video_to_webp refused without libwebp_anim", func(t *testing.T) {
		rec := start(t, `{"inputPath":"C:/videos/clip.mp4","operation":"video_to_webp","params":{}}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d (body=%q)", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "libwebp_anim") {
			t.Errorf("expected libwebp_anim error, body=%q", rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "jobId") {
			t.Errorf("job must not be created, body=%q", rec.Body.String())
		}
	})

	t.Run("webp anim trim refused without libwebp_anim", func(t *testing.T) {
		rec := start(t, `{"inputPath":"C:/anims/clip.webp","operation":"video_anim_trim","params":{"start":"0","duration":"1"}}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d (body=%q)", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "libwebp_anim") {
			t.Errorf("expected libwebp_anim error, body=%q", rec.Body.String())
		}
	})

	t.Run("video_to_gif passes gate then fails input validation", func(t *testing.T) {
		rec := start(t, `{"inputPath":"C:/videos/does-not-exist.mp4","operation":"video_to_gif","params":{}}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d (body=%q)", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "input file not found") {
			t.Errorf("expected input validation error (gate passed), body=%q", rec.Body.String())
		}
	})
}

// TestGalleryEditStart_WebpDecoderGate simulates a working ffmpeg build that
// has both encoders but lacks the webp_anim decoder: a .webp anim trim is
// refused with the decoder error (fail-closed when the input cannot be
// probed), while a .gif trim passes the gate.
func TestGalleryEditStart_WebpDecoderGate(t *testing.T) {
	ff := writeFakeFFmpeg(t, []string{"gif", "libwebp_anim"}, []string{"gif"})
	h := newEditTestHandler(t, ff)
	r := chi.NewRouter()
	h.Register(r)

	t.Run("animated webp trim refused without webp_anim decoder", func(t *testing.T) {
		body := `{"inputPath":"C:/anims/clip.webp","operation":"video_anim_trim","params":{"start":"0","duration":"1"}}`
		req := httptest.NewRequest(http.MethodPost, "/edit/start", strings.NewReader(body))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d (body=%q)", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "webp_anim") {
			t.Errorf("expected webp_anim decoder error, body=%q", rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "jobId") {
			t.Errorf("job must not be created, body=%q", rec.Body.String())
		}
	})

	t.Run("gif trim passes gate then fails input validation", func(t *testing.T) {
		body := `{"inputPath":"C:/anims/does-not-exist.gif","operation":"video_anim_trim","params":{"start":"0","duration":"1"}}`
		req := httptest.NewRequest(http.MethodPost, "/edit/start", strings.NewReader(body))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d (body=%q)", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "input file not found") {
			t.Errorf("expected input validation error (gate passed), body=%q", rec.Body.String())
		}
	})
}

// TestGalleryEditStart_PassesCapabilityCheckForRealFfmpeg verifies the
// capability check is permissive when the required encoder exists on the real
// machine ffmpeg: video_to_gif proceeds past the capability gate and fails
// only at input validation (nonexistent input file).
func TestGalleryEditStart_PassesCapabilityCheckForRealFfmpeg(t *testing.T) {
	ff, err := mediaedit.ResolveFfmpeg("")
	if err != nil {
		t.Skipf("ffmpeg not resolvable: %v", err)
	}
	caps, err := mediaedit.ProbeFfmpegCaps(ff)
	if err != nil || !caps.Gif {
		t.Skipf("gif encoder not available: %v", err)
	}
	h := newEditTestHandler(t, ff)
	r := chi.NewRouter()
	h.Register(r)

	input := filepath.ToSlash(filepath.Join(t.TempDir(), "does-not-exist.mp4"))
	body := `{"inputPath":"` + input + `","operation":"video_to_gif","params":{}}`
	req := httptest.NewRequest(http.MethodPost, "/edit/start", strings.NewReader(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	// Capability gate passed; the job fails later at input validation.
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400 (input not found), got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "input file not found") {
		t.Errorf("expected input validation error, body=%q", rec.Body.String())
	}
}
