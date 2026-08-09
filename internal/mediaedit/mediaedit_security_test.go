package mediaedit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// F-07: ffprobe/ffmpeg must never receive network URLs or non-regular-file
// inputs. The input validation runs before any process is spawned, so these
// tests need no ffmpeg/ffprobe binary.

func TestProbeRejectsNonLocalInputs(t *testing.T) {
	cases := []string{
		"http://127.0.0.1:8080/video.mp4",
		"https://internal.example/steal",
		"rtmp://10.0.0.5/live",
		"file:///etc/passwd",
	}
	for _, in := range cases {
		if _, err := Probe("/nonexistent/ffprobe", in); err == nil || !strings.Contains(err.Error(), "local files") {
			t.Errorf("%q: got %v, want local-files rejection", in, err)
		}
	}
}

func TestProbeRejectsNonRegularFile(t *testing.T) {
	dir := t.TempDir()
	if _, err := Probe("/nonexistent/ffprobe", dir); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Errorf("directory input: got %v, want not-a-regular-file rejection", err)
	}
	missing := filepath.Join(dir, "nope.mp4")
	if _, err := Probe("/nonexistent/ffprobe", missing); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("missing input: got %v, want not-found rejection", err)
	}
}

// F-07: subtitle filter inputs must not be able to alter the ffmpeg filter
// graph structure, and font/language values are charset-restricted.

func TestVideoSubtitleFilterSafety(t *testing.T) {
	// Hostile font/language values are rejected, never interpolated.
	bad := []struct {
		name string
		sp   VideoSubtitleParams
	}{
		{"font-injection", VideoSubtitleParams{SubtitlePath: "/tmp/s.srt", Mode: "burn", FontName: "Arial',eval:evil()", Container: "mp4"}},
		{"language-injection", VideoSubtitleParams{SubtitlePath: "/tmp/s.srt", Mode: "soft", Language: "eng; rm -rf /", Container: "mkv"}},
		{"font-backtick", VideoSubtitleParams{SubtitlePath: "/tmp/s.srt", Mode: "burn", FontName: "Arial$(id)", Container: "mkv"}},
	}
	for _, c := range bad {
		raw, _ := json.Marshal(c.sp)
		if _, _, _, err := BuildVideoSubtitleArgs("/tmp/video.mp4", raw); err == nil {
			t.Errorf("%s: expected rejection", c.name)
		}
	}

	// A benign font name and language still work.
	ok := VideoSubtitleParams{SubtitlePath: "/tmp/s.srt", Mode: "burn", FontName: "Noto Sans CJK SC", Language: "zh-Hans", Container: "mp4"}
	raw, _ := json.Marshal(ok)
	if _, _, _, err := BuildVideoSubtitleArgs("/tmp/video.mp4", raw); err != nil {
		t.Fatalf("benign params rejected: %v", err)
	}
}

func TestVideoSubtitlePathEscapedInFilter(t *testing.T) {
	// A subtitle path carrying filter metacharacters must be escaped so the
	// filter graph structure cannot change.
	sp := VideoSubtitleParams{SubtitlePath: `/tmp/we ird'file.srt`, Mode: "burn", Container: "mp4"}
	raw, _ := json.Marshal(sp)
	args, _, _, err := BuildVideoSubtitleArgs("/tmp/video.mp4", raw)
	if err != nil {
		t.Fatalf("build args: %v", err)
	}
	var filter string
	for _, a := range args {
		if strings.Contains(a, "subtitles=") {
			filter = a
			break
		}
	}
	if filter == "" {
		t.Fatal("no subtitles= filter produced")
	}
	if strings.Contains(filter, "we ird'file.srt") {
		t.Fatalf("raw unescaped quote reached the filter graph: %s", filter)
	}
	if !strings.Contains(filter, `we ird\'file.srt`) {
		t.Fatalf("quote not escaped with backslash: %s", filter)
	}
}

// F-07: ffmpeg runs are constrained to the file/pipe protocols at the process
// level even if a hostile path slips through validation.

func TestFfmpegProtocolWhitelist(t *testing.T) {
	found := false
	for i, f := range ffmpegCommonFlags {
		if f == "-protocol_whitelist" && i+1 < len(ffmpegCommonFlags) {
			if ffmpegCommonFlags[i+1] != "file,pipe" {
				t.Fatalf("unexpected protocol whitelist %q", ffmpegCommonFlags[i+1])
			}
			found = true
		}
	}
	if !found {
		t.Fatal("ffmpeg common flags must carry -protocol_whitelist file,pipe")
	}
	if ffprobeProtocolWhitelist != "file" {
		t.Fatalf("ffprobe whitelist must be file-only, got %q", ffprobeProtocolWhitelist)
	}
}

// F-07: subtitle inputs must resolve inside the server-managed upload dir.

func TestValidateSubtitleInputContainment(t *testing.T) {
	root := subtitleUploadDir()
	inside := filepath.Join(root, "abc123.srt")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	if err := os.WriteFile(inside, []byte("1\n00:00:00,000 --> 00:00:01,000\nx\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateSubtitleInput(inside); err != nil {
		t.Fatalf("uploaded subtitle rejected: %v", err)
	}
	for _, bad := range []string{
		"http://127.0.0.1:8080/sub.srt",
		"/etc/passwd",
		filepath.Join(t.TempDir(), "sub.srt"),
	} {
		if err := validateSubtitleInput(bad); err == nil {
			t.Errorf("%q: expected containment rejection", bad)
		}
	}
}
