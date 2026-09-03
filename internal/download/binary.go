package download

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/tinylab/tinylab/internal/procutil"
)

// resolveConfiguredTool canonicalizes a configured/external tool path and
// verifies it is a safe regular executable. A relative value (bare name) is
// resolved through PATH first so legacy configs keep working, then validated.
func resolveConfiguredTool(candidate, name string) (string, error) {
	if !filepath.IsAbs(candidate) {
		if lp, err := exec.LookPath(candidate); err == nil {
			candidate = lp
		}
	}
	path, err := procutil.ValidateExecutable(candidate)
	if err != nil {
		return "", fmt.Errorf("%s not usable: %w", name, err)
	}
	return path, nil
}

// resolveYtDlpPath 解析 yt-dlp 二进制路径：
// 1. 配置 settings.YtDlpPath
// 2. 环境变量 YTDLP_PATH
// 3. PATH 中的 yt-dlp
func (e *Executor) resolveYtDlpPath() (string, error) {
	if e.settings.YtDlpPath != "" {
		return resolveConfiguredTool(e.settings.YtDlpPath, "yt-dlp")
	}
	if env := os.Getenv("YTDLP_PATH"); env != "" {
		return resolveConfiguredTool(env, "yt-dlp")
	}
	path, err := exec.LookPath("yt-dlp")
	if err != nil {
		return "", fmt.Errorf("yt-dlp not found (set download.ytDlpPath, YTDLP_PATH, or put yt-dlp in PATH)")
	}
	return resolveConfiguredTool(path, "yt-dlp")
}

// resolveFfmpegPath 解析 ffmpeg 二进制路径：
// 1. 配置 settings.FfmpegPath
// 2. 环境变量 FFMPEG_PATH
// 3. PATH 中的 ffmpeg
func (e *Executor) resolveFfmpegPath() (string, error) {
	if e.settings.FfmpegPath != "" {
		return resolveConfiguredTool(e.settings.FfmpegPath, "ffmpeg")
	}
	if env := os.Getenv("FFMPEG_PATH"); env != "" {
		return resolveConfiguredTool(env, "ffmpeg")
	}
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		return "", fmt.Errorf("ffmpeg not found (set download.ffmpegPath, FFMPEG_PATH, or put ffmpeg in PATH)")
	}
	return resolveConfiguredTool(path, "ffmpeg")
}

// --- 输出文件路径提取 ---

var (
	// (?m) 使 $ 匹配行尾：Destination 行之后通常还有进度行，必须按行锚定，
	// 且 lazy 捕获只有锚定到行尾才能取到完整路径（否则最小匹配只取 1 个字符）。
	mergeRe   = regexp.MustCompile(`Merging formats into "([^"]+)"`)
	destRe    = regexp.MustCompile(`(?m)Destination:\s+"?([^"]+?)"?\s*$`)
	alreadyRe = regexp.MustCompile(`\[download\]\s+(.+?)\s+has already been downloaded`)
)

// extractSavedFilePath 从 yt-dlp stdout 日志中提取输出文件路径。
// 匹配模式（按优先级）：
//
//	Merging formats into "path"  → 提取 path
//	Destination: "path"          → 提取 path
//	[download] path has already been → 提取 path
func extractSavedFilePath(stdoutTail string) string {
	if m := mergeRe.FindStringSubmatch(stdoutTail); m != nil {
		return strings.TrimSpace(m[1])
	}
	if m := destRe.FindStringSubmatch(stdoutTail); m != nil {
		return strings.TrimSpace(m[1])
	}
	if m := alreadyRe.FindStringSubmatch(stdoutTail); m != nil {
		return strings.TrimSpace(m[1])
	}
	return ""
}
