package mediaedit

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestParseCodecListOutput(t *testing.T) {
	// Realistic `ffmpeg -hide_banner -encoders` / `-decoders` output shape:
	// header + legend lines, then one codec per line with a 6-char flag
	// column followed by the codec name.
	encOut := `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ------
 V....D gif                  GIF (Graphics Interchange Format)
 V....D libwebp_anim         libwebp WebP image (codec webp)
 V....D libwebp              libwebp WebP image (codec webp)
`
	decOut := `Decoders:
 V..... = Video
 ------
 V.S..D webp_anim            Animated WebP image
 V....D gif                  GIF (Graphics Interchange Format)
`
	enc := parseCodecListOutput(encOut)
	if !enc["gif"] {
		t.Error("expected gif encoder detected")
	}
	if !enc["libwebp_anim"] {
		t.Error("expected libwebp_anim encoder detected")
	}
	if enc["libwebp"] != true {
		t.Error("expected libwebp (non-anim) also detected")
	}
	if enc["Video"] || enc["Audio"] || enc["Subtitle"] {
		t.Error("legend lines parsed as codec names")
	}
	if enc["------"] {
		t.Error("separator line parsed as codec name")
	}

	dec := parseCodecListOutput(decOut)
	if !dec["webp_anim"] {
		t.Error("expected webp_anim decoder detected")
	}
	if dec["Video"] {
		t.Error("legend line parsed as decoder name")
	}
}

func TestProbeFfmpegCaps_Full(t *testing.T) {
	path := writeFakeFfmpeg(t, true, true)
	caps, err := ProbeFfmpegCaps(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !caps.Gif || !caps.WebpAnim || !caps.WebpAnimDecode {
		t.Errorf("expected all capabilities true, got %+v", caps)
	}
}

func TestProbeFfmpegCaps_MissingEncoder(t *testing.T) {
	path := writeFakeFfmpeg(t, false, true)
	caps, err := ProbeFfmpegCaps(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !caps.Gif {
		t.Error("expected gif encoder present in fixture")
	}
	if caps.WebpAnim {
		t.Error("expected libwebp_anim encoder absent in fixture")
	}
	if !caps.WebpAnimDecode {
		t.Error("expected webp_anim decoder present in fixture")
	}
}

func TestProbeFfmpegCaps_MissingDecoder(t *testing.T) {
	path := writeFakeFfmpeg(t, true, false)
	caps, err := ProbeFfmpegCaps(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !caps.WebpAnim {
		t.Error("expected libwebp_anim encoder present in fixture")
	}
	if caps.WebpAnimDecode {
		t.Error("expected webp_anim decoder absent in fixture")
	}
}

func TestProbeFfmpegCaps_ExecFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "no-such-ffmpeg")
	caps, err := ProbeFfmpegCaps(path)
	if err == nil {
		t.Fatal("expected error for nonexistent ffmpeg path")
	}
	if caps.Gif || caps.WebpAnim || caps.WebpAnimDecode {
		t.Errorf("expected all capabilities false on exec failure, got %+v", caps)
	}
}

func TestProbeFfmpegCaps_PathCacheIsolation(t *testing.T) {
	withAnim := writeFakeFfmpeg(t, true, true)
	withoutAnim := writeFakeFfmpeg(t, false, false)

	// Two distinct paths must produce independent results.
	caps1, err := ProbeFfmpegCaps(withAnim)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	caps2, err := ProbeFfmpegCaps(withoutAnim)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !caps1.WebpAnim || !caps1.WebpAnimDecode {
		t.Errorf("expected full caps for %s, got %+v", withAnim, caps1)
	}
	if caps2.WebpAnim || caps2.WebpAnimDecode {
		t.Errorf("expected no anim caps for %s, got %+v", withoutAnim, caps2)
	}
}

func TestProbeFfmpegCaps_CacheHitsOnSamePath(t *testing.T) {
	path := writeFakeFfmpeg(t, true, true)
	caps1, err := ProbeFfmpegCaps(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !caps1.WebpAnim || !caps1.WebpAnimDecode {
		t.Fatalf("fixture should report full caps, got %+v", caps1)
	}

	// Overwrite the fake binary with one that lacks the encoders. The cached
	// result for the same absolute path must be reused (path-keyed cache).
	writeFakeFfmpegAt(t, path, false, false)
	caps2, err := ProbeFfmpegCaps(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !caps2.WebpAnim || !caps2.WebpAnimDecode {
		t.Errorf("expected cached full caps for unchanged path, got %+v", caps2)
	}
}

// writeFakeFfmpeg creates a fake ffmpeg executable in a fresh temp dir that
// answers `-hide_banner -encoders` / `-hide_banner -decoders` with a
// configurable codec list, then returns its absolute path.
func writeFakeFfmpeg(t *testing.T, withWebpAnimEncoder, withWebpAnimDecoder bool) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ffmpeg")
	if runtime.GOOS == "windows" {
		path += ".bat"
	}
	writeFakeFfmpegAt(t, path, withWebpAnimEncoder, withWebpAnimDecoder)
	return path
}

func writeFakeFfmpegAt(t *testing.T, path string, withWebpAnimEncoder, withWebpAnimDecoder bool) {
	t.Helper()
	le := "\n"
	if runtime.GOOS == "windows" {
		le = "\r\n"
	}
	encLine := func(s string) string { return "echo  " + s + le }
	var encoders strings.Builder
	encoders.WriteString(encLine("V....D gif                  GIF (Graphics Interchange Format)"))
	if withWebpAnimEncoder {
		encoders.WriteString(encLine("V....D libwebp_anim         libwebp WebP image (codec webp)"))
	}
	var decoders strings.Builder
	if withWebpAnimDecoder {
		decoders.WriteString(encLine("V.S..D webp_anim            Animated WebP image"))
	}
	decoders.WriteString(encLine("V....D gif                  GIF (Graphics Interchange Format)"))

	var content string
	if runtime.GOOS == "windows" {
		// cmd.exe: respond by 2nd argument (-hide_banner is arg 1).
		content = "@echo off" + le +
			"if \"%2\"==\"-encoders\" goto enc" + le +
			"if \"%2\"==\"-decoders\" goto dec" + le +
			"exit /b 1" + le +
			":enc" + le +
			"echo Encoders:" + le +
			encLine("V..... = Video") +
			encLine("------") +
			encoders.String() +
			"exit /b 0" + le +
			":dec" + le +
			"echo Decoders:" + le +
			encLine("V..... = Video") +
			encLine("------") +
			decoders.String() +
			"exit /b 0" + le
	} else {
		// POSIX sh: respond by 2nd argument.
		content = "#!/bin/sh\n" +
			"if [ \"$2\" = \"-encoders\" ]; then\n" +
			"  echo 'Encoders:'\n" +
			"  echo ' ------'\n" +
			"  echo ' V..... = Video'\n" +
			"  echo ' ------' \n" +
			"  echo '" + encoders.String() + "'\n" +
			"  exit 0\n" +
			"fi\n" +
			"if [ \"$2\" = \"-decoders\" ]; then\n" +
			"  echo 'Decoders:'\n" +
			"  echo ' ------'\n" +
			"  echo ' V..... = Video'\n" +
			"  echo ' ------' \n" +
			"  echo '" + decoders.String() + "'\n" +
			"  exit 0\n" +
			"fi\n" +
			"exit 1\n"
	}
	if err := os.WriteFile(path, []byte(content), 0755); err != nil {
		t.Fatalf("write fake ffmpeg: %v", err)
	}
}
