package gallery

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
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
	path := filepath.Join(fakeToolDir(t), name)
	if err := os.WriteFile(path, []byte(content), 0755); err != nil {
		t.Fatalf("write fake ffmpeg: %v", err)
	}
	return path
}

// fakeToolDir returns a private, non-temp directory for test tool binaries:
// procutil.ValidateExecutable rejects tool paths inside the OS temp dir
// (binary-swap defense), so fakes must live elsewhere. The dir is removed
// when the test finishes.
// fakeFFmpegPath returns an absolute path to a nonexistent ffmpeg binary:
// resolution fails, which exercises the available=false/error status path.
func fakeFFmpegPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "no-such-ffmpeg.exe")
}

// fakeToolDir returns a private, non-temp directory for test tool binaries:
// procutil.ValidateExecutable rejects tool paths inside the OS temp dir
// (binary-swap defense), so fakes must live elsewhere. The dir is removed
// when the test finishes.
func fakeToolDir(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	dir := filepath.Join(cwd, ".testbin-"+strconv.Itoa(os.Getpid())+"-"+strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == ' ' {
			return '_'
		}
		return r
	}, t.Name()))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir testbin: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// fakeFFmpegBrokenProbe returns a path to an existing executable that always
// exits non-zero, so ResolveFfmpeg succeeds (existing regular file outside
// the temp dir) while the capability probe fails — the "capability probe
// failed" path.
func fakeFFmpegBrokenProbe(t *testing.T) string {
	t.Helper()
	le := "\n"
	if runtime.GOOS == "windows" {
		le = "\r\n"
	}
	content := "@echo off" + le + "exit /b 1" + le
	if runtime.GOOS != "windows" {
		content = "#!/bin/sh\nexit 1\n"
	}
	name := "broken-ffmpeg"
	if runtime.GOOS == "windows" {
		name += ".bat"
	}
	path := filepath.Join(fakeToolDir(t), name)
	if err := os.WriteFile(path, []byte(content), 0755); err != nil {
		t.Fatalf("write broken ffmpeg: %v", err)
	}
	return path
}

// registerTestInput registers a temp input asset whose backing file is then
// removed: resolveMediaInput succeeds (registration lookup) while
// mediaedit.Start's os.Stat input validation fails, preserving the legacy
// "input file not found" gate-ordering tests under the asset contract.
func registerTestInput(t *testing.T, h *Handler, name string) string {
	t.Helper()
	st, err := h.assetStore()
	if err != nil {
		t.Fatalf("asset store: %v", err)
	}
	ref, err := st.Create(t.Context(), testOwner, "test", name, "application/octet-stream", strings.NewReader("garbage"), 0)
	if err != nil {
		t.Fatalf("create asset: %v", err)
	}
	if err := os.Remove(ref.Path); err != nil {
		t.Fatalf("remove backing file: %v", err)
	}
	return ref.ID
}

// startEdit posts an edit/start request with the shared owner cookie.
func startEdit(t *testing.T, srv *httptest.Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	resp, err := post(srv.URL+"/edit/start", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST /edit/start: %v", err)
	}
	defer resp.Body.Close()
	rec := httptest.NewRecorder()
	rec.Code = resp.StatusCode
	rec.Body.Write(readBody(t, resp))
	return rec
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
	h := newEditTestHandler(t, fakeFFmpegBrokenProbe(t))
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	for _, tc := range []struct {
		name      string
		operation string
	}{
		{"video_to_gif", "video_to_gif"},
		{"video_to_webp", "video_to_webp"},
		{"gif anim trim", "video_anim_trim"},
		{"webp anim trim", "video_anim_trim"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assetID := registerTestInput(t, h, "clip.mp4")
			body := "{\"inputAssetId\":\"" + assetID + "\",\"operation\":\"" + tc.operation + "\",\"params\":{}}"
			rec := startEdit(t, srv, body)
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
	srv := httptest.NewServer(r)
	defer srv.Close()

	t.Run("video_to_webp refused without libwebp_anim", func(t *testing.T) {
		assetID := registerTestInput(t, h, "clip.mp4")
		rec := startEdit(t, srv, "{\"inputAssetId\":\""+assetID+"\",\"operation\":\"video_to_webp\",\"params\":{}}")
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
		assetID := registerTestInput(t, h, "clip.webp")
		rec := startEdit(t, srv, "{\"inputAssetId\":\""+assetID+"\",\"operation\":\"video_anim_trim\",\"params\":{\"start\":\"0\",\"duration\":\"1\"}}")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d (body=%q)", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "libwebp_anim") {
			t.Errorf("expected libwebp_anim error, body=%q", rec.Body.String())
		}
	})

	t.Run("video_to_gif passes gate then fails input validation", func(t *testing.T) {
		assetID := registerTestInput(t, h, "clip.mp4")
		rec := startEdit(t, srv, "{\"inputAssetId\":\""+assetID+"\",\"operation\":\"video_to_gif\",\"params\":{}}")
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
	srv := httptest.NewServer(r)
	defer srv.Close()

	t.Run("animated webp trim refused without webp_anim decoder", func(t *testing.T) {
		assetID := registerTestInput(t, h, "clip.webp")
		rec := startEdit(t, srv, "{\"inputAssetId\":\""+assetID+"\",\"operation\":\"video_anim_trim\",\"params\":{\"start\":\"0\",\"duration\":\"1\"}}")
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
		assetID := registerTestInput(t, h, "clip.gif")
		rec := startEdit(t, srv, "{\"inputAssetId\":\""+assetID+"\",\"operation\":\"video_anim_trim\",\"params\":{\"start\":\"0\",\"duration\":\"1\"}}")
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
// only at input validation (registered asset whose file was removed).
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
	srv := httptest.NewServer(r)
	defer srv.Close()

	assetID := registerTestInput(t, h, "clip.mp4")
	rec := startEdit(t, srv, "{\"inputAssetId\":\""+assetID+"\",\"operation\":\"video_to_gif\",\"params\":{}}")

	// Capability gate passed; the job fails later at input validation.
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400 (input not found), got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "input file not found") {
		t.Errorf("expected input validation error, body=%q", rec.Body.String())
	}
}

// TestGalleryEditExtractZipEntry_ReturnsAssetId pins the JS/backend contract
// for the single-zip extract-to-edit flow (audit F-03/F-28): the response
// body is exactly { "assetId": "..." }. The frontend resolves the edit by
// assetId and must never read a tempPath.
func TestGalleryEditExtractZipEntry_ReturnsAssetId(t *testing.T) {
	h := newEditTestHandler(t, fakeFFmpegPath(t))
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	// Register an in-memory zip session (the flow the single-edit UI uses for
	// FSAA/drag-drop zips).
	upResp, err := post(srv.URL+"/zip", "application/zip", bytes.NewReader(buildTestZipBytes(t)))
	if err != nil {
		t.Fatalf("POST /zip: %v", err)
	}
	defer upResp.Body.Close()
	if upResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /zip: want 200, got %d", upResp.StatusCode)
	}
	var up struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(upResp.Body).Decode(&up); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	if up.SessionID == "" {
		t.Fatal("expected non-empty sessionId")
	}

	body, err := json.Marshal(map[string]string{"sessionId": up.SessionID, "zipPath": "a.png"})
	if err != nil {
		t.Fatalf("marshal extract request: %v", err)
	}
	resp, err := post(srv.URL+"/edit/extract-zip-entry", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST extract-zip-entry: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("extract-zip-entry: want 200, got %d (body=%q)", resp.StatusCode, readBody(t, resp))
	}
	var out map[string]json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode extract response: %v", err)
	}
	var assetID string
	raw, ok := out["assetId"]
	if !ok {
		t.Fatal("extract-zip-entry response must contain assetId")
	}
	if err := json.Unmarshal(raw, &assetID); err != nil || assetID == "" {
		t.Fatalf("extract-zip-entry assetId must be non-empty, got %q", assetID)
	}
	if _, ok := out["tempPath"]; ok {
		t.Fatal("extract-zip-entry response must not contain tempPath (frontend resolves by assetId)")
	}
}

// TestGalleryEditUploadTemp_ReturnsAssetId pins the same assetId-only contract
// for upload-temp, which materializes FSAA/drag-drop inputs for editing.
func TestGalleryEditUploadTemp_ReturnsAssetId(t *testing.T) {
	h := newEditTestHandler(t, fakeFFmpegPath(t))
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	resp, err := post(srv.URL+"/edit/upload-temp?name=a.png", "image/png", strings.NewReader("png-bytes"))
	if err != nil {
		t.Fatalf("POST upload-temp: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload-temp: want 200, got %d (body=%q)", resp.StatusCode, readBody(t, resp))
	}
	var out map[string]json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode upload-temp response: %v", err)
	}
	raw, ok := out["assetId"]
	if !ok {
		t.Fatal("upload-temp response must contain assetId")
	}
	var assetID string
	if err := json.Unmarshal(raw, &assetID); err != nil || assetID == "" {
		t.Fatalf("upload-temp assetId must be non-empty, got %q", assetID)
	}
	if _, ok := out["tempPath"]; ok {
		t.Fatal("upload-temp response must not contain tempPath")
	}
}

// TestGalleryEditUploadTemp_ZipPreservesFrameNames pins the legacy ZIP
// contract for the GIF editor: frame basenames requested via ?name= must
// survive upload-temp AND zip-outputs (frame_001.png stays frame_001.png
// instead of collapsing to "upload.png"), and cleanUp releases the packed
// input assets on success.
func TestGalleryEditUploadTemp_ZipPreservesFrameNames(t *testing.T) {
	h := newEditTestHandler(t, fakeFFmpegPath(t))
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	var ids []string
	for _, name := range []string{"frame_001.png", "frame_002.png"} {
		resp, err := post(srv.URL+"/edit/upload-temp?name="+name, "image/png", strings.NewReader("png-"+name))
		if err != nil {
			t.Fatalf("POST upload-temp %s: %v", name, err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("upload-temp %s: want 200, got %d (body=%q)", name, resp.StatusCode, readBody(t, resp))
		}
		var out struct {
			AssetID string `json:"assetId"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			resp.Body.Close()
			t.Fatalf("decode upload-temp %s: %v", name, err)
		}
		resp.Body.Close()
		if out.AssetID == "" {
			t.Fatalf("upload-temp %s: missing assetId", name)
		}
		ids = append(ids, out.AssetID)
	}

	body, err := json.Marshal(map[string]any{"assetIds": ids, "zipName": "frames", "cleanUp": true})
	if err != nil {
		t.Fatalf("marshal zip-outputs body: %v", err)
	}
	resp, err := post(srv.URL+"/edit/zip-outputs", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST zip-outputs: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("zip-outputs: want 200, got %d (body=%q)", resp.StatusCode, readBody(t, resp))
	}
	var zout struct {
		AssetID string `json:"assetId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&zout); err != nil {
		resp.Body.Close()
		t.Fatalf("decode zip-outputs: %v", err)
	}
	resp.Body.Close()
	if zout.AssetID == "" {
		t.Fatal("zip-outputs: missing assetId")
	}

	// The packed zip must keep the requested frame basenames.
	st, err := h.assetStore()
	if err != nil {
		t.Fatalf("asset store: %v", err)
	}
	rc, _, err := st.Open(testOwner, zout.AssetID)
	if err != nil {
		t.Fatalf("open packed zip asset: %v", err)
	}
	data, err := io.ReadAll(rc)
	rc.Close()
	if err != nil {
		t.Fatalf("read packed zip: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("parse packed zip: %v", err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	want := []string{"frame_001.png", "frame_002.png"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("zip entry names = %v, want %v", names, want)
	}

	// cleanUp:true must release the input frame assets on success.
	for _, id := range ids {
		if _, _, err := st.Open(testOwner, id); !archiveIsNotFound(err) {
			t.Fatalf("frame asset %s must be released after pack, got %v", id, err)
		}
	}
}

// TestGalleryEditZipOutputs_ReleasesOnPackFailure verifies cleanUp:true
// releases the registered input assets even when the pack fails partway (an
// unknown assetId), so a failed pack never leaks the frames until TTL.
func TestGalleryEditZipOutputs_ReleasesOnPackFailure(t *testing.T) {
	h := newEditTestHandler(t, fakeFFmpegPath(t))
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	resp, err := post(srv.URL+"/edit/upload-temp?name=frame_001.png", "image/png", strings.NewReader("png-bytes"))
	if err != nil {
		t.Fatalf("POST upload-temp: %v", err)
	}
	var up struct {
		AssetID string `json:"assetId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&up); err != nil {
		resp.Body.Close()
		t.Fatalf("decode upload-temp: %v", err)
	}
	resp.Body.Close()

	body, err := json.Marshal(map[string]any{"assetIds": []string{up.AssetID, "bogus-id"}, "zipName": "frames", "cleanUp": true})
	if err != nil {
		t.Fatalf("marshal zip-outputs body: %v", err)
	}
	resp, err = post(srv.URL+"/edit/zip-outputs", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST zip-outputs: %v", err)
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("zip-outputs with bogus id: want 404, got %d (body=%q)", resp.StatusCode, readBody(t, resp))
	}
	resp.Body.Close()

	st, err := h.assetStore()
	if err != nil {
		t.Fatalf("asset store: %v", err)
	}
	if _, _, err := st.Open(testOwner, up.AssetID); !archiveIsNotFound(err) {
		t.Fatalf("frame asset must be released after failed pack, got %v", err)
	}
}
