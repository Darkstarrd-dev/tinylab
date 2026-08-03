package download

import (
	"path/filepath"
	"strings"
	"testing"
)

func containsAll(t *testing.T, haystack []string, needles ...string) {
	t.Helper()
	joined := strings.Join(haystack, " ")
	for _, n := range needles {
		if !strings.Contains(joined, n) {
			t.Errorf("expected args to contain %q, got: %v", n, haystack)
		}
	}
}

func TestResolveVideoFormatSelector(t *testing.T) {
	cases := []struct {
		quality QualityPreset
		want    string
		exact   bool
	}{
		{QualityBest, "bestvideo+bestaudio/best", true},
		{QualityWorst, "worstvideo+worstaudio/worst/best", true},
		// 以下为算法生成的较长选择器（含 bestvideo 后备候选），断言关键子串与后缀。
		{QualityGood, "bestvideo[height<=1080]+bestaudio[abr<=256]", false},
		{QualityNormal, "bestvideo[height<=720]+bestaudio[abr<=192]", false},
		{QualityBad, "bestvideo[height<=480]+bestaudio[abr<=128]", false},
	}
	for _, c := range cases {
		got := resolveVideoFormatSelector(c.quality)
		if c.exact {
			if got != c.want {
				t.Errorf("resolveVideoFormatSelector(%q) = %q, want %q", c.quality, got, c.want)
			}
		} else {
			if !strings.Contains(got, c.want) {
				t.Errorf("resolveVideoFormatSelector(%q) = %q, want it to contain %q", c.quality, got, c.want)
			}
			if !strings.HasSuffix(got, "/best") {
				t.Errorf("resolveVideoFormatSelector(%q) = %q, want suffix /best", c.quality, got)
			}
		}
	}
}

func TestResolveAudioFormatSelector(t *testing.T) {
	cases := []struct {
		quality QualityPreset
		want    string
	}{
		{QualityBest, "bestaudio[abr<=320]/bestaudio/best"},
		{QualityGood, "bestaudio[abr<=256]/bestaudio/best"},
		{QualityNormal, "bestaudio[abr<=192]/bestaudio/best"},
		{QualityBad, "bestaudio[abr<=128]/bestaudio/best"},
		{QualityWorst, "worstaudio/bestaudio/best"},
	}
	for _, c := range cases {
		if got := resolveAudioFormatSelector(c.quality); got != c.want {
			t.Errorf("resolveAudioFormatSelector(%q) = %q, want %q", c.quality, got, c.want)
		}
	}
}

func TestBuildDownloadArgs(t *testing.T) {
	url := "https://example.com/video"
	settings := RuntimeSettings{}
	args := BuildDownloadArgs(url, TypeVideo, QualityGood, ContainerMP4, "/tmp/dl", 4, settings)

	containsAll(t, args,
		"--no-playlist", "--no-mtime", "--encoding", "utf-8", "--newline",
		"--concurrent-fragments", "4",
		"-f",
		"--merge-output-format", "mp4", "--remux-video", "mp4",
		"--sub-langs", "all", "--embed-subs",
		"--no-embed-thumbnail", "--embed-metadata", "--embed-chapters",
		"-o",
		"--continue", "--no-playlist-reverse",
		"--trim-filenames", "120",
		"--retries", "30", "--fragment-retries", "30", "--retry-sleep", "2", "--socket-timeout", "30",
	)
	// 输出路径应为 downloadDir 与模板的 OS 路径拼接（Windows 用反斜杠）。
	if i := indexOf(args, "-o"); i == -1 || i+1 >= len(args) || args[i+1] != filepath.Join("/tmp/dl", "%(title)s.%(ext)s") {
		t.Errorf("expected -o %q, got %v", filepath.Join("/tmp/dl", "%(title)s.%(ext)s"), args)
	}
	if last := args[len(args)-1]; last != url {
		t.Errorf("expected URL as last arg, got %q", last)
	}
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "youtube:player_client") {
		t.Errorf("non-YouTube URL should not get YouTube extractor args: %v", args)
	}
	if strings.Contains(joined, "--proxy") {
		t.Errorf("empty proxy settings should not add --proxy: %v", args)
	}

	// concurrentFragments=1 不应添加 --concurrent-fragments
	argsNoFrag := BuildDownloadArgs(url, TypeVideo, QualityBest, ContainerAuto, "/tmp/dl", 1, settings)
	if strings.Contains(strings.Join(argsNoFrag, " "), "--concurrent-fragments") {
		t.Errorf("concurrentFragments=1 should omit --concurrent-fragments: %v", argsNoFrag)
	}

	// audio 类型不应添加 --merge-output-format
	argsAudio := BuildDownloadArgs(url, TypeAudio, QualityBest, ContainerAuto, "/tmp/dl", 4, settings)
	if strings.Contains(strings.Join(argsAudio, " "), "--merge-output-format") {
		t.Errorf("audio type should not add --merge-output-format: %v", argsAudio)
	}

	// YouTube URL 应添加安全提取器参数
	ytArgs := BuildDownloadArgs("https://www.youtube.com/watch?v=abc", TypeVideo, QualityBest, ContainerAuto, "/tmp/dl", 4, settings)
	if !strings.Contains(strings.Join(ytArgs, " "), "youtube:player_client=default,-web") {
		t.Errorf("YouTube URL should add safe extractor args: %v", ytArgs)
	}

	// 代理 / cookies / ffmpeg 注入
	rich := RuntimeSettings{
		Proxy:          "http://127.0.0.1:8080",
		BrowserCookies: "chrome",
		CookiesPath:    "/tmp/cookies.txt",
		FfmpegPath:     "/opt/ffmpeg/bin/ffmpeg",
	}
	richArgs := BuildDownloadArgs(url, TypeVideo, QualityBest, ContainerMP4, "/tmp/dl", 4, rich)
	richJoined := strings.Join(richArgs, " ")
	containsAll(t, []string{richJoined},
		"--proxy", "http://127.0.0.1:8080",
		"--cookies-from-browser", "chrome",
		"--cookies", "/tmp/cookies.txt",
		"--ffmpeg-location", "/opt/ffmpeg/bin",
	)
	// ffmpeg-location 必须在 URL 之前
	if idxFfmpeg := indexOf(richArgs, "--ffmpeg-location"); idxFfmpeg == -1 || richArgs[idxFfmpeg+2] != url {
		t.Errorf("ffmpeg-location should appear before URL: %v", richArgs)
	}
}

func indexOf(slice []string, s string) int {
	for i, v := range slice {
		if v == s {
			return i
		}
	}
	return -1
}

func TestParseProgressLine(t *testing.T) {
	line := "[download]  50.0% of 100.00MiB at 5.00MiB/s ETA 00:10"
	p, ok := parseProgressLine(line)
	if !ok {
		t.Fatalf("expected progress line match, got ok=false for %q", line)
	}
	if p.Percent != 0.5 {
		t.Errorf("percent = %v, want 0.5", p.Percent)
	}
	if p.TotalBytes != 100*1024*1024 {
		t.Errorf("totalBytes = %d, want %d", p.TotalBytes, 100*1024*1024)
	}
	if p.Downloaded != 50*1024*1024 {
		t.Errorf("downloaded = %d, want %d", p.Downloaded, 50*1024*1024)
	}
	if p.SpeedBytes != 5*1024*1024 {
		t.Errorf("speed = %d, want %d", p.SpeedBytes, 5*1024*1024)
	}
	if p.ETASeconds != 10 {
		t.Errorf("eta = %d, want 10", p.ETASeconds)
	}

	line2 := "[download]   1.2% of 1.00GiB at 500.00KiB/s ETA 01:02:03"
	p2, ok2 := parseProgressLine(line2)
	if !ok2 {
		t.Fatalf("expected match for %q", line2)
	}
	if p2.ETASeconds != 3723 {
		t.Errorf("eta = %d, want 3723", p2.ETASeconds)
	}
	totalGiB := int64(1 * 1024 * 1024 * 1024)
	if p2.TotalBytes != totalGiB {
		t.Errorf("totalBytes = %d, want %d", p2.TotalBytes, totalGiB)
	}
	wantDownloaded := int64(float64(totalGiB) * 0.012)
	if p2.Downloaded != wantDownloaded {
		t.Errorf("downloaded = %d, want %d", p2.Downloaded, wantDownloaded)
	}

	if _, ok := parseProgressLine("some unrelated log line"); ok {
		t.Errorf("expected non-match for unrelated line")
	}
}

func TestExtractSavedFilePath(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{`Merging formats into "/path/out.mp4"`, "/path/out.mp4"},
		{`Destination: "/movie.mkv"`, "/movie.mkv"},
		{`[download] /foo/bar.mp4 has already been downloaded`, "/foo/bar.mp4"},
		{`no path here`, ""},
		// 真实 yt-dlp 输出：单文件/音频提取（无 merge），Destination 不带引号，
		// 且后面紧跟进度行 —— 必须按行锚定才能提取完整路径。
		{
			"[download] Destination: /home/user/Music/track.mp3\n" +
				"[download] 100% of 5.00MiB in 00:00:01 at 5.00MiB/s",
			"/home/user/Music/track.mp3",
		},
		{
			"[download] Destination: /home/user/Videos/clip.webm\n" +
				"[download] 100% of 20.00MiB in 00:00:02 at 10.00MiB/s\n" +
				"[download] Merging formats into \"/home/user/Videos/clip.mp4\"",
			"/home/user/Videos/clip.mp4",
		},
		// 带引号的 Destination（Windows 路径）仍应兼容。
		{
			"[download] Destination: \"C:\\Users\\me\\Videos\\out.mp4\"\n" +
				"[download] 100% of 10.00MiB in 00:00:01 at 10.00MiB/s",
			`C:\Users\me\Videos\out.mp4`,
		},
	}
	for _, c := range cases {
		if got := extractSavedFilePath(c.input); got != c.want {
			t.Errorf("extractSavedFilePath(%q) = %q, want %q", c.input, got, c.want)
		}
	}
	// 优先级：merge 优先于 destination
	mixed := "Destination: \"/a.mp4\"\nMerging formats into \"/b.mp4\""
	if got := extractSavedFilePath(mixed); got != "/b.mp4" {
		t.Errorf("extractSavedFilePath priority = %q, want /b.mp4", got)
	}
	// 未加 (?m) 时，Destination 行在末尾之外会因 $ 锚定失败；这里显式验证多行尾部。
	multiline := "[download] Destination: /out/unquoted.mp4\n[download] 100% of 1.00MiB in 00:00:00 at 1.00MiB/s\n"
	if got := extractSavedFilePath(multiline); got != "/out/unquoted.mp4" {
		t.Errorf("extractSavedFilePath multiline = %q, want /out/unquoted.mp4", got)
	}
}

func TestClassifyExitError(t *testing.T) {
	cases := []struct {
		stderr string
		want   string
	}{
		{"ERROR: HTTP Error 429: Too Many Requests", "rate limited"},
		{"ERROR: Sign in to confirm you're not a bot", "authentication required"},
		{"ERROR: Video unavailable", "video not found"},
		{"ERROR: This video is not available in your country", "geo-blocked"},
		{"ERROR: No space left on device", "disk full"},
		{"ERROR: Permission denied", "permission denied"},
		{"ERROR: ffmpeg reported an error", "ffmpeg error"},
		{"ERROR: network timeout occurred", "network error"},
		{"some unknown failure", "yt-dlp exited with error"},
	}
	for _, c := range cases {
		err := classifyExitError(c.stderr)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("classifyExitError(%q) = %v, want to contain %q", c.stderr, err, c.want)
		}
	}
}

func TestIsYouTubeURL(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"https://www.youtube.com/watch?v=abc", true},
		{"https://youtu.be/abc", true},
		{"https://youtube-nocookie.com/embed/x", true},
		{"https://music.youtube.com/watch?v=x", true},
		{"https://example.com/video", false},
		{"not a url", false},
	}
	for _, c := range cases {
		if got := isYouTubeURL(c.url); got != c.want {
			t.Errorf("isYouTubeURL(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}

func TestIsBilibiliURL(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"https://www.bilibili.com/video/BV1xx", true},
		{"https://b23.tv/abc", true},
		{"https://example.com/video", false},
		{"not a url", false},
	}
	for _, c := range cases {
		if got := isBilibiliURL(c.url); got != c.want {
			t.Errorf("isBilibiliURL(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}
